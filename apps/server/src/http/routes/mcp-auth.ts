// MCP sign-in routes (API.md 5.37, ADR-059; W14.1-T6). Thin: validate, call the MCP auth service (`deps.mcpAuth`,
// `mcp/oauth/`), map the answer. Every route needs a session and passes the Origin check (no fresh auth; none is
// public).
//
// - `POST /mcp/:id/oauth` (body `{ returnTo? }`): starts an OAuth sign-in for a personal or plugin http / sse server:
//   discovery (one unauthenticated probe reads `WWW-Authenticate`), dynamic client registration or the configured
//   client id, PKCE S256, `state`, `resource`, `redirect_uri = <request Origin>/oauth/callback` (the Origin already
//   passed the origin check; without an Origin header the server's own origin); answers `{ authorizationUrl,
//   redirectUri, expiresAt }` (`authorizationUrl: null` = the stored tokens still work and the server reconnected).
//   `404` unknown server, `400` a stdio server or one with an `Authorization` header, `409` `disabled`, `502` when the
//   discovery or the registration fails or the authorization server is refused.
// - `DELETE /mcp/:id/oauth`: signs out (deletes the stored record, best-effort RFC 7009 revoke through `safeFetch`);
//   answers the `McpServer` (status `needs-auth` when the server still asks for a sign-in).
// - `POST /projects/:id/mcp/:serverId/oauth` / `DELETE …`: the same for an approved project `.mcp.json` server (`409`
//   `untrusted` while it is pending, `disabled` in safe mode, `404` unknown project or server); answers `McpAuthStart` /
//   `ProjectMcpServer`.
// - `POST /mcp/oauth/callback` (posted by the SPA page `/oauth/callback`): body `{ state, code | error, iss?,
//   errorDescription? }`; exchanges the code once and reconnects; answers `{ target, status, returnTo }`. An unknown,
//   used or expired `state` is `409` `stale`; an `error` from the authorization server or a failed exchange is `502`
//   `auth_invalid` (the provider's text as plain text, `details.target`); an `iss` of another server `400`.
// - Never logs or answers a token, a code, a code verifier, a client secret or a state value.
import type { McpServer, ProjectMcpServer } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { AppContext, AppEnv } from '../types.ts'
import {
  apiRoutes,
  HarnessError,
  mcpAuthCallbackBodySchema,
  mcpAuthStartBodySchema,
  mcpServerParamsSchema,
  projectMcpServerParamsSchema,
} from '@harness-forge/shared'
import { Hono } from 'hono'
import { normalizeOrigin, serverOrigin } from '../middleware/request-info.ts'
import { validate } from '../validate.ts'
import { presentMcpServer } from './mcp.ts'

/**
 * The origin the browser uses for this app: the request's `Origin` (it passed the origin check), else the server's
 * own origin (`Host`, the trusted proxy scheme). The redirect URI of a sign-in is `<origin>/oauth/callback`.
 */
export function requestAppOrigin(c: AppContext, deps: AppDeps): string {
  const header = c.req.header('origin')
  const origin = (header === undefined ? null : normalizeOrigin(header.trim())) ?? serverOrigin(c, deps.env)
  if (origin === null)
    throw new HarnessError({ code: 'validation_error', message: 'The sign-in needs the address of this app (the request has no usable Origin or Host).' })
  return origin
}

/** The project server after a sign-in change (`GET /projects/:id/mcp`'s entry). */
async function projectServer(deps: AppDeps, projectId: string, serverId: string): Promise<ProjectMcpServer> {
  const list = await deps.projectMcp.list(projectId)
  const server = list.items.find(item => item.id === serverId)
  if (server === undefined)
    throw new HarnessError({ code: 'not_found', message: `Unknown MCP server "${serverId}".` })
  return server
}

export function createMcpAuthRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The static callback path first (it never meets `/mcp/:id/oauth`: the third segments differ).
  app.post(apiRoutes['mcpAuth.callback'].path, validate('json', mcpAuthCallbackBodySchema), async (c) => {
    const body = c.req.valid('json')
    return c.json(await deps.mcpAuth.complete(body, { origin: requestAppOrigin(c, deps) }))
  })

  app.post(apiRoutes['mcpAuth.start'].path, validate('param', mcpServerParamsSchema), validate('json', mcpAuthStartBodySchema), async (c) => {
    const { id } = c.req.valid('param')
    const { returnTo } = c.req.valid('json')
    return c.json(await deps.mcpAuth.start({ kind: 'global', serverId: id }, { origin: requestAppOrigin(c, deps), returnTo: returnTo ?? null }))
  })

  app.delete(apiRoutes['mcpAuth.signOut'].path, validate('param', mcpServerParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    await deps.mcpAuth.signOut({ kind: 'global', serverId: id })
    const server: McpServer = await presentMcpServer(deps, await deps.mcp.get(id))
    return c.json(server)
  })

  app.post(apiRoutes['mcpAuth.projectStart'].path, validate('param', projectMcpServerParamsSchema), validate('json', mcpAuthStartBodySchema), async (c) => {
    const { id, serverId } = c.req.valid('param')
    const { returnTo } = c.req.valid('json')
    return c.json(await deps.mcpAuth.start({ kind: 'project', projectId: id, serverId }, { origin: requestAppOrigin(c, deps), returnTo: returnTo ?? null }))
  })

  app.delete(apiRoutes['mcpAuth.projectSignOut'].path, validate('param', projectMcpServerParamsSchema), async (c) => {
    const { id, serverId } = c.req.valid('param')
    await deps.mcpAuth.signOut({ kind: 'project', projectId: id, serverId })
    return c.json(await projectServer(deps, id, serverId))
  })

  return app
}
