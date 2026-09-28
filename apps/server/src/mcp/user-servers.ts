// User-configured MCP servers (`core-mcp`): rows of `mcp_servers` + header / env values stored as secrets in scope
// `mcp:<id>` with names `header.<Name>` / `env.<NAME>` (ARCHITECTURE.md 8). The row keeps only the names; values are
// decrypted only at connect time and are never returned (DTOs carry `SecretState`s).
import type { McpServerInput, McpServerUpdate, McpTransportInput, McpTransportUpdate, SecretState, ToolPolicy } from '@harness-forge/shared'
import type { McpServerRow, McpTransportRecord } from '../db/schema.ts'
import type { SecretEntry, SecretScope } from '../services/secrets/types.ts'
import type { AppDeps } from '../types.ts'
import type { ResolvedMcpTransport } from './templating.ts'
import { HarnessError } from '@harness-forge/shared'
import { asc, eq } from 'drizzle-orm'
import { mcpServers } from '../db/schema.ts'
import { DEFAULT_MCP_POLICY } from './policy.ts'

export const HEADER_SECRET_PREFIX = 'header.'
export const ENV_SECRET_PREFIX = 'env.'
/** Secret names are limited to 256 characters (`services/secrets/scope.ts`). */
const SECRET_NAME_MAX = 256

export type UserServerRecord = McpServerRow

export function mcpSecretScope(id: string): SecretScope {
  return `mcp:${id}`
}

function conflictExists(id: string): HarnessError {
  return new HarnessError({ code: 'conflict', message: `An MCP server with the id "${id}" already exists.`, details: { reason: 'exists' } })
}

function invalid(message: string, path: (string | number)[]): HarnessError {
  return new HarnessError({ code: 'validation_error', message, details: { issues: [{ path, message, code: 'custom' }] } })
}

/** Rejects header names that differ only by case and names too long for a secret name. */
export function checkTransportNames(transport: McpTransportInput | McpTransportUpdate, base: (string | number)[] = ['transport']): void {
  if (transport.type === 'stdio') {
    for (const name of Object.keys(transport.env ?? {})) {
      if (ENV_SECRET_PREFIX.length + name.length > SECRET_NAME_MAX)
        throw invalid(`The environment variable name "${name.slice(0, 40)}..." is too long.`, [...base, 'env', name])
    }
    return
  }
  const seen = new Set<string>()
  for (const name of Object.keys(transport.headers ?? {})) {
    const key = name.toLowerCase()
    if (seen.has(key))
      throw invalid(`The header "${name}" is listed twice.`, [...base, 'headers', name])
    seen.add(key)
    if (HEADER_SECRET_PREFIX.length + name.length > SECRET_NAME_MAX)
      throw invalid(`The header name "${name.slice(0, 40)}..." is too long.`, [...base, 'headers', name])
  }
}

/** The stored transport (names only) of an input or replacement transport. */
export function transportRecordOf(transport: McpTransportInput | McpTransportUpdate): McpTransportRecord {
  return transport.type === 'stdio'
    ? { type: 'stdio', command: transport.command, args: [...(transport.args ?? [])], envNames: Object.keys(transport.env ?? {}) }
    : { type: transport.type, url: transport.url, headerNames: Object.keys(transport.headers ?? {}) }
}

/** Secret name -> value of the values present in a transport (null values of an update are skipped). */
function secretValuesOf(transport: McpTransportInput | McpTransportUpdate): Map<string, string> {
  const values = new Map<string, string>()
  const entries = transport.type === 'stdio'
    ? Object.entries(transport.env ?? {}).map(([name, value]) => [`${ENV_SECRET_PREFIX}${name}`, value] as const)
    : Object.entries(transport.headers ?? {}).map(([name, value]) => [`${HEADER_SECRET_PREFIX}${name}`, value] as const)
  for (const [name, value] of entries) {
    if (typeof value === 'string')
      values.set(name, value)
  }
  return values
}

/** Secret names a stored transport refers to. */
export function secretNamesOf(record: McpTransportRecord): string[] {
  return record.type === 'stdio'
    ? record.envNames.map(name => `${ENV_SECRET_PREFIX}${name}`)
    : record.headerNames.map(name => `${HEADER_SECRET_PREFIX}${name}`)
}

/** True when `next` connects differently than `current` (type, URL, command, args, names, or a new secret value). */
export function transportChanged(current: McpTransportRecord, next: McpTransportUpdate): boolean {
  const record = transportRecordOf(next)
  if (JSON.stringify(record) !== JSON.stringify(current))
    return true
  return secretValuesOf(next).size > 0
}

/** `SecretState` of one secret name. */
export function secretStateOf(entry: SecretEntry | undefined): SecretState {
  return entry ? { set: true, hint: entry.hint, source: 'stored' } : { set: false, hint: null, source: null }
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const record = current as { code?: unknown, message?: unknown, cause?: unknown }
    if (typeof record.code === 'string' && record.code.includes('CONSTRAINT'))
      return true
    if (typeof record.message === 'string' && /UNIQUE constraint failed|PRIMARY KEY/i.test(record.message))
      return true
    current = record.cause
  }
  return false
}

export interface UserServerStore {
  readonly list: () => Promise<UserServerRecord[]>
  readonly get: (id: string) => Promise<UserServerRecord | null>
  /** Inserts the row and stores the header / env values; `conflict` when the id exists. */
  readonly insert: (input: McpServerInput) => Promise<UserServerRecord>
  /** Applies a validated update (row + secrets); returns the new row. */
  readonly update: (current: UserServerRecord, patch: McpServerUpdate) => Promise<UserServerRecord>
  /** Deletes the row and every secret of the server. */
  readonly remove: (id: string) => Promise<void>
  /** Stored secrets of a server by name (metadata only). */
  readonly secretEntries: (id: string) => Promise<Map<string, SecretEntry>>
  /** The transport with decrypted values (missing secrets are skipped). Never log the result. */
  readonly resolveTransport: (record: UserServerRecord) => Promise<ResolvedMcpTransport>
}

export function createUserServerStore(deps: Pick<AppDeps, 'db' | 'secrets'>): UserServerStore {
  const { db } = deps

  async function get(id: string): Promise<UserServerRecord | null> {
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1)
    return row ?? null
  }

  async function writeSecrets(id: string, values: Map<string, string>): Promise<void> {
    for (const [name, value] of values)
      await deps.secrets.set(mcpSecretScope(id), name, value)
  }

  return {
    list: () => db.select().from(mcpServers).orderBy(asc(mcpServers.createdAt), asc(mcpServers.id)),

    get,

    insert: async (input) => {
      checkTransportNames(input.transport)
      const now = Date.now()
      const row: UserServerRecord = {
        id: input.id,
        name: input.name,
        transport: transportRecordOf(input.transport),
        policy: input.policy ?? DEFAULT_MCP_POLICY,
        enabled: input.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      }
      try {
        await db.insert(mcpServers).values(row)
      }
      catch (error) {
        if (isUniqueViolation(error) || (await get(input.id)) !== null)
          throw conflictExists(input.id)
        throw error
      }
      try {
        // Leftovers of an earlier server with the same id never leak into this one.
        await deps.secrets.deleteScope(mcpSecretScope(input.id))
        await writeSecrets(input.id, secretValuesOf(input.transport))
      }
      catch (error) {
        await db.delete(mcpServers).where(eq(mcpServers.id, input.id)).catch(() => {})
        await deps.secrets.deleteScope(mcpSecretScope(input.id)).catch(() => 0)
        throw error
      }
      return row
    },

    update: async (current, patch) => {
      if (patch.transport)
        checkTransportNames(patch.transport)
      const next: UserServerRecord = {
        ...current,
        name: patch.name ?? current.name,
        policy: (patch.policy ?? current.policy) as ToolPolicy,
        enabled: patch.enabled ?? current.enabled,
        transport: patch.transport ? transportRecordOf(patch.transport) : current.transport,
        updatedAt: Math.max(Date.now(), current.updatedAt + 1),
      }
      await db
        .update(mcpServers)
        .set({ name: next.name, policy: next.policy, enabled: next.enabled, transport: next.transport, updatedAt: next.updatedAt })
        .where(eq(mcpServers.id, current.id))
      if (patch.transport) {
        const scope = mcpSecretScope(current.id)
        const keep = new Set(secretNamesOf(next.transport))
        for (const entry of await deps.secrets.list(scope)) {
          if (!keep.has(entry.name))
            await deps.secrets.delete(scope, entry.name)
        }
        await writeSecrets(current.id, secretValuesOf(patch.transport))
      }
      return next
    },

    remove: async (id) => {
      await db.delete(mcpServers).where(eq(mcpServers.id, id))
      await deps.secrets.deleteScope(mcpSecretScope(id))
    },

    secretEntries: async id => new Map((await deps.secrets.list(mcpSecretScope(id))).map(entry => [entry.name, entry])),

    resolveTransport: async (record) => {
      const scope = mcpSecretScope(record.id)
      const read = async (names: readonly string[], prefix: string): Promise<Record<string, string>> => {
        const values: Record<string, string> = {}
        for (const name of names) {
          const value = await deps.secrets.get(scope, `${prefix}${name}`)
          if (value !== null)
            values[name] = value
        }
        return values
      }
      const transport = record.transport
      return transport.type === 'stdio'
        ? { type: 'stdio', command: transport.command, args: [...transport.args], env: await read(transport.envNames, ENV_SECRET_PREFIX) }
        : { type: transport.type, url: transport.url, headers: await read(transport.headerNames, HEADER_SECRET_PREFIX) }
    },
  }
}
