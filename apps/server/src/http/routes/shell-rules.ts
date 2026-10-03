// Shell rule routes (API.md 5.25, ADR-038). Owner: W8.6. Thin: validate, call the shell rule service, map to the
// response.
//
// - No fresh auth: a session can already approve its own shell calls.
// - `POST /shell-rules` checks the prefix with the shared rule parser (a refused prefix is `400 validation_error` on
//   `['prefix']` with the parser's message), stores the canonical form, refuses a duplicate (`409`, `exists`), an
//   unknown project (`404`) and a full scope (`400`, `LIMITS.shellRulesPerScopeMax`). There is no edit route.
// - No event (API.md 5.25); rules are read when a run starts, so a change applies from the next run.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, shellRuleCreateSchema, shellRuleParamsSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { validate } from '../validate.ts'

export function createShellRulesRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['shellRules.list'].path, async c => c.json({ items: await deps.shellRules.list() }))

  app.post(apiRoutes['shellRules.create'].path, validate('json', shellRuleCreateSchema), async (c) => {
    return c.json(await deps.shellRules.create(c.req.valid('json')), 201)
  })

  app.delete(apiRoutes['shellRules.remove'].path, validate('param', shellRuleParamsSchema), async (c) => {
    await deps.shellRules.remove(c.req.valid('param').id)
    return c.body(null, 204)
  })

  return app
}
