import type { Disposable } from '@harness-forge/plugin-sdk'
// MCP OAuth (Phase 14, ADR-059; W14.1; ARCHITECTURE.md 6.39 / 10.14, API.md 4.36 / 5.37) behind `McpAuthService`
// (./types.ts): the sign-in of remote MCP servers (Streamable HTTP / SSE) of every origin (personal servers, plugin and
// Claude Code plugin servers, approved project `.mcp.json` servers).
//
// - `provider(target, 'connect')` (the MCP managers' transports): the stored token record only (`provider.ts`); a
//   server without a usable record throws `McpAuthRequired` and becomes `needs-auth`; nothing ever registers a client
//   or redirects in the background.
// - `start(target, { origin, returnTo })` (the user's click): the sign-in rules (`servers.ts`: 404, 400 stdio or an
//   `Authorization` header, 409 `disabled` / `untrusted`), one unauthenticated probe of the MCP URL (`probe.ts`: the
//   `WWW-Authenticate` metadata URL and scopes), then `auth()` with the start provider: discovery, dynamic client
//   registration or the configured client id, PKCE S256, `state`, `resource` and `redirect_uri = <origin>/oauth/callback`.
//   `REDIRECT` keeps a pending flow (`flows.ts`: memory only, one per server, at most 20, 10 minutes, single use) and
//   answers the authorization URL; `AUTHORIZED` (a stored refresh token worked) stores the tokens, reconnects the server
//   and answers `authorizationUrl: null`, as does a server that answers the probe without credentials.
// - `complete(body, { origin })` (`POST /mcp/oauth/callback`): the flow by `state` (unknown, used, expired or another
//   origin → 409 `stale`); an authorization-server `error` → 502 `auth_invalid` with its text as plain text (≤ 300
//   characters, `details.target`); an `iss` that is not the flow's issuer → 400; else `auth()` with the callback provider
//   exchanges the code (the SDK checks the state and the issuer again), the token record is stored (`store.ts`) and the
//   server reconnects: `{ target, status, returnTo }`.
// - `signOut(target)`: the record deleted (a personal server's configured client secret stays), a pending flow dropped,
//   a best-effort RFC 7009 revocation (`revoke.ts`, `safeFetch` POST; its outcome only at `debug`) next to the reconnect
//   (`needs-auth`).
// - `info(target)`: the DTO's sign-in state of a matching record (never a token), else null; never rejects.
// - Pending flows are dropped on `key.rotated`, on the deletion of their server or project, and by `stop()`.
//
// Never passes a custom `fetch` to `auth()` (the AI SDK guards the OAuth URLs only with its own fetch) and adds the
// harness's own guard (`guard.ts`). Tokens, codes, code verifiers, client secrets, state values and authorization URL
// queries are registered with the redactor and never logged, answered or put into an error message; log lines carry the
// server id, the origin kind, the step, the outcome and the authorization server's host.
import type { McpAuthCallbackBody, McpAuthCallbackResult, McpAuthInfo, McpAuthStart, McpAuthTarget, McpServerStateAny, ServerEvent } from '@harness-forge/shared'
import type { SafeFetch } from '../../security/types.ts'
import type { AppDeps } from '../../types.ts'
import type { FlowEntry } from './flows.ts'
import type { ConnectContext, FlowState, ProviderContext } from './provider.ts'
import type { AuthServer } from './servers.ts'
import type { McpOAuthRecord, StoredClient } from './store.ts'
import type { McpAuthProviderMode, McpAuthService } from './types.ts'
import { randomBytes } from 'node:crypto'
import { auth, AuthorizationServerMismatchError, MCPClientOAuthError } from '@ai-sdk/mcp'
import { HarnessError, isHarnessError, LIMITS, MCP_SERVER_ID_PATTERN } from '@harness-forge/shared'
import { createSafeFetch, safeFetch } from '../../security/ssrf.ts'
import { errorMessage, isConnectionFailure } from '../errors.ts'
import { createFlowStore } from './flows.ts'
import { AUTHORIZATION_SERVER_REFUSED_MESSAGE, isMcpOAuthGuardError, withoutQuery } from './guard.ts'
import { probeMcpServer } from './probe.ts'
import { createCallbackProvider, createConnectProvider, createStartProvider, MCP_OAUTH_CALLBACK_PATH } from './provider.ts'
import { revokeTokens } from './revoke.ts'
import { createServerResolver, targetKey } from './servers.ts'
import { createTokenStore, normalizeResource, recordMatches, sameTokens, tokensOf } from './store.ts'
import { McpAuthRequired } from './types.ts'

export { CONNECT_REDIRECT_URI, MCP_OAUTH_CALLBACK_PATH, mcpOAuthClientMetadata } from './provider.ts'

/** Characters of a provider's text in an error message (the callback page shows it as plain text). */
export const PROVIDER_TEXT_MAX_CHARS = 300
/** The time budget of one `auth()` run (discovery, registration, exchange). */
export const MCP_OAUTH_AUTH_TIMEOUT_MS = 30_000
/** The message of a used, expired or unknown sign-in (409 `stale`). */
export const STALE_SIGN_IN_MESSAGE = 'This sign-in link was already used or expired.'

/** A pending sign-in (`flows.ts`). */
interface PendingFlow extends FlowEntry {
  readonly target: McpAuthTarget
  /** The origin of the start request (the callback must come from the same one). */
  readonly origin: string
  readonly returnTo: string | null
  readonly oauth: FlowState
  readonly resourceMetadataUrl?: URL
}

export interface McpAuthServiceOptions {
  /** Clock (epoch ms; default `Date.now`). */
  readonly now?: () => number
  /** Default `LIMITS.mcpOAuthFlowMs`. */
  readonly flowTtlMs?: number
  /** Default `LIMITS.mcpOAuthFlowsMax`. */
  readonly flowsMax?: number
  /** Default `MCP_OAUTH_PROBE_TIMEOUT_MS` (20 s). */
  readonly probeTimeoutMs?: number
  /** Default `MCP_OAUTH_AUTH_TIMEOUT_MS`. */
  readonly authTimeoutMs?: number
  /** Default 10 s. */
  readonly revokeTimeoutMs?: number
  /** The `safeFetch` of the revocation (default: `safeFetch`, with loopback allowed only for a loopback pair). */
  readonly revokeFetch?: (allowLoopback: boolean) => SafeFetch
}

function stale(): HarnessError {
  return new HarnessError({ code: 'conflict', message: STALE_SIGN_IN_MESSAGE, details: { reason: 'stale' } })
}

/** Plain text of at most `max` characters: control characters removed, whitespace collapsed. */
function plainText(text: string, max = PROVIDER_TEXT_MAX_CHARS): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    out += code < 0x20 || (code >= 0x7F && code <= 0x9F) ? ' ' : char
  }
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > max ? `${out.slice(0, max - 3)}...` : out
}

/** An origin (`scheme://host[:port]`) of an http(s) URL, else null. */
function originOf(value: string): string | null {
  if (!URL.canParse(value))
    return null
  const url = new URL(value)
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
}

function hostOf(value: string | undefined): string | null {
  if (value === undefined || !URL.canParse(value))
    return null
  return new URL(value).host
}

/** Races `work` against a timer (cleared either way). */
async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new HarnessError({ code: 'provider_unreachable', message, action: 'retry' })), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([work, timeout])
  }
  finally {
    clearTimeout(timer)
  }
}

/** The OAuth error code of an SDK OAuth error (`invalid_grant`, …), when it carries one. */
function oauthErrorCode(error: unknown): string | null {
  if (!MCPClientOAuthError.isInstance(error))
    return null
  const code = (error.constructor as { errorCode?: unknown }).errorCode
  return typeof code === 'string' ? code : null
}

export function createMcpAuthService(deps: AppDeps): McpAuthService {
  return createMcpAuthServiceCore(deps)
}

/** The service with test options (clock, flow limits, timeouts, the revocation's fetch). */
export function createMcpAuthServiceCore(deps: AppDeps, options: McpAuthServiceOptions = {}): McpAuthService {
  const now = options.now ?? Date.now
  const ttlMs = options.flowTtlMs ?? LIMITS.mcpOAuthFlowMs
  const authTimeoutMs = options.authTimeoutMs ?? MCP_OAUTH_AUTH_TIMEOUT_MS
  const log = deps.logger.child({ component: 'mcp-auth' })
  const store = createTokenStore({ secrets: deps.secrets, redactor: deps.redactor })
  const resolver = createServerResolver(deps)
  const shutdown = new AbortController()
  let subscription: Disposable | null = null
  let stopped = false
  const flows = createFlowStore<PendingFlow>({
    max: options.flowsMax,
    now,
    onRemoved: () => {
      if (flows.size() === 0)
        unsubscribe()
    },
  })
  const loopbackFetch = createSafeFetch({ allowLoopback: true })
  const revokeFetch = options.revokeFetch ?? ((allowLoopback: boolean) => (allowLoopback ? loopbackFetch : safeFetch))

  // ---------- helpers ----------

  function context(target: McpAuthTarget): ProviderContext {
    return { target, store, redactor: deps.redactor, logger: log, now }
  }

  function logFields(target: McpAuthTarget, kind: string, step: string, outcome: string, extra: Record<string, unknown> = {}) {
    return {
      serverId: target.serverId,
      ...(target.kind === 'project' ? { projectId: target.projectId } : {}),
      origin: kind,
      step,
      outcome,
      ...extra,
    }
  }

  /** Safe text of an error: redacted, URL queries removed, plain, capped. */
  function safeText(error: unknown): string {
    const text = deps.redactor.redactText(errorMessage(error)).replace(/https?:\/\/\S+/g, match => withoutQuery(match))
    return plainText(text)
  }

  /** The `HarnessError` of a failed start (API.md 5.37: 502 `provider_unreachable` / `provider_error`). */
  function startError(error: unknown, server: AuthServer): HarnessError {
    if (isHarnessError(error))
      return error
    if (isMcpOAuthGuardError(error))
      return new HarnessError({ code: 'provider_error', message: error.message })
    const message = error instanceof Error ? error.message : ''
    if (/\bnot allowed\b/i.test(message))
      return new HarnessError({ code: 'provider_error', message: AUTHORIZATION_SERVER_REFUSED_MESSAGE })
    if (AuthorizationServerMismatchError.isInstance(error))
      return new HarnessError({ code: 'provider_error', message: `The authorization server of "${server.name}" changed; sign in again later or check the server's address.` })
    if (isConnectionFailure(error))
      return new HarnessError({ code: 'provider_unreachable', message: `The authorization server of "${server.name}" is not reachable.`, action: 'retry' })
    return new HarnessError({ code: 'provider_error', message: plainText(`Signing in to "${server.name}" failed: ${safeText(error)}`) })
  }

  /** The `HarnessError` of a failed code exchange (502 `auth_invalid`, `details.target`). */
  function exchangeError(error: unknown, target: McpAuthTarget, name: string): HarnessError {
    if (isHarnessError(error) && error.code !== 'provider_unreachable')
      return error
    const code = oauthErrorCode(error)
    let message: string
    if (code === 'invalid_grant')
      message = `The authorization server refused the sign-in code of "${name}" (it may have expired). Try again.`
    else if (isMcpOAuthGuardError(error))
      message = error.message
    else if (isConnectionFailure(error) || isHarnessError(error))
      message = `The authorization server of "${name}" is not reachable. Try again.`
    else
      message = plainText(`The sign-in to "${name}" could not be completed: ${safeText(error)}`)
    return new HarnessError({ code: 'auth_invalid', message, details: { target } })
  }

  /** Reconnects the server after a sign-in change; answers its status (never rejects). */
  async function reconnect(target: McpAuthTarget): Promise<McpServerStateAny> {
    try {
      if (target.kind === 'global')
        return (await deps.mcp.reconnect(target.serverId)).status
      return (await deps.projectMcp.reconnect(target.projectId, target.serverId)).state
    }
    catch (error) {
      log.debug('MCP sign-in reconnect failed', { serverId: target.serverId, code: isHarnessError(error) ? error.code : 'error' })
      try {
        if (target.kind === 'global')
          return (await deps.mcp.get(target.serverId)).status
      }
      catch {}
      return 'error'
    }
  }

  /** The record of a finished flow (the tokens it obtained, its client and pin). */
  function recordOf(server: AuthServer, flow: FlowState): McpOAuthRecord | null {
    const tokens = flow.obtained
    if (tokens === undefined)
      return null
    const client: StoredClient | undefined = server.clientId !== null
      ? { info: { client_id: server.clientId }, dynamic: false, redirectUris: [flow.redirectUri] }
      : flow.client
    if (client === undefined)
      return null
    return {
      v: 1,
      resource: normalizeResource(server.url),
      clientId: client.info.client_id,
      client,
      ...(flow.as === undefined ? {} : { as: flow.as }),
      tokens,
    }
  }

  /** The flow of a start, seeded from a stored record when its client can be reused for this redirect URI. */
  function newFlow(server: AuthServer, redirectUri: string, record: McpOAuthRecord | null): FlowState {
    const state = randomBytes(32).toString('base64url')
    deps.redactor.addSecret(state)
    const flow: FlowState = { state, redirectUri, server }
    if (server.clientId !== null)
      flow.client = { info: { client_id: server.clientId }, dynamic: false, redirectUris: [redirectUri] }
    if (record === null)
      return flow
    const reusable = server.clientId !== null || (record.client?.dynamic === true && record.client.redirectUris.includes(redirectUri))
    if (!reusable)
      return flow
    if (server.clientId === null)
      flow.client = record.client
    if (record.as !== undefined)
      flow.as = record.as
    if (record.tokens !== undefined)
      flow.tokens = record.tokens
    return flow
  }

  // ---------- following deletions and key rotations while flows are pending ----------

  function unsubscribe(): void {
    subscription?.dispose()
    subscription = null
  }

  function ensureSubscribed(): void {
    if (subscription !== null || stopped)
      return
    subscription = deps.events.subscribe((event: ServerEvent) => {
      if (event.type === 'key.rotated') {
        flows.clear()
      }
      else if (event.type === 'project.changed' && event.data.project === null) {
        const projectId = event.data.id
        flows.dropWhere(flow => flow.target.kind === 'project' && flow.target.projectId === projectId)
      }
      else if (event.type === 'plugin.changed') {
        // A personal or plugin server that is gone (deleted, its plugin removed) takes its pending sign-in with it.
        flows.dropWhere(flow => flow.target.kind === 'global' && deps.registry.mcpServers.get(flow.target.serverId) === undefined && deps.mcp.authTarget(flow.target.serverId) === null)
      }
    })
  }

  // ---------- the service ----------

  async function start(target: McpAuthTarget, startOptions: { origin: string, returnTo: string | null }): Promise<McpAuthStart> {
    if (stopped)
      throw new HarnessError({ code: 'conflict', message: 'The server is shutting down.', details: { reason: 'busy' } })
    const origin = originOf(startOptions.origin)
    if (origin === null)
      throw new HarnessError({ code: 'validation_error', message: 'The sign-in needs the address of this app (the request has no usable Origin).' })
    const redirectUri = `${origin}${MCP_OAUTH_CALLBACK_PATH}`
    const server = await resolver.resolveSignInServer(target)
    const kind = server.storage.kind
    let probe
    try {
      probe = await probeMcpServer(server.type, server.url, server.headers, { ...(options.probeTimeoutMs === undefined ? {} : { timeoutMs: options.probeTimeoutMs }), signal: shutdown.signal })
    }
    catch (error) {
      log.info('MCP sign-in', logFields(target, kind, 'probe', 'unreachable'))
      throw new HarnessError({ code: 'provider_unreachable', message: plainText(`The MCP server "${server.name}" is not reachable: ${safeText(error)}`), action: 'retry' })
    }
    if (!probe.unauthorized && probe.status >= 200 && probe.status < 300) {
      // The server answers without credentials: nothing to sign in to; reconnect it.
      await reconnect(target)
      log.info('MCP sign-in', logFields(target, kind, 'start', 'not-needed'))
      return { authorizationUrl: null, redirectUri, expiresAt: now() }
    }
    const stored = await store.read(server.storage).catch(() => null)
    const usable = stored !== null && recordMatches(stored, server) ? stored : null
    const scope = server.scopes ?? probe.scope
    const run = async (record: McpOAuthRecord | null): Promise<{ flow: FlowState, result: 'AUTHORIZED' | 'REDIRECT' }> => {
      const flow = newFlow(server, redirectUri, record)
      const result = await withTimeout(auth(createStartProvider(context(target), flow), {
        serverUrl: server.url,
        ...(scope === undefined || scope === null || scope === '' ? {} : { scope }),
        ...(probe.resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl: probe.resourceMetadataUrl }),
      }), authTimeoutMs, `The authorization server of "${server.name}" did not answer in time.`)
      return { flow, result }
    }
    let outcome: { flow: FlowState, result: 'AUTHORIZED' | 'REDIRECT' }
    try {
      try {
        outcome = await run(usable)
      }
      catch (error) {
        // A stored client or pin of another authorization server: start over without the stored record.
        if (usable === null || isHarnessError(error) || isMcpOAuthGuardError(error) || !MCPClientOAuthError.isInstance(error))
          throw error
        outcome = await run(null)
      }
    }
    catch (error) {
      const mapped = startError(error, server)
      log.info('MCP sign-in', logFields(target, kind, 'start', 'failed', { code: mapped.code }))
      throw mapped
    }
    const { flow, result } = outcome
    if (result === 'AUTHORIZED') {
      // A stored refresh token worked: keep the new tokens and reconnect; no browser round trip.
      const record = recordOf(server, flow)
      if (record !== null)
        await store.write(server.storage, record)
      await reconnect(target)
      log.info('MCP sign-in', logFields(target, kind, 'start', 'authorized', { authorizationServer: hostOf(flow.as?.authorizationServerUrl) }))
      return { authorizationUrl: null, redirectUri, expiresAt: now() }
    }
    if (flow.tokensInvalidated === true && usable?.tokens !== undefined) {
      // The stored refresh token was refused: drop the dead tokens now (the new sign-in replaces the record anyway).
      const dead = tokensOf(usable.tokens)
      await store.update(server.storage, current => current?.tokens !== undefined && sameTokens(tokensOf(current.tokens), dead) ? (({ tokens: _tokens, ...rest }) => rest)(current) : undefined)
    }
    if (flow.authorizationUrl === undefined) {
      log.info('MCP sign-in', logFields(target, kind, 'start', 'failed'))
      throw new HarnessError({ code: 'provider_error', message: `The authorization server of "${server.name}" gave no authorization URL.` })
    }
    const expiresAt = now() + ttlMs
    flows.add({
      state: flow.state,
      key: targetKey(target),
      expiresAt,
      target,
      origin,
      returnTo: startOptions.returnTo,
      oauth: flow,
      ...(probe.resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl: probe.resourceMetadataUrl }),
    })
    ensureSubscribed()
    log.info('MCP sign-in', logFields(target, kind, 'start', 'redirect', { authorizationServer: hostOf(flow.authorizationUrl) }))
    return { authorizationUrl: flow.authorizationUrl, redirectUri, expiresAt }
  }

  async function complete(body: McpAuthCallbackBody, completeOptions: { origin: string }): Promise<McpAuthCallbackResult> {
    deps.redactor.addSecret(body.state)
    if (body.code !== undefined)
      deps.redactor.addSecret(body.code)
    const flow = flows.take(body.state)
    const origin = originOf(completeOptions.origin)
    if (flow === null || origin === null || flow.origin !== origin)
      throw stale()
    const { target } = flow
    const kind = flow.oauth.server.storage.kind
    const name = flow.oauth.server.name
    if (body.error !== undefined) {
      log.info('MCP sign-in', logFields(target, kind, 'callback', 'refused'))
      const description = body.errorDescription === undefined || body.errorDescription.trim() === '' ? '' : `: ${body.errorDescription}`
      const text = plainText(deps.redactor.redactText(`The authorization server refused the sign-in (${body.error}${description}).`))
      throw new HarnessError({ code: 'auth_invalid', message: text, details: { target } })
    }
    const issuer = flow.oauth.as?.issuer
    if (body.iss !== undefined && issuer !== undefined && body.iss !== issuer) {
      log.info('MCP sign-in', logFields(target, kind, 'callback', 'issuer-mismatch'))
      const message = 'The sign-in answer came from another authorization server.'
      throw new HarnessError({ code: 'validation_error', message, details: { issues: [{ path: ['iss'], message, code: 'custom' }], target } })
    }
    // The server must still be the one the sign-in started for (deleted, moved or changed → the link is stale).
    let server: AuthServer
    try {
      server = await resolver.resolveSignInServer(target)
    }
    catch (error) {
      if (isHarnessError(error) && error.code === 'not_found')
        throw stale()
      throw error
    }
    if (normalizeResource(server.url) !== normalizeResource(flow.oauth.server.url) || server.clientId !== flow.oauth.server.clientId)
      throw stale()
    const state: FlowState = { ...flow.oauth, server }
    try {
      await withTimeout(auth(createCallbackProvider(context(target), state), {
        serverUrl: server.url,
        authorizationCode: body.code as string,
        callbackState: body.state,
        ...(body.iss === undefined ? {} : { callbackIssuer: body.iss }),
        ...(flow.resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl: flow.resourceMetadataUrl }),
      }), authTimeoutMs, `The authorization server of "${name}" did not answer in time.`)
    }
    catch (error) {
      const mapped = exchangeError(error, target, name)
      log.info('MCP sign-in', logFields(target, kind, 'callback', 'failed', { code: mapped.code }))
      throw mapped
    }
    const record = recordOf(server, state)
    if (record === null) {
      log.info('MCP sign-in', logFields(target, kind, 'callback', 'failed'))
      throw new HarnessError({ code: 'auth_invalid', message: `The authorization server of "${name}" issued no tokens. Try again.`, details: { target } })
    }
    await store.write(server.storage, record)
    const status = await reconnect(target)
    log.info('MCP sign-in', logFields(target, kind, 'callback', 'signed-in', { status, authorizationServer: hostOf(state.as?.authorizationServerUrl) }))
    return { target, status, returnTo: flow.returnTo }
  }

  async function signOut(target: McpAuthTarget): Promise<void> {
    const found = await resolver.resolveSignOut(target)
    flows.dropKey(targetKey(target))
    const binding = await resolver.resolveBinding(target)
    let previous: McpOAuthRecord | null = null
    await store.update(found.storage, (current) => {
      previous = current
      return null
    })
    const record = previous as McpOAuthRecord | null
    log.info('MCP sign-in', logFields(target, found.storage.kind, 'sign-out', record === null ? 'no-record' : 'deleted'))
    const revocation = async (): Promise<void> => {
      if (record === null || record.tokens === undefined || record.as === undefined || found.url === null)
        return
      const client = binding !== null && binding.clientId !== null && binding.clientId === record.clientId
        ? { client_id: binding.clientId, ...(binding.clientSecret === null ? {} : { client_secret: binding.clientSecret }) }
        : record.client?.info ?? { client_id: record.clientId }
      const outcome = await revokeTokens(
        { mcpUrl: found.url, as: record.as, tokens: tokensOf(record.tokens), client },
        { fetchFor: revokeFetch, signal: shutdown.signal, ...(options.revokeTimeoutMs === undefined ? {} : { timeoutMs: options.revokeTimeoutMs }) },
      ).catch(() => 'failed' as const)
      log.debug('MCP sign-in revocation', logFields(target, found.storage.kind, 'revoke', outcome, { authorizationServer: hostOf(record.as.authorizationServerUrl) }))
    }
    await Promise.all([revocation(), reconnect(target)])
  }

  return {
    start,
    complete,
    signOut,

    provider: (target: McpAuthTarget, mode: McpAuthProviderMode) => {
      if (mode === 'connect') {
        const connect: ConnectContext = { ...context(target), resolve: () => resolver.resolveBinding(target) }
        return createConnectProvider(connect)
      }
      const flow = flows.byKey(targetKey(target))
      if (flow === null)
        throw new McpAuthRequired(target, 'No sign-in of this server is pending.')
      return mode === 'start' ? createStartProvider(context(target), flow.oauth) : createCallbackProvider(context(target), flow.oauth)
    },

    info: async (target): Promise<McpAuthInfo | null> => {
      try {
        if (!MCP_SERVER_ID_PATTERN.test(target.serverId))
          return null
        const server = await resolver.resolveBinding(target)
        if (server === null)
          return null
        const record = await store.read(server.storage)
        if (record === null || !recordMatches(record, server))
          return null
        const tokens = record.tokens
        const expiresAt = tokens?.expires_in === undefined ? null : Math.max(0, Math.round(tokens.obtainedAt + tokens.expires_in * 1000))
        const issuer = record.as?.issuer ?? tokens?.issuer ?? null
        return {
          signedIn: tokens !== undefined,
          expiresAt,
          scope: tokens?.scope === undefined ? null : tokens.scope.slice(0, 1024),
          client: record.client === undefined ? null : record.client.dynamic ? 'dynamic' : 'configured',
          issuer: issuer === null ? null : issuer.slice(0, 2048),
        }
      }
      catch {
        return null
      }
    },

    stop: async () => {
      if (stopped)
        return
      stopped = true
      shutdown.abort()
      flows.clear()
      unsubscribe()
    },
  }
}
