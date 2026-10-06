// Project MCP routes (API.md 5.33, ADR-050) - Phase 11 stubs (501). Owner: W11.4. Keep the export name
// `createProjectMcpRoutes`. Thin: validate, call the project MCP manager, map to the response.
//
// - `GET /projects/:id/mcp`: the servers of the project's `.mcp.json` (state, tools, the global server each shadows,
//   missing variables) and the variables they reference (whether a value is stored; values are never answered);
//   `404` unknown project.
// - `PUT /projects/:id/mcp/variables` (fresh auth through the route table: a value can change what an approved stdio
//   server runs): a value sets a variable (encrypted, secret scope `project:<projectId>`), null removes it; servers
//   that use a changed variable restart. Variables never come from the server environment. Answers the list.
// - `POST /projects/:id/mcp/:serverId/reconnect`: restarts one approved server (`404` unknown server; `409` `disabled`
//   in safe mode); answers the server.
// - Every state change emits `project-mcp.changed`. Never logs variable values or resolved env / args / headers.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, projectMcpServerParamsSchema, projectMcpVariablesBodySchema, projectParamsSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createProjectMcpRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['projectMcp.list'].path, validate('param', projectParamsSchema), notImplemented('projectMcp.list'))
  // Static `variables` (PUT) and `/:serverId/reconnect` (POST) differ in method and segment count.
  app.put(apiRoutes['projectMcp.setVariables'].path, validate('param', projectParamsSchema), validate('json', projectMcpVariablesBodySchema), notImplemented('projectMcp.setVariables'))
  app.post(apiRoutes['projectMcp.reconnect'].path, validate('param', projectMcpServerParamsSchema), notImplemented('projectMcp.reconnect'))
  return app
}
