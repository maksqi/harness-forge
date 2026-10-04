// Remember route (API.md 5.29, ADR-047). Owner: W10.6. Thin: validate, call the memory service
// (`services/customizations/memory.ts`), answer its result.
//
// - `POST /memory` (strict body `{ target, text, chatId? }`): `project-file` appends `- <text>` to the project's
//   `AGENTS.md` (else `CLAUDE.md`, else a new `AGENTS.md`) through the change journal (rewindable; a link is `400`, a
//   file over 1 MiB `413`); `project-instructions` appends to the project's instructions, `global` to the global Custom
//   instructions (over 20 000 characters `400`). Project targets need the chat of a project (`404` unknown chat, `400`
//   without a project).
// - No fresh auth; never logs the text.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, rememberBodySchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { remember } from '../../services/customizations/memory.ts'
import { validate } from '../validate.ts'

export function createMemoryRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.post(apiRoutes['memory.remember'].path, validate('json', rememberBodySchema), async (c) => {
    const result = await remember(deps, c.req.valid('json'), { logger: c.var.logger, signal: c.req.raw.signal })
    c.header('Cache-Control', 'no-store')
    return c.json(result)
  })
  return app
}
