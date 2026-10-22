// MCP sign-in routes (API.md 5.37, ADR-059) - Phase 14 stubs (501). Owner: W14.1. Keep the export name
// `createMcpAuthRoutes`. Thin: validate, call the MCP auth service (`deps.mcpAuth`, `mcp/oauth/`), map the answer.
//
// - `POST /mcp/:id/oauth` (body `{ returnTo? }`): starts an OAuth sign-in for a personal or plugin http / sse server:
//   discovery (one unauthenticated probe reads `WWW-Authenticate`), dynamic client registration or the configured
//   client id, PKCE S256, `state`, `resource`, `redirect_uri = <request Origin>/oauth/callback`; answers
//   `{ authorizationUrl, redirectUri, expiresAt }` (`authorizationUrl: null` = the stored tokens still work and the
//   server reconnected). The pending flow lives in memory (one per server, at most 20, 10 min, single use; a new start
//   replaces it). `404` unknown server, `400` a stdio server or one with an `Authorization` header, `409` `disabled`.
// - `DELETE /mcp/:id/oauth`: signs out (deletes the stored record, best-effort RFC 7009 revoke through `safeFetch`);
//   answers the `McpServer` (status `needs-auth` when the server still asks for a sign-in).
// - `POST /projects/:id/mcp/:serverId/oauth` / `DELETE …`: the same for an approved project `.mcp.json` server (`409`
//   `untrusted` while it is pending, `404` unknown project or server); answers `McpAuthStart` / `ProjectMcpServer`.
// - `POST /mcp/oauth/callback` (session + Origin check, no fresh auth; posted by the SPA page `/oauth/callback`): body
//   `{ state, code | error, iss?, errorDescription? }`; exchanges the code once (the flow's verifier, client and
//   authorization server), stores the tokens and reconnects; answers `{ target, status, returnTo }`. An unknown, used or
//   expired `state` is `409` `stale`; an `error` from the authorization server or a failed exchange is `502`
//   `auth_invalid` with a safe message.
// - Never logs or answers a token, a code, a code verifier, a client secret or a state value.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import {
  apiRoutes,
  mcpAuthCallbackBodySchema,
  mcpAuthStartBodySchema,
  mcpServerParamsSchema,
  projectMcpServerParamsSchema,
} from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createMcpAuthRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  // The static callback path first (it never meets `/mcp/:id/oauth`: the third segments differ).
  app.post(apiRoutes['mcpAuth.callback'].path, validate('json', mcpAuthCallbackBodySchema), notImplemented('mcpAuth.callback'))
  app.post(apiRoutes['mcpAuth.start'].path, validate('param', mcpServerParamsSchema), validate('json', mcpAuthStartBodySchema), notImplemented('mcpAuth.start'))
  app.delete(apiRoutes['mcpAuth.signOut'].path, validate('param', mcpServerParamsSchema), notImplemented('mcpAuth.signOut'))
  app.post(apiRoutes['mcpAuth.projectStart'].path, validate('param', projectMcpServerParamsSchema), validate('json', mcpAuthStartBodySchema), notImplemented('mcpAuth.projectStart'))
  app.delete(apiRoutes['mcpAuth.projectSignOut'].path, validate('param', projectMcpServerParamsSchema), notImplemented('mcpAuth.projectSignOut'))
  return app
}
