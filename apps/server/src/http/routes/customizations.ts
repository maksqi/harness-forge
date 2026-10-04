// Customization routes (API.md 5.28, ADR-044, ADR-045) - Phase 10 stubs (501). Owner: W10.1. Keep the export name
// `createCustomizationsRoutes`. Thin: validate, call the customization service, map to the response.
//
// - `GET /customizations?projectId&kind&refresh`: the merged catalog (builtin < plugin < user < project `.claude` <
//   project `.harness`), every state and diagnostic; an unknown project is `404`, an unavailable folder lists no project
//   entries (`project.available: false`). `refresh=true` rebuilds the project part now (else cached 10 s).
// - `GET /customizations/source?projectId&kind&name&source[&path]`: the markdown of a project, plugin or builtin entry
//   (a project file re-read through the workspace path guard); a personal entry is `400` (use `/customizations/:id`),
//   an unknown entry `404`. Registered before `/customizations/:id`, so the static segment wins.
// - `POST /customizations` (`201`): parsed with `parseDefinition`; an `error` diagnostic is `400` (`details.diagnostics`),
//   a reserved name `400`, a taken kind + name `409` `exists`, more than 200 of a kind `409`.
// - `GET` / `PATCH` / `DELETE /customizations/:id` (`404` unknown; `PATCH` re-parses new content, the kind stays;
//   `DELETE` is `204`). Every write emits `customization.changed`.
// - No fresh auth; never logs definition bodies at `info`.
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
import { notImplemented, validate } from '../validate.ts'

export function createCustomizationsRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['customizations.list'].path, validate('query', customizationsQuerySchema), notImplemented('customizations.list'))
  // Static before param: `/customizations/source` must never reach `/customizations/:id`.
  app.get(apiRoutes['customizations.source'].path, validate('query', customizationSourceQuerySchema), notImplemented('customizations.source'))
  app.post(apiRoutes['customizations.create'].path, validate('json', customizationCreateSchema), notImplemented('customizations.create'))
  app.get(apiRoutes['customizations.get'].path, validate('param', customizationParamsSchema), notImplemented('customizations.get'))
  app.patch(apiRoutes['customizations.update'].path, validate('param', customizationParamsSchema), validate('json', customizationUpdateSchema), notImplemented('customizations.update'))
  app.delete(apiRoutes['customizations.remove'].path, validate('param', customizationParamsSchema), notImplemented('customizations.remove'))
  return app
}
