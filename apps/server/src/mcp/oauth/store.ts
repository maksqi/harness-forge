// The OAuth token records of MCP servers (Phase 14, ADR-059; W14.1-T1; ARCHITECTURE.md 10.14). One record per server,
// stored only through `SecretStore` (AES-256-GCM) under the names of `McpAuthStorage` (personal servers `mcp:<id>`
// `oauth.record`, plugin servers `plugin:<pluginId>` and project servers `project:<projectId>` `mcp-oauth.<serverId>`):
//
//   { v: 1, resource, clientId, client?: { info, dynamic, redirectUris }, as?: { issuer, authorizationServerUrl,
//     tokenEndpoint }, tokens?: { access_token, token_type, expires_in?, scope?, refresh_token?, …, obtainedAt } }
//
// - `resource` is the MCP server URL the tokens were issued for and `clientId` the OAuth client they were issued to: a
//   record is used only while both still match the server (`recordMatches`: the URL, and the configured client id or a
//   dynamically registered client when none is configured); a mismatched record is ignored and replaced by the next
//   save. Plugin code cannot read these names (`ctx.secrets` is limited to its own prefix); backups never contain
//   secrets; a key rotation re-encrypts them; the scope goes with its server, plugin (unless `keepData`) or project.
// - Every token, client secret and the whole serialized record are registered with the redactor when read or written.
// - Writes of one record are serialized (a refresh racing a sign-out never resurrects a deleted record: `update` sees
//   the current value). Values are never logged.
import type { OAuthAuthorizationServerInformation, OAuthClientInformation, OAuthTokens } from '@ai-sdk/mcp'
import type { Redactor } from '../../security/types.ts'
import type { SecretScope, SecretStore } from '../../services/secrets/types.ts'
import type { McpAuthStorage } from './types.ts'
import { z } from 'zod'

/** Characters of a serialized record (a secret value is limited to 64 KB; tokens are far smaller). */
const RECORD_MAX_CHARS = 60_000

/** The OAuth client of a record or a pending flow: its information, how it was obtained and its redirect URIs. */
export interface StoredClient {
  /** `client_id` (+ `client_secret` of a dynamically registered confidential client, never a configured secret). */
  readonly info: OAuthClientInformation
  /** Registered by the harness at the authorization server (RFC 7591), not configured by the user. */
  readonly dynamic: boolean
  /** The redirect URIs the client was registered or used with (`<origin>/oauth/callback`). */
  readonly redirectUris: readonly string[]
}

/** Tokens as the SDK saves them (with its authorization-server pin fields) and when they were obtained (epoch ms). */
export type StoredTokens = OAuthTokens & { readonly obtainedAt: number }

export interface McpOAuthRecord {
  readonly v: 1
  /** The MCP server URL the record belongs to (normalized). */
  readonly resource: string
  /** The OAuth client id the tokens were issued to. */
  readonly clientId: string
  readonly client?: StoredClient
  readonly as?: OAuthAuthorizationServerInformation
  readonly tokens?: StoredTokens
}

/** What a record must match to be used: the server's URL and configured client id (null = dynamic registration). */
export interface RecordBinding {
  readonly url: string
  readonly clientId: string | null
}

const text = (max: number) => z.string().max(max)

const clientInfoSchema = z.object({
  client_id: text(1024).min(1),
  client_secret: text(8192).optional(),
  client_id_issued_at: z.number().optional(),
  client_secret_expires_at: z.number().optional(),
  issuer: text(2048).optional(),
  authorization_server: text(2048).optional(),
  token_endpoint: text(2048).optional(),
})

const recordSchema = z.object({
  v: z.literal(1),
  resource: text(4096).min(1),
  clientId: text(1024).min(1),
  client: z.object({
    info: clientInfoSchema,
    dynamic: z.boolean(),
    redirectUris: z.array(text(2048)).max(10),
  }).optional(),
  as: z.object({
    issuer: text(2048).optional(),
    authorizationServerUrl: text(2048).min(1),
    tokenEndpoint: text(2048).min(1),
  }).optional(),
  tokens: z.object({
    access_token: text(16_384).min(1),
    id_token: text(16_384).optional(),
    token_type: text(64),
    expires_in: z.number().optional(),
    scope: text(4096).optional(),
    refresh_token: text(16_384).optional(),
    issuer: text(2048).optional(),
    authorization_server: text(2048).optional(),
    token_endpoint: text(2048).optional(),
    obtainedAt: z.number(),
  }).optional(),
})

/** The normalized form of a URL (`new URL(url).href`), or the input when it does not parse. */
export function normalizeResource(url: string): string {
  try {
    return new URL(url).href
  }
  catch {
    return url
  }
}

/** The client information fields a record keeps (the SDK may add registration metadata; it is not stored). */
export function pickClientInfo(info: OAuthClientInformation): OAuthClientInformation {
  return clientInfoSchema.parse(info)
}

/** The tokens without `obtainedAt` (what the SDK and the transport read). */
export function tokensOf(tokens: StoredTokens): OAuthTokens {
  const { obtainedAt: _obtainedAt, ...rest } = tokens
  return rest
}

/** Parses a stored record; null for anything that is not a v1 record. */
export function parseRecord(value: string): McpOAuthRecord | null {
  if (value.length > RECORD_MAX_CHARS)
    return null
  let json: unknown
  try {
    json = JSON.parse(value)
  }
  catch {
    return null
  }
  const parsed = recordSchema.safeParse(json)
  return parsed.success ? parsed.data as McpOAuthRecord : null
}

/** True when the record may be used for a server with this binding (see the module comment). */
export function recordMatches(record: McpOAuthRecord, binding: RecordBinding): boolean {
  if (record.resource !== normalizeResource(binding.url))
    return false
  if (binding.clientId !== null)
    return record.clientId === binding.clientId && record.client?.dynamic !== true
  return record.client?.dynamic === true && record.client.info.client_id === record.clientId
}

/** True when two token sets are the same generation (the access or the refresh token is equal). */
export function sameTokens(a: OAuthTokens | undefined, b: OAuthTokens | undefined): boolean {
  if (a === undefined || b === undefined)
    return false
  return a.access_token === b.access_token || (a.refresh_token !== undefined && a.refresh_token === b.refresh_token)
}

/** Registers every secret value of tokens (and a client secret) with the redactor. */
export function registerTokenSecrets(redactor: Redactor, tokens: Partial<OAuthTokens> | undefined, clientSecret?: string): void {
  for (const value of [tokens?.access_token, tokens?.refresh_token, tokens?.id_token, clientSecret]) {
    if (typeof value === 'string' && value !== '')
      redactor.addSecret(value)
  }
}

function registerRecord(redactor: Redactor, record: McpOAuthRecord): void {
  registerTokenSecrets(redactor, record.tokens, record.client?.info.client_secret)
}

export interface TokenStore {
  /** The stored record (secrets registered with the redactor), or null (absent, unreadable or not a v1 record). */
  readonly read: (storage: McpAuthStorage) => Promise<McpOAuthRecord | null>
  /** Replaces the record. */
  readonly write: (storage: McpAuthStorage, record: McpOAuthRecord) => Promise<void>
  /**
   * Read-modify-write under the record's lock: `fn` gets the current record; it answers the new one, `null` to delete
   * it or `undefined` to leave it. Answers the record afterwards.
   */
  readonly update: (storage: McpAuthStorage, fn: (current: McpOAuthRecord | null) => McpOAuthRecord | null | undefined) => Promise<McpOAuthRecord | null>
  /** Deletes the record; true when one existed. */
  readonly remove: (storage: McpAuthStorage) => Promise<boolean>
}

export interface TokenStoreDeps {
  readonly secrets: SecretStore
  readonly redactor: Redactor
}

function keyOf(storage: McpAuthStorage): string {
  return `${storage.scope}\u0000${storage.name}`
}

export function createTokenStore(deps: TokenStoreDeps): TokenStore {
  const locks = new Map<string, Promise<unknown>>()

  function locked<T>(storage: McpAuthStorage, fn: () => Promise<T>): Promise<T> {
    const key = keyOf(storage)
    const previous = locks.get(key) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    const settled = run.then(() => undefined, () => undefined)
    locks.set(key, settled)
    void settled.then(() => {
      if (locks.get(key) === settled)
        locks.delete(key)
    })
    return run
  }

  async function readRaw(storage: McpAuthStorage): Promise<McpOAuthRecord | null> {
    const value = await deps.secrets.get(storage.scope as SecretScope, storage.name)
    if (value === null)
      return null
    const record = parseRecord(value)
    if (record !== null)
      registerRecord(deps.redactor, record)
    return record
  }

  async function writeRaw(storage: McpAuthStorage, record: McpOAuthRecord): Promise<void> {
    registerRecord(deps.redactor, record)
    await deps.secrets.set(storage.scope as SecretScope, storage.name, JSON.stringify(record))
  }

  return {
    read: readRaw,
    write: (storage, record) => locked(storage, () => writeRaw(storage, record)),
    update: (storage, fn) => locked(storage, async () => {
      const current = await readRaw(storage)
      const next = fn(current)
      if (next === undefined)
        return current
      if (next === null) {
        // Also an unreadable value: it is replaced by nothing.
        await deps.secrets.delete(storage.scope as SecretScope, storage.name)
        return null
      }
      await writeRaw(storage, next)
      return next
    }),
    remove: storage => locked(storage, () => deps.secrets.delete(storage.scope as SecretScope, storage.name)),
  }
}
