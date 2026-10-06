// Project routes (API.md 5.22, ADR-031). Owner: W7.1. Thin: validate, call `deps.projects`, map to the response.
//
// - `POST /projects` needs fresh auth (route table flag, checked by the middleware; the service checks again through
//   `freshAuthOptions(c)` before it writes anything): adding a folder turns a session into file and shell access to it.
// - There is no `GET /projects/:id`, so `GET /projects/browse` never meets a param route of the same method.
// - Deleting a project detaches its chats in one transaction and never touches the folder; deleting while a chat of it
//   runs is `409` (`run-active`). Phase 11: its `project_trust` rows go with it (foreign key cascade); the project MCP
//   runtimes, its variables and the hooks cache follow the `project.changed { project: null }` event.
// - Phase 11 (ADR-051): `PATCH /projects/:id { outputStyle }` sets the project's output style (any valid style name, an
//   unknown one falls back at run time; null clears it). No fresh auth: a style only changes how the agent writes.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, projectBrowseQuerySchema, projectCreateSchema, projectParamsSchema, projectUpdateSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { freshAuthOptions } from '../middleware/fresh-auth.ts'
import { validate } from '../validate.ts'

export function createProjectsRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['projects.list'].path, async c => c.json({ items: await deps.projects.list() }))

  app.post(apiRoutes['projects.create'].path, validate('json', projectCreateSchema), async (c) => {
    return c.json(await deps.projects.create(c.req.valid('json'), freshAuthOptions(c)), 201)
  })

  app.get(apiRoutes['projects.browse'].path, validate('query', projectBrowseQuerySchema), async (c) => {
    return c.json(await deps.projects.browse(c.req.valid('query').path))
  })

  app.patch(apiRoutes['projects.update'].path, validate('param', projectParamsSchema), validate('json', projectUpdateSchema), async (c) => {
    const { id } = c.req.valid('param')
    return c.json(await deps.projects.update(id, c.req.valid('json')))
  })

  app.delete(apiRoutes['projects.remove'].path, validate('param', projectParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    await deps.projects.remove(id)
    return c.body(null, 204)
  })

  return app
}
