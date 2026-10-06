// Hook routes (API.md 5.31, ADR-048) - Phase 11 stubs (501). Owner: W11.1. Keep the export name `createHooksRoutes`.
// Thin: validate, call the hook service, map to the response.
//
// - `GET /hooks?projectId`: every hook of the scope in run order (personal rows, the project's settings-file hooks with
//   their trust state when `projectId` is given, plugin command and code hooks), the configuration diagnostics and the
//   kill switches (`switches`); an unknown project is `404`, an unavailable folder lists no project hooks.
// - `GET /hooks/runs`: the in-memory run log (the last 200 hook runs, newest first). No `GET /hooks/:id`, so the static
//   `runs` segment never meets a param route of the same method.
// - `POST /hooks` (`201`, fresh auth through the route table): a personal hook; an invalid matcher is `400`, more than
//   100 personal hooks `409`.
// - `PATCH /hooks/:id`: fresh auth unless the body only turns the hook off (`isHookTurnOff`: exactly
//   `{ enabled: false }`), checked here after validation (the route table has no `fresh` flag); `404` unknown.
// - `DELETE /hooks/:id` (`204`; no fresh auth). Every write emits `hooks.changed { projectId: null }`.
// - Never logs hook commands, payloads or outputs at `info`.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, hookCreateSchema, hookParamsSchema, hooksQuerySchema, hookUpdateSchema, isHookTurnOff } from '@harness-forge/shared'
import { Hono } from 'hono'
import { requireFreshAuth } from '../middleware/fresh-auth.ts'
import { notImplemented, validate } from '../validate.ts'

export function createHooksRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['hooks.list'].path, validate('query', hooksQuerySchema), notImplemented('hooks.list'))
  app.get(apiRoutes['hooks.runs'].path, notImplemented('hooks.runs'))
  app.post(apiRoutes['hooks.create'].path, validate('json', hookCreateSchema), notImplemented('hooks.create'))
  const update = notImplemented('hooks.update')
  app.patch(apiRoutes['hooks.update'].path, validate('param', hookParamsSchema), validate('json', hookUpdateSchema), (c) => {
    // Turning a hook off needs no fresh auth; every other change does (it can change what runs).
    if (!isHookTurnOff(c.req.valid('json')))
      requireFreshAuth(c)
    return update(c)
  })
  app.delete(apiRoutes['hooks.remove'].path, validate('param', hookParamsSchema), notImplemented('hooks.remove'))
  return app
}
