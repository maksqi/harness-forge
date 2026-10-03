// Steer queue routes (W9.2-T2, API.md 4.26 / 5.26): every answer of `GET / POST /chat/:id/queue` and
// `DELETE /chat/:id/queue/:itemId` (200, 201, 204, 400, 404, 409 `run-idle` / `queue-full` / `exists`) and the
// `queue.changed` event. A chat waiting for an approval (`mock:tool-approval`) accepts items without a run, so the queue
// is observed without a model running.
import type { ChatDetail, HarnessErrorInit, QueueItem, ServerEvent } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import { chatDetailSchema, createMessageId, harnessErrorEnvelopeSchema, LIMITS, queueItemSchema, queueListSchema } from '@harness-forge/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { answerApprovals, chatBody, postChat, readSse, runnerOf, testChatId } from '../../chat/testing.ts'
import { createTestApp } from '../../testing/create-test-app.ts'

let t: TestApp
let events: ServerEvent[]
let nextChat = 0xA000

beforeAll(async () => {
  t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
  t.deps.events.subscribe(event => events.push(event))
})

beforeEach(() => {
  events = []
})

afterAll(async () => {
  await t.close()
})

function newChatId(): string {
  nextChat += 1
  return testChatId(nextChat)
}

function body(text: string, overrides: Record<string, unknown> = {}, id: string = createMessageId()): Record<string, unknown> {
  return { message: { id, role: 'user', parts: [{ type: 'text', text }] }, modelRef: 'mock:tool-approval', reasoningEffort: 'auto', toolMode: 'ask', ...overrides }
}

function post(chatId: string, payload: unknown): Promise<Response> {
  return t.request(`/api/chat/${chatId}/queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
}

async function errorOf(response: Response): Promise<HarnessErrorInit> {
  return harnessErrorEnvelopeSchema.parse(await response.json()).error
}

async function detailOf(chatId: string): Promise<ChatDetail> {
  return chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId}`)).json())
}

/** A chat whose reply waits for an approval: no run, `pendingApproval` true. */
async function waitingChat(): Promise<string> {
  const chatId = newChatId()
  await readSse(await postChat(t, chatBody(chatId, 'echo me', { modelRef: 'mock:tool-approval' })))
  expect((await detailOf(chatId)).pendingApproval).toBe(true)
  expect(t.deps.runs.hasRun(chatId)).toBe(false)
  return chatId
}

async function queued(chatId: string, text: string): Promise<QueueItem> {
  const response = await post(chatId, body(text))
  expect(response.status).toBe(201)
  return queueItemSchema.parse(await response.json())
}

describe('gET /api/chat/:id/queue', () => {
  it('answers the queued items oldest first, an empty list for a known chat, 404 for an unknown chat, 400 for a bad id', async () => {
    const chatId = await waitingChat()
    expect(queueListSchema.parse(await (await t.request(`/api/chat/${chatId}/queue`)).json())).toEqual({ items: [] })
    const a = await queued(chatId, 'first')
    const b = await queued(chatId, 'second')
    const response = await t.request(`/api/chat/${chatId}/queue`)
    expect(response.status).toBe(200)
    expect(queueListSchema.parse(await response.json())).toEqual({ items: [a, b] })

    const unknown = await t.request(`/api/chat/${newChatId()}/queue`)
    expect(unknown.status).toBe(404)
    expect((await errorOf(unknown)).code).toBe('not_found')
    expect((await t.request('/api/chat/not-a-chat/queue')).status).toBe(400)
  })
})

describe('pOST /api/chat/:id/queue', () => {
  it('answers 201 with the item and emits queue.changed', async () => {
    const chatId = await waitingChat()
    const id = createMessageId()
    const response = await post(chatId, body('later please', {}, id))
    expect(response.status).toBe(201)
    const item = queueItemSchema.parse(await response.json())
    expect(item).toMatchObject({ id, message: { id, role: 'user', parts: [{ type: 'text', text: 'later please' }] }, modelRef: 'mock:tool-approval', reasoningEffort: 'auto', toolMode: 'ask', turnOnly: false })
    expect(item.createdAt).toBeGreaterThan(0)
    expect(events.filter(event => event.type === 'queue.changed')).toEqual([expect.objectContaining({ data: { chatId, items: [item] } })])
    const compact = queueItemSchema.parse(await (await post(chatId, body('/compact keep it short'))).json())
    expect(compact.turnOnly).toBe(true)
  })

  it('answers 409 run-idle for a chat with neither a run nor a pending approval, 404 for an unknown chat', async () => {
    const chatId = newChatId()
    await readSse(await postChat(t, chatBody(chatId, 'done already')))
    await runnerOf(t).idle()
    const idle = await post(chatId, body('too late'))
    expect(idle.status).toBe(409)
    expect(await errorOf(idle)).toMatchObject({ code: 'conflict', details: { reason: 'run-idle', chatId } })
    const unknown = await post(newChatId(), body('nobody'))
    expect(unknown.status).toBe(404)
    expect(events.some(event => event.type === 'queue.changed')).toBe(false)
  })

  it('answers 409 exists for a stored or queued id and 409 queue-full at 10 items', async () => {
    const chatId = await waitingChat()
    const stored = (await detailOf(chatId)).messages[0]!.id
    const reused = await post(chatId, body('reuse', {}, stored))
    expect(reused.status).toBe(409)
    expect(await errorOf(reused)).toMatchObject({ details: { reason: 'exists' } })
    const first = await queued(chatId, 'one')
    expect(await errorOf(await post(chatId, body('again', {}, first.id)))).toMatchObject({ details: { reason: 'exists' } })
    for (let n = 1; n < LIMITS.queueItemsMax; n++)
      await queued(chatId, `item ${n}`)
    const full = await post(chatId, body('eleventh'))
    expect(full.status).toBe(409)
    expect(await errorOf(full)).toMatchObject({ code: 'conflict', details: { reason: 'queue-full', chatId } })
    expect(t.deps.runs.queueList(chatId)).toHaveLength(LIMITS.queueItemsMax)
  })

  it('validates the body (400): strict keys, roles, parts, the 256 KiB cap and uploaded files only', async () => {
    const chatId = await waitingChat()
    const cases: Array<[unknown, (string | number)[]]> = [
      [{ ...body('x'), extra: true }, []],
      [body('x', { message: { id: createMessageId(), role: 'assistant', parts: [{ type: 'text', text: 'x' }] } }), ['message', 'role']],
      [body('x', { message: { id: createMessageId(), role: 'user', parts: [] } }), ['message', 'parts']],
      [body('x', { message: { id: 'not-an-id', role: 'user', parts: [{ type: 'text', text: 'x' }] } }), ['message', 'id']],
      [body('x', { toolMode: 'yolo' }), ['toolMode']],
      [body('y'.repeat(LIMITS.queueItemBytes)), ['message']],
      [body('x', { message: { id: createMessageId(), role: 'user', parts: [{ type: 'file', mediaType: 'image/png', url: 'https://example.com/a.png' }] } }), ['message', 'parts', 0]],
      [body('x', { message: { id: createMessageId(), role: 'user', parts: [{ type: 'text', text: 'see' }, { type: 'file', mediaType: 'image/png', url: '/api/files/file_AAAAAAAAAAAAAAAA' }] } }), ['message', 'parts', 1]],
    ]
    for (const [payload, path] of cases) {
      const response = await post(chatId, payload)
      expect(response.status, JSON.stringify(path)).toBe(400)
      const error = await errorOf(response)
      expect(error.code).toBe('validation_error')
      if (path.length > 0)
        expect((error.details as { issues: Array<{ path: unknown[] }> }).issues.map(issue => issue.path)).toContainEqual(path)
    }
    expect(t.deps.runs.queueList(chatId)).toEqual([])
  })

  it('normalizes file parts from the stored file', async () => {
    const chatId = await waitingChat()
    const file = await t.deps.files.upload(new File(['hello'], 'real.txt', { type: 'text/plain' }))
    const response = await post(chatId, body('x', { message: { id: createMessageId(), role: 'user', parts: [{ type: 'file', mediaType: 'image/png', filename: 'fake.png', url: file.url }] } }))
    expect(response.status).toBe(201)
    expect(queueItemSchema.parse(await response.json()).message.parts).toEqual([{ type: 'file', mediaType: 'text/plain', filename: 'real.txt', url: file.url }])
  })
})

describe('dELETE /api/chat/:id/queue/:itemId', () => {
  it('cancels a queued item (204, removed cancelled), then answers 404; 404 for an unknown chat or item, 400 for bad ids', async () => {
    const chatId = await waitingChat()
    const a = await queued(chatId, 'a')
    const b = await queued(chatId, 'b')
    events = []
    const response = await t.request(`/api/chat/${chatId}/queue/${a.id}`, { method: 'DELETE' })
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(events.filter(event => event.type === 'queue.changed').map(event => event.data)).toEqual([{ chatId, items: [b], removed: [{ id: a.id, reason: 'cancelled' }] }])
    const again = await t.request(`/api/chat/${chatId}/queue/${a.id}`, { method: 'DELETE' })
    expect(again.status).toBe(404)
    expect(await errorOf(again)).toMatchObject({ code: 'not_found' })
    expect((await t.request(`/api/chat/${newChatId()}/queue/${b.id}`, { method: 'DELETE' })).status).toBe(404)
    expect((await t.request(`/api/chat/${chatId}/queue/${createMessageId()}`, { method: 'DELETE' })).status).toBe(404)
    expect((await t.request(`/api/chat/${chatId}/queue/nope`, { method: 'DELETE' })).status).toBe(400)
    expect(t.deps.runs.queueList(chatId)).toEqual([b])
  })

  it('answers 404 once the item was delivered (the approval continuation took it at step 0)', async () => {
    const chatId = await waitingChat()
    const item = await queued(chatId, 'deliver me')
    const assistant = (await detailOf(chatId)).messages[1]!
    const { chunks } = await readSse(await postChat(t, { ...chatBody(chatId, '', { modelRef: 'mock:tool-approval' }), message: answerApprovals(assistant, true) }))
    expect(chunks.find(chunk => chunk.type === 'data-steer')).toMatchObject({ data: { id: item.id } })
    const late = await t.request(`/api/chat/${chatId}/queue/${item.id}`, { method: 'DELETE' })
    expect(late.status).toBe(404)
    expect((await errorOf(late)).message).toContain('already sent')
    await runnerOf(t).idle()
  })
})
