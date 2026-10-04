// The project of a chat (Phase 7, ADR-031, W7.5): `projectId` in records, summaries, search results and events
// (W7.5-T1), the list filter (W7.5-T2), `ensure` and the move of `update` (W7.5-T3), exports and imports (W7.5-T4).
import type { ChatExportAny, HarnessUIMessage } from '@harness-forge/shared'
import type { ChatRunner } from '../../chat/types.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { RecordingEventBus } from '../../testing/fakes.ts'
import type { ChatListFilter } from './list.ts'
import type { ChatsService } from './types.ts'
import { chatExportSchema, chatSummarySchema, HarnessError, serverEventSchema } from '@harness-forge/shared'
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chats, projects } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createRecordingEventBus } from '../../testing/fakes.ts'
import { encodeChatCursor } from './cursor.ts'
import { IMPORT_DENIAL_REASON } from './import.ts'
import { chatPageQuery } from './list.ts'

let t: TestApp
let service: ChatsService
let events: RecordingEventBus
let activeRuns: Set<string>

function chatId(n: number): string {
  return `0199a8f0-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
}

function messageId(n: number): string {
  return `msg_${n.toString().padStart(16, '0')}`
}

function projectId(n: number): string {
  return `prj_${n.toString().padStart(16, '0')}`
}

/** A project id that has no row. */
const UNKNOWN_PROJECT = 'prj_unknownproject00'

function userMessage(id: string, text: string): HarnessUIMessage {
  return { id, role: 'user', metadata: { modelRef: 'mock:echo', startedAt: 1 }, parts: [{ type: 'text', text }] }
}

/** A `projects` row (the chats service only needs the row; folders belong to the project service). */
async function addProject(n: number): Promise<string> {
  const id = projectId(n)
  await t.db.insert(projects).values({ id, name: `Project ${n}`, path: `/workspaces/project-${n}`, createdAt: n, updatedAt: n })
  return id
}

async function insertChat(n: number, updatedAt: number, fields: Partial<typeof chats.$inferInsert> = {}): Promise<string> {
  const id = chatId(n)
  await t.db.insert(chats).values({ id, createdAt: updatedAt, updatedAt, ...fields })
  return id
}

async function storedProject(id: string): Promise<string | null | undefined> {
  const [row] = await t.db.select({ projectId: chats.projectId }).from(chats).where(eq(chats.id, id))
  return row?.projectId
}

async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  }
  catch (error) {
    expect(error).toBeInstanceOf(HarnessError)
    return error as HarnessError
  }
  throw new Error('expected a rejection')
}

beforeEach(async () => {
  events = createRecordingEventBus()
  activeRuns = new Set()
  const runs: ChatRunner = {
    start: async () => new Response(null),
    resume: () => null,
    stop: async () => false,
    isActive: id => activeRuns.has(id),
    hasRun: id => activeRuns.has(id),
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
  t = await createTestApp({ start: false, overrides: { events, runs } })
  service = t.deps.chats
})

afterEach(async () => {
  await t.close()
})

describe('records and events (W7.5-T1)', () => {
  it('create stores the project; the detail, the record, the summary and chat.created carry it', async () => {
    const project = await addProject(1)
    const detail = await service.create({ id: chatId(1), title: 'In a project', projectId: project })
    expect(detail.projectId).toBe(project)
    expect((await service.find(chatId(1)))?.projectId).toBe(project)
    expect((await service.summary(chatId(1))).projectId).toBe(project)
    expect((await service.get(chatId(1))).projectId).toBe(project)
    const [created] = events.ofType('chat.created')
    expect(serverEventSchema.parse(created)).toEqual(created)
    expect(created?.data).toMatchObject({ id: chatId(1), projectId: project })

    const plain = await service.create({ id: chatId(2) })
    expect(plain.projectId).toBeNull()
    expect(events.ofType('chat.created')[1]?.data.projectId).toBeNull()
  })

  it('every chat.updated (update, touch, setTitle, switchBranch, deleteMessage) carries the project', async () => {
    const project = await addProject(1)
    await service.create({
      id: chatId(1),
      projectId: project,
      messages: [userMessage(messageId(1), 'first'), userMessage(messageId(2), 'second')],
      parentIds: [null, null],
    })
    events.clear()
    await service.update(chatId(1), { pinned: true })
    await service.touch(chatId(1))
    await service.setTitle(chatId(1), 'Auto', 'auto')
    await service.switchBranch(chatId(1), messageId(1))
    await service.deleteMessage(chatId(1), messageId(2))
    const updated = events.ofType('chat.updated')
    expect(updated).toHaveLength(5)
    for (const event of updated) {
      expect(serverEventSchema.parse(event)).toEqual(event)
      expect(event.data.projectId).toBe(project)
    }
  })

  it('list and search results carry the project', async () => {
    const project = await addProject(1)
    await insertChat(1, 100, { title: 'Lisbon trip', projectId: project })
    await insertChat(2, 200, { title: 'Lisbon food' })
    const list = await service.list({})
    expect(list.items.map(chat => [chat.id, chat.projectId])).toEqual([[chatId(2), null], [chatId(1), project]])
    const search = await service.list({ q: 'lisbon' })
    expect(search.items.map(chat => [chat.id, chat.projectId])).toEqual([[chatId(2), null], [chatId(1), project]])
    for (const item of [...list.items, ...search.items])
      expect(chatSummarySchema.parse(item)).toEqual(item)
  })
})

describe('the project filter (W7.5-T2)', () => {
  async function seed() {
    const a = await addProject(1)
    const b = await addProject(2)
    // updatedAt: chat n at n * 100; chats 1, 3, 5, 7 in A (7 archived), 2 in B, 4 and 6 without a project.
    await insertChat(1, 100, { projectId: a, title: 'alpha one' })
    await insertChat(2, 200, { projectId: b, title: 'bravo one' })
    await insertChat(3, 300, { projectId: a, title: 'alpha two' })
    await insertChat(4, 400, { title: 'none one' })
    await insertChat(5, 500, { projectId: a, title: 'alpha three' })
    await insertChat(6, 600, { title: 'none two' })
    await insertChat(7, 700, { projectId: a, title: 'alpha archived', archived: true })
    return { a, b }
  }

  function idsOf(page: { items: { id: string }[] }): string[] {
    return page.items.map(chat => chat.id)
  }

  it('a project id lists only its chats, none only chats without a project, omitted every chat', async () => {
    const { a, b } = await seed()
    expect(idsOf(await service.list({ projectId: a }))).toEqual([5, 3, 1].map(chatId))
    expect(idsOf(await service.list({ projectId: b }))).toEqual([chatId(2)])
    expect(idsOf(await service.list({ projectId: 'none' }))).toEqual([6, 4].map(chatId))
    expect(idsOf(await service.list({}))).toEqual([6, 5, 4, 3, 2, 1].map(chatId))
  })

  it('combines with archived; an unknown project lists nothing (no error)', async () => {
    const { a } = await seed()
    expect(idsOf(await service.list({ projectId: a, archived: true }))).toEqual([chatId(7)])
    expect(idsOf(await service.list({ projectId: 'none', archived: true }))).toEqual([])
    expect(await service.list({ projectId: UNKNOWN_PROJECT })).toEqual({ items: [], nextCursor: null })
  })

  it('pages with the cursor inside a filter', async () => {
    const { a } = await seed()
    const first = await service.list({ projectId: a, limit: 2 })
    expect(idsOf(first)).toEqual([5, 3].map(chatId))
    expect(first.nextCursor).toBe(encodeChatCursor({ updatedAt: 300, id: chatId(3) }))
    const second = await service.list({ projectId: a, limit: 2, cursor: first.nextCursor! })
    expect(second).toMatchObject({ nextCursor: null })
    expect(idsOf(second)).toEqual([chatId(1)])

    const none = await service.list({ projectId: 'none', limit: 1 })
    expect(idsOf(none)).toEqual([chatId(6)])
    expect(idsOf(await service.list({ projectId: 'none', limit: 1, cursor: none.nextCursor! }))).toEqual([chatId(4)])
  })

  it('search keeps the filter, the snippets and the cursor', async () => {
    const { a } = await seed()
    await service.create({ id: chatId(8), projectId: a, messages: [userMessage(messageId(1), 'The alpha plan, in detail')] })
    const found = await service.list({ q: 'ALPHA', projectId: a, limit: 2 })
    expect(idsOf(found)).toEqual([chatId(8), chatId(5)])
    expect(found.items[0]?.snippet).toContain('alpha plan')
    const rest = await service.list({ q: 'alpha', projectId: a, limit: 2, cursor: found.nextCursor! })
    expect(idsOf(rest)).toEqual([3, 1].map(chatId))
    expect(rest.nextCursor).toBeNull()
    expect(idsOf(await service.list({ q: 'two', projectId: 'none' }))).toEqual([chatId(6)])
    expect(idsOf(await service.list({ q: 'alpha', projectId: 'none' }))).toEqual([])
    expect(idsOf(await service.list({ q: 'alpha', projectId: a, archived: true }))).toEqual([chatId(7)])
  })

  it('walks chats_project_idx with a project filter and chats_list_idx without one: one range, never a sort', async () => {
    async function plan(filter: ChatListFilter, after: { updatedAt: number, id: string } | null): Promise<string[]> {
      const rows = await t.db.all<{ detail: string }>(sql`EXPLAIN QUERY PLAN ${chatPageQuery(t.db, filter, after, 51).getSQL()}`)
      return rows.map(row => row.detail)
    }
    const cursor = { updatedAt: 500, id: chatId(5) }
    for (const filter of [{ archived: false, projectId: projectId(1) }, { archived: true, projectId: 'none' }]) {
      expect(await plan(filter, null), JSON.stringify(filter)).toEqual(['SEARCH chats USING INDEX chats_project_idx (project_id=? AND archived=?)'])
      expect(await plan(filter, cursor), JSON.stringify(filter)).toEqual(['SEARCH chats USING INDEX chats_project_idx (project_id=? AND archived=? AND (updated_at,id)<(?,?))'])
    }
    expect(await plan({ archived: false }, null)).toEqual(['SEARCH chats USING INDEX chats_list_idx (archived=?)'])
    expect(await plan({ archived: false }, cursor)).toEqual(['SEARCH chats USING INDEX chats_list_idx (archived=? AND (updated_at,id)<(?,?))'])
  })
})

describe('ensure (W7.5-T3)', () => {
  it('applies the project only when it creates the chat', async () => {
    const a = await addProject(1)
    const b = await addProject(2)
    const first = await service.ensure(chatId(1), { modelRef: 'mock:echo', projectId: a })
    expect(first).toMatchObject({ created: true, chat: { projectId: a } })
    expect(events.ofType('chat.created').map(event => event.data.projectId)).toEqual([a])

    const again = await service.ensure(chatId(1), { modelRef: 'mock:reasoning', projectId: b })
    expect(again).toMatchObject({ created: false, chat: { projectId: a, modelRef: 'mock:reasoning' } })
    // An unknown project is ignored for an existing chat, too.
    expect(await service.ensure(chatId(1), { projectId: UNKNOWN_PROJECT })).toMatchObject({ created: false, chat: { projectId: a } })
    expect(await storedProject(chatId(1))).toBe(a)
    expect(events.ofType('chat.created')).toHaveLength(1)

    // A chat without a project keeps none.
    await service.ensure(chatId(2))
    expect((await service.ensure(chatId(2), { projectId: a })).chat.projectId).toBeNull()
  })

  it('an unknown project is not_found before the chat row exists; a malformed id is a validation_error', async () => {
    const missing = await rejection(service.ensure(chatId(1), { projectId: UNKNOWN_PROJECT }))
    expect(missing.code).toBe('not_found')
    expect(missing.message).toContain(UNKNOWN_PROJECT)
    expect(await service.find(chatId(1))).toBeNull()
    expect(events.events).toHaveLength(0)

    const malformed = await rejection(service.ensure(chatId(1), { projectId: 'project-1' }))
    expect(malformed.code).toBe('validation_error')
    expect((malformed.details as { issues: { path: unknown[] }[] }).issues[0]?.path).toEqual(['projectId'])
    expect(await service.find(chatId(1))).toBeNull()
  })

  it('never stores a project whose row is gone (the insert reads the project row again)', async () => {
    const project = await addProject(1)
    // The project is deleted right after `ensure` checked it (between the check and the insert).
    const db = t.db as unknown as { select: (...args: unknown[]) => { from: (table: unknown) => PromiseLike<unknown> } }
    const select = db.select.bind(db)
    db.select = (...args) => {
      const builder = select(...args)
      const from = builder.from.bind(builder)
      builder.from = (table) => {
        const query = from(table) as { then: PromiseLike<unknown>['then'] }
        if (table === projects) {
          const then = query.then.bind(query)
          query.then = (onFulfilled, onRejected) => then(async (rows) => {
            await t.db.delete(projects).where(eq(projects.id, project))
            return rows
          }).then(onFulfilled, onRejected)
        }
        return query
      }
      return builder
    }
    try {
      const { created, chat } = await service.ensure(chatId(1), { projectId: project })
      expect(created).toBe(true)
      expect(chat.projectId).toBeNull()
    }
    finally {
      db.select = select
    }
    expect(await t.db.select().from(projects)).toEqual([])
    expect(await storedProject(chatId(1))).toBeNull()
  })
})

describe('create (POST /chats)', () => {
  it('an unknown project is not_found and creates nothing', async () => {
    const error = await rejection(service.create({ id: chatId(1), projectId: UNKNOWN_PROJECT, messages: [userMessage(messageId(1), 'hi')] }))
    expect(error.code).toBe('not_found')
    expect(await service.allIds()).toEqual([])
    expect(events.events).toHaveLength(0)
  })

  it('an import without projectId gets no project', async () => {
    await addProject(1)
    const detail = await service.create({ id: chatId(1), messages: [userMessage(messageId(1), 'hi')] })
    expect(detail.projectId).toBeNull()
  })
})

describe('the move: update with projectId (W7.5-T3)', () => {
  it('moves into a project, to another and out of it; keeps updatedAt; chat.updated carries the new summary', async () => {
    const a = await addProject(1)
    const b = await addProject(2)
    const id = await insertChat(1, 1000, { activeLeafId: null })
    events.clear()

    const moved = await service.update(id, { projectId: a })
    expect(moved).toMatchObject({ id, projectId: a, updatedAt: 1000 })
    expect(chatSummarySchema.parse(moved)).toEqual(moved)
    const [event] = events.ofType('chat.updated')
    expect(serverEventSchema.parse(event)).toEqual(event)
    expect(event?.data).toEqual({ ...moved, activeLeafId: null })

    expect((await service.update(id, { projectId: b })).projectId).toBe(b)
    expect((await service.update(id, { projectId: b })).projectId).toBe(b)
    expect((await service.update(id, { projectId: null })).projectId).toBeNull()
    expect((await service.update(id, { projectId: null })).projectId).toBeNull()
    expect(await storedProject(id)).toBeNull()
    expect(events.ofType('chat.updated').map(entry => entry.data.projectId)).toEqual([a, b, b, null, null])
    expect((await service.find(id))?.updatedAt).toBe(1000)
  })

  it('moves together with other fields', async () => {
    const a = await addProject(1)
    const id = await insertChat(1, 1000)
    expect(await service.update(id, { title: 'Moved', pinned: true, projectId: a })).toMatchObject({ title: 'Moved', pinned: true, projectId: a })
  })

  it('an unknown project is not_found and changes nothing (the other fields included), no event', async () => {
    const a = await addProject(1)
    const id = await insertChat(1, 1000, { title: 'Kept', projectId: a })
    events.clear()
    const error = await rejection(service.update(id, { title: 'Lost', projectId: UNKNOWN_PROJECT }))
    expect(error.code).toBe('not_found')
    expect(error.message).toContain(UNKNOWN_PROJECT)
    expect(await service.find(id)).toMatchObject({ title: 'Kept', projectId: a })
    expect(events.events).toHaveLength(0)
  })

  it('an unknown chat is not_found (with a known, an unknown or no project)', async () => {
    const a = await addProject(1)
    for (const target of [a, UNKNOWN_PROJECT, null]) {
      const error = await rejection(service.update(chatId(9), { projectId: target }))
      expect(error.code).toBe('not_found')
      expect(error.message).toContain(chatId(9))
    }
    expect((await rejection(service.update('not-a-chat', { projectId: a }))).code).toBe('not_found')
  })

  it('is refused with 409 run-active while a run holds the chat; other fields still change during a run', async () => {
    const a = await addProject(1)
    const id = await insertChat(1, 1000)
    activeRuns.add(id)
    events.clear()
    for (const target of [a, null, UNKNOWN_PROJECT]) {
      const error = await rejection(service.update(id, { title: 'No', projectId: target }))
      expect(error.toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'run-active', chatId: id } })
    }
    expect(await service.find(id)).toMatchObject({ title: null, projectId: null })
    expect(events.events).toHaveLength(0)
    expect((await service.update(id, { title: 'Renamed' })).title).toBe('Renamed')
    activeRuns.delete(id)
    expect((await service.update(id, { projectId: a })).projectId).toBe(a)
  })

  it('rejects a malformed project id with validation_error', async () => {
    const id = await insertChat(1, 1000)
    const error = await rejection(service.update(id, { projectId: 'prj_short' }))
    expect(error.code).toBe('validation_error')
    expect(await storedProject(id)).toBeNull()
  })
})

/** A chat JSON export version 2 as v1.2 wrote it (before Phase 7: no `projectId` anywhere), as uploaded. */
const V12_EXPORT_V2 = `{
  "format": "harness-forge.chat",
  "version": 2,
  "exportedAt": 1790000000000,
  "chat": {
    "id": "0199a8f0-0000-7000-8000-0000000000a2",
    "title": "Branched v1.2 chat",
    "titleSource": "auto",
    "modelRef": "openai:gpt-6",
    "pinned": true,
    "archived": false,
    "running": false,
    "pendingApproval": false,
    "createdAt": 1789000000000,
    "updatedAt": 1789500000000,
    "settings": { "toolMode": "ask", "reasoningEffort": "low" },
    "totals": { "inputTokens": 120, "outputTokens": 80, "reasoningTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0, "costUsd": 0.002 },
    "messages": [
      { "id": "msg_v12q000000000001", "role": "user", "metadata": { "modelRef": "openai:gpt-6", "startedAt": 1789000000000 }, "parts": [{ "type": "text", "text": "Name a color." }] },
      { "id": "msg_v12a000000000001", "role": "assistant", "metadata": { "modelRef": "openai:gpt-6", "startedAt": 1789000000001, "finishedAt": 1789000000002 }, "parts": [{ "type": "step-start" }, { "type": "text", "text": "Blue.", "state": "done" }] },
      { "id": "msg_v12a000000000002", "role": "assistant", "metadata": { "modelRef": "openai:gpt-6", "startedAt": 1789000000003, "finishedAt": 1789000000004 }, "parts": [{ "type": "step-start" }, { "type": "text", "text": "Green.", "state": "done" }] }
    ],
    "parentIds": [null, "msg_v12q000000000001", "msg_v12q000000000001"],
    "activeLeafId": "msg_v12a000000000001"
  }
}`

/** A chat JSON export version 1 as v1.0 wrote it (a linear chat; the detail without `branches`). */
const V10_EXPORT_V1 = `{
  "format": "harness-forge.chat",
  "version": 1,
  "exportedAt": 1780000000000,
  "chat": {
    "id": "0199a8f0-0000-7000-8000-0000000000a1",
    "title": "Linear v1.0 chat",
    "titleSource": "user",
    "modelRef": "anthropic:claude-sonnet-5",
    "pinned": false,
    "archived": true,
    "running": false,
    "pendingApproval": false,
    "createdAt": 1779000000000,
    "updatedAt": 1779000005000,
    "settings": {},
    "totals": { "inputTokens": 0, "outputTokens": 0, "reasoningTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0, "costUsd": null },
    "messages": [
      { "id": "msg_v10q000000000001", "role": "user", "parts": [{ "type": "text", "text": "Fetch the page." }] },
      { "id": "msg_v10a000000000001", "role": "assistant", "parts": [{ "type": "tool-web_fetch", "toolCallId": "call_1", "state": "approval-requested", "input": { "url": "https://example.com" }, "approval": { "id": "ap_1" } }] }
    ]
  }
}`

describe('exports and imports never carry a project (W7.5-T4)', () => {
  async function chatInProject(): Promise<string> {
    const project = await addProject(1)
    await service.create({ id: chatId(1), title: 'Project chat', projectId: project, messages: [userMessage(messageId(1), 'hello')] })
    return project
  }

  it('the JSON export (v2) has no projectId; the Markdown export does not mention the project', async () => {
    const project = await chatInProject()
    const json = await service.export(chatId(1), 'json')
    const body = JSON.parse(json.body) as { chat: Record<string, unknown> }
    expect(body.chat).not.toHaveProperty('projectId')
    expect(json.body).not.toContain(project)
    expect(chatExportSchema.parse(body).chat.id).toBe(chatId(1))
    const markdown = await service.export(chatId(1), 'md')
    expect(markdown.body).not.toContain(project)
  })

  it('an export of a project chat imports again without a project (keep + restore and new)', async () => {
    await chatInProject()
    const exported = chatExportSchema.parse(JSON.parse((await service.export(chatId(1), 'json')).body))
    const copy = await service.importChat({ exported, id: 'new', restore: true })
    expect(await storedProject(copy.id)).toBeNull()
    await service.remove(chatId(1))
    events.clear()
    await service.importChat({ exported, id: 'keep', restore: true })
    expect(await service.get(chatId(1))).toMatchObject({ title: 'Project chat', projectId: null })
    expect(events.ofType('chat.created').map(event => event.data.projectId)).toEqual([null])
  })

  it('a projectId key in an upload is dropped (v1 and v2)', async () => {
    const project = await addProject(1)
    const v2 = JSON.parse(V12_EXPORT_V2) as { chat: Record<string, unknown> }
    v2.chat.projectId = project
    const v1 = JSON.parse(V10_EXPORT_V1) as { chat: Record<string, unknown> }
    v1.chat.projectId = project
    const fromV2 = await service.importChat({ exported: v2 as unknown as ChatExportAny, id: 'keep', restore: true })
    const fromV1 = await service.importChat({ exported: v1 as unknown as ChatExportAny, id: 'keep', restore: true })
    expect(await storedProject(fromV2.id)).toBeNull()
    expect(await storedProject(fromV1.id)).toBeNull()
    expect(idsOfList(await service.list({ projectId: project }))).toEqual([])
  })

  it('the v2 export written by v1.2 still imports: versions, active leaf, title, flags, dates and settings', async () => {
    const exported = JSON.parse(V12_EXPORT_V2) as ChatExportAny
    expect(await service.importChat({ exported, id: 'keep', restore: true })).toEqual({ id: '0199a8f0-0000-7000-8000-0000000000a2', messages: 3 })
    const detail = await service.get('0199a8f0-0000-7000-8000-0000000000a2')
    expect(detail).toMatchObject({
      title: 'Branched v1.2 chat',
      titleSource: 'auto',
      modelRef: 'openai:gpt-6',
      pinned: true,
      archived: false,
      projectId: null,
      createdAt: 1789000000000,
      updatedAt: 1789500000000,
      settings: { toolMode: 'ask', reasoningEffort: 'low' },
    })
    expect(detail.messages.map(message => message.id)).toEqual(['msg_v12q000000000001', 'msg_v12a000000000001'])
    expect(detail.branches).toEqual({ msg_v12a000000000001: { siblings: ['msg_v12a000000000001', 'msg_v12a000000000002'], index: 0 } })
    // And it exports again as a v2 export without a project.
    const again = JSON.parse((await service.export(detail.id, 'json')).body) as { chat: Record<string, unknown> }
    expect(again.chat).not.toHaveProperty('projectId')
  })

  it('the v1 export written by v1.0 still imports as a linear chat (pending approvals denied)', async () => {
    const exported = JSON.parse(V10_EXPORT_V1) as ChatExportAny
    const result = await service.importChat({ exported, id: 'new', restore: false })
    expect(result.messages).toBe(2)
    const detail = await service.get(result.id)
    expect(detail).toMatchObject({ title: null, archived: false, projectId: null, modelRef: 'anthropic:claude-sonnet-5', pendingApproval: false })
    expect(detail.messages[1]?.parts[0]).toMatchObject({ state: 'output-denied', approval: { reason: IMPORT_DENIAL_REASON } })
  })
})

function idsOfList(page: { items: { id: string }[] }): string[] {
  return page.items.map(chat => chat.id)
}
