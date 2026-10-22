import type { OAuthClientProvider, OAuthTokens } from '@ai-sdk/mcp'
// Test double of `McpAuthService` (Phase 14, C50-T6), so the MCP managers' seams (the connect-mode provider, the DTO
// decoration), the `mcpAuth` routes and the web contract can be tested without an authorization server:
//
//   const t = await createTestApp({ mcpAuth: 'fake' })       // or overrides: { mcpAuth: createFakeMcpAuthService() }
//   const fake = t.deps.mcpAuth as FakeMcpAuthService
//   fake.infos.set(mcpAuthTargetKey({ kind: 'global', serverId: 'docs' }), fakeMcpAuthInfo())
//   const start = await fake.start({ kind: 'global', serverId: 'docs' }, { origin: 'http://127.0.0.1:8787', returnTo: null })
//   await fake.complete({ state: fake.flows.keys().next().value!, code: 'code' }, { origin: 'http://127.0.0.1:8787' })
//
// `info` answers the scripted entry of the target (`infos`, keyed by `mcpAuthTargetKey`; else null). `start` records the
// call, refuses a scripted error (`startErrors`), keeps a pending flow under a fresh `state` (one per target: a new start
// replaces the old one) and answers `{ authorizationUrl: <FAKE_AUTHORIZATION_URL>?state=…, redirectUri:
// <origin>/oauth/callback, expiresAt }`, or `authorizationUrl: null` when the target already has tokens (`tokens`).
// `complete` records the call (the state and whether a code or an error came, never the code), takes the flow by state
// (unknown, used, expired or another origin → 409 `stale`), answers `provider_error` for an `error` body, else stores
// fake tokens and a signed-in info and answers `{ target, status: 'connected', returnTo }`. `signOut` records the call
// and drops the tokens and the info. `provider(target, mode)` records the call; its `tokens()` answer the target's
// `tokens` entry (else undefined), `clientInformation()` answers a fake client when tokens exist and otherwise throws
// `McpAuthRequired` (like the connect mode of the real service); every redirect member throws `McpAuthRequired`.
// `stop` drops the flows. Every call is counted.
import type { McpAuthCallbackBody, McpAuthInfo, McpAuthStart, McpAuthTarget } from '@harness-forge/shared'
import type { McpAuthProviderMode, McpAuthService, McpAuthStartOptions } from '../mcp/oauth/types.ts'
import { HarnessError, LIMITS } from '@harness-forge/shared'
import { MCP_OAUTH_CALLBACK_PATH, mcpOAuthClientMetadata } from '../mcp/oauth/index.ts'
import { McpAuthRequired } from '../mcp/oauth/types.ts'

/** The authorize endpoint of the fake (never contacted: `.invalid`). */
export const FAKE_AUTHORIZATION_URL = 'https://auth.example.invalid/authorize'

/** The access token the fake stores after a `complete` (a test value, never a real token). */
export const FAKE_ACCESS_TOKEN = 'fake-access-token-0000'

/** The map key of a target: `global:<serverId>` or `project:<projectId>:<serverId>`. */
export function mcpAuthTargetKey(target: McpAuthTarget): string {
  return target.kind === 'global' ? `global:${target.serverId}` : `project:${target.projectId}:${target.serverId}`
}

/** A signed-in `McpAuthInfo` (a dynamic client, no expiry), then `fields`. */
export function fakeMcpAuthInfo(fields: Partial<McpAuthInfo> = {}): McpAuthInfo {
  return { signedIn: true, expiresAt: null, scope: null, client: 'dynamic', issuer: 'https://auth.example.invalid', ...fields }
}

/** A recorded `start`. */
export interface FakeMcpAuthStart {
  readonly target: McpAuthTarget
  readonly origin: string
  readonly returnTo: string | null
}

/** A recorded `complete` (never the code). */
export interface FakeMcpAuthComplete {
  readonly state: string
  readonly code: boolean
  readonly error: string | null
  readonly origin: string
}

/** A recorded `provider` call. */
export interface FakeMcpAuthProviderCall {
  readonly target: McpAuthTarget
  readonly mode: McpAuthProviderMode
}

/** A pending flow of the fake. */
export interface FakeMcpAuthFlow {
  readonly target: McpAuthTarget
  readonly origin: string
  readonly returnTo: string | null
  readonly expiresAt: number
}

export interface FakeMcpAuthServiceOptions {
  /** `info` answers keyed by `mcpAuthTargetKey`. */
  infos?: Readonly<Record<string, McpAuthInfo | null>>
  /** Stored tokens keyed by `mcpAuthTargetKey` (the connect provider answers them; `start` answers `authorizationUrl: null`). */
  tokens?: Readonly<Record<string, OAuthTokens>>
  /** Clock (epoch ms; default `Date.now`). */
  now?: () => number
}

export interface FakeMcpAuthService extends McpAuthService {
  /** `info` answers by `mcpAuthTargetKey`; tests may edit them. */
  readonly infos: Map<string, McpAuthInfo | null>
  /** Stored tokens by `mcpAuthTargetKey`; tests may edit them. */
  readonly tokens: Map<string, OAuthTokens>
  /** Errors `start` throws by `mcpAuthTargetKey` (400 / 409 cases of the real service); tests may edit them. */
  readonly startErrors: Map<string, HarnessError>
  /** The pending flows by `state`. */
  readonly flows: Map<string, FakeMcpAuthFlow>
  /** Every `start`, in order. */
  readonly starts: FakeMcpAuthStart[]
  /** Every `complete`, in order (the code is never recorded). */
  readonly completes: FakeMcpAuthComplete[]
  /** Every `signOut` target, in order. */
  readonly signOuts: McpAuthTarget[]
  /** Every `provider` call, in order. */
  readonly providers: FakeMcpAuthProviderCall[]
  /** Number of calls of each member. */
  readonly calls: Record<keyof McpAuthService, number>
}

function stale(): HarnessError {
  return new HarnessError({ code: 'conflict', message: 'This sign-in link was already used or expired.', details: { reason: 'stale' } })
}

export function createFakeMcpAuthService(options: FakeMcpAuthServiceOptions = {}): FakeMcpAuthService {
  const now = options.now ?? Date.now
  const infos = new Map(Object.entries(options.infos ?? {}))
  const tokens = new Map(Object.entries(options.tokens ?? {}))
  const startErrors = new Map<string, HarnessError>()
  const flows = new Map<string, FakeMcpAuthFlow>()
  const starts: FakeMcpAuthStart[] = []
  const completes: FakeMcpAuthComplete[] = []
  const signOuts: McpAuthTarget[] = []
  const providers: FakeMcpAuthProviderCall[] = []
  const calls: Record<keyof McpAuthService, number> = { start: 0, complete: 0, signOut: 0, provider: 0, info: 0, stop: 0 }
  let sequence = 0

  function provider(target: McpAuthTarget): OAuthClientProvider {
    const key = mcpAuthTargetKey(target)
    const required = (): never => {
      throw new McpAuthRequired(target)
    }
    const redirectUri = `http://127.0.0.1${MCP_OAUTH_CALLBACK_PATH}`
    return {
      get redirectUrl() {
        return redirectUri
      },
      get clientMetadata() {
        return mcpOAuthClientMetadata(redirectUri)
      },
      tokens: () => tokens.get(key),
      saveTokens: (value) => {
        tokens.set(key, value)
      },
      clientInformation: () => (tokens.has(key) ? { client_id: 'fake-client' } : required()),
      redirectToAuthorization: required,
      saveCodeVerifier: required,
      codeVerifier: required,
      state: required,
    }
  }

  return {
    infos,
    tokens,
    startErrors,
    flows,
    starts,
    completes,
    signOuts,
    providers,
    calls,
    start: async (target: McpAuthTarget, startOptions: McpAuthStartOptions): Promise<McpAuthStart> => {
      calls.start += 1
      starts.push({ target, origin: startOptions.origin, returnTo: startOptions.returnTo })
      const key = mcpAuthTargetKey(target)
      const error = startErrors.get(key)
      if (error !== undefined)
        throw error
      const redirectUri = `${startOptions.origin}${MCP_OAUTH_CALLBACK_PATH}`
      if (tokens.has(key))
        return { authorizationUrl: null, redirectUri, expiresAt: now() }
      for (const [state, flow] of flows) {
        if (mcpAuthTargetKey(flow.target) === key)
          flows.delete(state)
      }
      sequence += 1
      const state = `fake-state-${String(sequence).padStart(8, '0')}`
      const expiresAt = now() + LIMITS.mcpOAuthFlowMs
      flows.set(state, { target, origin: startOptions.origin, returnTo: startOptions.returnTo, expiresAt })
      const url = new URL(FAKE_AUTHORIZATION_URL)
      url.searchParams.set('state', state)
      url.searchParams.set('redirect_uri', redirectUri)
      return { authorizationUrl: url.href, redirectUri, expiresAt }
    },
    complete: async (body: McpAuthCallbackBody, completeOptions) => {
      calls.complete += 1
      completes.push({ state: body.state, code: body.code !== undefined, error: body.error ?? null, origin: completeOptions.origin })
      const flow = flows.get(body.state)
      flows.delete(body.state)
      if (flow === undefined || flow.expiresAt <= now() || flow.origin !== completeOptions.origin)
        throw stale()
      if (body.error !== undefined) {
        throw new HarnessError({
          code: 'provider_error',
          message: `The sign-in failed: ${body.errorDescription ?? body.error}`,
          details: { target: flow.target },
        })
      }
      const key = mcpAuthTargetKey(flow.target)
      tokens.set(key, { access_token: FAKE_ACCESS_TOKEN, token_type: 'Bearer' })
      infos.set(key, fakeMcpAuthInfo())
      return { target: flow.target, status: 'connected', returnTo: flow.returnTo }
    },
    signOut: async (target) => {
      calls.signOut += 1
      signOuts.push(target)
      const key = mcpAuthTargetKey(target)
      tokens.delete(key)
      infos.delete(key)
      for (const [state, flow] of flows) {
        if (mcpAuthTargetKey(flow.target) === key)
          flows.delete(state)
      }
    },
    provider: (target, mode) => {
      calls.provider += 1
      providers.push({ target, mode })
      return provider(target)
    },
    info: async (target) => {
      calls.info += 1
      return infos.get(mcpAuthTargetKey(target)) ?? null
    },
    stop: async () => {
      calls.stop += 1
      flows.clear()
    },
  }
}
