// The Phase 5 fakes (C8-T6) behave like the frozen contracts they stand in for, so W5.3 / W5.4 can rely on them; the
// Phase 6 fakes (C11-T5) likewise for W6.1, W6.4, W6.5 and W6.6; the Phase 7 additions (C14-T6) for W7.7 and W7.8. The
// fake project service has its own file (./fake-projects.test.ts).
import type { PluginContext } from '@harness-forge/plugin-sdk'
import type { ChatCreate, HarnessUIMessage } from '@harness-forge/shared'
import type { ResolvedImageModel } from '../providers/types.ts'
import type { ChatsService } from '../services/chats/types.ts'
import type { TestApp } from './create-test-app.ts'
import type { FakeChatRunner, RecordingEventBus } from './fakes.ts'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { chatDetailSchema, chatExportSchema, dataCleanupPreviewSchema, dataCleanupResultSchema, dataImportResultSchema, HarnessError, LIMITS, SHARE_TOKEN_PATTERN, shareSummarySchema, shareViewSchema } from '@harness-forge/shared'
import { generateImage, generateSpeech, transcribe } from 'ai'
import { MockTranscriptionModelV4 } from 'ai/test'
import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { manifest as mockManifest } from '../builtin-plugins/mock/index.ts'
import { firstPixel, readPng, readWav } from '../builtin-plugins/mock/media.test-util.ts'
import { MOCK_TRANSCRIPT, mockImageColor } from '../builtin-plugins/mock/media.ts'
import { encodeSolidPng } from '../builtin-plugins/mock/png.ts'
import { chats, chatShares, files, messages, usage } from '../db/schema.ts'
import { createProvidersTestApp, fakeMediaProviders } from '../providers/testing.ts'
import { messageInsertValues } from '../services/chats/store.ts'
import { createTestApp } from './create-test-app.ts'
import {
  createFakeAudioService,
  createFakeChatRunner,
  createFakeChatsService,
  createFakeDataService,
  createFakeFilesService,
  createFakeImageService,
  createFakeShareService,
  createRecordingEventBus,
  EMPTY_ZIP,
  fakeShareToken,
  NO_IMAGE_MODEL_MESSAGE,
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
    expect(await data.summary()).toEqual({ chats: 0, archivedChats: 0, messages: 0, files: 0, fileBytes: 0, fileSweep: { mode: 'off', lastAttempt: null, nextRunAt: null } })
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

  it('phase 7: answers the cleanup preview and run from its options, busy like the maintenance lock', async () => {
    const data = createFakeDataService({ now: () => 1234 })
    expect(dataCleanupPreviewSchema.parse(await data.cleanupPreview())).toEqual({ files: 0, fileBytes: 0, blobs: 0, diskBytes: 0, tempFiles: 0, recentFiles: 0, graceMs: 86_400_000, lastRunAt: null, fileSweep: { mode: 'off', lastAttempt: null, nextRunAt: null }, pluginData: 'complete' })
    expect(dataCleanupResultSchema.parse(await data.cleanup())).toEqual({ files: 0, fileBytes: 0, blobs: 0, diskBytes: 0, tempFiles: 0, ranAt: 1234, pluginData: 'complete' })
    const custom = createFakeDataService({ cleanupResult: { files: 2, fileBytes: 10, blobs: 1, diskBytes: 8, tempFiles: 0, ranAt: 5, pluginData: 'complete' } })
    expect(await custom.cleanup()).toMatchObject({ files: 2, ranAt: 5 })
    data.busy = true
    expect((await rejection(data.cleanupPreview())).toJSON().error).toMatchObject({ code: 'conflict', message: 'Another data task is running. Try again when it finishes.', details: { reason: 'busy' } })
    expect((await rejection(data.cleanup())).toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'busy' } })
    expect(data.calls.map(call => call.member)).toEqual(['cleanupPreview', 'cleanup', 'cleanupPreview', 'cleanup'])
  })
})

describe('createRecordingEventBus: disconnectAll (Phase 7)', () => {
  it('ends the streams (onDisconnect, else onClose), keeps plain listeners, records the call and keeps working', async () => {
    const bus = createRecordingEventBus()
    const seen: string[] = []
    const ended: string[] = []
    bus.subscribe(() => seen.push('plain'))
    bus.subscribe(() => seen.push('stream'), { onDisconnect: async () => void ended.push('disconnect') })
    bus.subscribe(() => seen.push('closer'), { onClose: () => void ended.push('close') })
    bus.emit('key.rotated', { keyVersion: 2, rotatedAt: 1, chatIds: [] })
    expect(seen).toEqual(['plain', 'stream', 'closer'])
    await bus.disconnectAll()
    expect(ended.sort()).toEqual(['close', 'disconnect'])
    expect(bus.subscriberCount()).toBe(1)
    expect(bus.disconnects()).toBe(1)
    bus.emit('catalog.changed', { providerId: null })
    expect(seen.at(-1)).toBe('plain')
    expect(bus.ofType('catalog.changed')).toHaveLength(1)
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

// ---------- Phase 6 (C11-T5) ----------

function signal(): AbortSignal {
  return new AbortController().signal
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController()
  controller.abort()
  return controller.signal
}

describe('createFakeChatsService: deleteMessage (ADR-030)', () => {
  it('deletes a version on the active path with its subtree; the path moves to the previous version', async () => {
    const { t, chats, events } = await treeApp()
    const created = await chats.create(TREE)
    await chats.addUsage({ chatId: chatId(1), messageId: mid(6), purpose: 'chat', providerId: 'mock', modelId: 'echo', inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null })
    events.clear()
    const detail = chatDetailSchema.parse(await chats.deleteMessage(chatId(1), mid(5)))
    expect(ids(detail.messages)).toEqual([mid(1), mid(2), mid(3), mid(4)])
    expect(detail.branches).toEqual({})
    expect(detail.updatedAt).toBe(created.updatedAt)
    expect(ids(await chats.listMessages(chatId(1)))).toEqual([mid(1), mid(2), mid(3), mid(4)])
    expect(events.ofType('chat.updated').map(event => [event.data.id, event.data.activeLeafId])).toEqual([[chatId(1), mid(4)]])
    expect(await t.db.select({ id: usage.id }).from(usage)).toHaveLength(1)
    // The new path is recorded as remembered.
    const pointers = await t.db.select({ id: messages.id, selectedChildId: messages.selectedChildId }).from(messages).where(eq(messages.chatId, chatId(1)))
    expect(Object.fromEntries(pointers.map(row => [row.id, row.selectedChildId]))).toEqual({ [mid(1)]: mid(2), [mid(2)]: mid(3), [mid(3)]: mid(4), [mid(4)]: null })
  })

  it('moves to the remembered leaf under the previous version, not the latest one', async () => {
    const { t, chats } = await treeApp()
    // A (1) -> RA (2) -> B (3) -> RB (4); under RA a newer version B2 (7) -> RB2 (8); A2 (5) -> RA2 (6) shown.
    await chats.create({
      id: chatId(2),
      messages: [user(1, 'A'), assistant(2, 'RA'), user(3, 'B'), assistant(4, 'RB'), user(5, 'A2'), assistant(6, 'RA2'), user(7, 'B2'), assistant(8, 'RB2')],
      parentIds: [null, mid(1), mid(2), mid(3), null, mid(5), mid(2), mid(7)],
      activeLeafId: mid(6),
    })
    for (const [parent, child] of [[1, 2], [2, 3], [3, 4]] as const)
      await t.db.update(messages).set({ selectedChildId: mid(child) }).where(and(eq(messages.chatId, chatId(2)), eq(messages.id, mid(parent))))
    const detail = await chats.deleteMessage(chatId(2), mid(5))
    expect(ids(detail.messages)).toEqual([mid(1), mid(2), mid(3), mid(4)])
    expect(detail.branches).toEqual({ [mid(3)]: { siblings: [mid(3), mid(7)], index: 0 } })
  })

  it('deletes a version off the active path without moving the leaf; the first version moves to the next one', async () => {
    const { chats, events } = await treeApp()
    await chats.create(TREE)
    events.clear()
    // A (1) is off the path (A2 is shown): deleting it keeps A2 -> RA2.
    const offPath = await chats.deleteMessage(chatId(1), mid(1))
    expect(ids(offPath.messages)).toEqual([mid(5), mid(6)])
    expect(offPath.branches).toEqual({})
    expect(ids(await chats.listMessages(chatId(1)))).toEqual([mid(5), mid(6)])
    expect(events.ofType('chat.updated').map(event => event.data.activeLeafId)).toEqual([mid(6)])

    // A (20) is shown and has no previous version: the path moves to the next one (A2).
    await chats.create({ ...TREE, id: chatId(3), activeLeafId: mid(23), messages: TREE.messages!.map((message, index) => ({ ...message, id: mid(20 + index) })), parentIds: [null, mid(20), mid(21), mid(22), null, mid(24)] })
    expect(ids((await chats.get(chatId(3))).messages)).toEqual([mid(20), mid(21), mid(22), mid(23)])
    const next = await chats.deleteMessage(chatId(3), mid(20))
    expect(ids(next.messages)).toEqual([mid(24), mid(25)])
  })

  it('answers only-version, 404 and run-active; recomputes pending_approval', async () => {
    const { chats, runs } = await treeApp()
    await chats.create(TREE)
    expect((await rejection(chats.deleteMessage(chatId(1), mid(2)))).toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'only-version' } })
    expect((await rejection(chats.deleteMessage(chatId(9), mid(1)))).code).toBe('not_found')
    expect((await rejection(chats.deleteMessage(chatId(1), mid(9)))).code).toBe('not_found')
    runs.phases.set(chatId(1), 'streaming')
    expect((await rejection(chats.deleteMessage(chatId(1), mid(5)))).toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'run-active', chatId: chatId(1) } })
    runs.phases.delete(chatId(1))
    expect(ids(await chats.listMessages(chatId(1)))).toHaveLength(6)

    const pending: HarnessUIMessage = {
      id: mid(11),
      role: 'assistant',
      parts: [{ type: 'tool-current_time', toolCallId: 'call-1', state: 'approval-requested', input: {}, approval: { id: 'approval-1' } } as never],
    }
    await chats.ensure(chatId(4))
    await chats.appendMessage(chatId(4), user(10), null)
    await chats.appendMessage(chatId(4), pending, mid(10))
    await chats.appendMessage(chatId(4), user(12), null)
    await chats.setActiveLeaf(chatId(4), mid(12))
    expect((await chats.deleteMessage(chatId(4), mid(12))).pendingApproval).toBe(true)
  })
})

describe('createFakeFilesService: saveGenerated', () => {
  const PNG = encodeSolidPng(4, 3, [10, 20, 30])

  it('stores a raster image once per content and returns the row', async () => {
    const { t } = await treeApp()
    const first = await t.deps.files.saveGenerated({ data: PNG, mediaType: 'image/png', name: 'image-1.png' })
    expect(first).toMatchObject({ name: 'image-1.png', mime: 'image/png', size: PNG.byteLength })
    expect((await t.deps.files.read(first.id)).data).toEqual(PNG)
    expect((await t.deps.files.saveGenerated({ data: PNG, mediaType: 'image/png; foo=bar', name: 'other.png' })).id).toBe(first.id)
    const uploaded = await t.deps.files.upload(new File([encodeSolidPng(2, 2, [1, 1, 1])], 'u.png', { type: 'image/png' }))
    expect((await t.deps.files.saveGenerated({ data: encodeSolidPng(2, 2, [1, 1, 1]), mediaType: 'image/png', name: 'g.png' })).id).toBe(uploaded.id)
  })

  it('refuses SVG and other types, a type mismatch and oversized images', async () => {
    const { t } = await treeApp()
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    expect((await rejection(t.deps.files.saveGenerated({ data: svg, mediaType: 'image/svg+xml', name: 'a.svg' }))).code).toBe('validation_error')
    expect((await rejection(t.deps.files.saveGenerated({ data: PNG, mediaType: 'image/jpeg', name: 'a.jpg' }))).code).toBe('validation_error')
    expect((await rejection(t.deps.files.saveGenerated({ data: PNG, mediaType: 'application/pdf', name: 'a.pdf' }))).code).toBe('validation_error')
    const huge = new Uint8Array(LIMITS.generatedImageBytes + 1)
    huge.set(PNG)
    expect((await rejection(t.deps.files.saveGenerated({ data: huge, mediaType: 'image/png', name: 'big.png' }))).toJSON().error).toMatchObject({ code: 'payload_too_large', details: { limitBytes: LIMITS.generatedImageBytes } })
    expect(await t.db.select().from(files)).toEqual([])
  })
})

describe('createFakeImageService', () => {
  async function imageApp(options: Parameters<typeof createFakeImageService>[1] = {}): Promise<TestApp> {
    const t = await createTestApp({ start: false, factories: { images: deps => createFakeImageService(deps, options) } })
    apps.push(t)
    return t
  }

  it('stores n PNGs at the aspect ratio, writes the usage row and answers the mock usage', async () => {
    const t = await imageApp()
    await t.deps.chats.ensure(chatId(1))
    const result = await t.deps.images.generate({ modelRef: 'mock:image', prompt: '  a red fox ', n: 2, aspectRatio: '16:9', signal: signal(), chatId: chatId(1), messageId: mid(1) })
    expect(result).toMatchObject({ modelRef: 'mock:image', usage: { inputTokens: 3, outputTokens: 200, totalTokens: 203 }, costUsd: null, revisedPrompt: 'Mock: a red fox', dropped: 0 })
    expect(result.images.map(image => image.file.name)).toEqual(['image-1.png', 'image-2.png'])
    for (const image of result.images) {
      expect(image.url).toBe(`/api/files/${image.file.id}`)
      expect(image.file.mime).toBe('image/png')
      expect(readPng((await t.deps.files.read(image.file.id)).data)).toMatchObject({ width: 320, height: 180 })
    }
    expect(firstPixel(readPng((await t.deps.files.read(result.images[0]!.file.id)).data))).toEqual(mockImageColor('a red fox', 0))
    const rows = await t.db.select().from(usage)
    expect(rows).toEqual([expect.objectContaining({ chatId: chatId(1), messageId: mid(1), purpose: 'image', providerId: 'mock', modelId: 'image', input: 3, output: 200, costUsd: null })])
    expect((t.deps.images as ReturnType<typeof createFakeImageService>).calls).toHaveLength(1)
  })

  it('takes the model from resolved, then modelRef, then settings.imageModelRef, else validation_error', async () => {
    const t = await imageApp({ recordUsage: false })
    const input = { prompt: 'x', n: 1, signal: signal(), chatId: null, messageId: null }
    const missing = await rejection(t.deps.images.generate(input))
    expect(missing).toMatchObject({ code: 'validation_error', message: NO_IMAGE_MODEL_MESSAGE })
    await t.deps.settings.update({ imageModelRef: 'mock:image' })
    expect((await t.deps.images.generate(input)).modelRef).toBe('mock:image')
    expect((await t.deps.images.generate({ ...input, modelRef: 'openai:gpt-image-1' })).modelRef).toBe('openai:gpt-image-1')
    const resolved = { modelRef: 'xai:grok-imagine-image' } as ResolvedImageModel
    expect((await t.deps.images.generate({ ...input, resolved, modelRef: 'openai:gpt-image-1' })).modelRef).toBe('xai:grok-imagine-image')
    expect(await t.db.select().from(usage)).toEqual([])
  })

  it('checks the prompt, n and the input files; edits change the colors', async () => {
    const t = await imageApp({ recordUsage: false })
    const base = { modelRef: 'mock:image', prompt: 'boat', n: 1, signal: signal(), chatId: null, messageId: null }
    expect((await rejection(t.deps.images.generate({ ...base, prompt: '   ' }))).code).toBe('validation_error')
    expect((await rejection(t.deps.images.generate({ ...base, prompt: 'p'.repeat(LIMITS.imagePromptMaxChars + 1) }))).code).toBe('validation_error')
    expect((await rejection(t.deps.images.generate({ ...base, n: 5 }))).code).toBe('validation_error')
    expect((await rejection(t.deps.images.generate({ ...base, n: 0 }))).code).toBe('validation_error')
    expect((await rejection(t.deps.images.generate({ ...base, inputFileIds: ['file_0000000000000009'] }))).code).toBe('not_found')
    const first = await t.deps.images.generate(base)
    const inputs = Array.from({ length: LIMITS.imageInputsMax + 1 }, () => first.images[0]!.file.id)
    expect((await rejection(t.deps.images.generate({ ...base, inputFileIds: inputs }))).code).toBe('validation_error')
    const edit = await t.deps.images.generate({ ...base, inputFileIds: [first.images[0]!.file.id] })
    const color = async (id: string): Promise<[number, number, number]> => firstPixel(readPng((await t.deps.files.read(id)).data))
    expect(await color(edit.images[0]!.file.id)).not.toEqual(await color(first.images[0]!.file.id))
  })

  it('reports dropped images, injects failures and honors the abort signal', async () => {
    const dropping = await imageApp({ dropped: 1, costUsd: 0.25, recordUsage: false })
    const base = { modelRef: 'mock:image', prompt: 'boat', n: 2, signal: signal(), chatId: null, messageId: null }
    expect(await dropping.deps.images.generate(base)).toMatchObject({ dropped: 1, costUsd: 0.25, images: [expect.anything()] })

    const failure = new HarnessError({ code: 'provider_error', message: 'Mock image generation failure', status: 400, providerId: 'mock' })
    const failing = await imageApp({ failWith: input => (input.prompt.includes('fail') ? failure : undefined), recordUsage: false })
    expect(await rejection(failing.deps.images.generate({ ...base, prompt: 'please fail' }))).toBe(failure)

    const slow = await imageApp({ delayMs: 5000, recordUsage: false })
    const controller = new AbortController()
    const pending = slow.deps.images.generate({ ...base, signal: controller.signal })
    setTimeout(() => controller.abort(), 10)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(slow.deps.images.generate({ ...base, signal: abortedSignal() })).rejects.toMatchObject({ name: 'AbortError' })
    expect(await slow.db.select().from(files)).toEqual([])
  })
})

describe('createFakeAudioService', () => {
  const recording = (bytes = 128, type = 'audio/webm'): Blob => new Blob([new Uint8Array(bytes)], { type })

  it('transcribes with the form model or the default, and speaks a silent WAV', async () => {
    const audio = createFakeAudioService()
    expect(await audio.transcribe({ file: recording(), form: {}, signal: signal() })).toEqual({ text: MOCK_TRANSCRIPT, language: null, durationSec: null, modelRef: 'mock:transcribe' })
    expect((await audio.transcribe({ file: recording(), form: { modelRef: 'groq:whisper-large-v3', language: 'de' }, signal: signal() })).modelRef).toBe('groq:whisper-large-v3')
    const speech = await audio.speak({ text: 'Hello world', voice: 'mock-voice-a', signal: signal() })
    expect(speech).toMatchObject({ mediaType: 'audio/wav', modelRef: 'mock:speech' })
    expect(readWav(speech.audio)).toMatchObject({ riff: 'RIFF', wave: 'WAVE', sampleRate: 8000, durationMs: 1000 })
    expect(audio.calls).toEqual([
      { member: 'transcribe', type: 'audio/webm', bytes: 128, form: {} },
      { member: 'transcribe', type: 'audio/webm', bytes: 128, form: { modelRef: 'groq:whisper-large-v3', language: 'de' } },
      { member: 'speak', text: 'Hello world', modelRef: undefined, voice: 'mock-voice-a' },
    ])
    expect((await createFakeAudioService({ text: '' }).transcribe({ file: recording(), form: {}, signal: signal() })).text).toBe('')
  })

  it('refuses a missing model, an empty or oversized recording; injects failures; honors abort', async () => {
    const none = createFakeAudioService({ transcriptionModelRef: null, speechModelRef: null })
    expect((await rejection(none.transcribe({ file: recording(), form: {}, signal: signal() }))).code).toBe('validation_error')
    expect((await rejection(none.speak({ text: 'hi', signal: signal() }))).code).toBe('validation_error')
    expect((await none.speak({ text: 'hi', modelRef: 'mock:speech', signal: signal() })).modelRef).toBe('mock:speech')

    const audio = createFakeAudioService()
    expect(await rejection(audio.transcribe({ file: recording(63), form: {}, signal: signal() }))).toMatchObject({ code: 'validation_error', message: 'The recording is empty.' })
    expect((await rejection(audio.transcribe({ file: recording(LIMITS.audioUploadBytes + 1), form: {}, signal: signal() }))).toJSON().error).toMatchObject({ code: 'payload_too_large', details: { limitBytes: LIMITS.audioUploadBytes } })
    await expect(audio.speak({ text: 'hi', signal: abortedSignal() })).rejects.toMatchObject({ name: 'AbortError' })

    const failure = new HarnessError({ code: 'rate_limited', message: 'Slow down.' })
    const failing = createFakeAudioService({ failWith: member => (member === 'speak' ? failure : undefined) })
    expect(await rejection(failing.speak({ text: 'hi', signal: signal() }))).toBe(failure)
    expect((await failing.transcribe({ file: recording(), form: {}, signal: signal() })).text).toBe(MOCK_TRANSCRIPT)

    const slow = createFakeAudioService({ delayMs: 5000 })
    const controller = new AbortController()
    const pending = slow.transcribe({ file: recording(), form: {}, signal: controller.signal })
    setTimeout(() => controller.abort(), 10)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('fake media resolvers (providers/testing.ts)', () => {
  async function mediaApp(options: Parameters<typeof fakeMediaProviders>[0] = {}): Promise<TestApp> {
    const t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, factories: { providers: fakeMediaProviders(options) } })
    apps.push(t)
    return t
  }

  it('resolves the mock media models from the catalog and registry, backed by instant mock models', async () => {
    const t = await mediaApp()
    const image = await t.deps.providers.resolveImageModel('mock:image', { signal: signal() })
    expect(image).toMatchObject({ modelRef: 'mock:image', providerId: 'mock', modelId: 'image', entry: { kind: 'image', ref: 'mock:image' }, info: { id: 'image', kind: 'image' } })
    expect(image.provider.definition.id).toBe('mock')
    const generated = await generateImage({ model: image.imageModel, prompt: 'a red fox', n: 2, aspectRatio: '9:16' })
    expect(generated.images.map(file => readPng(file.uint8Array).height)).toEqual([320, 320])
    expect(generated.usage).toEqual({ inputTokens: 3, outputTokens: 200, totalTokens: 203 })

    const transcription = await t.deps.providers.resolveTranscriptionModel('mock:transcribe')
    expect(transcription.entry.kind).toBe('transcription')
    expect((await transcribe({ model: transcription.model, audio: new Uint8Array(64) })).text).toBe(MOCK_TRANSCRIPT)
    const speech = await t.deps.providers.resolveSpeechModel('mock:speech')
    expect(speech.entry).toMatchObject({ kind: 'speech' })
    expect((await generateSpeech({ model: speech.model, text: 'Hello world' })).audio.mediaType).toBe('audio/wav')
  })

  it('answers the resolver errors: wrong kind, unknown model, unknown provider; resolveModel refuses image models', async () => {
    const t = await mediaApp()
    expect((await rejection(t.deps.providers.resolveImageModel('mock:echo'))).code).toBe('validation_error')
    expect((await rejection(t.deps.providers.resolveTranscriptionModel('mock:speech'))).code).toBe('validation_error')
    expect((await rejection(t.deps.providers.resolveSpeechModel('mock:transcribe'))).code).toBe('validation_error')
    expect((await rejection(t.deps.providers.resolveImageModel('mock:nope'))).toJSON().error).toMatchObject({ code: 'model_not_found', action: 'refresh-models' })
    expect((await rejection(t.deps.providers.resolveSpeechModel('acme:speech'))).code).toBe('provider_not_configured')
    expect((await rejection(t.deps.providers.resolveModel('mock:image'))).code).toBe('validation_error')
    expect((await t.deps.providers.resolveModel('mock:echo')).modelRef).toBe('mock:echo')
  })

  it('returns the model instances given per ref', async () => {
    const custom = new MockTranscriptionModelV4({ provider: 'mock', modelId: 'transcribe', doGenerate: async () => ({ text: 'custom', segments: [], language: 'en', durationInSeconds: 1.5, warnings: [], response: { timestamp: new Date(0), modelId: 'transcribe' } }) })
    const t = await mediaApp({ transcriptionModels: { 'mock:transcribe': custom } })
    const resolved = await t.deps.providers.resolveTranscriptionModel('mock:transcribe')
    expect(resolved.model).toBe(custom)
    expect(await transcribe({ model: resolved.model, audio: new Uint8Array(64) })).toMatchObject({ text: 'custom', language: 'en', durationInSeconds: 1.5 })
  })
})

describe('createFakePluginHost: ctx.images', () => {
  it('delegates to the app image service and maps the result to the plugin API shape', async () => {
    let ctx: PluginContext | undefined
    const t = await createProvidersTestApp({
      builtins: [{ id: 'mock', manifest: mockManifest, module: { setup: (context) => {
        ctx = context
      } } }],
      factories: { images: deps => createFakeImageService(deps, { costUsd: 0.5 }) },
    })
    apps.push(t)
    const result = await ctx!.images.generate({ prompt: 'a lighthouse', modelRef: 'mock:image', n: 2, aspectRatio: '1:1' })
    expect(result).toMatchObject({ modelRef: 'mock:image', costUsd: 0.5, revisedPrompt: 'Mock: a lighthouse' })
    expect(result.images).toHaveLength(2)
    for (const image of result.images) {
      expect(image).toMatchObject({ url: `/api/files/${image.fileId}`, mediaType: 'image/png', name: expect.stringMatching(/^image-\d\.png$/) })
      expect(image.size).toBe((await t.deps.files.get(image.fileId))?.size)
    }
    const calls = (t.deps.images as ReturnType<typeof createFakeImageService>).calls
    expect(calls.at(-1)).toMatchObject({ modelRef: 'mock:image', n: 2, aspectRatio: '1:1', chatId: null, messageId: null })

    const controller = new AbortController()
    controller.abort()
    await expect(ctx!.images.generate({ prompt: 'x', modelRef: 'mock:image', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(ctx!.images.generate({ prompt: 'x' })).rejects.toMatchObject({ code: 'validation_error', message: NO_IMAGE_MODEL_MESSAGE })
  })

  it('reaches the real image service (P6-A) instead of the P6-0b stub', async () => {
    let ctx: PluginContext | undefined
    const t = await createProvidersTestApp({ builtins: [{ id: 'mock', manifest: mockManifest, module: { setup: (context) => {
      ctx = context
    } } }] })
    apps.push(t)
    // This mock plugin registers no provider, so the real resolver cannot find `mock:image`: an unknown provider is
    // `provider_not_configured` (Phase 7, as on chat).
    const error: unknown = await ctx!.images.generate({ prompt: 'x', modelRef: 'mock:image' }).then(() => null, (reason: unknown) => reason)
    expect(error).toMatchObject({ code: 'provider_not_configured' })
  })
})
