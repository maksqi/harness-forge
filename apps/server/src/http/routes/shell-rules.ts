// Shell rule routes (API.md 5.25, ADR-038) - Phase 8 stubs (501). Owner: W8.6. Keep the export name
// `createShellRulesRoutes`. Thin: validate, call the shell rule service, map to the response.
//
// - No fresh auth: a session can already approve its own shell calls.
// - `POST /shell-rules` checks the prefix with the shared rule parser (a refused prefix is `400 validation_error` on
//   `['prefix']` with the parser's message), stores the canonical form, refuses a duplicate (`409`, `exists`), an
//   unknown project (`404`) and a full scope (`400`, `LIMITS.shellRulesPerScopeMax`). There is no edit route.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, shellRuleCreateSchema, shellRuleParamsSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createShellRulesRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['shellRules.list'].path, notImplemented('shellRules.list'))
  app.post(apiRoutes['shellRules.create'].path, validate('json', shellRuleCreateSchema), notImplemented('shellRules.create'))
  app.delete(apiRoutes['shellRules.remove'].path, validate('param', shellRuleParamsSchema), notImplemented('shellRules.remove'))
  return app
}
