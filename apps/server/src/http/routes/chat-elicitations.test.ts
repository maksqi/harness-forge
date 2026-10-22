// `POST /chat/:id/elicitations/:elicitationId` (API.md 5.38, ADR-060; W14.3-T5, T7) through `createTestApp()` with the
// real elicitation broker: an MCP tool call is registered on the broker and its client's handler receives a request, as
// the MCP managers do. 400 with field issues, 404 (unknown id, another chat's), 409 `stale` (answered, the run ended,
// expired), the answer reaching the MCP server, `awaitingInput` in the chat answers and `chat.updated`.
import type { ElicitationRequest, ElicitResult } from '@ai-sdk/mcp'
import type { McpElicitation, ServerEvent } from '@harness-forge/shared'
import type { ElicitationCallHandle } from '../../mcp/elicitation/types.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import { chatDetailSchema, chatSummarySchema, cursorPageSchema, harnessErrorEnvelopeSchema, mcpElicitationAnswerResultSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { testChatId } from '../../chat/testing.ts'
import { createTestApp } from '../../testing/create-test-app.ts'

const SECRET_VALUE = 'route-secret-value-91ab'
const FORM_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 2 },
    email: { type: 'string', format: 'email' },
  },
  required: ['name'],
}

const apps: TestApp[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
})

async function app(env: Record<string, string> = {}): Promise<TestApp> {
  const t = await createTestApp({ start: false, env })
  apps.push(t)
  return t
}

interface Asked {
  handle: ElicitationCallHandle
  card: McpElicitation
  result: Promise<ElicitResult>
  controller: AbortController
}

/** Registers a call of `chatId` on a client and lets the client's handler receive a request (the card waits). */
function ask(t: TestApp, chatId: string, toolCallId = 'call_1'): Asked {
  const controller = new AbortController()
  const runtimeKey = `mcp:docs#${toolCallId}`
  const handle = t.deps.elicitations.begin({ runtimeKey, chatId, toolCallId, serverId: 'docs', serverName: 'Docs', interactive: true, signal: controller.signal })
  const result = t.deps.elicitations.handler(runtimeKey)({ method: 'elicitation/create', params: { message: 'Who are you?', requestedSchema: FORM_SCHEMA } } as ElicitationRequest)
  const card = handle.pending()
  expect(card).not.toBeNull()
  return { handle, card: card!, result, controller }
}

function answer(t: TestApp, chatId: string, elicitationId: string, body: unknown): Promise<Response> {
  return t.request(`/api/chat/${chatId}/elicitations/${elicitationId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

async function errorOf(response: Response) {
  return harnessErrorEnvelopeSchema.parse(await response.json()).error
}

describe('chatElicitations.answer', () => {
  it('accept: 200 { action }, the MCP server receives the validated content; a second answer is 409 stale', async () => {
    const t = await app()
    const chatId = testChatId(0xE1)
    const asked = ask(t, chatId)
    const response = await answer(t, chatId, asked.card.id, { action: 'accept', content: { name: SECRET_VALUE, email: ' ada@example.com ' } })
    expect(response.status).toBe(200)
    expect(mcpElicitationAnswerResultSchema.parse(await response.json())).toEqual({ action: 'accept' })
    expect(await asked.result).toEqual({ action: 'accept', content: { name: SECRET_VALUE, email: 'ada@example.com' } })
    expect(asked.handle.records()).toEqual([{ id: asked.card.id, message: 'Who are you?', fields: ['name', 'email'], action: 'accept', reason: 'user' }])

    const again = await answer(t, chatId, asked.card.id, { action: 'decline' })
    expect(again.status).toBe(409)
    expect(await errorOf(again)).toMatchObject({ code: 'conflict', details: { reason: 'stale' } })
    asked.handle.end()
    // The values are never logged.
    expect(t.logs.text()).not.toContain(SECRET_VALUE)
  })

  it('decline and cancel reach the MCP server without content', async () => {
    const t = await app()
    const chatId = testChatId(0xE2)
    for (const action of ['decline', 'cancel'] as const) {
      const asked = ask(t, chatId, `call_${action}`)
      const response = await answer(t, chatId, asked.card.id, { action })
      expect(await response.json()).toEqual({ action })
      expect(await asked.result).toEqual({ action })
      asked.handle.end()
    }
  })

  it('400 with the field issues on [content, field]; the request keeps waiting', async () => {
    const t = await app()
    const chatId = testChatId(0xE3)
    const asked = ask(t, chatId)
    const invalid = await answer(t, chatId, asked.card.id, { action: 'accept', content: { name: 'A', email: 'nope' } })
    expect(invalid.status).toBe(400)
    const error = await errorOf(invalid)
    expect(error.code).toBe('validation_error')
    expect(error.details).toMatchObject({ issues: [
      { path: ['content', 'name'], code: 'too-short' },
      { path: ['content', 'email'], code: 'format' },
    ] })
    const missing = await answer(t, chatId, asked.card.id, { action: 'accept' })
    expect(await errorOf(missing)).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['content', 'name'], code: 'required' }] } })
    // The body schema refuses content without accept before the broker sees it.
    const contentWithDecline = await answer(t, chatId, asked.card.id, { action: 'decline', content: { name: 'Ada' } })
    expect(contentWithDecline.status).toBe(400)
    expect(asked.handle.waiting()).toBe(true)
    expect((await answer(t, chatId, asked.card.id, { action: 'accept', content: { name: 'Ada' } })).status).toBe(200)
    expect(await asked.result).toEqual({ action: 'accept', content: { name: 'Ada' } })
    asked.handle.end()
  })

  it('404 for an unknown id or another chat\'s request; 409 stale after the call ended (the run ended)', async () => {
    const t = await app()
    const chatId = testChatId(0xE4)
    const asked = ask(t, chatId)
    const unknown = await answer(t, chatId, 'eli_AAAAAAAAAAAAAAAA', { action: 'decline' })
    expect(unknown.status).toBe(404)
    expect((await errorOf(unknown)).code).toBe('not_found')
    expect((await answer(t, testChatId(0xE5), asked.card.id, { action: 'decline' })).status).toBe(404)
    // Stop aborts the call: the request is cancelled and a late answer is stale.
    asked.controller.abort(new Error('Stopped'))
    expect(await asked.result).toEqual({ action: 'cancel' })
    const late = await answer(t, chatId, asked.card.id, { action: 'decline' })
    expect(late.status).toBe(409)
    expect(await errorOf(late)).toMatchObject({ code: 'conflict', message: 'This request was already answered or has ended.', details: { reason: 'stale' } })
    asked.handle.end()

    const ended = ask(t, chatId, 'call_2')
    ended.handle.end()
    expect(await ended.result).toEqual({ action: 'cancel' })
    expect((await answer(t, chatId, ended.card.id, { action: 'decline' })).status).toBe(409)
  })

  it('409 stale once the wait expired (HF_TEST_ELICITATION_WAIT_MS)', async () => {
    const t = await app({ HF_MOCK_PROVIDER: '1', HF_TEST_ELICITATION_WAIT_MS: '1000' })
    const chatId = testChatId(0xE6)
    const asked = ask(t, chatId)
    expect(asked.card.expiresAt - Date.now()).toBeLessThanOrEqual(1000)
    expect(await asked.result).toEqual({ action: 'cancel' })
    expect(asked.handle.records()[0]).toMatchObject({ action: 'cancel', reason: 'timeout' })
    expect((await answer(t, chatId, asked.card.id, { action: 'decline' })).status).toBe(409)
    asked.handle.end()
  })
})

describe('awaitingInput (W14.3-T7)', () => {
  it('gET /chats and GET /chats/:id carry it; chat.updated reports every 0 <-> >= 1 transition', async () => {
    const t = await app()
    const chatId = testChatId(0xE7)
    await t.deps.chats.ensure(chatId)
    const events: ServerEvent[] = []
    t.deps.events.subscribe(event => void events.push(event))
    const awaiting = () => events.flatMap(event => (event.type === 'chat.updated' && event.data.id === chatId && event.data.awaitingInput !== undefined ? [event.data.awaitingInput] : []))

    const detail = async () => chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId}`)).json())
    expect((await detail()).awaitingInput).toBe(false)
    const first = ask(t, chatId)
    const second = ask(t, chatId, 'call_2')
    expect(t.deps.elicitations.pendingCount(chatId)).toBe(2)
    await expect.poll(awaiting).toEqual([true])
    expect((await detail()).awaitingInput).toBe(true)
    const list = cursorPageSchema(chatSummarySchema).parse(await (await t.request('/api/chats')).json())
    expect(list.items.find(item => item.id === chatId)?.awaitingInput).toBe(true)
    const updated = events.find(event => event.type === 'chat.updated' && event.data.awaitingInput === true)
    expect(updated?.type === 'chat.updated' && updated.data.activeLeafId).toBeNull()

    expect((await answer(t, chatId, first.card.id, { action: 'decline' })).status).toBe(200)
    expect((await detail()).awaitingInput).toBe(true)
    expect((await answer(t, chatId, second.card.id, { action: 'decline' })).status).toBe(200)
    await expect.poll(awaiting).toEqual([true, false])
    expect((await detail()).awaitingInput).toBe(false)
    first.handle.end()
    second.handle.end()
  })

  it('chat delete cancels the chat\'s waits (stopped)', async () => {
    const t = await app()
    const chatId = testChatId(0xE8)
    await t.deps.chats.ensure(chatId)
    const asked = ask(t, chatId)
    expect((await t.request(`/api/chats/${chatId}`, { method: 'DELETE' })).status).toBe(204)
    expect(await asked.result).toEqual({ action: 'cancel' })
    expect(asked.handle.records()[0]).toMatchObject({ action: 'cancel', reason: 'stopped' })
    expect(t.deps.elicitations.pendingCount(chatId)).toBe(0)
    asked.handle.end()
  })
})
