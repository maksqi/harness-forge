// Hook routes (API.md 5.31, ADR-048). Owner: W11.1. Thin: validate, call the hook service, map to the response.
//
// - `GET /hooks?projectId`: every hook of the scope in run order (personal rows, plugin command and code hooks, the
//   project's settings-file hooks with their trust state when `projectId` is given), the configuration diagnostics and
//   the kill switches (`switches`); an unknown project is `404`, an unavailable folder lists no project hooks.
// - `GET /hooks/runs`: the in-memory run log (the last 200 hook runs, newest first). No `GET /hooks/:id`, so the static
//   `runs` segment never meets a param route of the same method.
// - `POST /hooks` (`201`, fresh auth through the route table and the service): a personal hook; an invalid matcher is
//   `400`, more than 100 personal hooks `409` (`exists`).
// - `PATCH /hooks/:id`: fresh auth unless the body only turns the hook off (`isHookTurnOff`: exactly
//   `{ enabled: false }`), checked here after validation (the route table has no `fresh` flag) and again by the
//   service; `404` unknown.
// - `DELETE /hooks/:id` (`204`; no fresh auth). Every write emits `hooks.changed { projectId: null }` (the service).
// - Never logs hook commands, payloads or outputs at `info`.
import type { HookRunList } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, hookCreateSchema, hookParamsSchema, hooksQuerySchema, hookUpdateSchema, isHookTurnOff } from '@harness-forge/shared'
import { Hono } from 'hono'
import { freshAuthOptions, requireFreshAuth } from '../middleware/fresh-auth.ts'
import { validate } from '../validate.ts'

export function createHooksRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['hooks.list'].path, validate('query', hooksQuerySchema), async c => c.json(await deps.hooks.list(c.req.valid('query'))))

  app.get(apiRoutes['hooks.runs'].path, (c) => {
    const body: HookRunList = { items: deps.hooks.runs() }
    return c.json(body)
  })

  app.post(apiRoutes['hooks.create'].path, validate('json', hookCreateSchema), async (c) => {
    return c.json(await deps.hooks.create(c.req.valid('json'), freshAuthOptions(c)), 201)
  })

  app.patch(apiRoutes['hooks.update'].path, validate('param', hookParamsSchema), validate('json', hookUpdateSchema), async (c) => {
    const body = c.req.valid('json')
    // Turning a hook off needs no fresh auth; every other change does (it can change what runs).
    if (!isHookTurnOff(body))
      requireFreshAuth(c)
    return c.json(await deps.hooks.update(c.req.valid('param').id, body, freshAuthOptions(c)))
  })

  app.delete(apiRoutes['hooks.remove'].path, validate('param', hookParamsSchema), async (c) => {
    await deps.hooks.remove(c.req.valid('param').id)
    return c.body(null, 204)
  })

  return app
}
