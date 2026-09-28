// The Phase 5 fakes (C8-T6) behave like the frozen contracts they stand in for, so W5.3 / W5.4 can rely on them.
import type { ChatCreate, HarnessUIMessage } from '@harness-forge/shared'
import type { ChatsService } from '../services/chats/types.ts'
import type { TestApp } from './create-test-app.ts'
import type { FakeChatRunner, RecordingEventBus } from './fakes.ts'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { chatDetailSchema, chatExportSchema, dataImportResultSchema, HarnessError, SHARE_TOKEN_PATTERN, shareSummarySchema, shareViewSchema } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { chats, chatShares, files, messages, usage } from '../db/schema.ts'
import { messageInsertValues } from '../services/chats/store.ts'
import { createTestApp } from './create-test-app.ts'
import {
  createFakeChatRunner,
  createFakeChatsService,
  createFakeDataService,
  createFakeFilesService,
  createFakeShareService,
  createRecordingEventBus,
  EMPTY_ZIP,
  fakeShareToken,
  readAllBytes,
} from './fakes.ts'

const apps: TestApp[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
})

function chatId(n: number): string {
  return `0199a8f0-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
}

function mid(n: number): string {
  return `msg_${n.toString().padStart(16, '0')}`
}

function user(n: number, text = `question ${n}`): HarnessUIMessage {
  return { id: mid(n), role: 'user', parts: [{ type: 'text', text }] }
}

function assistant(n: number, text = `answer ${n}`): HarnessUIMessage {
  return { id: mid(n), role: 'assistant', parts: [{ type: 'text', text, state: 'done' }] }
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

interface TreeApp {
  t: TestApp
  chats: ChatsService
  events: RecordingEventBus
  runs: FakeChatRunner
}

async function treeApp(): Promise<TreeApp> {
  const events = createRecordingEventBus()
  const runs = createFakeChatRunner()
  const t = await createTestApp({ start: false, overrides: { events, runs }, factories: { chats: createFakeChatsService, files: createFakeFilesService } })
  apps.push(t)
  return { t, chats: t.deps.chats, events, runs }
}

/**
 * ARCHITECTURE.md 6.8: A (1) -> RA (2) -> B (3) -> RB (4); A2 (5, an edit of A: a second first message) -> RA2 (6),
 * active leaf RA2.
 */
const TREE: ChatCreate = {
  id: chatId(1),
  title: 'Branches',
  messages: [user(1, 'A'), assistant(2, 'RA'), user(3, 'B'), assistant(4, 'RB'), user(5, 'A2'), assistant(6, 'RA2')],
  parentIds: [null, mid(1), mid(2), mid(3), null, mid(5)],
  activeLeafId: mid(6),
}

function ids(list: readonly HarnessUIMessage[]): string[] {
  return list.map(message => message.id)
}

describe('createFakeChatsService: the message tree', () => {
  it('creates a tree: get returns the active path and the branches of its messages', async () => {
    const { chats } = await treeApp()
    const detail = chatDetailSchema.parse(await chats.create(TREE))
    expect(ids(detail.messages)).toEqual([mid(5), mid(6)])
    expect(detail.branches).toEqual({ [mid(5)]: { siblings: [mid(1), mid(5)], index: 1 } })
    expect(ids(await chats.listMessages(chatId(1)))).toEqual([mid(1), mid(2), mid(3), mid(4), mid(5), mid(6)])
    expect(ids(await chats.listPath(chatId(1), mid(4)))).toEqual([mid(1), mid(2), mid(3), mid(4)])
    expect(await chats.listPath(chatId(1), null)).toEqual([])
    expect((await rejection(chats.listPath(chatId(1), mid(9)))).code).toBe('not_found')
    expect((await chats.find(chatId(1)))?.activeLeafId).toBe(mid(6))
  })

  it('an active leaf in the middle of a path shows the most recent leaf under it', async () => {
    const { chats } = await treeApp()
    const detail = await chats.create({ ...TREE, activeLeafId: mid(1) })
    expect(ids(detail.messages)).toEqual([mid(1), mid(2), mid(3), mid(4)])
    expect(detail.branches).toEqual({ [mid(1)]: { siblings: [mid(1), mid(5)], index: 0 } })
  })

  it('refuses an invalid tree before writing anything', async () => {
    const { chats } = await treeApp()
    const cases: Array<[Partial<ChatCreate>, (string | number)[]]> = [
      [{ parentIds: [null, mid(3), mid(2)], messages: [user(1), assistant(2), user(3)] }, ['parentIds', 1]],
      [{ parentIds: [null], messages: [user(1), assistant(2)] }, ['parentIds']],
      [{ parentIds: [null, null], messages: [user(1), user(1)] }, ['messages', 1, 'id']],
      [{ activeLeafId: mid(9), messages: [user(1)] }, ['activeLeafId']],
    ]
    for (const [input, path] of cases) {
      const error = await rejection(chats.create({ id: chatId(2), ...input }))
      expect(error.code).toBe('validation_error')
      expect((error.details as { issues: Array<{ path: unknown[] }> }).issues[0]?.path).toEqual(path)
    }
    expect(await chats.find(chatId(2))).toBeNull()
  })

  it('switchBranch shows the latest leaf under the message, keeps updatedAt, emits chat.updated', async () => {
    const { chats, events } = await treeApp()
    const created = await chats.create(TREE)
    events.clear()
    const switched = await chats.switchBranch(chatId(1), mid(1))
    expect(ids(switched.messages)).toEqual([mid(1), mid(2), mid(3), mid(4)])
    expect(switched.branches).toEqual({ [mid(1)]: { siblings: [mid(1), mid(5)], index: 0 } })
    expect(switched.updatedAt).toBe(created.updatedAt)
    expect(events.ofType('chat.updated').map(event => event.data.id)).toEqual([chatId(1)])
    // A message in the middle of a path: the most recent leaf under it.
    expect(ids((await chats.switchBranch(chatId(1), mid(5))).messages)).toEqual([mid(5), mid(6)])
    expect(ids((await chats.get(chatId(1))).messages)).toEqual([mid(5), mid(6)])
  })

  it('switchBranch answers 404 for an unknown chat or message and 409 while a run holds the chat', async () => {
    const { chats, runs } = await treeApp()
    await chats.create(TREE)
    expect((await rejection(chats.switchBranch(chatId(9), mid(1)))).code).toBe('not_found')
    expect((await rejection(chats.switchBranch(chatId(1), mid(9)))).code).toBe('not_found')
    runs.phases.set(chatId(1), 'preparing')
    const conflict = await rejection(chats.switchBranch(chatId(1), mid(1)))
    expect(conflict.toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'run-active', chatId: chatId(1) } })
    expect(ids((await chats.get(chatId(1))).messages)).toEqual([mid(5), mid(6)])
  })

  it('switchBranch recomputes pending_approval from the new path', async () => {
    const { chats } = await treeApp()
    const pending: HarnessUIMessage = {
      id: mid(2),
      role: 'assistant',
      parts: [{ type: 'tool-current_time', toolCallId: 'call-1', state: 'approval-requested', input: {}, approval: { id: 'approval-1' } } as never],
    }
    await chats.ensure(chatId(3))
    await chats.appendMessage(chatId(3), user(1), null)
    await chats.appendMessage(chatId(3), pending, mid(1))
    await chats.appendMessage(chatId(3), user(3), null)
    expect((await chats.switchBranch(chatId(3), mid(1))).pendingApproval).toBe(true)
    expect((await chats.switchBranch(chatId(3), mid(3))).pendingApproval).toBe(false)
  })

  it('reads a linear chat (v1 data, the P5-0b pipeline) as a chain and stores it before the first tree write', async () => {
    const { t, chats } = await treeApp()
    await chats.ensure(chatId(4))
    // Rows as the P5-0b pipeline wrote them: seq order, no parent, no active leaf.
    await t.db.insert(messages).values([
      messageInsertValues(chatId(4), user(1), 0, null, 1),
      messageInsertValues(chatId(4), assistant(2), 1, null, 2),
    ])
    expect(ids((await chats.get(chatId(4))).messages)).toEqual([mid(1), mid(2)])
    expect((await chats.find(chatId(4)))?.activeLeafId).toBe(mid(2))

    // An edit of the first message: a second first message; the chain is stored first, the leaf does not move.
    await chats.appendMessage(chatId(4), user(3, 'A2'), null)
    const rows = await t.db.select({ id: messages.id, parentId: messages.parentId }).from(messages).where(eq(messages.chatId, chatId(4)))
    expect(Object.fromEntries(rows.map(row => [row.id, row.parentId]))).toEqual({ [mid(1)]: null, [mid(2)]: mid(1), [mid(3)]: null })
    const detail = await chats.get(chatId(4))
    expect(ids(detail.messages)).toEqual([mid(1), mid(2)])
    expect(detail.branches).toEqual({ [mid(1)]: { siblings: [mid(1), mid(3)], index: 0 } })
  })

  it('setActiveLeaf is a compare-and-set', async () => {
    const { chats } = await treeApp()
    await chats.create(TREE)
    expect(await chats.setActiveLeaf(chatId(1), mid(4), [mid(2)])).toBe(false)
    expect(await chats.setActiveLeaf(chatId(1), mid(4), [])).toBe(false)
    expect(await chats.setActiveLeaf(chatId(1), mid(9))).toBe(false)
    expect(await chats.setActiveLeaf(chatId(9), mid(4))).toBe(false)
    expect(ids((await chats.get(chatId(1))).messages)).toEqual([mid(5), mid(6)])
    expect(await chats.setActiveLeaf(chatId(1), mid(4), [mid(6), null])).toBe(true)
    expect(ids((await chats.get(chatId(1))).messages)).toEqual([mid(1), mid(2), mid(3), mid(4)])
    await chats.ensure(chatId(5))
    await chats.appendMessage(chatId(5), user(7), null)
    expect(await chats.setActiveLeaf(chatId(5), mid(7), [null])).toBe(true)
    expect(await chats.setActiveLeaf(chatId(1), mid(2))).toBe(true)
  })

  it('appendMessage inserts only; upsertMessage uses the parent on insert only', async () => {
    const { chats } = await treeApp()
    await chats.create(TREE)
    expect((await rejection(chats.appendMessage(chatId(9), user(20), null))).code).toBe('not_found')
    expect((await rejection(chats.appendMessage(chatId(1), user(20), mid(99)))).code).toBe('not_found')
    expect((await rejection(chats.appendMessage(chatId(1), user(3), mid(2)))).toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    expect((await rejection(chats.appendMessage(chatId(1), { ...user(20), id: 'msg_short' }, null))).code).toBe('validation_error')

    await chats.appendMessage(chatId(1), user(7, 'B2'), mid(2))
    await chats.upsertMessage(chatId(1), assistant(8, 'RB2'), mid(7))
    await chats.upsertMessage(chatId(1), assistant(8, 'RB2 edited'), mid(1))
    expect(await chats.setActiveLeaf(chatId(1), mid(8))).toBe(true)
    const detail = await chats.get(chatId(1))
    expect(ids(detail.messages)).toEqual([mid(1), mid(2), mid(7), mid(8)])
    expect((detail.messages[3]?.parts[0] as { text: string }).text).toBe('RB2 edited')
    expect(detail.branches).toEqual({
      [mid(1)]: { siblings: [mid(1), mid(5)], index: 0 },
      [mid(7)]: { siblings: [mid(3), mid(7)], index: 1 },
    })
  })
})

describe('createFakeChatsService: export, import, allIds, removeAll', () => {
  it('exports version 2 with every version, the parents and the active leaf, and imports it back (keep / new)', async () => {
    const source = await treeApp()
    await source.chats.create(TREE)
    await source.chats.update(chatId(1), { pinned: true })
    await source.t.db.update(chats).set({ createdAt: 1000, updatedAt: 2000 }).where(eq(chats.id, chatId(1)))
    const file = await source.chats.export(chatId(1), 'json')
    const exported = chatExportSchema.parse(JSON.parse(file.body))
    expect(file.filename).toMatch(/^branches-\d{4}-\d{2}-\d{2}\.json$/)
    expect(exported.chat).toMatchObject({ id: chatId(1), title: 'Branches', pinned: true, createdAt: 1000, updatedAt: 2000, activeLeafId: mid(6) })
    expect(ids(exported.chat.messages)).toEqual([mid(1), mid(2), mid(3), mid(4), mid(5), mid(6)])
    expect(exported.chat.parentIds).toEqual([null, mid(1), mid(2), mid(3), null, mid(5)])
    expect((await source.chats.export(chatId(1), 'md')).body).toContain('# Branches')

    const target = await treeApp()
    const kept = await target.chats.importChat({ exported, id: 'keep', restore: true })
    expect(kept).toEqual({ id: chatId(1), messages: 6 })
    const restored = await target.chats.get(chatId(1))
    expect(restored).toMatchObject({ title: 'Branches', titleSource: 'user', pinned: true, archived: false, createdAt: 1000, updatedAt: 2000 })
    expect(ids(restored.messages)).toEqual([mid(5), mid(6)])
    expect(restored.branches).toEqual({ [mid(5)]: { siblings: [mid(1), mid(5)], index: 1 } })
    expect(target.events.ofType('chat.created').map(event => event.data.id)).toEqual([chatId(1)])
    expect((await rejection(target.chats.importChat({ exported, id: 'keep', restore: true }))).toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })

    const copy = await target.chats.importChat({ exported, id: 'new', restore: false })
    expect(copy.id).not.toBe(chatId(1))
    const copied = await target.chats.get(copy.id)
    expect(copied).toMatchObject({ title: null, pinned: false })
    expect(copied.messages).toHaveLength(2)
    expect(ids(copied.messages)).not.toContain(mid(5))
    expect(Object.values(copied.branches)[0]?.siblings).toHaveLength(2)
    expect(await target.chats.allIds()).toEqual([chatId(1), copy.id].sort())
  })

  it('imports a version 1 export as a linear chat and reports an invalid tree under chat', async () => {
    const { chats } = await treeApp()
    const v1 = {
      format: 'harness-forge.chat' as const,
      version: 1 as const,
      exportedAt: 1,
      chat: {
        id: chatId(7),
        title: 'Old',
        titleSource: 'user' as const,
        modelRef: 'mock:echo',
        pinned: false,
        archived: true,
        running: false,
        pendingApproval: false,
        createdAt: 5,
        updatedAt: 6,
        settings: {},
        totals: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null },
        messages: [user(1), assistant(2), user(3)],
      },
    }
    expect(await chats.importChat({ exported: v1, id: 'keep', restore: true })).toEqual({ id: chatId(7), messages: 3 })
    expect(await chats.get(chatId(7))).toMatchObject({ archived: true, modelRef: 'mock:echo', branches: {} })
    expect(ids((await chats.get(chatId(7))).messages)).toEqual([mid(1), mid(2), mid(3)])

    const broken = { ...v1, version: 2 as const, chat: { ...v1.chat, id: chatId(8), parentIds: [null, mid(3), mid(1)], activeLeafId: mid(3) } }
    const error = await rejection(chats.importChat({ exported: broken, id: 'keep', restore: true }))
    expect(error.code).toBe('validation_error')
    expect((error.details as { issues: Array<{ path: unknown[] }> }).issues[0]?.path).toEqual(['chat', 'parentIds', 1])
    expect(await chats.find(chatId(8))).toBeNull()
  })

  it('removeAll deletes every chat, message and share link, detaches or deletes usage rows, emits chat.deleted', async () => {
    const { t, chats, events } = await treeApp()
    await chats.create(TREE)
    await chats.create({ id: chatId(2), messages: [user(10)] })
    await chats.ensure(chatId(3))
    await chats.addUsage({ chatId: chatId(1), messageId: mid(6), purpose: 'chat', providerId: 'mock', modelId: 'echo', inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null })
    await t.db.insert(chatShares).values({
      id: 'shr_0000000000000001',
      chatId: chatId(1),
      options: { reasoning: false, toolDetails: false, attachments: true },
      snapshot: { title: null, messages: [] },
      snapshotAt: 1,
    })
    events.clear()
    expect(await chats.allIds()).toEqual([chatId(1), chatId(2), chatId(3)])

    const result = await chats.removeAll({ usage: false })
    expect(result).toEqual({ chatIds: [chatId(1), chatId(2), chatId(3)], messages: 7, usageRows: 0 })
    expect(events.ofType('chat.deleted').map(event => event.data.id).sort()).toEqual([chatId(1), chatId(2), chatId(3)])
    expect(await t.db.select().from(chatShares)).toEqual([])
    expect(await t.db.select().from(messages)).toEqual([])
    expect(await t.db.select({ chatId: usage.chatId }).from(usage)).toEqual([{ chatId: null }])
    expect(await chats.allIds()).toEqual([])

    await chats.ensure(chatId(4))
    expect(await chats.removeAll({ usage: true })).toEqual({ chatIds: [chatId(4)], messages: 0, usageRows: 1 })
    expect(await t.db.select().from(usage)).toEqual([])
  })
})

describe('createFakeChatRunner', () => {
  it('reports hasRun in every phase, isActive and active() only while streaming, and records stops', async () => {
    const runs = createFakeChatRunner()
    runs.phases.set('a', 'preparing')
    runs.phases.set('b', 'streaming')
    runs.phases.set('c', 'finishing')
    expect(['a', 'b', 'c', 'd'].map(id => runs.hasRun(id))).toEqual([true, true, true, false])
    expect(['a', 'b', 'c'].map(id => runs.isActive(id))).toEqual([false, true, false])
    expect(runs.active().map(run => run.chatId)).toEqual(['b'])
    expect(await runs.stop('a')).toBe(true)
    expect(await runs.stop('c')).toBe(false)
    expect(await runs.stop('d')).toBe(false)
    expect(runs.stopped).toEqual(['a', 'c', 'd'])
    await runs.stopAll()
    expect(runs.phases.size).toBe(0)
    expect(runs.resume('b')).toBeNull()
    expect((await rejection(runs.start({} as never, {} as never))).code).toBe('not_implemented')
    expect(createFakeChatRunner({ hasRun: () => true }).hasRun('x')).toBe(true)
  })
})

describe('createFakeDataService', () => {
  it('answers from its options, streams the backup lazily and counts cancelled exports', async () => {
    const data = createFakeDataService({ now: () => Date.UTC(2026, 8, 28) })
    expect(await data.summary()).toEqual({ chats: 0, archivedChats: 0, messages: 0, files: 0, fileBytes: 0 })
    const backup = await data.exportBackup({})
    expect(backup.filename).toBe('harness-forge-backup-2026-09-28.zip')
    expect(await readAllBytes(backup.stream)).toEqual(EMPTY_ZIP)
    expect(data.exports.completed).toBe(1)
    await (await data.exportBackup({ files: false })).stream.cancel()
    expect(data.exports.cancelled).toBe(1)
    expect(data.calls.map(call => call.member)).toEqual(['summary', 'exportBackup', 'exportBackup'])
  })

  it('checks the upload kind, the confirmation, fresh auth and the busy flag', async () => {
    const data = createFakeDataService()
    expect(dataImportResultSchema.parse(await data.importData(new Blob([EMPTY_ZIP]))).kind).toBe('backup')
    expect((await data.importData(new Blob(['{"format":"harness-forge.chat"}']), { onConflict: 'copy' })).kind).toBe('chat')
    expect((await rejection(data.importData(new Blob(['hello'])))).code).toBe('validation_error')
    expect((await rejection(data.deleteAll({ confirm: 'delete' } as never))).code).toBe('validation_error')
    let fresh = 0
    expect(await data.deleteAll({ confirm: 'DELETE', files: true }, { requireFreshAuth: () => void (fresh += 1) })).toMatchObject({ chats: 0 })
    expect(fresh).toBe(1)
    const forbidden = new HarnessError({ code: 'forbidden', message: 'fresh auth', action: 'login' })
    expect((await rejection(data.deleteAll({ confirm: 'DELETE' }, { requireFreshAuth: () => {
      throw forbidden
    } }))).code).toBe('forbidden')
    data.busy = true
    expect((await rejection(data.importData(new Blob([EMPTY_ZIP])))).toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'busy' } })
    expect((await rejection(data.deleteAll({ confirm: 'DELETE' }))).toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'busy' } })
  })
})

describe('createFakeShareService', () => {
  it('creates, lists, updates and removes links with stable tokens of the real format', async () => {
    let now = 1_000_000
    const shares = createFakeShareService({ now: () => now })
    const first = shareSummarySchema.parse(await shares.create({ chatId: chatId(1) }))
    expect(first).toMatchObject({ chatId: chatId(1), title: null, options: { reasoning: false, toolDetails: false, attachments: true }, expired: false, createdAt: now })
    const token = first.path.slice('/share/'.length)
    expect(token).toMatch(SHARE_TOKEN_PATTERN)
    expect(token).toBe(fakeShareToken(first.id))
    now += 1
    const second = await shares.create({ chatId: chatId(2), title: 'Mine', options: { reasoning: true }, expiresAt: now + 60_000 })
    expect((await shares.list({})).map(share => share.id)).toEqual([second.id, first.id])
    expect((await shares.list({ chatId: chatId(1) })).map(share => share.id)).toEqual([first.id])

    const updated = await shares.update(first.id, { title: 'Renamed', options: { attachments: false }, refresh: true })
    expect(updated).toMatchObject({ title: 'Renamed', options: { reasoning: false, attachments: false }, path: first.path, snapshotAt: now })
    expect((await rejection(shares.create({ chatId: chatId(1), expiresAt: now - 1 }))).code).toBe('validation_error')
    await shares.remove(first.id)
    expect((await rejection(shares.remove(first.id))).code).toBe('not_found')
    expect((await rejection(shares.update(first.id, { title: null }))).code).toBe('not_found')
    expect((await rejection(shares.view(token))).code).toBe('not_found')
  })

  it('applies the options in view, serves only the share files and hides expired links', async () => {
    let now = 5000
    const snapshot = {
      title: 'Shared',
      messages: [{
        role: 'assistant' as const,
        parts: [
          { type: 'reasoning' as const, text: 'thinking' },
          { type: 'text' as const, text: 'Here is the chart' },
          { type: 'file' as const, mediaType: 'image/png', url: '/api/files/file_0000000000000001' },
          { type: 'tool' as const, toolName: 'current_time', status: 'done' as const, input: {}, output: { now: 1 } },
        ],
      }],
    }
    const shares = createFakeShareService({ now: () => now, snapshot: () => snapshot })
    const created = await shares.create({ chatId: chatId(1), expiresAt: now + 1000 })
    const token = created.path.slice('/share/'.length)
    const png = Uint8Array.from([0x89, 0x50, 0x4E, 0x47])
    shares.shares.get(created.id)!.files.set('file_0000000000000001', {
      file: { id: 'file_0000000000000001', sha256: 'a'.repeat(64), name: 'chart.png', mime: 'image/png', size: png.byteLength, createdAt: 1 },
      data: png,
    })

    const view = shareViewSchema.parse(await shares.view(token))
    expect(view.messages[0]?.parts).toEqual([
      { type: 'text', text: 'Here is the chart' },
      { type: 'file', mediaType: 'image/png', url: `/api/share/${token}/files/file_0000000000000001` },
      { type: 'tool', toolName: 'current_time', status: 'done' },
    ])
    const opened = await shares.openFile(token, 'file_0000000000000001')
    expect(await readAllBytes(opened.stream)).toEqual(png)
    expect((await rejection(shares.openFile(token, 'file_0000000000000002'))).code).toBe('not_found')

    await shares.update(created.id, { options: { reasoning: true, toolDetails: true, attachments: false } })
    const detailed = await shares.view(token)
    expect(detailed.messages[0]?.parts.map(part => part.type)).toEqual(['reasoning', 'text', 'tool'])
    expect(detailed.messages[0]?.parts[2]).toMatchObject({ input: {}, output: { now: 1 } })
    expect((await rejection(shares.openFile(token, 'file_0000000000000001'))).code).toBe('not_found')

    now += 1000
    expect((await shares.list({}))[0]?.expired).toBe(true)
    expect((await rejection(shares.view(token))).code).toBe('not_found')
    expect((await rejection(shares.view('0000000000000000AAAAAAAAAAAAAAAAAAAAAA'))).code).toBe('not_found')
  })
})

describe('createFakeFilesService', () => {
  const PNG = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])
  const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

  it('imports under the preferred id, reuses the same content, refuses a hash mismatch', async () => {
    const { t } = await treeApp()
    const text = new TextEncoder().encode('hello notes\n')
    const input = { preferredId: 'file_0000000000000001', sha256: sha(text), name: 'notes.txt', mime: 'text/plain', data: text, createdAt: 1234 }
    const first = await t.deps.files.importFile(input)
    expect(first).toMatchObject({ reused: false, file: { id: 'file_0000000000000001', name: 'notes.txt', mime: 'text/plain', size: text.byteLength, createdAt: 1234 } })
    expect(new TextDecoder().decode((await t.deps.files.read('file_0000000000000001')).data)).toBe('hello notes\n')
    expect(await t.deps.files.importFile({ ...input, preferredId: 'file_0000000000000009' })).toMatchObject({ reused: true, file: { id: 'file_0000000000000001' } })

    const image = await t.deps.files.importFile({ preferredId: 'file_0000000000000001', sha256: sha(PNG), name: 'dot.png', mime: 'image/png', data: PNG, createdAt: 5 })
    expect(image.reused).toBe(false)
    expect(image.file.id).not.toBe('file_0000000000000001')
    expect((await rejection(t.deps.files.importFile({ ...input, sha256: 'f'.repeat(64) }))).code).toBe('validation_error')
    expect((await rejection(t.deps.files.importFile({ ...input, data: Uint8Array.from([0xFF, 0xFE, 0x00]), sha256: sha(Uint8Array.from([0xFF, 0xFE, 0x00])) }))).code).toBe('validation_error')
  })

  it('purge deletes every row and blob and reports the rows bytes', async () => {
    const { t } = await treeApp()
    const text = new TextEncoder().encode('same bytes')
    await t.deps.files.upload(new File([text], 'a.txt', { type: 'text/plain' }))
    await t.deps.files.upload(new File([text], 'b.txt', { type: 'text/plain' }))
    expect(readdirSync(t.env.paths.files)).toHaveLength(1)
    expect(await t.deps.files.purge()).toEqual({ files: 2, bytes: 2 * text.byteLength })
    expect(await t.db.select().from(files)).toEqual([])
    expect(existsSync(t.env.paths.files)).toBe(true)
    expect(readdirSync(t.env.paths.files)).toEqual([])
    expect(await t.deps.files.purge()).toEqual({ files: 0, bytes: 0 })
  })
})
