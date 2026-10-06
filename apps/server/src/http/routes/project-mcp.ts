// Project MCP routes (API.md 5.33, ADR-050). Owner: W11.4. Thin: validate, call the project MCP manager, answer.
//
// - `GET /projects/:id/mcp`: the servers of the project's `.mcp.json` (state, tools, the global server each shadows,
//   missing variables) and the variables they reference (whether a value is stored; values are never answered);
//   `404` unknown project.
// - `PUT /projects/:id/mcp/variables` (fresh auth through the route table; the manager checks it again): a value sets a
//   variable (encrypted, secret scope `project:<projectId>`), null removes it; servers that use a changed variable
//   restart. Variables never come from the server environment. Answers the list; `409` `exists` above 50 variables.
// - `POST /projects/:id/mcp/:serverId/reconnect`: restarts one approved server, waiting at most 10 s (`404` unknown
//   server; `409` `disabled` in safe mode); answers the server.
// - Every state change emits `project-mcp.changed` (the manager). Never logs variable values or resolved env / args /
//   headers.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, projectMcpServerParamsSchema, projectMcpVariablesBodySchema, projectParamsSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { freshAuthOptions } from '../middleware/fresh-auth.ts'
import { validate } from '../validate.ts'

export function createProjectMcpRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['projectMcp.list'].path, validate('param', projectParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    return c.json(await deps.projectMcp.list(id))
  })

  // Static `variables` (PUT) and `/:serverId/reconnect` (POST) differ in method and segment count.
  app.put(apiRoutes['projectMcp.setVariables'].path, validate('param', projectParamsSchema), validate('json', projectMcpVariablesBodySchema), async (c) => {
    const { id } = c.req.valid('param')
    const { values } = c.req.valid('json')
    return c.json(await deps.projectMcp.setVariables(id, values, freshAuthOptions(c)))
  })

  app.post(apiRoutes['projectMcp.reconnect'].path, validate('param', projectMcpServerParamsSchema), async (c) => {
    const { id, serverId } = c.req.valid('param')
    return c.json(await deps.projectMcp.reconnect(id, serverId))
  })

  return app
}
