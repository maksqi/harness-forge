import type { HarnessUIMessage, ServerEvent } from '@harness-forge/shared'
import type { ChatRunner } from '../../chat/types.ts'
import type { ChatsService } from '../../services/chats/types.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import {
  chatDetailSchema,
  chatExportSchema,
  chatSummarySchema,
  cursorPageSchema,
  harnessErrorEnvelopeSchema,
} from '@harness-forge/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatBody, nextEvent, testChatId } from '../../chat/testing.ts'
import { createChatsService } from '../../services/chats/index.ts'
import { createTestApp } from '../../testing/create-test-app.ts'

const chatPageSchema = cursorPageSchema(chatSummarySchema)

let t: TestApp
let received: ServerEvent[]
const stop = vi.fn(async (_chatId: string) => false)
/** Chats the fake runner holds a run for (`hasRun`, any phase). */
const holding = new Set<string>()

function chatId(n: number): string {
  return `0199a8f0-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
}

function mid(n: number): string {
  return `msg_${n.toString().padStart(16, '0')}`
}

function userMessage(n: number, text: string): HarnessUIMessage {
  return { id: mid(n), role: 'user', metadata: { modelRef: 'mock:echo', startedAt: 1 }, parts: [{ type: 'text', text }] }
}

function assistantMessage(n: number, text: string): HarnessUIMessage {
  return { id: mid(n), role: 'assistant', metadata: { modelRef: 'mock:echo', startedAt: 2 }, parts: [{ type: 'text', text, state: 'done' }] }
}

/** ARCHITECTURE.md 6.8: A -> RA -> B -> RB; A2 (an edit of A) -> RA2, active leaf RA2 (message numbers from `first`). */
function treeBody(id: string, first: number) {
  return {
    id,
    messages: [
      userMessage(first, 'A'),
      assistantMessage(first + 1, 'RA'),
      userMessage(first + 2, 'B'),
      assistantMessage(first + 3, 'RB'),
      userMessage(first + 4, 'A2'),
      assistantMessage(first + 5, 'RA2'),
    ],
    parentIds: [null, mid(first), mid(first + 1), mid(first + 2), null, mid(first + 4)],
    activeLeafId: mid(first + 5),
  }
}

function ids(list: readonly HarnessUIMessage[]): string[] {
  return list.map(message => message.id)
}

beforeAll(async () => {
  const runs: ChatRunner = {
    start: async () => new Response(null),
    resume: () => null,
    stop,
    isActive: () => false,
    hasRun: chatId => holding.has(chatId),
    active: () => [],
    stopAll: async () => {},
  }
  t = await createTestApp({ start: false, overrides: { runs } })
  t.deps.events.subscribe(event => received.push(event))
})

beforeEach(() => {
  received = []
  stop.mockClear()
  holding.clear()
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

describe('message tree routes (ADR-023)', () => {
  it('pOST /api/chats imports a tree: the detail shows the active path and its versions', async () => {
    const response = await t.request('/api/chats', json('POST', treeBody(chatId(20), 200)))
    expect(response.status).toBe(201)
    const detail = chatDetailSchema.parse(await response.json())
    expect(ids(detail.messages)).toEqual([mid(204), mid(205)])
    expect(detail.branches).toEqual({ [mid(204)]: { siblings: [mid(200), mid(204)], index: 1 } })
    expect(chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId(20)}`)).json())).toEqual(detail)
  })

  it('pOST /api/chats rejects an invalid tree with 400 and the field path', async () => {
    const body = treeBody(chatId(21), 210)
    const cases: Array<[unknown, unknown[]]> = [
      [{ ...body, parentIds: [null, mid(212), mid(211), mid(212), null, mid(214)] }, ['parentIds', 1]],
      [{ ...body, parentIds: [null] }, ['parentIds']],
      [{ ...body, activeLeafId: 'msg_unknown000000001' }, ['activeLeafId']],
    ]
    for (const [input, path] of cases) {
      const response = await t.request('/api/chats', json('POST', input))
      expect(response.status).toBe(400)
      expect(await errorOf(response)).toMatchObject({ code: 'validation_error', details: { issues: [{ path }] } })
    }
    expect((await t.request(`/api/chats/${chatId(21)}`)).status).toBe(404)
  })

  it('pOST /api/chats/:id/branch switches to the remembered leaf under the message and emits chat.updated', async () => {
    await t.request('/api/chats', json('POST', treeBody(chatId(22), 220)))
    const before = chatSummarySchema.parse(await (await t.request(`/api/chats/${chatId(22)}`)).json())
    received = []
    const response = await t.request(`/api/chats/${chatId(22)}/branch`, json('POST', { messageId: mid(220) }))
    expect(response.status).toBe(200)
    const detail = chatDetailSchema.parse(await response.json())
    expect(ids(detail.messages)).toEqual([mid(220), mid(221), mid(222), mid(223)])
    expect(detail.branches).toEqual({ [mid(220)]: { siblings: [mid(220), mid(224)], index: 0 } })
    expect(detail.updatedAt).toBe(before.updatedAt)
    expect(received.map(event => event.type)).toEqual(['chat.updated'])
    // The switch is stored: a reload shows the same version.
    expect(ids(chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId(22)}`)).json()).messages)).toEqual(ids(detail.messages))
    const back = chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId(22)}/branch`, json('POST', { messageId: mid(224) }))).json())
    expect(ids(back.messages)).toEqual([mid(224), mid(225)])
  })

  it.each([
    [{}],
    [{ messageId: 'nope' }],
    [{ messageId: mid(220), extra: true }],
  ])('pOST /api/chats/:id/branch answers 400 for the body %j', async (body) => {
    const response = await t.request(`/api/chats/${chatId(22)}/branch`, json('POST', body))
    expect(response.status).toBe(400)
    expect((await errorOf(response)).code).toBe('validation_error')
  })

  it('pOST /api/chats/:id/branch answers 400 for a malformed chat id and 404 for an unknown chat or message', async () => {
    expect((await t.request('/api/chats/not-a-chat/branch', json('POST', { messageId: mid(220) }))).status).toBe(400)
    const unknownChat = await t.request(`/api/chats/${chatId(99)}/branch`, json('POST', { messageId: mid(220) }))
    expect(unknownChat.status).toBe(404)
    expect((await errorOf(unknownChat)).code).toBe('not_found')
    await t.request('/api/chats', json('POST', treeBody(chatId(23), 230)))
    const foreign = await t.request(`/api/chats/${chatId(23)}/branch`, json('POST', { messageId: mid(220) }))
    expect(foreign.status).toBe(404)
    expect(received.filter(event => event.type === 'chat.updated')).toEqual([])
  })

  it('pOST /api/chats/:id/branch answers 409 conflict (run-active) while a run holds the chat, in any phase', async () => {
    await t.request('/api/chats', json('POST', treeBody(chatId(24), 240)))
    holding.add(chatId(24))
    received = []
    const response = await t.request(`/api/chats/${chatId(24)}/branch`, json('POST', { messageId: mid(240) }))
    expect(response.status).toBe(409)
    expect(await errorOf(response)).toMatchObject({ code: 'conflict', details: { reason: 'run-active', chatId: chatId(24) } })
    expect(received).toEqual([])
    expect(ids(chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId(24)}`)).json()).messages)).toEqual([mid(244), mid(245)])
    holding.delete(chatId(24))
    expect((await t.request(`/api/chats/${chatId(24)}/branch`, json('POST', { messageId: mid(240) }))).status).toBe(200)
  })

  it('gET /api/chats/:id/export?format=json carries every version, the parents and the active leaf', async () => {
    await t.request('/api/chats', json('POST', treeBody(chatId(25), 250)))
    const body = chatExportSchema.parse(await (await t.request(`/api/chats/${chatId(25)}/export?format=json`)).json())
    expect(body.version).toBe(2)
    expect(ids(body.chat.messages)).toEqual([250, 251, 252, 253, 254, 255].map(mid))
    expect(body.chat.parentIds).toEqual([null, mid(250), mid(251), mid(252), null, mid(254)])
    expect(body.chat.activeLeafId).toBe(mid(255))
    // Imported again under a new chat id (the message ids are taken: they are replaced), the tree comes back.
    const { id: _id, ...chat } = body.chat
    const imported = await t.request('/api/chats', json('POST', { id: chatId(26), messages: chat.messages, parentIds: chat.parentIds, activeLeafId: chat.activeLeafId }))
    expect(imported.status).toBe(201)
    const detail = chatDetailSchema.parse(await imported.json())
    expect(detail.messages.map(message => (message.parts[0] as { text: string }).text)).toEqual(['A2', 'RA2'])
    expect(Object.values(detail.branches)).toHaveLength(1)
    expect(ids(detail.messages).some(id => ids(body.chat.messages).includes(id))).toBe(false)
  })
})

describe('dELETE /api/chats/:id/messages/:messageId (ADR-030)', () => {
  function del(id: string, messageId: string): Promise<Response> {
    return t.request(`/api/chats/${id}/messages/${messageId}`, { method: 'DELETE' })
  }

  it('deletes a version and everything after it: 200 ChatDetail, chat.updated with the new active leaf', async () => {
    await t.request('/api/chats', json('POST', treeBody(chatId(40), 400)))
    const before = chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId(40)}`)).json())
    received = []
    const response = await del(chatId(40), mid(404))
    expect(response.status).toBe(200)
    const detail = chatDetailSchema.parse(await response.json())
    // A2 was shown: the path moves to the previous version A and what was last shown under it.
    expect(ids(detail.messages)).toEqual([mid(400), mid(401), mid(402), mid(403)])
    expect(detail.branches).toEqual({})
    expect(detail.updatedAt).toBe(before.updatedAt)
    expect(chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId(40)}`)).json())).toEqual(detail)
    expect(received.map(event => event.type)).toEqual(['chat.updated'])
    expect(received[0]).toMatchObject({ data: { id: chatId(40), activeLeafId: mid(403) } })
    // The deleted versions are gone from the JSON export too.
    const exported = chatExportSchema.parse(await (await t.request(`/api/chats/${chatId(40)}/export?format=json`)).json())
    expect(ids(exported.chat.messages)).toEqual([mid(400), mid(401), mid(402), mid(403)])
  })

  it('answers 404 for an unknown chat or message and 400 for malformed params', async () => {
    await t.request('/api/chats', json('POST', treeBody(chatId(41), 410)))
    const unknownChat = await del(chatId(99), mid(410))
    expect(unknownChat.status).toBe(404)
    expect(await errorOf(unknownChat)).toEqual({ code: 'not_found', message: `Chat ${chatId(99)} not found.` })
    const unknownMessage = await del(chatId(41), mid(400))
    expect(unknownMessage.status).toBe(404)
    expect(await errorOf(unknownMessage)).toEqual({ code: 'not_found', message: `Message ${mid(400)} not found in chat ${chatId(41)}.` })
    for (const path of [`/api/chats/not-a-chat/messages/${mid(410)}`, `/api/chats/${chatId(41)}/messages/msg_short`]) {
      const response = await t.request(path, { method: 'DELETE' })
      expect(response.status, path).toBe(400)
      expect((await errorOf(response)).code).toBe('validation_error')
    }
    expect(received.filter(event => event.type === 'chat.updated')).toEqual([])
  })

  it('answers 409 conflict (only-version) for a message without another version', async () => {
    await t.request('/api/chats', json('POST', treeBody(chatId(42), 420)))
    received = []
    const response = await del(chatId(42), mid(425))
    expect(response.status).toBe(409)
    expect(await errorOf(response)).toEqual({
      code: 'conflict',
      message: 'This is the only version of the message. Delete the chat instead.',
      details: { reason: 'only-version' },
    })
    expect(received).toEqual([])
    expect(ids(chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId(42)}`)).json()).messages)).toEqual([mid(424), mid(425)])
  })

  it('answers 409 conflict (run-active) while a run holds the chat, in any phase, and deletes nothing', async () => {
    await t.request('/api/chats', json('POST', treeBody(chatId(43), 430)))
    holding.add(chatId(43))
    received = []
    const response = await del(chatId(43), mid(434))
    expect(response.status).toBe(409)
    expect(await errorOf(response)).toEqual({
      code: 'conflict',
      message: 'A reply is already being generated for this chat. Stop it or wait until it finishes.',
      details: { reason: 'run-active', chatId: chatId(43) },
    })
    expect(received).toEqual([])
    const body = chatExportSchema.parse(await (await t.request(`/api/chats/${chatId(43)}/export?format=json`)).json())
    expect(body.chat.messages).toHaveLength(6)
    holding.delete(chatId(43))
    expect((await del(chatId(43), mid(434))).status).toBe(200)
  })
})

describe('pOST /api/chats/:id/branch with a real run held in preparing', () => {
  it('is refused while the run holds the chat and accepted once it is released', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const app = await createTestApp({
      env: { HF_MOCK_PROVIDER: '1' },
      factories: {
        chats: (deps): ChatsService => {
          const chats = createChatsService(deps)
          return {
            ...chats,
            ensure: async (id, init) => {
              await gate
              return chats.ensure(id, init)
            },
          }
        },
      },
    })
    try {
      const id = testChatId(300)
      expect((await app.request('/api/chats', json('POST', treeBody(id, 300)))).status).toBe(201)
      const finished = nextEvent(app, 'run.finished', event => event.data.chatId === id)
      const run = app.deps.runs.start(chatBody(id, 'while switching'), { logger: app.logs.logger, requestId: 'req-gated' })
      expect(app.deps.runs.hasRun(id)).toBe(true)
      const refused = await app.request(`/api/chats/${id}/branch`, json('POST', { messageId: mid(300) }))
      expect(refused.status).toBe(409)
      expect(await errorOf(refused)).toMatchObject({ code: 'conflict', details: { reason: 'run-active', chatId: id } })
      release()
      await (await run).text()
      await finished
      // The run answered on the path it was sent from (the active leaf RA2); the old version is still there.
      const after = chatDetailSchema.parse(await (await app.request(`/api/chats/${id}`)).json())
      expect(after.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
      expect(ids(after.messages).slice(0, 2)).toEqual([mid(304), mid(305)])
      const switched = await app.request(`/api/chats/${id}/branch`, json('POST', { messageId: mid(300) }))
      expect(switched.status).toBe(200)
      expect(ids(chatDetailSchema.parse(await switched.json()).messages)).toEqual([mid(300), mid(301), mid(302), mid(303)])
    }
    finally {
      release()
      await app.close()
    }
  })
})
