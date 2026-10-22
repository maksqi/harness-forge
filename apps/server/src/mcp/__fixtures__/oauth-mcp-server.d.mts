// Types of the OAuth MCP fixture (`oauth-mcp-server.mjs`; Phase 14, C53-T3, FROZEN after Gate P14-0b). The module
// comment of the `.mjs` file is the reference for the endpoints, tools, prompts, resources, counters and toggles.
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'

export declare const FIXTURE_SERVER_NAME: 'oauth-fixture'
export declare const FIXTURE_CLIENT_ID: 'fixture-client'
/** The optional secret of `fixture-client` (the other pre-registered clients are public). */
export declare const FIXTURE_CLIENT_SECRET: 'fixture-secret'
/** The pre-registered public client ids without a `clients` option: `fixture-client`, `seed-client`, `seed-plugin-client`. */
export declare const DEFAULT_PRE_REGISTERED_CLIENTS: readonly string[]
export declare const FIXTURE_SCOPE: 'mcp:read mcp:write'
export declare const FIXTURE_SUBJECT: 'fixture-user'
export declare const FIXTURE_MCP_PATH: '/mcp'
export declare const FIXTURE_PROTOCOL_2026: '2026-07-28'
export declare const DEFAULT_TOKEN_LIFE_SEC: number
/** Life of an authorization code. */
export declare const CODE_LIFE_MS: number
/** The wait of `slow_ask` before it asks. */
export declare const SLOW_ASK_DELAY_MS: number
/** The server-side timeout of an `elicitation/create` request (10 minutes). */
export declare const ELICITATION_TIMEOUT_MS: number
/** The size of `fixture://notes/large.txt` (6 MiB). */
export declare const LARGE_RESOURCE_BYTES: number

export declare const README_URI: 'fixture://notes/readme.md'
export declare const LARGE_URI: 'fixture://notes/large.txt'
export declare const PIXEL_URI: 'fixture://images/pixel.png'
/** Listed by the stdio variant after the first `__touch`. */
export declare const TOUCHED_URI: 'fixture://notes/touched.md'
export declare const README_TEXT: string
/** A 1x1 PNG, base64. */
export declare const PIXEL_PNG_BASE64: string
/** The URL of the `url` form (a URL-mode elicitation request). */
export declare const URL_ELICITATION_URL: string

export type FixtureCounterName
  = | 'connects'
    | 'discovers'
    | 'unauthorized'
    | 'registrations'
    | 'authorizations'
    | 'tokens'
    | 'refreshes'
    | 'revocations'
    | 'promptsGet'
    | 'resourcesRead'
    | 'elicitations'
    | 'toolCalls'

export type FixtureCounters = Record<FixtureCounterName, number>

export declare const COUNTER_NAMES: readonly FixtureCounterName[]

export interface FixtureToggles {
  /** No dynamic registration (no registration endpoint): only the pre-registered clients sign in. */
  preRegistered: boolean
  /** The authorization server named by the protected-resource metadata (null = this origin). */
  foreignAs: string | null
  /** 401 without `resource_metadata`; no well-known documents. */
  noMetadata: boolean
  /** Life of new access tokens in seconds (default 3600). */
  tokenLifeSec: number
  /** An HTML page with Approve / Deny buttons instead of the auto-approval. */
  approvePage: boolean
  /** `/mcp` answers without a token. */
  noAuth: boolean
  /** Negotiates protocol `2026-07-28` through `server/discover`. */
  protocol2026: boolean
}

export type FixtureToggleName = keyof FixtureToggles

export declare const TOGGLE_NAMES: readonly FixtureToggleName[]

export type FixtureFormName = 'basic' | 'all-types' | 'sensitive' | 'multi' | 'unsupported' | 'url'

/** The `params` of an `elicitation/create` request: a form (`requestedSchema`) or a URL-mode request. */
export type FixtureElicitationParams
  = | { message: string, requestedSchema: Record<string, unknown> }
    | { mode: 'url', message: string, url: string, elicitationId: string, requestedSchema: Record<string, unknown> }

export declare const ELICITATION_FORMS: Readonly<Record<FixtureFormName, FixtureElicitationParams>>
export declare const ELICITATION_FORM_NAMES: readonly FixtureFormName[]

export interface FixtureToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean }
}

export interface FixturePromptDefinition {
  name: string
  title?: string
  description: string
  arguments?: Array<{ name: string, description: string, required: boolean }>
}

export interface FixtureResourceDefinition {
  uri: string
  name: string
  title: string
  description: string
  mimeType: string
  size?: number
}

export interface FixtureResourceTemplateDefinition {
  uriTemplate: string
  name: string
  title: string
  description: string
  mimeType: string
}

/** `ask`, `ask_echo`, `slow_ask`, `whoami` (the stdio variant adds `__touch`). */
export declare const FIXTURE_TOOLS: readonly FixtureToolDefinition[]
/** `greet`, `review`, `with_resource`, `with_image`. */
export declare const FIXTURE_PROMPTS: readonly FixturePromptDefinition[]
export declare const FIXTURE_RESOURCES: readonly FixtureResourceDefinition[]
export declare const FIXTURE_RESOURCE_TEMPLATES: readonly FixtureResourceTemplateDefinition[]

export interface FixtureState {
  counters: FixtureCounters
  touches: number
}

/** The SDK server of the stdio variant (`stdio: true`) or of one HTTP session (not connected). */
export declare function createFixtureMcpServer(options?: { name?: string, stdio?: boolean, state?: FixtureState }): Server

export interface OAuthMcpServerOptions {
  /** Default 0 (a free port). */
  port?: number
  /** A loopback host: `127.0.0.1` (default), `::1` or `localhost`. */
  host?: string
  /** The MCP `serverInfo` name (default `oauth-fixture`). */
  name?: string
  /**
   * The pre-registered public client ids (default `DEFAULT_PRE_REGISTERED_CLIENTS`): any http(s) redirect URI, no
   * secret, PKCE required; `fixture-client` also accepts the secret `fixture-secret`.
   */
  clients?: readonly string[]
  toggles?: Partial<FixtureToggles>
}

export interface IssuedFixtureToken {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

export interface OAuthMcpServer {
  /** `<origin>/mcp`. */
  readonly url: string
  /** `http://<host>:<port>` (the issuer). */
  readonly origin: string
  readonly port: number
  counters: () => FixtureCounters
  resetCounters: () => void
  toggles: () => FixtureToggles
  /** Throws for an unknown name or an invalid value. */
  setToggle: <K extends FixtureToggleName>(name: K, value: FixtureToggles[K]) => void
  /** A valid token pair without the browser flow (default client `fixture-client`; an unknown id is pre-registered). */
  issueToken: (options?: { clientId?: string, scope?: string }) => IssuedFixtureToken
  /** Revokes every access and refresh token (a later refresh answers `invalid_grant`). */
  revokeAll: () => void
  /** Closes every MCP session and the HTTP server. */
  stop: () => Promise<void>
}

export declare function startOAuthMcpServer(options?: OAuthMcpServerOptions): Promise<OAuthMcpServer>
