// The `OAuthClientProvider` of an MCP server (Phase 14, ADR-059; W14.1-T2; ARCHITECTURE.md 6.39), in three modes:
//
// - **connect** (the MCP managers' transports: background connects, reconnects and the transport's own 401 handling):
//   the stored token record only, while it still matches the server (`recordMatches`); refreshed tokens are saved;
//   `clientInformation()` throws `McpAuthRequired` when no record is stored, so the background never registers a client;
//   `state()`, `redirectToAuthorization` and the code verifier members throw `McpAuthRequired`; a refused refresh
//   (`invalid_grant`) drops the tokens (`invalidateCredentials('tokens')`, compared by generation) and the next step
//   throws `McpAuthRequired`: the server becomes `needs-auth`. A guard refusal is `McpAuthRequired` too (never a retry).
// - **start** (`McpAuthService.start`, the user's click): works on a pending flow: a fresh `state`, the code verifier
//   and the authorization-server pin are kept on it; a configured client is answered without its secret until the
//   flow has a pin (a confidential client must be tied to its authorization server, `@ai-sdk/mcp` P:1379); a client is
//   registered dynamically when none is configured or reusable; the authorization URL is captured (http(s) only),
//   never followed by the server. Stored tokens with a refresh token are offered, so a working refresh answers
//   `AUTHORIZED` without a redirect.
// - **callback** (`McpAuthService.complete`): the flow's client (with the configured secret of a personal server), pin,
//   state and verifier; the issued tokens are kept on the flow (the service stores them).
//
// Every mode: `validateAuthorizationServerURL` and `validateResourceURL` from `guard.ts` (the SDK's own URL guard holds
// too: no custom `fetch` is ever passed); every token, code verifier, state and client secret is registered with the
// redactor. Values are never logged.
import type { OAuthAuthorizationServerInformation, OAuthClientInformation, OAuthClientMetadata, OAuthClientProvider, OAuthTokens } from '@ai-sdk/mcp'
import type { McpAuthTarget } from '@harness-forge/shared'
import type { Logger } from '../../logger.ts'
import type { Redactor } from '../../security/types.ts'
import type { AuthServer } from './servers.ts'
import type { McpOAuthRecord, StoredClient, StoredTokens, TokenStore } from './store.ts'
import type { McpAuthProviderMode } from './types.ts'
import { checkAuthorizationUrl, selectResourceUrl, validateAuthorizationServerUrl } from './guard.ts'
import { pickClientInfo, recordMatches, registerTokenSecrets, sameTokens, tokensOf } from './store.ts'
import { McpAuthRequired } from './types.ts'

/** The redirect path every sign-in comes back to (the SPA page; the full URI is `<request Origin>/oauth/callback`). */
export const MCP_OAUTH_CALLBACK_PATH = '/oauth/callback'

/**
 * The redirect URI of the connect mode, which never redirects (`redirectToAuthorization` throws): a loopback placeholder
 * so `clientMetadata` is valid wherever the SDK reads it before `clientInformation()`.
 */
export const CONNECT_REDIRECT_URI = `http://127.0.0.1${MCP_OAUTH_CALLBACK_PATH}`

/** The OAuth client metadata of the harness (a public client: PKCE, no client secret; dynamic registration uses it). */
export function mcpOAuthClientMetadata(redirectUri: string): OAuthClientMetadata {
  return {
    redirect_uris: [redirectUri],
    client_name: 'harness-forge',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }
}

/**
 * The OAuth state of one sign-in (start → callback). Mutable: the provider of the flow fills it. Lives only in memory
 * (`flows.ts`); its values are registered with the redactor and never logged.
 */
export interface FlowState {
  /** The random `state` of the authorization request. */
  readonly state: string
  /** `<origin>/oauth/callback`. */
  readonly redirectUri: string
  /** The server as resolved at the start (URL, configured client, scopes). */
  readonly server: AuthServer
  /** The OAuth client of the flow (configured, reused or registered). */
  client?: StoredClient
  /** The authorization server pin (saved by the SDK before the redirect). */
  as?: OAuthAuthorizationServerInformation
  /** Stored tokens offered for a refresh (start mode). */
  tokens?: StoredTokens
  /** Tokens the flow obtained (a refresh in start mode, the code exchange in callback mode). */
  obtained?: StoredTokens
  codeVerifier?: string
  /** The authorization URL the browser opens (start mode, `REDIRECT`). */
  authorizationUrl?: string
  /** The resource sent to the authorization server. */
  resource?: string
  /** The stored tokens were refused (`invalidateCredentials('tokens')`): the service drops them from the record. */
  tokensInvalidated?: boolean
}

export interface ProviderContext {
  readonly target: McpAuthTarget
  readonly store: TokenStore
  readonly redactor: Redactor
  readonly logger: Logger
  /** Clock (epoch ms). */
  readonly now: () => number
}

/** A connect-mode context: the server's binding is resolved lazily (once per provider: one per connection attempt). */
export interface ConnectContext extends ProviderContext {
  readonly resolve: () => Promise<AuthServer | null>
}

function stamp(tokens: OAuthTokens, now: number): StoredTokens {
  return { ...tokens, obtainedAt: now }
}

/** The client information the connect mode answers for a record, or undefined. */
function recordClient(record: McpOAuthRecord, server: AuthServer): OAuthClientInformation | undefined {
  if (server.clientId !== null)
    return server.clientSecret === null ? { client_id: server.clientId } : { client_id: server.clientId, client_secret: server.clientSecret }
  return record.client?.dynamic === true ? record.client.info : undefined
}

// ---------- connect ----------

/** The connect-mode provider of a server (see the module comment). */
export function createConnectProvider(context: ConnectContext): OAuthClientProvider {
  const { target, store, redactor } = context
  const required = (): never => {
    throw new McpAuthRequired(target)
  }
  let binding: Promise<AuthServer | null> | null = null
  const server = (): Promise<AuthServer | null> => {
    binding ??= context.resolve().catch(() => null)
    return binding
  }
  /** The record while it matches the server, with the server. */
  async function bound(): Promise<{ server: AuthServer, record: McpOAuthRecord } | null> {
    const resolved = await server()
    if (resolved === null)
      return null
    const record = await store.read(resolved.storage).catch(() => null)
    if (record === null || !recordMatches(record, resolved))
      return null
    if (resolved.clientSecret !== null)
      redactor.addSecret(resolved.clientSecret)
    return { server: resolved, record }
  }
  return {
    get redirectUrl() {
      return CONNECT_REDIRECT_URI
    },
    get clientMetadata() {
      return mcpOAuthClientMetadata(CONNECT_REDIRECT_URI)
    },
    tokens: async () => {
      const found = await bound()
      return found?.record.tokens === undefined ? undefined : tokensOf(found.record.tokens)
    },
    saveTokens: async (tokens) => {
      registerTokenSecrets(redactor, tokens)
      const resolved = await server()
      if (resolved === null)
        return
      // A refresh never resurrects a record that was deleted (a sign-out) or replaced (another client).
      await store.update(resolved.storage, current => current !== null && recordMatches(current, resolved) ? { ...current, tokens: stamp(tokens, context.now()) } : undefined)
      context.logger.info('MCP sign-in refreshed', { serverId: target.serverId, origin: resolved.storage.kind, step: 'refresh', outcome: 'saved' })
    },
    clientInformation: async () => {
      const found = await bound()
      const info = found === null ? undefined : recordClient(found.record, found.server)
      if (info === undefined)
        required()
      return info
    },
    isClientInformationDynamicallyRegistered: async () => (await bound())?.record.client?.dynamic === true,
    saveClientInformation: required,
    authorizationServerInformation: async () => (await bound())?.record.as,
    saveAuthorizationServerInformation: required,
    redirectToAuthorization: required,
    saveCodeVerifier: required,
    codeVerifier: required,
    state: required,
    storedState: () => undefined,
    invalidateCredentials: async (scope, invalidation) => {
      const resolved = await server()
      if (resolved === null || scope === 'verifier')
        return
      await store.update(resolved.storage, (current) => {
        if (current === null || !recordMatches(current, resolved))
          return undefined
        if (scope === 'all' || scope === 'client')
          return null
        // `tokens`: only the generation the SDK refused (a concurrent refresh keeps its new tokens).
        if (current.tokens === undefined || (invalidation !== undefined && !sameTokens(tokensOf(current.tokens), invalidation.tokens)))
          return undefined
        const { tokens: _dropped, ...rest } = current
        return rest
      })
      context.logger.info('MCP sign-in dropped', { serverId: target.serverId, origin: resolved.storage.kind, step: `invalidate-${scope}`, outcome: 'needs-auth' })
    },
    validateAuthorizationServerURL: (serverUrl, authorizationServerUrl) => {
      try {
        validateAuthorizationServerUrl(serverUrl, authorizationServerUrl)
      }
      catch {
        required()
      }
    },
    validateResourceURL: async (serverUrl, resource) => {
      let selected: URL
      try {
        selected = selectResourceUrl(serverUrl, resource)
      }
      catch {
        return required()
      }
      // Nothing stored that could authorize (no record or no tokens): stop before any more OAuth requests.
      const found = await bound()
      if (found?.record.tokens === undefined)
        required()
      return selected
    },
  }
}

// ---------- start ----------

/** The client information the start mode answers (see the module comment). */
function startClient(flow: FlowState): OAuthClientInformation | undefined {
  const { server } = flow
  if (server.clientId !== null) {
    const pinned = flow.as !== undefined || flow.tokens?.authorization_server !== undefined
    return pinned && server.clientSecret !== null ? { client_id: server.clientId, client_secret: server.clientSecret } : { client_id: server.clientId }
  }
  return flow.client?.dynamic === true ? flow.client.info : undefined
}

function sharedFlowMembers(context: ProviderContext, flow: FlowState) {
  const { redactor } = context
  return {
    get redirectUrl() {
      return flow.redirectUri
    },
    get clientMetadata() {
      return mcpOAuthClientMetadata(flow.redirectUri)
    },
    authorizationServerInformation: () => flow.as,
    saveAuthorizationServerInformation: (information: OAuthAuthorizationServerInformation) => {
      flow.as = { ...information }
    },
    saveCodeVerifier: (verifier: string) => {
      redactor.addSecret(verifier)
      flow.codeVerifier = verifier
    },
    codeVerifier: () => {
      if (flow.codeVerifier === undefined)
        throw new McpAuthRequired(context.target, 'The sign-in has no code verifier; start it again.')
      return flow.codeVerifier
    },
    state: () => flow.state,
    saveState: () => {},
    storedState: () => flow.state,
    validateAuthorizationServerURL: (serverUrl: string | URL, authorizationServerUrl: string | URL) => validateAuthorizationServerUrl(serverUrl, authorizationServerUrl),
    validateResourceURL: async (serverUrl: string | URL, resource?: string) => {
      const selected = selectResourceUrl(serverUrl, resource)
      flow.resource = selected.href
      return selected
    },
  }
}

/** The start-mode provider over a pending flow (see the module comment). */
export function createStartProvider(context: ProviderContext, flow: FlowState): OAuthClientProvider {
  const { redactor } = context
  redactor.addSecret(flow.state)
  return {
    ...sharedFlowMembers(context, flow),
    tokens: () => (flow.tokens === undefined ? undefined : tokensOf(flow.tokens)),
    saveTokens: (tokens) => {
      registerTokenSecrets(redactor, tokens)
      flow.obtained = stamp(tokens, context.now())
    },
    clientInformation: () => startClient(flow),
    isClientInformationDynamicallyRegistered: () => flow.server.clientId === null && flow.client?.dynamic === true,
    saveClientInformation: (information) => {
      const info = pickClientInfo(information)
      registerTokenSecrets(redactor, undefined, info.client_secret)
      flow.client = { info, dynamic: true, redirectUris: [flow.redirectUri] }
    },
    redirectToAuthorization: (authorizationUrl) => {
      flow.authorizationUrl = checkAuthorizationUrl(authorizationUrl)
    },
    invalidateCredentials: (scope) => {
      if (scope === 'all' || scope === 'client') {
        flow.client = undefined
        flow.as = undefined
      }
      if (scope === 'all' || scope === 'tokens') {
        flow.tokens = undefined
        flow.tokensInvalidated = true
      }
      if (scope === 'verifier')
        flow.codeVerifier = undefined
    },
  }
}

// ---------- callback ----------

/** The client information the callback mode answers: the flow's client (+ the configured secret of a personal server). */
function callbackClient(flow: FlowState): OAuthClientInformation | undefined {
  const { server } = flow
  if (server.clientId !== null)
    return server.clientSecret === null ? { client_id: server.clientId } : { client_id: server.clientId, client_secret: server.clientSecret }
  return flow.client?.info
}

/** The callback-mode provider over a taken flow (see the module comment). */
export function createCallbackProvider(context: ProviderContext, flow: FlowState): OAuthClientProvider {
  const { redactor } = context
  if (flow.server.clientSecret !== null)
    redactor.addSecret(flow.server.clientSecret)
  return {
    ...sharedFlowMembers(context, flow),
    tokens: () => undefined,
    saveTokens: (tokens) => {
      registerTokenSecrets(redactor, tokens)
      flow.obtained = stamp(tokens, context.now())
    },
    clientInformation: () => callbackClient(flow),
    isClientInformationDynamicallyRegistered: () => flow.server.clientId === null && flow.client?.dynamic === true,
    saveClientInformation: (information) => {
      const info = pickClientInfo(information)
      registerTokenSecrets(redactor, undefined, info.client_secret)
      flow.client = { info, dynamic: true, redirectUris: [flow.redirectUri] }
    },
    redirectToAuthorization: () => {
      throw new McpAuthRequired(context.target, 'The sign-in answer was refused; start the sign-in again.')
    },
    invalidateCredentials: () => {},
  }
}

/** The provider of a mode over a flow (start / callback) or a connect context. */
export function createModeProvider(mode: McpAuthProviderMode, context: ConnectContext, flow: FlowState | null): OAuthClientProvider {
  if (mode === 'connect')
    return createConnectProvider(context)
  if (flow === null)
    throw new McpAuthRequired(context.target, 'No sign-in of this server is pending.')
  return mode === 'start' ? createStartProvider(context, flow) : createCallbackProvider(context, flow)
}
