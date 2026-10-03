// Project routes (API.md 5.22, ADR-031) - Phase 7 stubs (501). Owner: W7.1. Keep the export name
// `createProjectsRoutes`. Thin: validate, call `deps.projects`, map to the response.
//
// - `POST /projects` needs fresh auth (route table flag, checked by the middleware; the service checks again): adding a
//   folder turns a session into file and shell access to it.
// - There is no `GET /projects/:id`, so `GET /projects/browse` never meets a param route of the same method.
// - Deleting a project detaches its chats in one transaction and never touches the folder; deleting while a chat of it
//   runs is `409` (`run-active`).
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, projectBrowseQuerySchema, projectCreateSchema, projectParamsSchema, projectUpdateSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createProjectsRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['projects.list'].path, notImplemented('projects.list'))
  app.post(apiRoutes['projects.create'].path, validate('json', projectCreateSchema), notImplemented('projects.create'))
  app.get(apiRoutes['projects.browse'].path, validate('query', projectBrowseQuerySchema), notImplemented('projects.browse'))
  app.patch(apiRoutes['projects.update'].path, validate('param', projectParamsSchema), validate('json', projectUpdateSchema), notImplemented('projects.update'))
  app.delete(apiRoutes['projects.remove'].path, validate('param', projectParamsSchema), notImplemented('projects.remove'))
  return app
}
