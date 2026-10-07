import type { HarnessUIMessage, ServerEvent } from '@harness-forge/shared'
import type { ChatRunner } from '../../chat/types.ts'
import type { ChatsService } from '../../services/chats/types.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeHookService } from '../../testing/fake-hooks.ts'
import {
  chatDetailSchema,
  chatExportSchema,
  chatSummarySchema,
  cursorPageSchema,
  harnessErrorEnvelopeSchema,
} from '@harness-forge/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatBody, nextEvent, testChatId } from '../../chat/testing.ts'
import { projects } from '../../db/schema.ts'
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
    queueList: () => [],
    enqueue: async () => Promise.reject(new Error('not used')),
    dequeue: () => false,
    clearQueue: () => [],
    // Phase 10: the background task members (no background tasks here).
    boot: async () => {},
    taskList: async () => [],
    stopTask: async () => null,
    stopTasks: async () => 0,
    hasTasks: () => false,
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

describe('projects (ADR-031)', () => {
  const PROJECT_A = 'prj_routeprojecta001'
  const PROJECT_B = 'prj_routeprojectb001'
  const UNKNOWN_PROJECT = 'prj_routeunknown0001'

  beforeAll(async () => {
    await t.db.insert(projects).values([PROJECT_A, PROJECT_B].map((id, index) => ({ id, name: `Project ${index}`, path: `/workspaces/${id}`, createdAt: 1, updatedAt: 1 })))
  })

  async function page(path: string) {
    const response = await t.request(path)
    expect(response.status).toBe(200)
    return chatPageSchema.parse(await response.json())
  }

  it('pOST /api/chats with projectId: 201 with the project and chat.created carries it; an unknown project is 404', async () => {
    const response = await t.request('/api/chats', json('POST', { id: chatId(60), title: 'Project chat', projectId: PROJECT_A }))
    expect(response.status).toBe(201)
    expect(chatDetailSchema.parse(await response.json()).projectId).toBe(PROJECT_A)
    expect(received.map(event => [event.type, (event.data as { projectId?: unknown }).projectId])).toEqual([['chat.created', PROJECT_A]])

    const unknown = await t.request('/api/chats', json('POST', { id: chatId(61), projectId: UNKNOWN_PROJECT, messages: [userMessage(610, 'hi')] }))
    expect(unknown.status).toBe(404)
    expect((await errorOf(unknown)).code).toBe('not_found')
    expect((await t.request(`/api/chats/${chatId(61)}`)).status).toBe(404)
    const malformed = await t.request('/api/chats', json('POST', { id: chatId(61), projectId: 'prj_bad' }))
    expect(malformed.status).toBe(400)
  })

  it('gET /api/chats?projectId=<id> and ?projectId=none filter (with search and the cursor); an unknown project lists nothing', async () => {
    await t.request('/api/chats', json('POST', { id: chatId(62), title: 'Second project chat', projectId: PROJECT_A }))
    await t.request('/api/chats', json('POST', { id: chatId(63), title: 'Other project chat', projectId: PROJECT_B }))
    await t.request('/api/chats', json('POST', { id: chatId(64), title: 'Loose project chat' }))

    const inA = await page(`/api/chats?projectId=${PROJECT_A}`)
    expect(inA.items.map(chat => [chat.id, chat.projectId])).toEqual([[chatId(62), PROJECT_A], [chatId(60), PROJECT_A]])
    const firstOfA = await page(`/api/chats?projectId=${PROJECT_A}&limit=1`)
    expect(firstOfA.items.map(chat => chat.id)).toEqual([chatId(62)])
    const secondOfA = await page(`/api/chats?projectId=${PROJECT_A}&limit=1&cursor=${firstOfA.nextCursor}`)
    expect(secondOfA).toMatchObject({ items: [{ id: chatId(60) }], nextCursor: null })

    const none = await page('/api/chats?projectId=none&limit=100')
    expect(none.items.map(chat => chat.id)).toContain(chatId(64))
    expect(none.items.every(chat => chat.projectId === null)).toBe(true)
    expect((await page('/api/chats?limit=100')).items.map(chat => chat.id)).toEqual(expect.arrayContaining([60, 62, 63, 64].map(chatId)))

    const search = await page(`/api/chats?q=PROJECT%20CHAT&projectId=${PROJECT_B}`)
    expect(search.items.map(chat => [chat.id, chat.projectId])).toEqual([[chatId(63), PROJECT_B]])
    expect((await page(`/api/chats?projectId=${UNKNOWN_PROJECT}`))).toEqual({ items: [], nextCursor: null })
  })

  it.each([
    '/api/chats?projectId=',
    '/api/chats?projectId=prj_short',
    '/api/chats?projectId=NONE',
    '/api/chats?projectId=null',
  ])('gET %s answers 400 validation_error', async (path) => {
    const response = await t.request(path)
    expect(response.status).toBe(400)
    expect((await errorOf(response)).code).toBe('validation_error')
  })

  it('pATCH /api/chats/:id { projectId } moves the chat (200 ChatSummary, chat.updated), null moves it out', async () => {
    const id = chatId(64)
    const moved = await t.request(`/api/chats/${id}`, json('PATCH', { projectId: PROJECT_B }))
    expect(moved.status).toBe(200)
    const summary = chatSummarySchema.parse(await moved.json())
    expect(summary).toMatchObject({ id, projectId: PROJECT_B })
    expect(received).toEqual([expect.objectContaining({ type: 'chat.updated', data: { ...summary, activeLeafId: null } })])
    expect((await page(`/api/chats?projectId=${PROJECT_B}`)).items.map(chat => chat.id)).toContain(id)

    const out = await t.request(`/api/chats/${id}`, json('PATCH', { projectId: null }))
    expect(out.status).toBe(200)
    expect(chatSummarySchema.parse(await out.json()).projectId).toBeNull()
    expect(received.map(event => [event.type, (event.data as { projectId?: unknown }).projectId])).toEqual([['chat.updated', PROJECT_B], ['chat.updated', null]])
  })

  it('pATCH /api/chats/:id { projectId } answers 404 for an unknown project (nothing changes) or chat, 400 for a malformed id', async () => {
    const id = chatId(60)
    const unknown = await t.request(`/api/chats/${id}`, json('PATCH', { title: 'Lost', projectId: UNKNOWN_PROJECT }))
    expect(unknown.status).toBe(404)
    expect(await errorOf(unknown)).toMatchObject({ code: 'not_found' })
    expect(chatDetailSchema.parse(await (await t.request(`/api/chats/${id}`)).json())).toMatchObject({ title: 'Project chat', projectId: PROJECT_A })
    expect(received).toEqual([])
    expect((await t.request(`/api/chats/${chatId(99)}`, json('PATCH', { projectId: PROJECT_A }))).status).toBe(404)
    expect((await t.request(`/api/chats/${id}`, json('PATCH', { projectId: 'prj_bad' }))).status).toBe(400)
    expect((await t.request(`/api/chats/${id}`, json('PATCH', { projectId: 'none' }))).status).toBe(400)
  })

  it('pATCH /api/chats/:id { projectId } answers 409 conflict (run-active) while a run holds the chat; a rename still works', async () => {
    const id = chatId(62)
    holding.add(id)
    for (const projectId of [PROJECT_B, null]) {
      const refused = await t.request(`/api/chats/${id}`, json('PATCH', { projectId }))
      expect(refused.status).toBe(409)
      expect(await errorOf(refused)).toMatchObject({ code: 'conflict', details: { reason: 'run-active', chatId: id } })
    }
    expect(received).toEqual([])
    const renamed = await t.request(`/api/chats/${id}`, json('PATCH', { title: 'Renamed during a run' }))
    expect(chatSummarySchema.parse(await renamed.json())).toMatchObject({ title: 'Renamed during a run', projectId: PROJECT_A })
    holding.delete(id)
    const moved = await t.request(`/api/chats/${id}`, json('PATCH', { projectId: PROJECT_B }))
    expect(chatSummarySchema.parse(await moved.json()).projectId).toBe(PROJECT_B)
  })

  it('gET /api/chats/:id/export never carries the project (JSON and Markdown)', async () => {
    const json = await t.request(`/api/chats/${chatId(60)}/export?format=json`)
    const text = await json.text()
    expect(text).not.toContain(PROJECT_A)
    expect((JSON.parse(text) as { chat: object }).chat).not.toHaveProperty('projectId')
    expect(chatExportSchema.parse(JSON.parse(text)).chat.id).toBe(chatId(60))
    expect(await (await t.request(`/api/chats/${chatId(60)}/export?format=md`)).text()).not.toContain(PROJECT_A)
  })
})

describe('pATCH /api/chats/:id { projectId } with a real run held in preparing', () => {
  it('is refused (409 run-active) while the run holds the chat and accepted once it is released', async () => {
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
      const project = 'prj_realrunproject01'
      await app.db.insert(projects).values({ id: project, name: 'Run project', path: '/workspaces/run', createdAt: 1, updatedAt: 1 })
      const id = testChatId(310)
      expect((await app.request('/api/chats', json('POST', { id }))).status).toBe(201)
      const finished = nextEvent(app, 'run.finished', event => event.data.chatId === id)
      const run = app.deps.runs.start(chatBody(id, 'while moving'), { logger: app.logs.logger, requestId: 'req-move' })
      expect(app.deps.runs.hasRun(id)).toBe(true)
      const refused = await app.request(`/api/chats/${id}`, json('PATCH', { projectId: project }))
      expect(refused.status).toBe(409)
      expect(await errorOf(refused)).toMatchObject({ code: 'conflict', details: { reason: 'run-active', chatId: id } })
      release()
      await (await run).text()
      await finished
      const moved = await app.request(`/api/chats/${id}`, json('PATCH', { projectId: project }))
      expect(moved.status).toBe(200)
      expect(chatSummarySchema.parse(await moved.json()).projectId).toBe(project)
    }
    finally {
      release()
      await app.close()
    }
  })
})

describe('dELETE /api/chats/:id: SessionEnd (Phase 12, C44 call site)', () => {
  let app: TestApp
  let hooks: FakeHookService

  beforeAll(async () => {
    const runs = { ...t.deps.runs, stop: async () => false, stopTasks: async () => 0, hasRun: () => false, hasTasks: () => false }
    app = await createTestApp({ start: false, hooks: 'fake', overrides: { runs } })
    hooks = app.deps.hooks as FakeHookService
  })

  afterAll(async () => {
    await app.close()
  })

  it('hands the deleted chat (as it was) to the SessionEnd hooks once, after chat.deleted; a 404 calls nothing', async () => {
    const project = 'prj_sessionendproj01'
    await app.db.insert(projects).values({ id: project, name: 'Session project', path: '/workspaces/session', createdAt: 1, updatedAt: 1 })
    const id = chatId(900)
    expect((await app.request('/api/chats', json('POST', { id, projectId: project }))).status).toBe(201)
    const order: string[] = []
    app.deps.events.subscribe((event) => {
      if (event.type === 'chat.deleted')
        order.push(`deleted:${hooks.sessionEnds.length}`)
    })
    expect((await app.request(`/api/chats/${id}`, { method: 'DELETE' })).status).toBe(204)
    expect(hooks.calls.sessionEnd).toBe(1)
    expect(hooks.sessionEnds).toHaveLength(1)
    expect(hooks.sessionEnds[0]).toMatchObject({ id, projectId: project })
    // The chat was already deleted when its session ended.
    expect(order).toEqual(['deleted:0'])
    expect((await app.request(`/api/chats/${id}`, { method: 'DELETE' })).status).toBe(404)
    expect(hooks.calls.sessionEnd).toBe(1)
  })

  it('only a single chat delete ends a session: a project delete and delete-all never call SessionEnd (W12.6-T6)', async () => {
    const project = 'prj_sessionendproj02'
    await app.db.insert(projects).values({ id: project, name: 'Session project 2', path: '/workspaces/session2', createdAt: 1, updatedAt: 1 })
    const inProject = chatId(910)
    const plain = chatId(911)
    expect((await app.request('/api/chats', json('POST', { id: inProject, projectId: project }))).status).toBe(201)
    expect((await app.request('/api/chats', json('POST', { id: plain }))).status).toBe(201)
    const before = hooks.calls.sessionEnd
    const ended = hooks.sessionEnds.length

    // A project delete detaches its chats: no session ends.
    expect((await app.request(`/api/projects/${project}`, { method: 'DELETE' })).status).toBe(204)
    expect((await app.request(`/api/chats/${inProject}`)).status).toBe(200)

    // Delete-all removes every chat: no session ends either.
    const deleted = await app.request('/api/data/delete', json('POST', { confirm: 'DELETE' }))
    expect(deleted.status).toBe(200)
    expect(((await deleted.json()) as { chats: number }).chats).toBeGreaterThanOrEqual(2)
    expect((await app.request(`/api/chats/${inProject}`)).status).toBe(404)
    expect((await app.request(`/api/chats/${plain}`)).status).toBe(404)
    expect(hooks.calls.sessionEnd).toBe(before)
    expect(hooks.sessionEnds).toHaveLength(ended)
  })

  it('a failing SessionEnd never fails the delete', async () => {
    const id = chatId(901)
    expect((await app.request('/api/chats', json('POST', { id }))).status).toBe(201)
    const original = hooks.sessionEnd
    Object.assign(hooks, { sessionEnd: async () => Promise.reject(new Error('broken')) })
    try {
      expect((await app.request(`/api/chats/${id}`, { method: 'DELETE' })).status).toBe(204)
      Object.assign(hooks, { sessionEnd: () => {
        throw new Error('broken')
      } })
      const other = chatId(902)
      expect((await app.request('/api/chats', json('POST', { id: other }))).status).toBe(201)
      expect((await app.request(`/api/chats/${other}`, { method: 'DELETE' })).status).toBe(204)
    }
    finally {
      Object.assign(hooks, { sessionEnd: original })
    }
  })
})
