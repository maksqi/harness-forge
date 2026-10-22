// Elicitation answer route (API.md 5.38, ADR-060). Owner: W14.3 (replaces C47's 501 stub). Keep the export name
// `createChatElicitationsRoutes`. Thin: validate, hand the answer to the elicitation broker (`deps.elicitations`).
//
// - `POST /chat/:id/elicitations/:elicitationId` (body `{ action, content? }`, `content` only with `accept`): answers
//   a pending MCP elicitation of the chat's running tool call. The card comes from the tool part's preliminary output
//   (`McpToolProgress`); there is no list route and no SSE event. `content` is validated against the request's form
//   (`validateElicitationAnswer`): `400` with field issues (`details.issues[].path` = `['content', <field>]`); `404`
//   unknown chat or elicitation (or another chat's); `409` `stale` when it was already answered, expired (480 s) or its
//   run ended. Answers `{ action }`; the broker emits `chat.updated` (`awaitingInput`) when the chat has nothing else
//   waiting.
// - Needs a session, no fresh auth. The values the user entered are never stored or logged (the stored tool output keeps
//   the message, the field names, the action and the reason); this route logs nothing itself (the broker logs the ids,
//   the action and the reason).
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, chatElicitationParamsSchema, mcpElicitationAnswerBodySchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { validate } from '../validate.ts'

export function createChatElicitationsRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.post(apiRoutes['chatElicitations.answer'].path, validate('param', chatElicitationParamsSchema), validate('json', mcpElicitationAnswerBodySchema), async (c) => {
    const { id, elicitationId } = c.req.valid('param')
    const result = await deps.elicitations.answer(id, elicitationId, c.req.valid('json'))
    return c.json(result)
  })
  return app
}
