// MCP OAuth (Phase 14, ADR-059; ARCHITECTURE.md 6.39) behind `McpAuthService` (./types.ts). Owner: W14.1 (C50 landed
// this stub with the final factory signature).
//
// The stub signs nobody in, so every server behaves as before Phase 14:
// - `info` answers null (no DTO shows a sign-in);
// - `provider(target, 'connect')` is a provider without tokens (no `Authorization` header is ever added) whose
//   `clientInformation()` throws `McpAuthRequired`, so a server that answers 401 is classified `needs-auth` by the MCP
//   managers and no client is ever registered in the background; `state()`, `redirectToAuthorization` and the code
//   verifier members throw `McpAuthRequired` too; a server that never answers 401 never reaches them;
// - `provider(target, 'start' | 'callback')`, `start`, `complete` and `signOut` throw `not_implemented` (501);
// - `stop` is a no-op (no flows).
import type { OAuthClientMetadata, OAuthClientProvider } from '@ai-sdk/mcp'
import type { AppDeps } from '../../types.ts'
import type { McpAuthProviderMode, McpAuthService, McpAuthTarget } from './types.ts'
import { noopAsync, notImplementedError } from '../../not-implemented.ts'
import { McpAuthRequired } from './types.ts'

/** The redirect path every sign-in comes back to (the SPA page; the full URI is `<request Origin>/oauth/callback`). */
export const MCP_OAUTH_CALLBACK_PATH = '/oauth/callback'

/**
 * The redirect URI of the connect mode, which never redirects (`redirectToAuthorization` throws): a loopback placeholder
 * so `clientMetadata` is valid wherever the SDK reads it before `clientInformation()`.
 */
const CONNECT_REDIRECT_URI = `http://127.0.0.1${MCP_OAUTH_CALLBACK_PATH}`

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

/** The stub's connect-mode provider: no tokens; anything that would need a client or a redirect throws `McpAuthRequired`. */
function connectProvider(target: McpAuthTarget): OAuthClientProvider {
  const required = (): never => {
    throw new McpAuthRequired(target)
  }
  return {
    get redirectUrl() {
      return CONNECT_REDIRECT_URI
    },
    get clientMetadata() {
      return mcpOAuthClientMetadata(CONNECT_REDIRECT_URI)
    },
    tokens: () => undefined,
    // Nothing is stored by the stub (no tokens are ever issued to it).
    saveTokens: () => {},
    clientInformation: required,
    redirectToAuthorization: required,
    saveCodeVerifier: required,
    codeVerifier: required,
    state: required,
  }
}

export function createMcpAuthService(_deps: AppDeps): McpAuthService {
  return {
    start: async () => {
      throw notImplementedError('MCP sign-in')
    },
    complete: async () => {
      throw notImplementedError('The MCP sign-in callback')
    },
    signOut: async () => {
      throw notImplementedError('MCP sign-out')
    },
    provider: (target: McpAuthTarget, mode: McpAuthProviderMode) => {
      if (mode !== 'connect')
        throw notImplementedError(`The MCP OAuth ${mode} provider`)
      return connectProvider(target)
    },
    info: async () => null,
    stop: noopAsync,
  }
}
