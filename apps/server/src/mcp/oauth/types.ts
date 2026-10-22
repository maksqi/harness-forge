import type { OAuthClientProvider } from '@ai-sdk/mcp'
// Frozen interface of MCP OAuth (Phase 14, ADR-059; API.md 4.36 / 5.37, ARCHITECTURE.md 6.39 / 10.14): the sign-in of
// remote MCP servers (Streamable HTTP / SSE) of every origin (personal servers, plugin and Claude Code plugin servers,
// approved project `.mcp.json` servers), the token records and the `OAuthClientProvider` the MCP transports use.
// Implementation: `createMcpAuthService(deps)` in `mcp/oauth/index.ts` (C50 stub: nothing is signed in, sign-in answers
// 501; W14.1 implements `provider.ts`, `store.ts`, `flows.ts`, `probe.ts`, `guard.ts`, `revoke.ts`). Consumers: the MCP
// managers (`mcp/index.ts`, `mcp/project.ts`: the connect-mode provider of http / sse transports without an
// `Authorization` header, the DTO decoration through `info`), the `mcpAuth` routes (start, signOut, projectStart,
// projectSignOut, callback) and shutdown (`stopDeps`: `stop()` after the MCP managers). Test double:
// `createFakeMcpAuthService` (`testing/fake-mcp-auth.ts`), installed with `createTestApp({ mcpAuth: 'fake' })`.
//
// Rules: tokens, codes, code verifiers, client secrets and `state` values live only in `SecretStore` (personal servers
// `mcp:<id>` names `oauth.record` / `oauth.clientSecret`; plugin servers `plugin:<pluginId>` and project servers
// `project:<projectId>` name `mcp-oauth.<serverId>`; see `McpAuthStorage`) and in the pending flows in memory; every
// value is registered with the redactor; none ever reaches a DTO, a log line, an error message, a backup or a message
// part. A sign-in starts only from the user's click (`start`): the connect mode never registers a client and never
// redirects (`McpAuthRequired`). Never pass a custom `fetch` to `auth()` or to an MCP transport (the AI SDK's OAuth URL
// guard holds only with its own fetch). Logs carry the server id, the origin kind, the step and the outcome only.
import type {
  McpAuthCallbackBody,
  McpAuthCallbackResult,
  McpAuthInfo,
  McpAuthStart,
  McpAuthTarget,
} from '@harness-forge/shared'

export type { McpAuthTarget } from '@harness-forge/shared'

/**
 * The three modes of a server's `OAuthClientProvider` (ADR-059):
 * - `connect`: background connects and reconnects (the transport's own 401 handling): the stored tokens only (refreshed
 *   tokens are saved); `clientInformation()` throws `McpAuthRequired` when no record is stored, so no client is ever
 *   registered in the background; `state()` and `redirectToAuthorization` throw `McpAuthRequired`.
 * - `start`: the user's sign-in (`McpAuthService.start`): a fresh `state` and code verifier on the pending flow, no
 *   `client_secret` on first use, the authorization URL captured instead of navigating.
 * - `callback`: the code exchange (`McpAuthService.complete`): the flow's client (with its secret for a personal server)
 *   and authorization-server pin.
 */
export type McpAuthProviderMode = 'connect' | 'start' | 'callback'

/**
 * Where the OAuth secrets of a server are stored (`McpManager.authTarget` / `ProjectMcpManager.authTarget`; ADR-059 token
 * storage): `kind` = the origin of the server, `scope` = its secret scope, `name` = the secret name of its token record.
 * - `user` (a personal server of `mcp_servers`): scope `mcp:<serverId>`, name `oauth.record` (the client secret is
 *   `oauth.clientSecret` of the same scope);
 * - `plugin` (a plugin or Claude Code plugin declaration): scope `plugin:<pluginId>`, name `mcp-oauth.<serverId>`;
 * - `project` (a project `.mcp.json` server): scope `project:<projectId>`, name `mcp-oauth.<serverId>`.
 * Plugin code cannot read these names (`ctx.secrets` is limited to its own `settings.*` / plain names).
 */
export interface McpAuthStorage {
  readonly kind: 'user' | 'plugin' | 'project'
  readonly scope: string
  readonly name: string
}

/** Options of `McpAuthService.start`. */
export interface McpAuthStartOptions {
  /**
   * The request's `Origin` (already accepted by the origin check): the redirect URI is `<origin>/oauth/callback`, which
   * the browser comes back to (there is no public-URL setting).
   */
  readonly origin: string
  /** The checked in-app path the callback page navigates to afterwards (`isSafeReturnTo`); null = the default page. */
  readonly returnTo: string | null
}

/** Options of `McpAuthService.complete`. */
export interface McpAuthCompleteOptions {
  /** The request's `Origin`: it must give the flow's redirect URI (`<origin>/oauth/callback`), else 409 `stale`. */
  readonly origin: string
}

/**
 * Thrown by the connect-mode provider when a server needs a sign-in (no token record, or the stored one cannot be used)
 * and by `start` / the DTO paths that need one; the MCP managers classify it (with `UnauthorizedError` of `@ai-sdk/mcp`
 * and an HTTP 401) as the permanent error `auth_invalid { status: 401 }`: status `needs-auth`, no backoff retry, the
 * server's tools unavailable, nothing prompts. The message never holds a token or a URL query.
 */
export class McpAuthRequired extends Error {
  override readonly name = 'McpAuthRequired'
  /** The server, when the thrower knows it. */
  readonly target: McpAuthTarget | null

  constructor(target: McpAuthTarget | null = null, message = 'The MCP server needs a sign-in.') {
    super(message)
    this.target = target
  }
}

/** True for `McpAuthRequired` (also across module copies: checked by name). */
export function isMcpAuthRequired(error: unknown): error is McpAuthRequired {
  return error instanceof McpAuthRequired || (error instanceof Error && error.name === 'McpAuthRequired')
}

/**
 * `deps.mcpAuth`: OAuth sign-ins of remote MCP servers. Errors are `HarnessError`s the routes pass through (API.md 2 /
 * 5.37). Lazy: no boot step; `stop()` runs after the MCP managers closed (the pending flows dropped).
 */
export interface McpAuthService {
  /**
   * `POST /mcp/:id/oauth` and `POST /projects/:id/mcp/:serverId/oauth`: probes the server (one unauthenticated
   * `initialize` POST reading `WWW-Authenticate`), runs `auth()` with the `start` provider (discovery, dynamic client
   * registration or the configured client id, PKCE S256, `resource`, `state`) and keeps a pending flow (memory only, one
   * per server — a new start replaces the old one —, at most `LIMITS.mcpOAuthFlowsMax`, `LIMITS.mcpOAuthFlowMs`, single
   * use). Answers `{ authorizationUrl, redirectUri, expiresAt }`; `authorizationUrl: null` = the stored tokens work (or
   * were refreshed) and the server reconnected. Throws `not_found` (unknown server or project), `validation_error` (a
   * stdio server, a server with an `Authorization` header, an authorization server the guard refuses, no OAuth metadata),
   * `conflict` `disabled` (a disabled server; every project server in safe mode) and `untrusted` (a pending project
   * server).
   */
  readonly start: (target: McpAuthTarget, options: McpAuthStartOptions) => Promise<McpAuthStart>
  /**
   * `POST /mcp/oauth/callback` (body validated by the route with `mcpAuthCallbackBodySchema`): takes the flow by `state`
   * (single use), exchanges the code with the `callback` provider (issuer checked), stores the token record (redactor
   * registered) and reconnects the server. Answers `{ target, status, returnTo }`. Throws `conflict` `stale` for an
   * unknown, used or expired `state` (or another origin); an authorization-server `error` or a failed exchange is a
   * `provider_error` whose message carries the provider's description as plain text (capped) and whose details name the
   * target.
   */
  readonly complete: (body: McpAuthCallbackBody, options: McpAuthCompleteOptions) => Promise<McpAuthCallbackResult>
  /**
   * `DELETE /mcp/:id/oauth` and `DELETE /projects/:id/mcp/:serverId/oauth`: deletes the token record (a personal server's
   * client secret stays configured), drops a pending flow of the server, makes a best-effort RFC 7009 revocation through
   * `safeFetch` POST (a failure is logged at `debug` only) and reconnects the server without tokens (`needs-auth`).
   * Idempotent for a server without a record. Throws `not_found` (unknown server or project), `validation_error` (stdio).
   */
  readonly signOut: (target: McpAuthTarget) => Promise<void>
  /**
   * The `OAuthClientProvider` of one server (see `McpAuthProviderMode`). Synchronous (the transports are built
   * synchronously); its methods read and write the token record lazily. The MCP managers use `connect` only; `start` and
   * `callback` belong to this service's own flows.
   */
  readonly provider: (target: McpAuthTarget, mode: McpAuthProviderMode) => OAuthClientProvider
  /**
   * The sign-in state of a server for its DTO (`McpServer.auth`, `ProjectMcpServer.auth`): null when the server has no
   * token record and never asked for a sign-in (stdio, a server with an `Authorization` header, a server without OAuth).
   * Never a token. Never rejects (an unreadable record answers null).
   */
  readonly info: (target: McpAuthTarget) => Promise<McpAuthInfo | null>
  /** Shutdown (after the MCP managers): drops every pending flow and its timers. Idempotent; never rejects. */
  readonly stop: () => Promise<void>
}
