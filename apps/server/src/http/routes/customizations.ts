// Customization routes (API.md 5.28, ADR-044, ADR-045). Owner: W10.1. Thin: validate, call the customization service,
// map to the response.
//
// - `GET /customizations?projectId&kind&refresh`: the merged catalog (builtin < plugin < user < project `.claude` <
//   project `.harness`), every state and diagnostic; an unknown project is `404`, an unavailable folder lists no project
//   entries (`project.available: false`). `refresh=true` rebuilds the catalog now (else cached 10 s).
// - `GET /customizations/source?projectId&kind&name&source[&path]`: the markdown of a project, plugin or builtin entry
//   (a project file re-read through the workspace path guard; `path` picks a shadowed file of the same name); a personal
//   entry is `400` (use `/customizations/:id`), an unknown entry `404`. Registered before `/customizations/:id`, so the
//   static segment wins.
// - `POST /customizations` (`201`): parsed with `parseDefinition`; an `error` diagnostic is `400` (`details.diagnostics`),
//   a reserved name `400`, a taken kind + name `409` `exists`, more than 200 of a kind `409`.
// - `GET` / `PATCH` / `DELETE /customizations/:id` (`404` unknown; `PATCH` re-parses new content, the kind stays;
//   `DELETE` is `204`). Every write emits `customization.changed`.
// - No fresh auth (a definition only narrows what the session can already do); never logs definition bodies.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import {
  apiRoutes,
  customizationCreateSchema,
  customizationParamsSchema,
  customizationSourceQuerySchema,
  customizationsQuerySchema,
  customizationUpdateSchema,
} from '@harness-forge/shared'
import { Hono } from 'hono'
import { validate } from '../validate.ts'

export function createCustomizationsRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['customizations.list'].path, validate('query', customizationsQuerySchema), async (c) => {
    return c.json(await deps.customizations.list(c.req.valid('query')))
  })

  // Static before param: `/customizations/source` must never reach `/customizations/:id`.
  app.get(apiRoutes['customizations.source'].path, validate('query', customizationSourceQuerySchema), async (c) => {
    return c.json(await deps.customizations.source(c.req.valid('query')))
  })

  app.post(apiRoutes['customizations.create'].path, validate('json', customizationCreateSchema), async (c) => {
    return c.json(await deps.customizations.create(c.req.valid('json')), 201)
  })

  app.get(apiRoutes['customizations.get'].path, validate('param', customizationParamsSchema), async (c) => {
    return c.json(await deps.customizations.get(c.req.valid('param').id))
  })

  app.patch(apiRoutes['customizations.update'].path, validate('param', customizationParamsSchema), validate('json', customizationUpdateSchema), async (c) => {
    return c.json(await deps.customizations.update(c.req.valid('param').id, c.req.valid('json')))
  })

  app.delete(apiRoutes['customizations.remove'].path, validate('param', customizationParamsSchema), async (c) => {
    await deps.customizations.remove(c.req.valid('param').id)
    return c.body(null, 204)
  })

  return app
}
