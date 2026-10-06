// The Phase 5 fakes (C8-T6) behave like the frozen contracts they stand in for, so W5.3 / W5.4 can rely on them; the
// Phase 6 fakes (C11-T5) likewise for W6.1, W6.4, W6.5 and W6.6; the Phase 7 additions (C14-T6) for W7.7 and W7.8. The
// fake project service has its own file (./fake-projects.test.ts). Phase 8 (W8.7): `createFakeFilesService` is the real
// files service (pins and the store gate).
import type { PluginContext } from '@harness-forge/plugin-sdk'
import type { ChatCreate, HarnessUIMessage, QueueAddBody } from '@harness-forge/shared'
import type { ResolvedImageModel } from '../providers/types.ts'
import type { ChatsService } from '../services/chats/types.ts'
import type { TestApp } from './create-test-app.ts'
import type { FakeBackgroundTasks, FakeChatRunner, RecordingEventBus } from './fakes.ts'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import {
  chatDetailSchema,
  chatExportSchema,
  claudeImportApplyResultSchema,
  claudeImportPlanSchema,
  dataCleanupPreviewSchema,
  dataCleanupResultSchema,
  dataImportResultSchema,
  HarnessError,
  hookDataSchema,
  LIMITS,
  marketplaceDetailSchema,
  marketplaceListSchema,
  projectDefinitionFileSchema,
  projectDefinitionWriteResultSchema,
  queueChangedDataSchema,
  queueItemSchema,
  SHARE_TOKEN_PATTERN,
  shareSummarySchema,
  shareViewSchema,
} from '@harness-forge/shared'
import { generateImage, generateSpeech, transcribe } from 'ai'
import { MockTranscriptionModelV4 } from 'ai/test'
import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { manifest as mockManifest } from '../builtin-plugins/mock/index.ts'
import { firstPixel, readPng, readWav } from '../builtin-plugins/mock/media.test-util.ts'
import { MOCK_TRANSCRIPT, mockImageColor } from '../builtin-plugins/mock/media.ts'
import { encodeSolidPng } from '../builtin-plugins/mock/png.ts'
import { chats, chatShares, files, messages, usage } from '../db/schema.ts'
import { createMemoryLogger } from '../logger.ts'
import { createProvidersTestApp, fakeMediaProviders } from '../providers/testing.ts'
import { messageInsertValues } from '../services/chats/store.ts'
import { createFilesService } from '../services/files/index.ts'
import { seedStoredFile } from '../services/files/store.test-util.ts'
import { createTestApp } from './create-test-app.ts'
import { createFakeClaudeImportService, fakeClaudeImportItem } from './fake-claude-import.ts'
import { createFakeHookService, createFakeHookSnapshot, fakeHookRecord, fakeHookResult, fakePromptHookRecord, fakePromptHookResult, hookTargetKey } from './fake-hooks.ts'
import { createFakeMarketplaceService, fakeMarketplaceEntry, marketplaceSourceKey } from './fake-marketplaces.ts'
import { createFakeProjectConfigService, fakeProjectConfigSnapshot, fakeProjectHookItem, fakeProjectMcpServerItem } from './fake-project-config.ts'
import { createFakeProjectDefinitionsService, projectDefinitionFileKey } from './fake-project-definitions.ts'
import { createFakeProjectMcpManager, fakeProjectMcpTool, fakeProjectMcpTools } from './fake-project-mcp.ts'
import { createFakeProjectTrustService, trustItemOf } from './fake-project-trust.ts'
import {
  createFakeAudioService,
  createFakeBackgroundTasks,
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

  // Phase 9 (C24-T5): the steer queue members.
  const queueBody = (id: string, text = 'also check the tests'): QueueAddBody => ({
    message: { id, role: 'user', parts: [{ type: 'text', text }] },
    modelRef: 'mock:steer',
    reasoningEffort: 'off',
    toolMode: 'ask',
  })
  const options = { logger: createMemoryLogger().logger, requestId: 'req_test' }
  const [QA, QB, QC, QD, QX, QY] = [901, 902, 903, 904, 905, 906].map(chatId) as [string, string, string, string, string, string]

  it('phase 9: enqueue needs a run or a pending approval, caps the queue, refuses a used id; items follow the schema', async () => {
    const events = createRecordingEventBus()
    const runs = createFakeChatRunner({}, { events, now: () => 42 })
    expect((await rejection(runs.enqueue(QA, queueBody('msg_q000000000000001'), options))).details).toEqual({ reason: 'run-idle', chatId: QA })
    runs.phases.set(QA, 'streaming')
    runs.awaitingApproval.add(QB)
    const item = await runs.enqueue(QA, queueBody('msg_q000000000000001'), options)
    expect(queueItemSchema.parse(item)).toEqual({ ...queueBody('msg_q000000000000001'), id: 'msg_q000000000000001', createdAt: 42, turnOnly: false })
    expect((await runs.enqueue(QB, queueBody('msg_q000000000000002', '/compact keep numbers'), options)).turnOnly).toBe(true)
    // A used id is refused in any chat.
    const exists = await rejection(runs.enqueue(QA, queueBody('msg_q000000000000002'), options))
    expect([exists.code, exists.details]).toEqual(['conflict', { reason: 'exists', chatId: QA }])
    for (let n = 3; n <= LIMITS.queueItemsMax + 1; n++)
      await runs.enqueue(QA, queueBody(`msg_q0000000000000${String(n).padStart(2, '0')}`), options)
    expect(runs.queueList(QA)).toHaveLength(LIMITS.queueItemsMax)
    expect((await rejection(runs.enqueue(QA, queueBody('msg_q000000000000099'), options))).details).toEqual({ reason: 'queue-full', chatId: QA })
    // Every accepted item emitted the whole queue, validated by the shared schema.
    const changed = events.ofType('queue.changed')
    expect(changed).toHaveLength(LIMITS.queueItemsMax + 1)
    expect(changed.every(event => queueChangedDataSchema.safeParse(event.data).success)).toBe(true)
    expect(changed.at(-1)?.data.items.map(entry => entry.id)).toEqual(runs.queueList(QA).map(entry => entry.id))
    // queueList returns a copy, oldest first.
    runs.queueList(QA).length = 0
    expect(runs.queueList(QA)[0]?.id).toBe('msg_q000000000000001')
    expect(runs.queueList(chatId(999))).toEqual([])
  })

  it('phase 9: dequeue cancels a queued item once; clearQueue returns the removed items; stop and stopAll empty the queues first', async () => {
    const events = createRecordingEventBus()
    const runs = createFakeChatRunner({}, { events })
    runs.phases.set(QA, 'streaming')
    runs.phases.set(QB, 'streaming')
    runs.awaitingApproval.add(QC)
    for (const [chat, id] of [[QA, 'msg_q100000000000001'], [QA, 'msg_q100000000000002'], [QA, 'msg_q100000000000003'], [QB, 'msg_q200000000000001'], [QC, 'msg_q300000000000001']] as const)
      await runs.enqueue(chat, queueBody(id), options)
    events.clear()

    expect(runs.dequeue(QA, 'msg_q100000000000002')).toBe(true)
    expect(runs.dequeue(QA, 'msg_q100000000000002')).toBe(false)
    expect(runs.dequeue(QB, 'msg_q100000000000001')).toBe(false)
    expect(events.ofType('queue.changed').map(event => event.data)).toEqual([{
      chatId: QA,
      items: runs.queueList(QA),
      removed: [{ id: 'msg_q100000000000002', reason: 'cancelled' }],
    }])

    expect(runs.clearQueue(QB, 'failed').map(item => item.id)).toEqual(['msg_q200000000000001'])
    expect(runs.clearQueue(QB, 'failed')).toEqual([])
    expect(events.ofType('queue.changed')).toHaveLength(2)

    // The stop route: clearQueue first (the dropped items), then stop (its own clearing finds nothing).
    const dropped = runs.clearQueue(QA, 'stopped')
    expect(dropped.map(item => item.id)).toEqual(['msg_q100000000000001', 'msg_q100000000000003'])
    expect(await runs.stop(QA)).toBe(true)
    // stop alone empties the queue of a chat waiting for an approval (no run: false).
    expect(await runs.stop(QC)).toBe(false)
    expect(runs.queueList(QC)).toEqual([])
    expect(runs.removals.map(removal => [removal.chatId, removal.id, removal.reason])).toEqual([
      [QA, 'msg_q100000000000002', 'cancelled'],
      [QB, 'msg_q200000000000001', 'failed'],
      [QA, 'msg_q100000000000001', 'stopped'],
      [QA, 'msg_q100000000000003', 'stopped'],
      [QC, 'msg_q300000000000001', 'stopped'],
    ])

    // stopAll: every queue is emptied before the first run stops.
    const bus = createRecordingEventBus()
    const all = createFakeChatRunner({}, { events: bus })
    all.phases.set(QX, 'streaming')
    all.phases.set(QY, 'streaming')
    await all.enqueue(QX, queueBody('msg_q500000000000001'), options)
    await all.enqueue(QY, queueBody('msg_q500000000000002'), options)
    const stoppedWhenCleared: number[] = []
    bus.subscribe((event) => {
      if (event.type === 'queue.changed')
        stoppedWhenCleared.push(all.stopped.length)
    })
    await all.stopAll()
    expect(stoppedWhenCleared).toEqual([0, 0])
    expect(all.stopped).toEqual([QX, QY])
    expect(all.removals.map(removal => [removal.chatId, removal.reason])).toEqual([[QX, 'stopped'], [QY, 'stopped']])
    runs.phases.set(QD, 'streaming')
    await runs.enqueue(QD, queueBody('msg_q400000000000001'), options)
    await runs.stopAll()
    expect(runs.queueList(QD)).toEqual([])
    expect(runs.phases.size).toBe(0)
  })

  it('phase 10: the task members delegate to the background manager; stopAll stops queues, then tasks, then runs', async () => {
    const runs = createFakeChatRunner()
    const background = runs.background as FakeBackgroundTasks
    expect(await runs.taskList(QA)).toEqual([])
    expect(runs.hasTasks(QA)).toBe(false)
    expect(await runs.stopTask(QA, 'bgt_AAAAAAAAAAAAAAAA')).toBeNull()
    expect(await runs.stopTasks(QA)).toBe(0)
    await runs.boot()
    expect(background.calls).toMatchObject({ list: 1, hasRunning: 1, stop: 1, stopChat: 1, start: 1 })

    const order: string[] = []
    const ordered = createFakeChatRunner({}, {
      backgroundTasks: { ...createFakeBackgroundTasks(), stopAll: async () => void order.push(`tasks (queued: ${ordered.queueList(QX).length}, stopped runs: ${ordered.stopped.length})`) },
    })
    ordered.phases.set(QX, 'streaming')
    await ordered.enqueue(QX, queueBody('msg_q600000000000001'), options)
    await ordered.stopAll()
    expect(order).toEqual(['tasks (queued: 0, stopped runs: 0)'])
    expect(ordered.stopped).toEqual([QX])
    // The chat's own stop never stops a background task.
    await ordered.stop(QX)
    expect(order).toHaveLength(1)
  })
})

describe('createFakeDataService', () => {
  it('phase 8: start / stop are no-ops that are counted, never recorded in calls', async () => {
    const data = createFakeDataService()
    await expect(data.start()).resolves.toBeUndefined()
    await expect(data.stop()).resolves.toBeUndefined()
    await data.stop()
    expect(data.lifecycle).toEqual({ started: 1, stopped: 2 })
    expect(data.calls).toEqual([])
  })

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

  // Phase 8 (W8.7-T6): the deprecated alias is the real files service, so the reuse paths pin and use the store gate.
  it('is the real files service: rows reused by importFile and saveGenerated are pinned', async () => {
    expect(createFakeFilesService).toBe(createFilesService)
    const { t } = await treeApp()
    const text = new TextEncoder().encode('reused notes')
    const png = encodeSolidPng(2, 2, [9, 9, 9])
    const oldText = await seedStoredFile(t.deps, text, { createdAt: 1, name: 'old.txt', mime: 'text/plain' })
    const oldPng = await seedStoredFile(t.deps, png, { createdAt: 1, name: 'old.png', mime: 'image/png' })
    expect(t.deps.files.pinnedIds()).toEqual(new Set())
    const imported = await t.deps.files.importFile({ preferredId: 'file_0000000000000009', sha256: sha(text), name: 'notes.txt', mime: 'text/plain', data: text, createdAt: 5 })
    expect(imported).toMatchObject({ reused: true, file: { id: oldText.id } })
    const saved = await t.deps.files.saveGenerated({ data: png, mediaType: 'image/png', name: 'image-1.png' })
    expect(saved.id).toBe(oldPng.id)
    expect(t.deps.files.pinnedIds()).toEqual(new Set([oldText.id, oldPng.id]))
    // A sweep never removes them, although they are old and unreferenced.
    expect(await t.deps.files.sweep({ referencedIds: new Set(), createdBefore: Date.now(), dryRun: false })).toMatchObject({ files: 0, recentFiles: 2 })
  })

  it('importFile and saveGenerated wait while the exclusive gate is held; purge waits for a shared holder', async () => {
    const { t } = await treeApp()
    const text = new TextEncoder().encode('gated notes')
    const png = encodeSolidPng(3, 1, [1, 2, 3])
    let release!: () => void
    const held = t.deps.files.withExclusiveGate(() => new Promise<void>((resolve) => {
      release = resolve
    }))
    const done: string[] = []
    const importing = t.deps.files.importFile({ preferredId: 'file_0000000000000001', sha256: sha(text), name: 'n.txt', mime: 'text/plain', data: text, createdAt: 1 }).then(() => done.push('import'))
    const saving = t.deps.files.saveGenerated({ data: png, mediaType: 'image/png', name: 'g.png' }).then(() => done.push('save'))
    for (let tick = 0; tick < 20; tick++)
      await new Promise(resolve => setImmediate(resolve))
    expect(done).toEqual([])
    expect(await t.db.select().from(files)).toEqual([])
    release()
    await held
    await Promise.all([importing, saving])
    expect(done.sort()).toEqual(['import', 'save'])

    let finish!: () => void
    const reading = t.deps.files.withSharedGate(() => new Promise<void>((resolve) => {
      finish = resolve
    }))
    let purged = false
    const purging = t.deps.files.purge().then(() => {
      purged = true
    })
    for (let tick = 0; tick < 20; tick++)
      await new Promise(resolve => setImmediate(resolve))
    expect(purged).toBe(false)
    finish()
    await reading
    await purging
    expect(await t.db.select().from(files)).toEqual([])
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

describe('phase 11 fakes: hooks', () => {
  const signal = new AbortController().signal

  it('createFakeHookSnapshot: results per event and target, function results, the call log, has, abort', async () => {
    const deny = fakeHookResult({ decision: 'deny', reason: 'no shell', record: fakeHookRecord('PreToolUse', 'denied', { toolCallId: 'c1', toolName: 'shell' }) })
    const snapshot = createFakeHookSnapshot({
      results: { PostToolUse: input => fakeHookResult({ context: `saw ${input.tool?.name}` }) },
      targets: { [hookTargetKey('PreToolUse', 'shell')]: deny },
      present: ['Notification'],
    })
    expect(['PreToolUse', 'PostToolUse', 'Notification', 'Stop'].map(event => snapshot.has(event as 'Stop'))).toEqual([true, true, true, false])
    expect(await snapshot.run('PreToolUse', { tool: { name: 'shell', callId: 'c1', input: {} } }, { signal })).toBe(deny)
    // Another target of the event has no scripted result: nothing ran.
    expect((await snapshot.run('PreToolUse', { tool: { name: 'read_file', callId: 'c2', input: {} } }, { signal })).ran).toBe(false)
    // `options.target` wins over the tool name.
    expect(await snapshot.run('PreToolUse', { tool: { name: 'other', callId: 'c3', input: {} } }, { signal, target: 'shell' })).toBe(deny)
    expect((await snapshot.run('PostToolUse', { tool: { name: 'write_file', callId: 'c4', input: {}, output: 'ok' } }, { signal })).context).toBe('saw write_file')
    expect(await snapshot.run('Notification', { message: 'waiting', notificationType: 'permission_prompt' }, { signal })).toMatchObject({ ran: false, record: null })
    expect(snapshot.calls.map(call => [call.event, call.input.tool?.callId ?? null])).toEqual([['PreToolUse', 'c1'], ['PreToolUse', 'c2'], ['PreToolUse', 'c3'], ['PostToolUse', 'c4'], ['Notification', null]])
    expect(snapshot.scope).toMatchObject({ projectId: null, toolMode: 'ask', origin: 'request' })

    const aborted = new AbortController()
    aborted.abort(new Error('stopped'))
    await expect(snapshot.run('Stop', {}, { signal: aborted.signal })).rejects.toThrow('stopped')
    expect(snapshot.calls).toHaveLength(6)
    expect(deny.record).toMatchObject({ event: 'PreToolUse', outcome: 'denied', hooks: [{ source: 'personal', exitCode: 0 }] })
    expect(deny.record?.id).toMatch(/^hev_/)
  })

  it('createFakeHookService: snapshots read the live scripts; personal hooks follow the contract; list, runs, invalidate', async () => {
    const events = createRecordingEventBus()
    const service = createFakeHookService({ events, switches: { setting: false } })
    const snapshot = await service.snapshot({ chatId: chatId(9), projectId: null, workspace: null, toolMode: 'auto', origin: 'hook', modelRef: 'mock:hooks' })
    expect(snapshot.has('Stop')).toBe(false)
    service.results.set('Stop', fakeHookResult({ block: true, reason: 'run the tests' }))
    expect(snapshot.has('Stop')).toBe(true)
    expect(await snapshot.run('Stop', { stopHookActive: true }, { signal })).toMatchObject({ block: true, reason: 'run the tests' })
    expect(service.runCalls.map(call => [call.event, call.input.stopHookActive])).toEqual([['Stop', true]])
    expect(service.snapshots).toEqual([snapshot])

    let fresh = 0
    const sensitive = { requireFreshAuth: () => void (fresh += 1) }
    const created = await service.create({ event: 'PreToolUse', matcher: 'Bash', command: 'sh guard.sh' }, sensitive)
    expect(created).toMatchObject({ event: 'PreToolUse', matcher: 'Bash', timeout: null, enabled: true })
    expect(created.id).toMatch(/^hok_/)
    await service.update(created.id, { enabled: false }, sensitive)
    expect(fresh).toBe(1)
    await service.update(created.id, { command: 'sh other.sh' }, sensitive)
    expect(fresh).toBe(2)
    const list = await service.list({ projectId: 'prj_AAAAAAAAAAAAAAAA' })
    expect(list.switches).toEqual({ setting: false, shell: true, safeMode: false })
    expect(list.items.map(item => [item.key, item.state])).toEqual([[`personal:${created.id}`, 'off']])
    expect(list.project).toMatchObject({ id: 'prj_AAAAAAAAAAAAAAAA', available: true })
    await service.remove(created.id)
    await expect(service.remove(created.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(service.update(created.id, { enabled: true })).rejects.toMatchObject({ code: 'not_found' })
    expect(events.ofType('hooks.changed').map(event => event.data)).toEqual([{ projectId: null }, { projectId: null }, { projectId: null }, { projectId: null }])

    for (let index = 0; index < LIMITS.personalHooksMax; index++)
      await service.create({ event: 'Stop', command: `sh stop-${index}.sh` })
    await expect(service.create({ event: 'Stop', command: 'sh one-more.sh' })).rejects.toMatchObject({ code: 'conflict' })

    service.runLog.push({ id: 'hev_AAAAAAAAAAAAAAAA', at: 1, event: 'Stop', source: 'personal', label: 'sh stop.sh', exitCode: 2, timedOut: false, durationMs: 3, outcome: 'continued' })
    expect(service.runs(1).map(run => run.id)).toEqual(['hev_AAAAAAAAAAAAAAAA'])
    service.invalidate('prj_AAAAAAAAAAAAAAAA')
    service.invalidate(null)
    expect(service.invalidated).toEqual(['prj_AAAAAAAAAAAAAAAA', null])
    await service.stop()
    expect(service.calls).toMatchObject({ snapshot: 1, list: 1, runs: 1, invalidate: 2, stop: 1 })
  })
})

describe('phase 11 fakes: project config, trust and MCP', () => {
  const PROJECT = 'prj_AAAAAAAAAAAAAAAA'

  it('createFakeProjectConfigService: scripted snapshots, a default empty one, verify with the real hash', async () => {
    const hook = fakeProjectHookItem({ event: 'Stop', command: 'sh .claude/hooks/tests.sh' }, { refs: [{ path: '.claude/hooks/tests.sh', sha256: 'c'.repeat(64) }] })
    const server = fakeProjectMcpServerItem('github')
    const config = createFakeProjectConfigService({ snapshots: { [PROJECT]: fakeProjectConfigSnapshot(PROJECT, { hooks: [hook], mcpServers: [server] }) } })
    const snapshot = await config.snapshot(PROJECT, { refresh: true })
    expect(snapshot).toMatchObject({ available: true, settingsFiles: ['.claude/settings.json'], mcpFile: true })
    expect(snapshot.hooks[0]?.spec).toMatchObject({ event: 'Stop', matcher: null, timeoutSec: null, file: '.claude/settings.json' })
    expect(snapshot.mcpServers[0]?.server).toMatchObject({ id: 'github', name: 'github', transport: { type: 'stdio', command: 'node' } })
    expect(await config.snapshot('prj_BBBBBBBBBBBBBBBB')).toMatchObject({ available: true, hooks: [], mcpServers: [] })
    expect(config.reads).toEqual([{ projectId: PROJECT, refresh: true }, { projectId: 'prj_BBBBBBBBBBBBBBBB', refresh: false }])

    expect(await config.verify(PROJECT, hook)).toBe(true)
    expect(await config.verify(PROJECT, { ...hook, hashItem: { ...hook.hashItem, command: 'sh evil.sh' } })).toBe(false)
    config.changed.add(server.sha256)
    expect(await config.verify(PROJECT, server)).toBe(false)
    expect(config.verified.map(entry => entry.sha256)).toEqual([hook.sha256, hook.sha256, server.sha256])
    config.invalidate(PROJECT)
    config.stop()
    expect(config.calls).toMatchObject({ snapshot: 2, verify: 3, invalidate: 1, stop: 1 })
  })

  it('createFakeProjectTrustService: an in-memory approved set; stale hashes; fresh auth; events; pending and orphaned', async () => {
    const events = createRecordingEventBus()
    const hook = fakeProjectHookItem({ command: 'sh guard.sh' })
    // eslint-disable-next-line no-template-curly-in-string -- `.mcp.json` variable references are test data
    const server = fakeProjectMcpServerItem('docs', { type: 'http', url: 'https://${DOCS_HOST:-docs.example.com}/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } })
    const trust = createFakeProjectTrustService({ events, items: { [PROJECT]: [trustItemOf(hook), trustItemOf(server)] }, approved: { [PROJECT]: ['f'.repeat(64)] } })
    expect(trustItemOf(server)).toMatchObject({ kind: 'mcp', detail: { id: 'docs', transport: 'http', headerNames: ['Authorization'], variables: ['DOCS_HOST', 'DOCS_TOKEN'] } })
    expect(await trust.pending(PROJECT)).toBe(2)
    expect(await trust.list(PROJECT)).toMatchObject({ orphaned: 1, available: true, items: [{ state: 'pending' }, { state: 'pending' }] })

    let fresh = 0
    await expect(trust.approve(PROJECT, [{ kind: 'mcp', sha256: hook.sha256 }], { requireFreshAuth: () => void (fresh += 1) })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'stale' } })
    expect(await trust.approved(PROJECT)).toEqual(new Set(['f'.repeat(64)]))
    const approved = await trust.approve(PROJECT, [{ kind: 'hook', sha256: hook.sha256 }], { requireFreshAuth: () => void (fresh += 1) })
    expect(fresh).toBe(2)
    expect(approved.items.map(item => item.state)).toEqual(['approved', 'pending'])
    expect(await trust.pending(PROJECT)).toBe(1)
    await trust.revoke(PROJECT, hook.sha256)
    await trust.revoke(PROJECT, hook.sha256)
    expect(await trust.approved(PROJECT)).toEqual(new Set(['f'.repeat(64)]))
    expect(events.ofType('project-trust.changed').map(event => event.data.pending)).toEqual([1, 2, 2])
    expect(events.ofType('hooks.changed').map(event => event.data)).toEqual([{ projectId: PROJECT }, { projectId: PROJECT }, { projectId: PROJECT }])

    // Without scripted items every hash is accepted.
    await trust.approve('prj_BBBBBBBBBBBBBBBB', [{ kind: 'command', sha256: 'e'.repeat(64) }])
    expect(await trust.approved('prj_BBBBBBBBBBBBBBBB')).toEqual(new Set(['e'.repeat(64)]))
    expect(trust.calls).toMatchObject({ approve: 3, revoke: 2 })
  })

  it('createFakeProjectMcpManager: scripted tools and lists, variables in memory, reconnect, stops', async () => {
    const tool = fakeProjectMcpTool('docs', 'search', { text: 'found' })
    expect(tool).toMatchObject({ pluginId: 'core-mcp', mcpServerId: 'docs', title: null })
    expect(tool.definition.name).toBe('mcp__docs__search')
    const manager = createFakeProjectMcpManager({
      tools: { [PROJECT]: fakeProjectMcpTools([tool], { shadowed: ['docs'], unavailable: ['Slow Server'], names: { docs: 'Docs' } }) },
      lists: {
        [PROJECT]: {
          items: [{ id: 'docs', name: 'Docs', transport: 'http', state: 'connected', sha256: 'a'.repeat(64), tools: ['mcp__docs__search'], missingVariables: [] }],
          variables: [{ name: 'DOCS_TOKEN', set: false, hint: null, usedBy: ['docs'] }],
        },
      },
    })
    const signal = new AbortController().signal
    const tools = await manager.toolsFor(PROJECT, { signal, waitMs: 5000 })
    expect(tools.tools).toEqual([tool])
    expect([...tools.shadowed]).toEqual(['docs'])
    expect(tools.unavailable).toEqual(['Slow Server'])
    expect(tools.names.get('docs')).toBe('Docs')
    expect(await manager.toolsFor('prj_BBBBBBBBBBBBBBBB', { signal, waitMs: 0 })).toEqual({ tools: [], shadowed: new Set(), unavailable: [], names: new Map() })
    const aborted = new AbortController()
    aborted.abort(new Error('stopped'))
    await expect(manager.toolsFor(PROJECT, { signal: aborted.signal, waitMs: 5000 })).rejects.toThrow('stopped')
    expect(manager.toolsCalls).toEqual([{ projectId: PROJECT, waitMs: 5000 }, { projectId: 'prj_BBBBBBBBBBBBBBBB', waitMs: 0 }, { projectId: PROJECT, waitMs: 5000 }])

    let fresh = 0
    const updated = await manager.setVariables(PROJECT, { DOCS_TOKEN: 'secret' }, { requireFreshAuth: () => void (fresh += 1) })
    expect(fresh).toBe(1)
    expect(updated.variables).toEqual([{ name: 'DOCS_TOKEN', set: true, hint: null, usedBy: ['docs'] }])
    expect((await manager.setVariables(PROJECT, { DOCS_TOKEN: null })).variables[0]?.set).toBe(false)
    expect(await manager.reconnect(PROJECT, 'docs')).toMatchObject({ id: 'docs', state: 'connected' })
    await expect(manager.reconnect(PROJECT, 'missing')).rejects.toMatchObject({ code: 'not_found' })
    expect(await manager.list('prj_BBBBBBBBBBBBBBBB')).toEqual({ items: [], variables: [] })
    await manager.stopProject(PROJECT)
    await manager.stop()
    expect(manager.stoppedProjects).toEqual([PROJECT])
    expect(manager.calls).toMatchObject({ toolsFor: 3, setVariables: 2, reconnect: 2, list: 1, stopProject: 1, stop: 1 })
  })

  it('createTestApp installs the Phase 11 fakes; the fake hooks and trust emit on the app event bus', async () => {
    const t = await createTestApp({ start: false, hooks: 'fake', projectConfig: 'fake', projectTrust: 'fake', projectMcp: 'fake' })
    apps.push(t)
    const hooks = t.deps.hooks as ReturnType<typeof createFakeHookService>
    const seen: string[] = []
    t.deps.events.subscribe(event => seen.push(event.type))
    await hooks.create({ event: 'Stop', command: 'sh stop.sh' })
    await t.deps.projectTrust.approve(PROJECT, [{ kind: 'hook', sha256: 'a'.repeat(64) }])
    expect(seen).toEqual(['hooks.changed', 'project-trust.changed', 'hooks.changed'])
    expect((t.deps.projectConfig as ReturnType<typeof createFakeProjectConfigService>).snapshots).toBeInstanceOf(Map)
    expect((t.deps.projectMcp as ReturnType<typeof createFakeProjectMcpManager>).toolsCalls).toEqual([])
  })
})

describe('phase 12 fakes: hooks (status messages, prompt hooks, importPersonal, sessionEnd)', () => {
  const signal = new AbortController().signal

  it('statusMessage answers the scripted label by target first, then by event; prompt-hook results carry kind prompt', async () => {
    const snapshot = createFakeHookSnapshot({ statusMessages: { [hookTargetKey('PreToolUse', 'write_file')]: 'Checking the write…', Stop: 'Reviewing…' } })
    expect(snapshot.statusMessage('PreToolUse', 'write_file')).toBe('Checking the write…')
    expect(snapshot.statusMessage('PreToolUse', 'shell')).toBeNull()
    expect(snapshot.statusMessage('Stop')).toBe('Reviewing…')
    expect(snapshot.statusMessage('SessionEnd')).toBeNull()

    const blocked = fakePromptHookResult({ block: true, reason: 'run the tests' }, 'Stop')
    expect(blocked).toMatchObject({ ran: true, block: true, reason: 'run the tests', record: { event: 'Stop', outcome: 'blocked' } })
    expect(hookDataSchema.parse(blocked.record).hooks[0]).toMatchObject({ kind: 'prompt', model: 'mock:prompt-hook', exitCode: null })
    expect(fakePromptHookResult({}).record).toBeNull()
    expect(fakePromptHookResult({ context: 'ok' }, 'PostToolUse').record?.outcome).toBe('context')
    expect(fakePromptHookRecord('PermissionRequest', 'context', {}, 'mock:echo').hooks[0]?.model).toBe('mock:echo')

    const service = createFakeHookService()
    const taken = await service.snapshot({ chatId: chatId(7), projectId: null, workspace: null, toolMode: 'ask', origin: 'request', modelRef: 'mock:echo' })
    service.statusMessages.set('PostToolUseFailure', 'Looking at the failure…')
    expect(taken.statusMessage('PostToolUseFailure', 'shell')).toBe('Looking at the failure…')
    service.results.set('PostToolUseFailure', input => fakeHookResult({ context: `failed: ${input.error}` }))
    expect((await taken.run('PostToolUseFailure', { tool: { name: 'shell', callId: 'c9', input: {} }, error: 'exit 1' }, { signal })).context).toBe('failed: exit 1')
  })

  it('importPersonal creates valid hooks like create (no fresh auth), fails invalid items and items over the limit, one hooks.changed', async () => {
    const events = createRecordingEventBus()
    const service = createFakeHookService({ events })
    const results = await service.importPersonal([
      { event: 'PreToolUse', matcher: 'Bash', command: 'sh guard.sh', enabled: false },
      { type: 'prompt', event: 'Stop', prompt: 'Did the tests run? $ARGUMENTS', model: 'sonnet' },
      { event: 'PreToolUse', matcher: 'Bash(', command: 'sh broken.sh' },
    ])
    expect(results.map(result => result.ok)).toEqual([true, true, false])
    expect(results[0]).toMatchObject({ ok: true, hook: { type: 'command', enabled: false, command: 'sh guard.sh' } })
    expect(results[1]).toMatchObject({ ok: true, hook: { type: 'prompt', model: 'sonnet', enabled: true } })
    expect(service.personal.size).toBe(2)
    expect(events.ofType('hooks.changed')).toHaveLength(1)
    expect(await service.importPersonal([{ event: 'Stop', command: '' }])).toEqual([{ ok: false, message: 'The hook is not valid.' }])
    expect(events.ofType('hooks.changed')).toHaveLength(1)
    for (let index = service.personal.size; index < LIMITS.personalHooksMax; index++)
      await service.create({ event: 'Stop', command: `sh stop-${index}.sh` })
    expect((await service.importPersonal([{ event: 'Stop', command: 'sh one-more.sh' }]))[0]?.ok).toBe(false)
    expect(service.imported).toHaveLength(5)

    const chat = { id: chatId(8), projectId: null, modelRef: 'mock:echo', settings: {} }
    await expect(service.sessionEnd(chat)).resolves.toBeUndefined()
    expect(service.sessionEnds).toEqual([chat])
    expect(service.calls).toMatchObject({ importPersonal: 3, sessionEnd: 1 })
  })
})

describe('phase 12 fakes: marketplaces', () => {
  const GITHUB = { type: 'github', repo: 'acme/tools' } as const

  it('add fetches the scripted remote and stores it; get, refresh (a failure keeps the catalog), remove; events and suggestions', async () => {
    const events = createRecordingEventBus()
    const service = createFakeMarketplaceService({ events, remotes: { [marketplaceSourceKey(GITHUB)]: { name: 'acme', entries: [fakeMarketplaceEntry('lint'), fakeMarketplaceEntry('fmt', { supported: false, unsupportedReason: 'Unsupported source (git).' })] } } })
    await expect(service.add({ source: { type: 'github', repo: 'acme/other' } })).rejects.toMatchObject({ code: 'not_found' })
    const added = marketplaceDetailSchema.parse(await service.add({ source: GITHUB }))
    expect(added).toMatchObject({ name: 'acme', plugins: 2, resolvedRef: 'a'.repeat(40), lastError: null, updates: 0 })
    expect(added.id).toMatch(/^mkt_/)
    expect(await service.get(added.id)).toEqual(added)
    await expect(service.add({ source: GITHUB })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'exists' } })

    service.updates.push({ pluginId: 'lint', marketplaceId: added.id, plugin: 'lint', version: '1.0.0', availableVersion: '1.1.0' })
    const list = marketplaceListSchema.parse(await service.list())
    expect(list.items.map(item => [item.name, item.updates])).toEqual([['acme', 1]])
    expect(list.suggestions.map(suggestion => suggestion.name)).toEqual(['claude-plugins-official'])

    service.remotes.set(marketplaceSourceKey(GITHUB), { name: 'acme', resolvedRef: 'b'.repeat(40), entries: [fakeMarketplaceEntry('lint', { version: '1.1.0' })] })
    expect(await service.refresh(added.id)).toMatchObject({ plugins: 1, resolvedRef: 'b'.repeat(40) })
    service.remotes.set(marketplaceSourceKey(GITHUB), new HarnessError({ code: 'rate_limited', message: 'Slow down.', retryAfterMs: 1000 }))
    await expect(service.refresh(added.id)).rejects.toMatchObject({ code: 'rate_limited' })
    expect(await service.get(added.id)).toMatchObject({ plugins: 1, lastError: { code: 'rate_limited', message: 'Slow down.' } })

    await service.remove(added.id)
    await expect(service.get(added.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(service.remove(added.id)).rejects.toMatchObject({ code: 'not_found' })
    expect(events.ofType('marketplace.changed').map(event => event.data.marketplace?.name ?? null)).toEqual(['acme', 'acme', 'acme', null])
    await service.stop()
    expect(service.calls).toMatchObject({ list: 1, add: 3, get: 3, refresh: 2, remove: 2, stop: 1 })
  })

  it('hF_OFFLINE refuses github / url sources (409 offline), a path source still works; reserved names only from anthropics/*', async () => {
    const official = { type: 'github', repo: 'anthropics/claude-plugins-official' } as const
    const impostor = { type: 'github', repo: 'evil/official' } as const
    const folder = { type: 'path', path: '/srv/marketplace' } as const
    const service = createFakeMarketplaceService({
      offline: true,
      remotes: {
        [marketplaceSourceKey(official)]: { name: 'claude-plugins-official' },
        [marketplaceSourceKey(impostor)]: { name: 'anthropic-tools' },
        [marketplaceSourceKey(folder)]: { name: 'local' },
      },
    })
    await expect(service.add({ source: official })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'offline' } })
    expect(await service.add({ source: folder })).toMatchObject({ name: 'local', resolvedRef: null })
    service.offline = false
    await expect(service.add({ source: impostor })).rejects.toMatchObject({ code: 'validation_error' })
    expect(await service.add({ source: official })).toMatchObject({ name: 'claude-plugins-official' })
    expect((await service.list()).suggestions).toEqual([])
  })
})

describe('phase 12 fakes: claude import', () => {
  it('home and scan follow homeAnswer (disabled 409, missing 404, fresh auth); upload checks its parts; plans are kept and capped', async () => {
    const service = createFakeClaudeImportService({ items: [fakeClaudeImportItem('agent', 'reviewer'), fakeClaudeImportItem('hook', 'PreToolUse Bash', { executable: true, warnings: ['runs-commands'] })] })
    expect(await service.home()).toEqual({ available: true, path: '/home/test/.claude' })
    let fresh = 0
    const plan = claudeImportPlanSchema.parse(await service.scan({ requireFreshAuth: () => void (fresh += 1) }))
    expect(fresh).toBe(1)
    expect(plan).toMatchObject({ source: 'scan', root: '/home/test/.claude' })
    expect(plan.items.map(item => [item.kind, item.name])).toEqual([['agent', 'reviewer'], ['hook', 'PreToolUse Bash']])
    expect(plan.expiresAt - plan.createdAt).toBe(LIMITS.claudeImportPlanTtlMs)
    service.homeAnswer = { available: false, reason: 'disabled', path: null }
    await expect(service.scan()).rejects.toMatchObject({ code: 'conflict', details: { reason: 'disabled' } })
    service.homeAnswer = { available: false, reason: 'missing', path: '/nowhere' }
    await expect(service.scan()).rejects.toMatchObject({ code: 'not_found' })

    await expect(service.upload({})).rejects.toMatchObject({ code: 'validation_error' })
    await expect(service.upload({ zip: new Blob(['PK']), files: [{ path: 'agents/a.md', file: new Blob(['a']) }] })).rejects.toMatchObject({ code: 'validation_error' })
    for (let index = 0; index < LIMITS.claudeImportPlansMax + 1; index++)
      await service.upload({ label: `upload-${index}`, zip: new Blob(['PK']) })
    expect(service.plans.size).toBe(LIMITS.claudeImportPlansMax)
    expect(service.plans.has(plan.id)).toBe(false)
    expect(service.uploads).toHaveLength(LIMITS.claudeImportPlansMax + 3)
    await service.stop()
    expect(service.plans.size).toBe(0)
  })

  it('apply checks the plan, the keys and the actions, reports outcomes, drops the plan and emits one event of each kind', async () => {
    const events = createRecordingEventBus()
    let now = 1_000
    const service = createFakeClaudeImportService({ events, now: () => now, items: [fakeClaudeImportItem('agent', 'reviewer'), fakeClaudeImportItem('command', 'status'), fakeClaudeImportItem('skill', 'notes')] })
    const plan = await service.upload({ zip: new Blob(['PK']) })
    const [agent, command, skill] = plan.items as [typeof plan.items[0], typeof plan.items[0], typeof plan.items[0]]
    await expect(service.apply({ planId: plan.id, items: [{ key: 'agent:nope', action: 'import' }] })).rejects.toMatchObject({ code: 'validation_error' })
    await expect(service.apply({ planId: plan.id, items: [{ key: agent.key, action: 'overwrite' }] })).rejects.toMatchObject({ code: 'validation_error' })
    service.outcomes.set(skill.key, 'failed')
    let fresh = 0
    const result = claudeImportApplyResultSchema.parse(await service.apply({ planId: plan.id, items: [{ key: agent.key, action: 'import' }, { key: command.key, action: 'skip' }, { key: skill.key, action: 'import' }] }, { requireFreshAuth: () => void (fresh += 1) }))
    expect(fresh).toBe(1)
    expect(result.results.map(entry => entry.outcome)).toEqual(['created', 'skipped', 'failed'])
    expect(result.counts).toEqual({ created: 1, updated: 0, unchanged: 0, skipped: 1, failed: 1 })
    expect(events.ofType('customization.changed').map(event => event.data)).toEqual([{}])
    expect(events.ofType('hooks.changed').map(event => event.data)).toEqual([{ projectId: null }])
    await expect(service.apply({ planId: plan.id, items: [{ key: agent.key, action: 'import' }] })).rejects.toMatchObject({ code: 'not_found' })

    const expiring = await service.upload({ zip: new Blob(['PK']) })
    now += LIMITS.claudeImportPlanTtlMs
    await expect(service.apply({ planId: expiring.id, items: [{ key: agent.key, action: 'import' }] })).rejects.toMatchObject({ code: 'not_found', message: 'The import plan expired. Read the folder again.' })
    expect(service.applied).toHaveLength(5)
  })
})

describe('phase 12 fakes: project definitions', () => {
  const PROJECT = 'prj_AAAAAAAAAAAAAAAA'

  it('reads, writes with the sha check, splices settings and .mcp.json keys, removes markdown only, emits workspace.changed', async () => {
    const events = createRecordingEventBus()
    const service = createFakeProjectDefinitionsService({ events, pending: 2, files: { [projectDefinitionFileKey(PROJECT, '.claude/settings.json')]: '{\n  "model": "sonnet",\n  "hooks": {},\n  "env": { "A": "1" }\n}\n' } })
    const missing = projectDefinitionFileSchema.parse(await service.read(PROJECT, '.claude/agents/reviewer.md'))
    expect(missing).toEqual({ path: '.claude/agents/reviewer.md', kind: 'agent', exists: false, content: null, sha256: null, diagnostics: [] })
    await expect(service.read(PROJECT, '.claude/notes.md')).rejects.toMatchObject({ code: 'validation_error' })

    const created = projectDefinitionWriteResultSchema.parse(await service.write(PROJECT, { path: '.claude/agents/reviewer.md', expectedSha256: null, content: '---\nname: reviewer\n---\nReview.' }))
    expect(created).toMatchObject({ created: true, trust: { pending: 2 } })
    await expect(service.write(PROJECT, { path: '.claude/agents/reviewer.md', expectedSha256: null, content: 'x' })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'stale' } })
    const read = await service.read(PROJECT, '.claude/agents/reviewer.md')
    expect(read).toMatchObject({ exists: true, content: '---\nname: reviewer\n---\nReview.', sha256: created.sha256 })

    const settings = await service.read(PROJECT, '.claude/settings.json')
    await service.write(PROJECT, { path: '.claude/settings.json', expectedSha256: settings.sha256, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'sh stop.sh' }] }] } })
    const spliced = JSON.parse(service.files.get(projectDefinitionFileKey(PROJECT, '.claude/settings.json')) ?? '{}') as Record<string, unknown>
    expect(Object.keys(spliced)).toEqual(['model', 'hooks', 'env'])
    expect(spliced.env).toEqual({ A: '1' })
    const mcp = await service.write(PROJECT, { path: '.mcp.json', expectedSha256: null, mcpServers: { github: { type: 'http', url: 'https://example.com/mcp' } } })
    expect(mcp.created).toBe(true)
    await service.write(PROJECT, { path: '.mcp.json', expectedSha256: mcp.sha256, mcpServers: null })
    expect(service.files.get(projectDefinitionFileKey(PROJECT, '.mcp.json'))).toBe('{}\n')

    await expect(service.remove(PROJECT, '.claude/settings.json', 'a'.repeat(64))).rejects.toMatchObject({ code: 'validation_error' })
    await expect(service.remove(PROJECT, '.claude/agents/reviewer.md', 'a'.repeat(64))).rejects.toMatchObject({ code: 'conflict', details: { reason: 'stale' } })
    await service.remove(PROJECT, '.claude/agents/reviewer.md', created.sha256)
    await expect(service.remove(PROJECT, '.claude/agents/reviewer.md', created.sha256)).rejects.toMatchObject({ code: 'not_found' })
    expect(events.ofType('workspace.changed').map(event => [event.data.source, event.data.chatId, event.data.paths])).toEqual([
      ['user', null, ['.claude/agents/reviewer.md']],
      ['user', null, ['.claude/settings.json']],
      ['user', null, ['.mcp.json']],
      ['user', null, ['.mcp.json']],
      ['user', null, ['.claude/agents/reviewer.md']],
    ])
    service.missingProjects.add(PROJECT)
    await expect(service.read(PROJECT, '.mcp.json')).rejects.toMatchObject({ code: 'not_found' })
    expect(service.calls).toMatchObject({ read: 5, write: 5, remove: 4 })
  })
})
