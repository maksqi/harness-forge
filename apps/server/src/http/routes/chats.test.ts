import type { HarnessUIMessage, ServerEvent } from '@harness-forge/shared'
import type { ChatRunner } from '../../chat/types.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import {
  chatDetailSchema,
  chatExportSchema,
  chatSummarySchema,
  cursorPageSchema,
  harnessErrorEnvelopeSchema,
} from '@harness-forge/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'

const chatPageSchema = cursorPageSchema(chatSummarySchema)

let t: TestApp
let received: ServerEvent[]
const stop = vi.fn(async (_chatId: string) => false)

function chatId(n: number): string {
  return `0199a8f0-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
}

function userMessage(n: number, text: string): HarnessUIMessage {
  return { id: `msg_${n.toString().padStart(16, '0')}`, role: 'user', metadata: { modelRef: 'mock:echo', startedAt: 1 }, parts: [{ type: 'text', text }] }
}

beforeAll(async () => {
  const runs: ChatRunner = {
    start: async () => new Response(null),
    resume: () => null,
    stop,
    isActive: () => false,
    hasRun: () => false,
    active: () => [],
    stopAll: async () => {},
  }
  t = await createTestApp({ start: false, overrides: { runs } })
  t.deps.events.subscribe(event => received.push(event))
})

beforeEach(() => {
  received = []
  stop.mockClear()
})

afterAll(async () => {
  await t.close()
})

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

async function errorOf(response: Response) {
  return harnessErrorEnvelopeSchema.parse(await response.json()).error
}

describe('chats routes', () => {
  it('pOST /api/chats creates a chat (201 ChatDetail) and emits chat.created; a second create is 409', async () => {
    const response = await t.request('/api/chats', json('POST', { id: chatId(1), title: 'Trip', messages: [userMessage(1, 'Plan a trip to Lisbon')] }))
    expect(response.status).toBe(201)
    const detail = chatDetailSchema.parse(await response.json())
    expect(detail).toMatchObject({ id: chatId(1), title: 'Trip', titleSource: 'user', messages: [{ role: 'user' }] })
    expect(received.map(event => event.type)).toEqual(['chat.created'])
    const again = await t.request('/api/chats', json('POST', { id: chatId(1) }))
    expect(again.status).toBe(409)
    expect(await errorOf(again)).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
  })

  it('pOST /api/chats validates the body strictly', async () => {
    const unknownKey = await t.request('/api/chats', json('POST', { id: chatId(2), extra: true }))
    expect(unknownKey.status).toBe(400)
    const badId = await t.request('/api/chats', json('POST', { id: 'not-a-uuid' }))
    expect((await errorOf(badId)).code).toBe('validation_error')
    const badMessages = await t.request('/api/chats', json('POST', { messages: [{ id: 'msg_x', role: 'user', parts: [] }] }))
    expect(badMessages.status).toBe(400)
  })

  it('gET /api/chats lists, searches with snippets and paginates', async () => {
    await t.request('/api/chats', json('POST', { id: chatId(3), title: 'Groceries' }))
    const list = chatPageSchema.parse(await (await t.request('/api/chats')).json())
    expect(list.items.map(chat => chat.id)).toEqual([chatId(3), chatId(1)])
    const search = chatPageSchema.parse(await (await t.request('/api/chats?q=LISBON')).json())
    expect(search.items.map(chat => chat.id)).toEqual([chatId(1)])
    expect(search.items[0]!.snippet).toBe('Plan a trip to Lisbon')
    const first = chatPageSchema.parse(await (await t.request('/api/chats?limit=1')).json())
    expect(first.items).toHaveLength(1)
    const second = chatPageSchema.parse(await (await t.request(`/api/chats?limit=1&cursor=${first.nextCursor}`)).json())
    expect(second.items.map(chat => chat.id)).toEqual([chatId(1)])
    expect(second.nextCursor).toBeNull()
  })

  it.each([
    '/api/chats?limit=0',
    '/api/chats?limit=101',
    '/api/chats?cursor=bad!cursor',
    '/api/chats?cursor=abc',
    '/api/chats?archived=maybe',
    `/api/chats?q=${'x'.repeat(201)}`,
  ])('gET %s answers 400 validation_error', async (path) => {
    const response = await t.request(path)
    expect(response.status).toBe(400)
    expect((await errorOf(response)).code).toBe('validation_error')
  })

  it('gET /api/chats/:id answers the detail, 404 for unknown and 400 for malformed ids', async () => {
    const response = await t.request(`/api/chats/${chatId(1)}`)
    expect(response.status).toBe(200)
    expect(chatDetailSchema.parse(await response.json()).messages).toHaveLength(1)
    expect((await t.request(`/api/chats/${chatId(99)}`)).status).toBe(404)
    expect((await t.request('/api/chats/..%2F..%2Fetc')).status).toBe(400)
  })

  it('pATCH /api/chats/:id updates and emits chat.updated', async () => {
    const response = await t.request(`/api/chats/${chatId(3)}`, json('PATCH', { title: 'Weekly groceries', pinned: true, settings: { toolMode: 'auto' } }))
    expect(response.status).toBe(200)
    const summary = chatSummarySchema.parse(await response.json())
    expect(summary).toMatchObject({ title: 'Weekly groceries', titleSource: 'user', pinned: true })
    expect(received.map(event => event.type)).toEqual(['chat.updated'])
    expect((await t.request(`/api/chats/${chatId(3)}`, json('PATCH', {}))).status).toBe(400)
    expect((await t.request(`/api/chats/${chatId(3)}`, json('PATCH', { color: 'red' }))).status).toBe(400)
    expect((await t.request(`/api/chats/${chatId(99)}`, json('PATCH', { pinned: true }))).status).toBe(404)
  })

  it('gET /api/chats/:id/export answers Markdown and JSON attachments', async () => {
    const markdown = await t.request(`/api/chats/${chatId(1)}/export?format=md`)
    expect(markdown.status).toBe(200)
    expect(markdown.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(markdown.headers.get('content-disposition')).toMatch(/^attachment; filename="trip-\d{4}-\d{2}-\d{2}\.md"; filename\*=UTF-8''trip-\d{4}-\d{2}-\d{2}\.md$/)
    expect(markdown.headers.get('cache-control')).toBe('no-store')
    expect(markdown.headers.get('x-content-type-options')).toBe('nosniff')
    const text = await markdown.text()
    expect(text.startsWith('# Trip\n')).toBe(true)
    expect(text).toContain('## User\n\nPlan a trip to Lisbon')
    const exported = await t.request(`/api/chats/${chatId(1)}/export?format=json`)
    expect(exported.headers.get('content-type')).toBe('application/json; charset=utf-8')
    const body = chatExportSchema.parse(await exported.json())
    expect(body.chat).toMatchObject({ id: chatId(1), running: false, pendingApproval: false })
    expect((await t.request(`/api/chats/${chatId(1)}/export?format=pdf`)).status).toBe(400)
    expect((await t.request(`/api/chats/${chatId(99)}/export?format=md`)).status).toBe(404)
  })

  it('dELETE /api/chats/:id stops the run first, deletes, emits chat.deleted; then 404', async () => {
    const order: string[] = []
    stop.mockImplementationOnce(async () => {
      order.push('stop')
      return true
    })
    t.deps.events.subscribe((event) => {
      if (event.type === 'chat.deleted')
        order.push('deleted')
    })
    const response = await t.request(`/api/chats/${chatId(1)}`, { method: 'DELETE' })
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(stop).toHaveBeenCalledWith(chatId(1))
    expect(order).toEqual(['stop', 'deleted'])
    expect(received.filter(event => event.type === 'chat.deleted').map(event => event.data)).toEqual([{ id: chatId(1) }])
    expect((await t.request(`/api/chats/${chatId(1)}`)).status).toBe(404)
    expect((await t.request(`/api/chats/${chatId(1)}`, { method: 'DELETE' })).status).toBe(404)
  })
})
