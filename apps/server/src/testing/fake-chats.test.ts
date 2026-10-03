// The Phase 6 behavior of `createFakeChatsService` (W6.6): remembered versions (ADR-030) and the active leaf in every
// `chat.updated`, like the real service, so the tests of other services see the same contract. Phase 7 (W7.5): the
// project of a chat (ADR-031), with the fake project service, and exports / imports without it.
import type { ChatCreate, ChatExportAny, HarnessUIMessage } from '@harness-forge/shared'
import type { ChatsService } from '../services/chats/types.ts'
import type { TestApp } from './create-test-app.ts'
import type { FakeProjectService } from './fake-projects.ts'
import type { RecordingEventBus } from './fakes.ts'
import { chatExportSchema, serverEventSchema } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { messages, projects as projectsTable } from '../db/schema.ts'
import { createTestApp } from './create-test-app.ts'
import { createFakeProjectService } from './fake-projects.ts'
import { createFakeChatRunner, createFakeChatsService, createRecordingEventBus } from './fakes.ts'

let t: TestApp
let chats: ChatsService
let events: RecordingEventBus

beforeEach(async () => {
  events = createRecordingEventBus()
  t = await createTestApp({ start: false, overrides: { events, runs: createFakeChatRunner() }, factories: { chats: createFakeChatsService } })
  chats = t.deps.chats
})

afterEach(async () => {
  await t.close()
})

function chatId(n: number): string {
  return `0199a8f0-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
}

function mid(n: number): string {
  return `msg_${n.toString().padStart(16, '0')}`
}

function user(n: number): HarnessUIMessage {
  return { id: mid(n), role: 'user', parts: [{ type: 'text', text: `question ${n}` }] }
}

function assistant(n: number): HarnessUIMessage {
  return { id: mid(n), role: 'assistant', parts: [{ type: 'text', text: `answer ${n}`, state: 'done' }] }
}

function ids(list: readonly HarnessUIMessage[]): string[] {
  return list.map(message => message.id)
}

async function pointersOf(id: string): Promise<Record<string, string | null>> {
  const rows = await t.db.select({ id: messages.id, selectedChildId: messages.selectedChildId }).from(messages).where(eq(messages.chatId, id))
  return Object.fromEntries(rows.map(row => [row.id, row.selectedChildId]))
}

/**
 * A (1) -> RA (2) -> B (3) -> RB (4); A2 (5) -> RA2 (6); a newer version B2 (7) -> RB2 (8) under RA. The active leaf is
 * RB (4): under A the remembered path (-> RB) differs from the latest leaf (RB2).
 */
const VERSIONS: ChatCreate = {
  id: chatId(1),
  messages: [user(1), assistant(2), user(3), assistant(4), user(5), assistant(6), user(7), assistant(8)],
  parentIds: [null, mid(1), mid(2), mid(3), null, mid(5), mid(2), mid(7)],
  activeLeafId: mid(4),
}

describe('createFakeChatsService: remembered versions (ADR-030)', () => {
  it('create records the active path only; switching away and back restores the path last shown', async () => {
    await chats.create(VERSIONS)
    expect(await pointersOf(chatId(1))).toEqual({
      [mid(1)]: mid(2),
      [mid(2)]: mid(3),
      [mid(3)]: mid(4),
      [mid(4)]: null,
      [mid(5)]: null,
      [mid(6)]: null,
      [mid(7)]: null,
      [mid(8)]: null,
    })
    expect(ids((await chats.switchBranch(chatId(1), mid(5))).messages)).toEqual([mid(5), mid(6)])
    expect(ids((await chats.switchBranch(chatId(1), mid(1))).messages)).toEqual([mid(1), mid(2), mid(3), mid(4)])
    expect(ids((await chats.switchBranch(chatId(1), mid(7))).messages)).toEqual([mid(1), mid(2), mid(7), mid(8)])
    await chats.switchBranch(chatId(1), mid(5))
    expect(ids((await chats.switchBranch(chatId(1), mid(1))).messages)).toEqual([mid(1), mid(2), mid(7), mid(8)])
  })

  it('setActiveLeaf records the shown path after a successful compare-and-set; a failed one writes nothing', async () => {
    await chats.create(VERSIONS)
    const before = await pointersOf(chatId(1))
    expect(await chats.setActiveLeaf(chatId(1), mid(8), [mid(6)])).toBe(false)
    expect(await pointersOf(chatId(1))).toEqual(before)
    expect(await chats.setActiveLeaf(chatId(1), mid(8), [mid(4)])).toBe(true)
    expect(await pointersOf(chatId(1))).toEqual({ ...before, [mid(2)]: mid(7), [mid(7)]: mid(8) })
  })

  it('importChat re-derives the pointers from the active path of the export', async () => {
    await chats.create(VERSIONS)
    await chats.switchBranch(chatId(1), mid(5))
    const exported = JSON.parse((await chats.export(chatId(1), 'json')).body)
    await chats.remove(chatId(1))
    await chats.importChat({ exported, id: 'keep', restore: true })
    expect(await pointersOf(chatId(1))).toEqual({
      [mid(1)]: null,
      [mid(2)]: null,
      [mid(3)]: null,
      [mid(4)]: null,
      [mid(5)]: mid(6),
      [mid(6)]: null,
      [mid(7)]: null,
      [mid(8)]: null,
    })
  })
})

describe('createFakeChatsService: chat.updated carries the active leaf (ADR-030)', () => {
  it('update, touch, setTitle, switchBranch and deleteMessage emit the stored activeLeafId', async () => {
    await chats.create(VERSIONS)
    events.clear()
    await chats.update(chatId(1), { pinned: true })
    await chats.touch(chatId(1), { at: 5000 })
    await chats.setTitle(chatId(1), 'Automatic title', 'auto')
    await chats.switchBranch(chatId(1), mid(5))
    // Off the shown path: the leaf stays.
    await chats.deleteMessage(chatId(1), mid(7))
    // On the shown path: the path moves to A and what was last shown under it.
    await chats.deleteMessage(chatId(1), mid(5))
    const emitted = events.ofType('chat.updated')
    expect(emitted.map(event => event.data.activeLeafId)).toEqual([mid(4), mid(4), mid(4), mid(6), mid(6), mid(4)])
    for (const event of emitted)
      expect(serverEventSchema.parse(event)).toEqual(event)
    expect((await chats.find(chatId(1)))?.activeLeafId).toBe(mid(4))
  })
})

describe('createFakeChatsService: projects (ADR-031)', () => {
  it('works with the fake project service: create, ensure, the move, the filter and the detach on remove', async () => {
    const app = await createTestApp({
      start: false,
      overrides: { events, runs: createFakeChatRunner() },
      factories: { chats: createFakeChatsService, projects: createFakeProjectService },
    })
    try {
      const projects = app.deps.projects as FakeProjectService
      const project = await projects.add({ name: 'Demo' })
      events.clear()
      expect((await app.deps.chats.create({ id: chatId(1), projectId: project.id, messages: [user(1)] })).projectId).toBe(project.id)
      expect((await app.deps.chats.ensure(chatId(2), { projectId: project.id })).chat.projectId).toBe(project.id)
      await app.deps.chats.ensure(chatId(3))
      expect(events.ofType('chat.created').map(event => event.data.projectId)).toEqual([project.id, project.id, null])
      expect((await app.deps.chats.update(chatId(3), { projectId: project.id })).projectId).toBe(project.id)
      expect((await app.deps.chats.update(chatId(2), { projectId: null })).projectId).toBeNull()
      expect((await app.deps.chats.list({ projectId: project.id })).items.map(chat => chat.id).sort()).toEqual([chatId(1), chatId(3)])
      expect((await app.deps.chats.list({ projectId: 'none' })).items.map(chat => chat.id)).toEqual([chatId(2)])
      expect((await projects.get(project.id)).chatCount).toBe(2)

      await projects.remove(project.id)
      expect((await app.deps.chats.find(chatId(1)))?.projectId).toBeNull()
      const missing = app.deps.chats.update(chatId(1), { projectId: project.id })
      await expect(missing).rejects.toMatchObject({ code: 'not_found' })
    }
    finally {
      await app.close()
    }
  })

  it('the JSON export leaves the project out; importChat never sets one', async () => {
    await t.db.insert(projectsTable).values({ id: 'prj_fakechatsproj001', name: 'P', path: '/workspaces/p', createdAt: 1, updatedAt: 1 })
    await chats.create({ ...VERSIONS, projectId: 'prj_fakechatsproj001' })
    const body = (await chats.export(chatId(1), 'json')).body
    expect(body).not.toContain('prj_fakechatsproj001')
    const exported = JSON.parse(body) as { chat: Record<string, unknown> }
    expect(exported.chat).not.toHaveProperty('projectId')
    expect(chatExportSchema.parse(exported).chat.parentIds).toEqual(VERSIONS.parentIds)
    exported.chat.projectId = 'prj_fakechatsproj001'
    const copy = await chats.importChat({ exported: exported as unknown as ChatExportAny, id: 'new', restore: true })
    expect((await chats.find(copy.id))?.projectId).toBeNull()
    expect((await chats.get(chatId(1))).projectId).toBe('prj_fakechatsproj001')
  })
})
