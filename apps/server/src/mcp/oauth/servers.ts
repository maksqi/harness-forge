// The MCP servers a sign-in is for (Phase 14, ADR-059; W14.1): what the OAuth service needs of a target (its URL, its
// configured client and scopes, where its token record lives) for every origin of a server:
// - a personal server (`mcp_servers` row, `core-mcp`): the row's URL and `transport.oauth`, the client secret
//   `oauth.clientSecret` of scope `mcp:<id>`;
// - a plugin or Claude Code plugin server (a registry declaration): the declaration's transport with its
//   `{{settings.x}}` placeholders resolved (`templating.ts`, also in `oauth.clientId`); never a client secret;
// - an approved project `.mcp.json` server: the item's transport with its `${VAR}` references expanded from the stored
//   values only (never `process.env`), its `oauth` (client id, scopes); never a client secret.
// `resolveSignInServer` applies the sign-in rules (API.md 5.37): 404 unknown, 400 stdio or an `Authorization` header,
// 409 `disabled` (a disabled server; every project server in safe mode), 409 `untrusted` (a project server that is
// not approved, or changed since: verify-before-run). `resolveBinding` is the light read of the connect mode and of the
// DTO decoration (`info`): it never calls the managers' DTO paths (they call `info` themselves) and answers null for
// anything it cannot resolve. Values (header values, the client secret, variables) are never logged.
import type { McpAuthTarget } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { McpAuthStorage } from './types.ts'
import { HarnessError } from '@harness-forge/shared'
import { hasAuthorizationHeader, OAUTH_CLIENT_SECRET_NAME, OAUTH_RECORD_SECRET_NAME, OAUTH_SERVER_SECRET_PREFIX } from '../index.ts'
import { CORE_MCP_PLUGIN_ID } from '../internal.ts'
import { createProjectVariableStore, projectMcpSecretScope } from '../project-variables.ts'
import { expandTransport, referencedVariables } from '../project-view.ts'
import { resolveDeclOAuth, resolveDeclTransport } from '../templating.ts'
import { createUserServerStore, mcpSecretScope } from '../user-servers.ts'

/** What the OAuth service knows of a server (values: never log them). */
export interface AuthServer {
  readonly target: McpAuthTarget
  /** Where the token record lives. */
  readonly storage: McpAuthStorage
  /** The server's display name. */
  readonly name: string
  readonly type: 'http' | 'sse'
  /** The resolved MCP URL. */
  readonly url: string
  /** The resolved headers (never with an `Authorization` header for a server that signs in). */
  readonly headers: Readonly<Record<string, string>>
  /** The configured OAuth client id; null = dynamic client registration. */
  readonly clientId: string | null
  /** The configured client secret (personal servers only); null = a public client. */
  readonly clientSecret: string | null
  /** The configured scopes (space-separated); null = the scopes the server names. */
  readonly scopes: string | null
}

function notFound(target: McpAuthTarget): HarnessError {
  return new HarnessError({ code: 'not_found', message: `Unknown MCP server "${target.serverId}".` })
}

function stdioRefused(): HarnessError {
  return new HarnessError({ code: 'validation_error', message: 'This server runs on this computer (stdio), so it does not sign in.' })
}

function headerRefused(): HarnessError {
  return new HarnessError({ code: 'validation_error', message: 'This server is set up with its own Authorization header, so it does not sign in.' })
}

function disabledConflict(name: string): HarnessError {
  return new HarnessError({ code: 'conflict', message: `The MCP server "${name}" is disabled.`, details: { reason: 'disabled' } })
}

function safeModeConflict(): HarnessError {
  return new HarnessError({ code: 'conflict', message: 'Project MCP servers are off in safe mode.', details: { reason: 'disabled' } })
}

function untrustedConflict(name: string): HarnessError {
  return new HarnessError({ code: 'conflict', message: `Approve the project MCP server "${name}" before signing in.`, details: { reason: 'untrusted' } })
}

/** The storage of a personal server's record. */
export function userStorage(serverId: string): McpAuthStorage {
  return { kind: 'user', scope: mcpSecretScope(serverId), name: OAUTH_RECORD_SECRET_NAME }
}

/** The storage of a project server's record. */
export function projectStorage(projectId: string, serverId: string): McpAuthStorage {
  return { kind: 'project', scope: projectMcpSecretScope(projectId), name: `${OAUTH_SERVER_SECRET_PREFIX}${serverId}` }
}

/** A stable key of a target (`global:<id>` / `project:<projectId>:<id>`). */
export function targetKey(target: McpAuthTarget): string {
  return target.kind === 'global' ? `global:${target.serverId}` : `project:${target.projectId}:${target.serverId}`
}

/** The origin kind of a target for logs (`user`, `plugin`, `project`). */
export type AuthOriginKind = McpAuthStorage['kind']

export interface ServerResolver {
  /** The server under the sign-in rules (see the module comment); throws the routes' `HarnessError`s. */
  readonly resolveSignInServer: (target: McpAuthTarget, signal?: AbortSignal) => Promise<AuthServer>
  /** The server for the connect mode and `info`, or null (unknown, stdio, unresolvable). Never rejects. */
  readonly resolveBinding: (target: McpAuthTarget) => Promise<AuthServer | null>
  /**
   * For sign-out: the storage of a remote server (404 unknown, 400 stdio); its URL when it still resolves (for the
   * revocation's endpoint rule).
   */
  readonly resolveSignOut: (target: McpAuthTarget) => Promise<{ storage: McpAuthStorage, name: string, url: string | null }>
}

export function createServerResolver(deps: AppDeps): ServerResolver {
  const users = createUserServerStore(deps)
  const variables = createProjectVariableStore(deps)

  /** A personal server (row) or a plugin declaration; `null` when the id is unknown. */
  async function globalServer(serverId: string): Promise<{ server: AuthServer | null, stdio: boolean, name: string, storage: McpAuthStorage } | null> {
    const target: McpAuthTarget = { kind: 'global', serverId }
    const row = await users.get(serverId)
    if (row !== null) {
      const storage = userStorage(serverId)
      if (row.transport.type === 'stdio')
        return { server: null, stdio: true, name: row.name, storage }
      const transport = await users.resolveTransport(row)
      if (transport.type === 'stdio')
        return { server: null, stdio: true, name: row.name, storage }
      const clientId = row.transport.oauth?.clientId ?? null
      const clientSecret = clientId === null ? null : await deps.secrets.get(mcpSecretScope(serverId), OAUTH_CLIENT_SECRET_NAME)
      return {
        server: { target, storage, name: row.name, type: transport.type, url: transport.url, headers: transport.headers, clientId, clientSecret, scopes: row.transport.oauth?.scopes ?? null },
        stdio: false,
        name: row.name,
        storage,
      }
    }
    const registered = deps.registry.mcpServers.get(serverId)
    if (registered === undefined || registered.pluginId === CORE_MCP_PLUGIN_ID)
      return null
    const storage: McpAuthStorage = deps.mcp.authTarget(serverId) ?? { kind: 'plugin', scope: `plugin:${registered.pluginId}`, name: `${OAUTH_SERVER_SECRET_PREFIX}${serverId}` }
    const { decl } = registered
    if (decl.transport.type === 'stdio')
      return { server: null, stdio: true, name: decl.name, storage }
    let settings: Record<string, unknown> = {}
    try {
      settings = await deps.plugins.settingsValues(registered.pluginId)
    }
    catch {}
    const transport = resolveDeclTransport(serverId, decl.transport, settings)
    if (transport.type === 'stdio')
      return { server: null, stdio: true, name: decl.name, storage }
    const oauth = resolveDeclOAuth(serverId, decl.transport.oauth, settings)
    if (oauth.missing.length > 0)
      throw new HarnessError({ code: 'validation_error', message: `The MCP server "${serverId}" needs the setting "${oauth.missing[0]}" (OAuth client id): set it in the plugin's Configuration tab.` })
    return {
      server: { target, storage, name: decl.name, type: transport.type, url: transport.url, headers: transport.headers, clientId: oauth.clientId, clientSecret: null, scopes: oauth.scopes },
      stdio: false,
      name: decl.name,
      storage,
    }
  }

  async function projectServer(target: Extract<McpAuthTarget, { kind: 'project' }>, options: { refresh: boolean }) {
    const snapshot = await deps.projectConfig.snapshot(target.projectId, { refresh: options.refresh })
    const item = snapshot.mcpServers.find(entry => entry.server.id === target.serverId)
    if (item === undefined)
      return null
    const storage = projectStorage(target.projectId, target.serverId)
    const transport = item.server.transport
    if (transport.type === 'stdio')
      return { item, storage, server: null, stdio: true as const, missing: false }
    const values = await variables.values(target.projectId, referencedVariables(transport))
    const expanded = expandTransport(transport, values)
    if (!expanded.ok || expanded.transport.type === 'stdio')
      return { item, storage, server: null, stdio: false as const, missing: true }
    const server: AuthServer = {
      target,
      storage,
      name: item.server.name,
      type: expanded.transport.type,
      url: expanded.transport.url,
      headers: expanded.transport.headers,
      clientId: transport.oauth?.clientId ?? null,
      clientSecret: null,
      scopes: transport.oauth?.scopes ?? null,
    }
    return { item, storage, server, stdio: false as const, missing: false }
  }

  return {
    resolveSignInServer: async (target, signal) => {
      if (target.kind === 'global') {
        // The manager's DTO decides `not_found` and `disabled` like every MCP route.
        const dto = await deps.mcp.get(target.serverId)
        if (dto.transport.type === 'stdio')
          throw stdioRefused()
        const found = await globalServer(target.serverId)
        if (found === null)
          throw notFound(target)
        if (found.stdio || found.server === null)
          throw stdioRefused()
        if (hasAuthorizationHeader(found.server.headers))
          throw headerRefused()
        if (dto.status === 'disabled' || !dto.enabled)
          throw disabledConflict(dto.name)
        return found.server
      }
      await deps.projects.get(target.projectId)
      const found = await projectServer(target, { refresh: true })
      if (found === null)
        throw notFound(target)
      if (found.stdio)
        throw stdioRefused()
      if (deps.env.safeMode)
        throw safeModeConflict()
      const approved = await deps.projectTrust.approved(target.projectId)
      if (!approved.has(found.item.sha256))
        throw untrustedConflict(found.item.server.name)
      // Verify-before-run: the item (and the files it names) must still hash to the approval.
      if (!await deps.projectConfig.verify(target.projectId, found.item, signal))
        throw untrustedConflict(found.item.server.name)
      if (found.server === null)
        throw new HarnessError({ code: 'validation_error', message: 'A variable of this server has no value, or its URL is not an http or https URL. Set its variables in the project MCP servers.' })
      if (hasAuthorizationHeader(found.server.headers))
        throw headerRefused()
      return found.server
    },

    resolveBinding: async (target) => {
      try {
        if (target.kind === 'global') {
          const found = await globalServer(target.serverId)
          return found?.server ?? null
        }
        return (await projectServer(target, { refresh: false }))?.server ?? null
      }
      catch {
        return null
      }
    },

    resolveSignOut: async (target) => {
      if (target.kind === 'global') {
        const found = await globalServer(target.serverId).catch((error: unknown) => {
          // A plugin server whose settings no longer resolve can still be signed out (its record is deleted).
          if (error instanceof HarnessError && error.code === 'validation_error')
            return undefined
          throw error
        })
        if (found === null)
          throw notFound(target)
        if (found === undefined) {
          const storage = deps.mcp.authTarget(target.serverId)
          if (storage === null)
            throw notFound(target)
          return { storage, name: target.serverId, url: null }
        }
        if (found.stdio)
          throw stdioRefused()
        return { storage: found.storage, name: found.name, url: found.server?.url ?? null }
      }
      await deps.projects.get(target.projectId)
      const found = await projectServer(target, { refresh: true })
      if (found === null)
        throw notFound(target)
      if (found.stdio)
        throw stdioRefused()
      return { storage: found.storage, name: found.item.server.name, url: found.server?.url ?? null }
    },
  }
}
