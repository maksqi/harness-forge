import type { ChatCreate, ChatExportV1, HarnessUIMessage } from '@harness-forge/shared'
import type { ChatRunner } from '../../chat/types.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { RecordingEventBus } from '../../testing/fakes.ts'
import type { ChatsService } from './types.ts'
import {
  CHAT_ID_PATTERN,
  chatDetailSchema,
  chatExportSchema,
  chatSummarySchema,
  HarnessError,
  MESSAGE_ID_PATTERN,
  serverEventSchema,
} from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chats, chatShares, messages, usage } from '../../db/schema.ts'
import { SAMPLE_CHAT_EXPORT } from '../../testing/api-samples.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createRecordingEventBus } from '../../testing/fakes.ts'
import { IMPORT_DENIAL_REASON } from './import.ts'

const META = { modelRef: 'mock:echo', startedAt: 1 }

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

function userMessage(id: string, text: string): HarnessUIMessage {
  return { id, role: 'user', metadata: META, parts: [{ type: 'text', text }] }
}

function assistantMessage(id: string, text: string): HarnessUIMessage {
  return { id, role: 'assistant', metadata: { modelRef: 'mock:echo', startedAt: 2 }, parts: [{ type: 'step-start' }, { type: 'text', text, state: 'done' }] }
}

/** An assistant message waiting for a tool approval. */
function pendingMessage(id: string): HarnessUIMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'tool-web_fetch', toolCallId: `call_${id}`, state: 'approval-requested', input: { url: 'u' }, approval: { id: `ap_${id}` } }],
  } as unknown as HarnessUIMessage
}

function ids(list: readonly HarnessUIMessage[]): string[] {
  return list.map(message => message.id)
}

function textOf(message: HarnessUIMessage | undefined): string {
  return message?.parts.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('') ?? ''
}

async function insertChat(n: number, updatedAt: number, fields: Partial<typeof chats.$inferInsert> = {}): Promise<string> {
  const id = chatId(n)
  await t.db.insert(chats).values({ id, createdAt: updatedAt, updatedAt, ...fields })
  return id
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

function issuePaths(error: HarnessError): unknown[][] {
  return (error.details as { issues: { path: unknown[] }[] }).issues.map(issue => issue.path)
}

/**
 * ARCHITECTURE.md 6.8: A (1) -> RA (2) -> B (3) -> RB (4); A2 (5, an edit of A: a second first message) -> RA2 (6),
 * active leaf RA2.
 */
function treeInput(n = 1): ChatCreate {
  return {
    id: chatId(n),
    title: 'Branches',
    messages: [
      userMessage(messageId(1), 'alpha question'),
      assistantMessage(messageId(2), 'alpha answer'),
      userMessage(messageId(3), 'bravo question'),
      assistantMessage(messageId(4), 'bravo answer'),
      userMessage(messageId(5), 'charlie question'),
      assistantMessage(messageId(6), 'charlie answer'),
    ],
    parentIds: [null, messageId(1), messageId(2), messageId(3), null, messageId(5)],
    activeLeafId: messageId(6),
  }
}

async function parentsOf(id: string): Promise<Record<string, string | null>> {
  const rows = await t.db.select({ id: messages.id, parentId: messages.parentId }).from(messages).where(eq(messages.chatId, id))
  return Object.fromEntries(rows.map(row => [row.id, row.parentId]))
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
  }
  t = await createTestApp({ start: false, overrides: { events, runs } })
  service = t.deps.chats
})

afterEach(async () => {
  await t.close()
})

describe('create and get', () => {
  it('creates an empty chat with the client id and emits chat.created', async () => {
    const id = chatId(1)
    const detail = await service.create({ id, modelRef: 'mock:echo', settings: { toolMode: 'auto' } })
    expect(chatDetailSchema.parse(detail)).toEqual(detail)
    expect(detail).toMatchObject({
      id,
      title: null,
      titleSource: null,
      modelRef: 'mock:echo',
      pinned: false,
      archived: false,
      running: false,
      pendingApproval: false,
      settings: { toolMode: 'auto' },
      messages: [],
      branches: {},
      totals: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null },
    })
    expect(detail.createdAt).toBe(detail.updatedAt)
    expect((await service.find(id))?.activeLeafId).toBeNull()
    const created = events.ofType('chat.created')
    expect(created).toHaveLength(1)
    expect(serverEventSchema.parse(created[0])).toEqual(created[0])
    expect(created[0]!.data).toEqual(chatSummarySchema.parse(created[0]!.data))
    expect(Object.keys(created[0]!.data)).not.toContain('messages')
  })

  it('generates a uuidv7 id and stores a sanitized user title', async () => {
    const detail = await service.create({ title: '  Trip\nplans  ' })
    expect(detail.id).toMatch(CHAT_ID_PATTERN)
    expect(detail).toMatchObject({ title: 'Trip plans', titleSource: 'user' })
  })

  it('refuses an id that is already used (409 conflict, reason exists)', async () => {
    await service.create({ id: chatId(1) })
    const error = await rejection(service.create({ id: chatId(1) }))
    expect(error).toMatchObject({ code: 'conflict', details: { reason: 'exists', chatId: chatId(1) } })
  })

  it('answers not_found for unknown and malformed ids', async () => {
    expect((await rejection(service.get(chatId(9)))).code).toBe('not_found')
    expect((await rejection(service.get('../etc/passwd'))).code).toBe('not_found')
    await expect(service.find(chatId(9))).resolves.toBeNull()
    await expect(service.find('nope')).resolves.toBeNull()
  })

  it('sums every usage row of purpose chat into totals, hidden versions included', async () => {
    const id = chatId(1)
    await service.create(treeInput())
    const base = { chatId: id, providerId: 'mock', modelId: 'echo', reasoningTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3 }
    // messageId(2) is not on the active path: its cost was paid all the same.
    await service.addUsage({ ...base, messageId: messageId(2), purpose: 'chat', inputTokens: 10, outputTokens: 20, costUsd: null })
    await service.addUsage({ ...base, messageId: messageId(6), purpose: 'chat', inputTokens: 5, outputTokens: 5, costUsd: 0.25 })
    await service.addUsage({ ...base, messageId: null, purpose: 'title', inputTokens: 100, outputTokens: 100, costUsd: 1 })
    const { totals } = await service.get(id)
    expect(totals).toEqual({ inputTokens: 15, outputTokens: 25, reasoningTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 6, costUsd: 0.25 })
  })

  it('reports running from the runs registry', async () => {
    const id = chatId(1)
    await service.create({ id })
    activeRuns.add(id)
    expect((await service.get(id)).running).toBe(true)
    expect((await service.summary(id)).running).toBe(true)
    expect((await service.list({})).items[0]!.running).toBe(true)
  })
})

describe('the active path and branches (get)', () => {
  it('answers the active path and the versions of its messages', async () => {
    const detail = chatDetailSchema.parse(await service.create(treeInput()))
    expect(ids(detail.messages)).toEqual([messageId(5), messageId(6)])
    expect(detail.branches).toEqual({ [messageId(5)]: { siblings: [messageId(1), messageId(5)], index: 1 } })
    expect(await service.get(chatId(1))).toEqual(detail)
    expect((await service.find(chatId(1)))?.activeLeafId).toBe(messageId(6))
    expect(await parentsOf(chatId(1))).toEqual({
      [messageId(1)]: null,
      [messageId(2)]: messageId(1),
      [messageId(3)]: messageId(2),
      [messageId(4)]: messageId(3),
      [messageId(5)]: null,
      [messageId(6)]: messageId(5),
    })
    // Every version is kept in creation order.
    expect(ids(await service.listMessages(chatId(1)))).toEqual([1, 2, 3, 4, 5, 6].map(messageId))
  })

  it('ends at a leaf that has children (the path committed when a run started)', async () => {
    await service.create(treeInput())
    expect(await service.setActiveLeaf(chatId(1), messageId(1))).toBe(true)
    const detail = await service.get(chatId(1))
    expect(ids(detail.messages)).toEqual([messageId(1)])
    expect(detail.branches).toEqual({ [messageId(1)]: { siblings: [messageId(1), messageId(5)], index: 0 } })
  })

  it('falls back to the most recent message when the stored leaf is missing', async () => {
    await service.create(treeInput())
    await t.db.update(chats).set({ activeLeafId: null }).where(eq(chats.id, chatId(1)))
    expect(ids((await service.get(chatId(1))).messages)).toEqual([messageId(5), messageId(6)])
    await t.db.update(chats).set({ activeLeafId: 'msg_gone000000000000' }).where(eq(chats.id, chatId(1)))
    expect(ids((await service.get(chatId(1))).messages)).toEqual([messageId(5), messageId(6)])
  })
})

describe('switchBranch', () => {
  it('shows the most recent leaf under the message, keeps updatedAt and emits chat.updated', async () => {
    await service.create(treeInput())
    await t.db.update(chats).set({ updatedAt: 1000 }).where(eq(chats.id, chatId(1)))
    events.clear()
    const switched = chatDetailSchema.parse(await service.switchBranch(chatId(1), messageId(1)))
    expect(ids(switched.messages)).toEqual([1, 2, 3, 4].map(messageId))
    expect(switched.branches).toEqual({ [messageId(1)]: { siblings: [messageId(1), messageId(5)], index: 0 } })
    expect(switched.updatedAt).toBe(1000)
    expect((await service.find(chatId(1)))?.activeLeafId).toBe(messageId(4))
    const updated = events.ofType('chat.updated')
    // The event carries the new active leaf (ADR-030), so other tabs follow the switch.
    expect(updated.map(event => event.data)).toEqual([expect.objectContaining({ id: chatId(1), updatedAt: 1000, activeLeafId: messageId(4) })])
    expect(await service.get(chatId(1))).toEqual(switched)

    // Any message of the chat: the middle of a path, the current version, a leaf.
    expect(ids((await service.switchBranch(chatId(1), messageId(3))).messages)).toEqual([1, 2, 3, 4].map(messageId))
    expect(ids((await service.switchBranch(chatId(1), messageId(5))).messages)).toEqual([messageId(5), messageId(6)])
    expect(ids((await service.switchBranch(chatId(1), messageId(2))).messages)).toEqual([1, 2, 3, 4].map(messageId))
  })

  it('recomputes pending_approval from the new path', async () => {
    const id = await insertChat(3, 1000)
    await service.appendMessage(id, userMessage(messageId(1), 'first'), null)
    await service.appendMessage(id, pendingMessage(messageId(2)), messageId(1))
    await service.appendMessage(id, userMessage(messageId(3), 'first, edited'), null)
    await service.setActiveLeaf(id, messageId(3))
    const back = await service.switchBranch(id, messageId(1))
    expect(back.pendingApproval).toBe(true)
    expect(ids(back.messages)).toEqual([messageId(1), messageId(2)])
    expect(events.ofType('chat.updated').at(-1)?.data.pendingApproval).toBe(true)
    expect((await service.find(id))?.pendingApproval).toBe(true)
    const away = await service.switchBranch(id, messageId(3))
    expect(away.pendingApproval).toBe(false)
    expect(away.updatedAt).toBe(1000)
  })

  it('answers not_found for an unknown chat or a message outside the chat', async () => {
    await service.create(treeInput())
    await service.create({ id: chatId(2), messages: [userMessage(messageId(9), 'other chat')] })
    expect((await rejection(service.switchBranch(chatId(8), messageId(1)))).code).toBe('not_found')
    expect((await rejection(service.switchBranch('bad', messageId(1)))).code).toBe('not_found')
    expect((await rejection(service.switchBranch(chatId(1), messageId(9)))).code).toBe('not_found')
    expect((await rejection(service.switchBranch(chatId(1), 'msg_unknown000000001'))).code).toBe('not_found')
    expect(ids((await service.get(chatId(1))).messages)).toEqual([messageId(5), messageId(6)])
  })
})

describe('import (POST /chats)', () => {
  it('imports messages in order as a linear chat, fixing ids and resolving pending approvals', async () => {
    await service.create({ id: chatId(1), messages: [userMessage(messageId(1), 'taken elsewhere')] })
    const pending = pendingMessage(messageId(3))
    const detail = await service.create({
      id: chatId(2),
      title: 'Imported',
      messages: [userMessage(messageId(1), 'first'), userMessage('bad-id', 'second'), pending, userMessage(messageId(3), 'dup')],
    })
    expect(detail.messages.map(message => textOf(message) || 'tool')).toEqual(['first', 'second', 'tool', 'dup'])
    const list = ids(detail.messages)
    expect(new Set(list).size).toBe(4)
    expect(list.every(id => MESSAGE_ID_PATTERN.test(id))).toBe(true)
    expect(list).not.toContain(messageId(1))
    expect(list[2]).toBe(messageId(3))
    expect(detail.messages[2]!.parts[0]).toMatchObject({ state: 'output-denied', approval: { approved: false, reason: IMPORT_DENIAL_REASON } })
    expect(detail.pendingApproval).toBe(false)
    expect(detail.branches).toEqual({})
    const rows = await t.db.select({ id: messages.id, seq: messages.seq, parentId: messages.parentId }).from(messages).where(eq(messages.chatId, chatId(2)))
    rows.sort((a, b) => a.seq - b.seq)
    expect(rows.map(row => row.seq)).toEqual([0, 1, 2, 3])
    expect(rows.map(row => row.parentId)).toEqual([null, list[0], list[1], list[2]])
    expect((await service.find(chatId(2)))?.activeLeafId).toBe(list[3])
    expect((await service.list({ q: 'second' })).items.map(chat => chat.id)).toEqual([chatId(2)])
  })

  it('restores a tree from parentIds; the active leaf is the most recent leaf under activeLeafId', async () => {
    const detail = await service.create({ ...treeInput(), activeLeafId: messageId(2) })
    expect(ids(detail.messages)).toEqual([1, 2, 3, 4].map(messageId))
    const defaulted = await service.create({ ...treeInput(2), messages: treeInput().messages!.map((message, index) => ({ ...message, id: messageId(20 + index) })), parentIds: [null, messageId(20), messageId(21), messageId(22), null, messageId(24)], activeLeafId: undefined })
    expect(ids(defaulted.messages)).toEqual([messageId(24), messageId(25)])
  })

  it('replaces invalid and already used ids; parents and the active leaf follow', async () => {
    await service.create({ id: chatId(1), messages: [userMessage(messageId(2), 'takes the id of the reply')] })
    const detail = await service.create({
      id: chatId(2),
      messages: [userMessage('first', 'q1'), assistantMessage(messageId(2), 'a1'), userMessage('first-edit', 'q1 bis')],
      parentIds: [null, 'first', null],
      activeLeafId: messageId(2),
    })
    const [q1, a1] = detail.messages
    expect(detail.messages).toHaveLength(2)
    expect(q1!.id).toMatch(MESSAGE_ID_PATTERN)
    expect(a1!.id).not.toBe(messageId(2))
    expect(textOf(a1)).toBe('a1')
    const parents = await parentsOf(chatId(2))
    expect(parents[a1!.id]).toBe(q1!.id)
    expect(Object.keys(detail.branches)).toEqual([q1!.id])
  })

  it('rejects an invalid tree with the field path and creates nothing', async () => {
    const base = treeInput()
    const cases: Array<[Partial<ChatCreate>, unknown[]]> = [
      [{ parentIds: [null, messageId(1)] }, ['parentIds']],
      [{ parentIds: [null, messageId(3), messageId(2), messageId(3), null, messageId(5)] }, ['parentIds', 1]],
      [{ parentIds: [messageId(1), messageId(1), messageId(2), messageId(3), null, messageId(5)] }, ['parentIds', 0]],
      [{ parentIds: [null, 'msg_unknown000000001', messageId(2), messageId(3), null, messageId(5)] }, ['parentIds', 1]],
      [{ messages: [...base.messages!.slice(0, 5), userMessage(messageId(1), 'repeated')] }, ['messages', 5, 'id']],
      [{ activeLeafId: 'msg_unknown000000001' }, ['activeLeafId']],
      [{ messages: [], parentIds: undefined, activeLeafId: messageId(1) }, ['activeLeafId']],
    ]
    for (const [patch, path] of cases) {
      const error = await rejection(service.create({ ...base, ...patch }))
      expect(error.code, JSON.stringify(patch)).toBe('validation_error')
      expect(issuePaths(error)[0], JSON.stringify(patch)).toEqual(path)
    }
    await expect(service.find(chatId(1))).resolves.toBeNull()
    expect(await t.db.select().from(messages)).toEqual([])
    expect(events.events).toHaveLength(0)
  })

  it('rejects invalid messages with validation_error and creates nothing', async () => {
    const invalid = { id: messageId(1), role: 'assistant', parts: [{ type: 'data-unknown', data: 1 }] } as unknown as HarnessUIMessage
    const error = await rejection(service.create({ id: chatId(1), messages: [invalid] }))
    expect(error.code).toBe('validation_error')
    expect(issuePaths(error)[0]?.[0]).toBe('messages')
    await expect(service.find(chatId(1))).resolves.toBeNull()
    expect(events.events).toHaveLength(0)
  })
})

describe('list and pagination', () => {
  it('orders by updatedAt desc, id desc and filters archived chats', async () => {
    await insertChat(1, 1000)
    await insertChat(2, 3000)
    await insertChat(3, 2000, { archived: true })
    await insertChat(4, 3000)
    const page = await service.list({})
    expect(page.items.map(chat => chat.id)).toEqual([chatId(4), chatId(2), chatId(1)])
    expect(page.nextCursor).toBeNull()
    expect((await service.list({ archived: true })).items.map(chat => chat.id)).toEqual([chatId(3)])
  })

  it('stays stable when chats are inserted between pages', async () => {
    for (let n = 1; n <= 5; n++)
      await insertChat(n, 1000 + n)
    const first = await service.list({ limit: 2 })
    expect(first.items.map(chat => chat.id)).toEqual([chatId(5), chatId(4)])
    // A new chat (sorts before the cursor) and one that sorts into the unseen part (same timestamp as chat 3).
    await insertChat(6, 5000)
    await insertChat(7, 1003)
    // A chat already seen moves to the top: it must not come back.
    await service.touch(chatId(5), { at: 6000 })
    const second = await service.list({ limit: 2, cursor: first.nextCursor! })
    const third = await service.list({ limit: 2, cursor: second.nextCursor! })
    expect(second.items.map(chat => chat.id)).toEqual([chatId(7), chatId(3)])
    expect(third.items.map(chat => chat.id)).toEqual([chatId(2), chatId(1)])
    expect(third.nextCursor).toBeNull()
    const seen = [...first.items, ...second.items, ...third.items].map(chat => chat.id)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('pages through equal timestamps by id', async () => {
    for (let n = 1; n <= 5; n++)
      await insertChat(n, 1000)
    const list: string[] = []
    let cursor: string | undefined
    do {
      const page = await service.list({ limit: 2, cursor })
      list.push(...page.items.map(chat => chat.id))
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    expect(list).toEqual([5, 4, 3, 2, 1].map(chatId))
  })

  it('clamps the limit and rejects an invalid cursor', async () => {
    for (let n = 1; n <= 3; n++)
      await insertChat(n, 1000 + n)
    expect((await service.list({ limit: 0 })).items).toHaveLength(1)
    expect((await service.list({ limit: 1000 })).items).toHaveLength(3)
    expect((await rejection(service.list({ cursor: 'garbage' }))).code).toBe('validation_error')
  })
})

describe('search', () => {
  async function chatWithText(n: number, updatedAt: number, text: string, title: string | null = null): Promise<string> {
    const id = await insertChat(n, updatedAt, { title, titleSource: title === null ? null : 'user' })
    await service.appendMessage(id, userMessage(messageId(n), text), null)
    return id
  }

  it('matches message text and titles case-insensitively, with snippets from the message', async () => {
    const greek = '\u039A\u039F\u03A3\u039C\u039F\u03A3'
    await chatWithText(1, 1001, `Planning a ${'long '.repeat(60)}trip to LISBON in May`)
    await chatWithText(2, 1002, 'nothing here', 'Lisbon notes')
    await chatWithText(3, 1003, `Hello ${greek}`)
    await chatWithText(4, 1004, 'unrelated')
    const page = await service.list({ q: 'lisbon' })
    expect(page.items.map(chat => chat.id)).toEqual([chatId(2), chatId(1)])
    expect(page.items[0]!.snippet).toBeUndefined()
    const snippet = page.items[1]!.snippet!
    expect(snippet.length).toBeLessThanOrEqual(160)
    expect(snippet).toContain('trip to LISBON in May')
    expect(chatSummarySchema.parse(page.items[1])).toEqual(page.items[1])
    const unicode = await service.list({ q: '\u03BA\u03BF\u03C3\u03BC\u03BF\u03C2' })
    expect(unicode.items.map(chat => chat.id)).toEqual([chatId(3)])
    expect(unicode.items[0]!.snippet).toBe(`Hello ${greek}`)
  })

  it('covers every version: a snippet may come from a version that is not shown', async () => {
    await service.create(treeInput())
    expect(ids((await service.get(chatId(1))).messages)).not.toContain(messageId(3))
    const page = await service.list({ q: 'BRAVO' })
    expect(page.items.map(chat => chat.id)).toEqual([chatId(1)])
    expect(page.items[0]!.snippet).toBe('bravo question')
  })

  it('treats %, _ and backslash literally', async () => {
    await chatWithText(1, 1001, 'we are 100% done')
    await chatWithText(2, 1002, 'we are 100 done')
    await chatWithText(3, 1003, 'snake_case name')
    await chatWithText(4, 1004, 'snakeXcase name')
    await chatWithText(5, 1005, 'path C:\\temp')
    await chatWithText(6, 1006, 'path C:temp')
    expect((await service.list({ q: '100%' })).items.map(chat => chat.id)).toEqual([chatId(1)])
    expect((await service.list({ q: 'snake_case' })).items.map(chat => chat.id)).toEqual([chatId(3)])
    expect((await service.list({ q: 'C:\\temp' })).items.map(chat => chat.id)).toEqual([chatId(5)])
    expect((await service.list({ q: '%' })).items.map(chat => chat.id)).toEqual([chatId(1)])
  })

  it('searches archived chats only with archived=true', async () => {
    await chatWithText(1, 1001, 'needle')
    await service.update(chatId(1), { archived: true })
    expect((await service.list({ q: 'needle' })).items).toHaveLength(0)
    expect((await service.list({ q: 'needle', archived: true })).items.map(chat => chat.id)).toEqual([chatId(1)])
  })

  it('finds matches beyond the first scan batch and paginates results', async () => {
    const filler = Array.from({ length: 450 }, (_, index) => ({ id: chatId(1000 + index), title: 'filler', createdAt: 5000 + index, updatedAt: 5000 + index }))
    for (let index = 0; index < filler.length; index += 100)
      await t.db.insert(chats).values(filler.slice(index, index + 100))
    await chatWithText(1, 100, 'the needle')
    await chatWithText(2, 101, 'another needle')
    await chatWithText(3, 102, 'a third needle')
    const first = await service.list({ q: 'needle', limit: 2 })
    expect(first.items.map(chat => chat.id)).toEqual([chatId(3), chatId(2)])
    const second = await service.list({ q: 'needle', limit: 2, cursor: first.nextCursor! })
    expect(second.items.map(chat => chat.id)).toEqual([chatId(1)])
    expect(second.nextCursor).toBeNull()
  })
})

describe('update and remove', () => {
  it('renames, pins, archives and merges settings without moving the chat', async () => {
    const id = await insertChat(1, 1000, { settings: { toolMode: 'ask', reasoningEffort: 'high' } })
    const renamed = await service.update(id, { title: 'New name', pinned: true, modelRef: 'mock:echo', settings: { toolMode: null, instructions: 'Be brief.' } })
    expect(renamed).toMatchObject({ title: 'New name', titleSource: 'user', pinned: true, modelRef: 'mock:echo', updatedAt: 1000 })
    expect((await service.find(id))!.settings).toEqual({ reasoningEffort: 'high', instructions: 'Be brief.' })
    const cleared = await service.update(id, { modelRef: null, archived: true })
    expect(cleared).toMatchObject({ modelRef: null, archived: true, pinned: true })
    expect(events.ofType('chat.updated').map(event => event.data.id)).toEqual([id, id])
  })

  it('rejects an empty title and unknown chats', async () => {
    const id = await insertChat(1, 1000)
    expect((await rejection(service.update(id, { title: '\n\t' }))).code).toBe('validation_error')
    expect((await rejection(service.update(chatId(2), { pinned: true }))).code).toBe('not_found')
  })

  it('deletes the chat and every message version, keeps usage rows detached, emits chat.deleted', async () => {
    const id = chatId(1)
    await service.create(treeInput())
    await service.addUsage({ chatId: id, messageId: messageId(1), purpose: 'chat', providerId: 'mock', modelId: 'echo', inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null })
    await service.remove(id)
    expect(await t.db.select().from(messages)).toHaveLength(0)
    const usageRows = await t.db.select().from(usage)
    expect(usageRows).toHaveLength(1)
    expect(usageRows[0]!.chatId).toBeNull()
    expect(events.ofType('chat.deleted').map(event => event.data)).toEqual([{ id }])
    expect((await rejection(service.remove(id))).code).toBe('not_found')
  })
})

describe('pipeline operations', () => {
  it('ensure creates once, then applies the init silently', async () => {
    const id = chatId(1)
    const first = await service.ensure(id, { modelRef: 'mock:echo', settings: { toolMode: 'auto' } })
    expect(first.created).toBe(true)
    expect(first.chat).toMatchObject({ id, modelRef: 'mock:echo', settings: { toolMode: 'auto' }, activeLeafId: null })
    const second = await service.ensure(id, { modelRef: 'mock:reasoning', settings: { reasoningEffort: 'low' } })
    expect(second.created).toBe(false)
    expect(second.chat).toMatchObject({ modelRef: 'mock:reasoning', settings: { toolMode: 'auto', reasoningEffort: 'low' } })
    expect(events.events.map(event => event.type)).toEqual(['chat.created'])
    expect((await rejection(service.ensure('not-a-uuid'))).code).toBe('validation_error')
    expect((await rejection(service.ensure(chatId(2), { modelRef: 'nope' }))).code).toBe('validation_error')
  })

  it('find and ensure report the active leaf', async () => {
    await service.ensure(chatId(1))
    await service.appendMessage(chatId(1), userMessage(messageId(1), 'q1'), null)
    expect((await service.find(chatId(1)))?.activeLeafId).toBeNull()
    await service.setActiveLeaf(chatId(1), messageId(1))
    expect((await service.find(chatId(1)))?.activeLeafId).toBe(messageId(1))
    expect((await service.ensure(chatId(1))).chat.activeLeafId).toBe(messageId(1))
  })

  it('touch moves updatedAt forward only and sets the given fields', async () => {
    const id = await insertChat(1, 1000)
    const touched = await service.touch(id, { at: 5000, pendingApproval: true, modelRef: 'mock:echo', settings: { toolMode: 'off' } })
    expect(touched).toMatchObject({ updatedAt: 5000, pendingApproval: true, modelRef: 'mock:echo' })
    expect((await service.touch(id, { at: 10 })).updatedAt).toBe(5000)
    expect((await service.find(id))!.settings).toEqual({ toolMode: 'off' })
    expect(events.ofType('chat.updated')).toHaveLength(2)
    // Every `chat.updated` carries the row's active leaf (null for a chat without messages); the result does not.
    expect(events.ofType('chat.updated').map(event => event.data.activeLeafId)).toEqual([null, null])
    expect(touched).not.toHaveProperty('activeLeafId')
    expect((await rejection(service.touch(chatId(2)))).code).toBe('not_found')
  })

  it('setTitle sets automatic titles but never overwrites a user title', async () => {
    const id = await insertChat(1, 1000)
    expect(await service.setTitle(id, '  Trip\nplanning ', 'auto')).toMatchObject({ title: 'Trip planning', titleSource: 'auto' })
    expect(await service.setTitle(id, 'Fallback', 'fallback')).toMatchObject({ title: 'Fallback', titleSource: 'fallback' })
    await service.update(id, { title: 'Mine' })
    await expect(service.setTitle(id, 'Auto', 'auto')).resolves.toBeNull()
    expect((await service.find(id))!.title).toBe('Mine')
    await expect(service.setTitle(chatId(2), 'Auto', 'auto')).resolves.toBeNull()
    await expect(service.setTitle(id, ' ', 'auto')).resolves.toBeNull()
  })

  it('addUsage keeps rows of a deleted chat and normalizes numbers', async () => {
    await service.addUsage({ chatId: chatId(7), messageId: null, purpose: 'title', providerId: 'mock', modelId: 'echo', inputTokens: -5, outputTokens: Number.NaN, reasoningTokens: 2.6, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: -1 })
    const [row] = await t.db.select().from(usage)
    expect(row).toMatchObject({ chatId: null, purpose: 'title', input: 0, output: 0, reasoning: 3, costUsd: null })
  })
})

describe('messages (the store)', () => {
  it('appendMessage inserts under the parent with the next seq and moves nothing', async () => {
    const id = await insertChat(1, 1000)
    await service.appendMessage(id, userMessage(messageId(1), 'q1'), null)
    await service.appendMessage(id, assistantMessage(messageId(2), 'a1'), messageId(1))
    await service.appendMessage(id, assistantMessage(messageId(3), 'a1 again'), messageId(1))
    const rows = await t.db.select({ id: messages.id, seq: messages.seq, parentId: messages.parentId, searchText: messages.searchText }).from(messages).where(eq(messages.chatId, id))
    expect(rows.sort((a, b) => a.seq - b.seq)).toEqual([
      { id: messageId(1), seq: 0, parentId: null, searchText: 'q1' },
      { id: messageId(2), seq: 1, parentId: messageId(1), searchText: 'a1' },
      { id: messageId(3), seq: 2, parentId: messageId(1), searchText: 'a1 again' },
    ])
    const row = (await service.find(id))!
    expect(row).toMatchObject({ activeLeafId: null, pendingApproval: false, updatedAt: 1000 })
    expect(events.events).toHaveLength(0)
  })

  it('appendMessage refuses unknown chats and parents, used ids and malformed messages', async () => {
    const id = await insertChat(1, 1000)
    const other = await insertChat(2, 1000)
    await service.appendMessage(id, userMessage(messageId(1), 'mine'), null)
    await service.appendMessage(other, userMessage(messageId(9), 'other chat'), null)
    expect((await rejection(service.appendMessage(chatId(3), userMessage(messageId(2), 'x'), null))).code).toBe('not_found')
    expect((await rejection(service.appendMessage(id, userMessage(messageId(2), 'x'), 'msg_unknown000000001'))).code).toBe('not_found')
    // A parent in another chat is not a parent.
    expect((await rejection(service.appendMessage(id, userMessage(messageId(2), 'x'), messageId(9)))).code).toBe('not_found')
    expect((await rejection(service.appendMessage(id, userMessage(messageId(1), 'again'), null))).toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    expect((await rejection(service.appendMessage(id, userMessage(messageId(9), 'steal'), null))).toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    expect((await rejection(service.appendMessage(id, userMessage('msg_short', 'x'), null))).code).toBe('validation_error')
    expect(ids(await service.listMessages(id))).toEqual([messageId(1)])
    expect(textOf((await service.getMessage(id, messageId(1)))!)).toBe('mine')
  })

  it('upsertMessage appends new ids under the parent and replaces existing ones in place', async () => {
    const id = await insertChat(1, 1000)
    await service.upsertMessage(id, userMessage(messageId(1), 'hello'), null)
    await service.upsertMessage(id, assistantMessage(messageId(2), 'first answer'), messageId(1))
    // The parent is used on insert only: an existing message keeps its parent, whatever is passed.
    await service.upsertMessage(id, assistantMessage(messageId(2), 'edited answer'), null)
    await service.upsertMessage(id, assistantMessage(messageId(2), 'edited answer'), 'msg_unknown000000001')
    const list = await service.listMessages(id)
    expect(ids(list)).toEqual([messageId(1), messageId(2)])
    expect(list[1]!.parts[1]).toMatchObject({ text: 'edited answer' })
    expect(await service.getMessage(id, messageId(2))).toEqual(list[1])
    await expect(service.getMessage(id, messageId(9))).resolves.toBeNull()
    const rows = await t.db.select({ seq: messages.seq, parentId: messages.parentId, searchText: messages.searchText }).from(messages).where(eq(messages.id, messageId(2)))
    expect(rows).toEqual([{ seq: 1, parentId: messageId(1), searchText: 'edited answer' }])
    expect(events.events).toHaveLength(0)
  })

  it('keeps metadata absent when the message has none', async () => {
    const id = await insertChat(1, 1000)
    await service.upsertMessage(id, { id: messageId(1), role: 'user', parts: [{ type: 'text', text: 'x' }] }, null)
    expect(await service.getMessage(id, messageId(1))).toEqual({ id: messageId(1), role: 'user', parts: [{ type: 'text', text: 'x' }] })
  })

  it('upsertMessage refuses unknown chats, unknown parents on insert, foreign ids and malformed messages', async () => {
    const id = await insertChat(1, 1000)
    const other = await insertChat(2, 1000)
    await service.upsertMessage(id, userMessage(messageId(1), 'mine'), null)
    expect((await rejection(service.upsertMessage(chatId(3), userMessage(messageId(2), 'x'), null))).code).toBe('not_found')
    expect((await rejection(service.upsertMessage(id, userMessage(messageId(2), 'x'), 'msg_unknown000000001'))).code).toBe('not_found')
    expect((await rejection(service.upsertMessage(other, userMessage(messageId(1), 'steal'), null))).toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    expect((await rejection(service.upsertMessage(id, userMessage('msg_short', 'x'), null))).code).toBe('validation_error')
    expect(textOf((await service.getMessage(id, messageId(1)))!)).toBe('mine')
    expect(ids(await service.listMessages(other))).toEqual([])
  })

  it('setActiveLeaf is a compare-and-set that changes nothing else', async () => {
    await service.create(treeInput())
    await t.db.update(chats).set({ updatedAt: 1000, pendingApproval: true }).where(eq(chats.id, chatId(1)))
    events.clear()
    expect(await service.setActiveLeaf(chatId(1), messageId(4), [messageId(2)])).toBe(false)
    expect(await service.setActiveLeaf(chatId(1), messageId(4), [])).toBe(false)
    expect(await service.setActiveLeaf(chatId(1), messageId(4), [null])).toBe(false)
    expect(await service.setActiveLeaf(chatId(1), 'msg_unknown000000001')).toBe(false)
    expect(await service.setActiveLeaf(chatId(9), messageId(4))).toBe(false)
    expect((await service.find(chatId(1)))?.activeLeafId).toBe(messageId(6))
    expect(await service.setActiveLeaf(chatId(1), messageId(4), [messageId(6), null])).toBe(true)
    expect(await service.find(chatId(1))).toMatchObject({ activeLeafId: messageId(4), updatedAt: 1000, pendingApproval: true })
    expect(await service.setActiveLeaf(chatId(1), messageId(2))).toBe(true)
    expect(ids((await service.get(chatId(1))).messages)).toEqual([messageId(1), messageId(2)])
    // A message of another chat is not a leaf of this one.
    await service.create({ id: chatId(2), messages: [userMessage(messageId(9), 'other')] })
    expect(await service.setActiveLeaf(chatId(1), messageId(9))).toBe(false)
    // A chat without a leaf matches null.
    const empty = await insertChat(3, 1000)
    await service.appendMessage(empty, userMessage(messageId(10), 'first'), null)
    expect(await service.setActiveLeaf(empty, messageId(10), [null])).toBe(true)
    expect(events.events.filter(event => event.type !== 'chat.created')).toEqual([])
  })

  it('listPath walks from the first message to the leaf, whatever the creation order', async () => {
    await service.create(treeInput())
    expect(ids(await service.listPath(chatId(1), messageId(4)))).toEqual([1, 2, 3, 4].map(messageId))
    expect(ids(await service.listPath(chatId(1), messageId(6)))).toEqual([messageId(5), messageId(6)])
    expect(ids(await service.listPath(chatId(1), messageId(1)))).toEqual([messageId(1)])
    expect(await service.listPath(chatId(1), null)).toEqual([])
    expect((await rejection(service.listPath(chatId(1), 'msg_unknown000000001'))).code).toBe('not_found')
    expect((await rejection(service.listPath(chatId(2), messageId(4)))).code).toBe('not_found')
    expect((await service.listPath(chatId(1), messageId(2)))[1]).toEqual(assistantMessage(messageId(2), 'alpha answer'))
  })

  it('listPath and get end on bad data (a cycle, a parent in another chat, a later parent)', async () => {
    const id = await insertChat(1, 1000)
    const other = await insertChat(2, 1000)
    await service.appendMessage(other, userMessage(messageId(9), 'elsewhere'), null)
    await service.appendMessage(id, userMessage(messageId(1), 'one'), null)
    await service.appendMessage(id, assistantMessage(messageId(2), 'two'), messageId(1))
    await service.appendMessage(id, userMessage(messageId(3), 'three'), messageId(2))
    // A cycle 1 -> 3 -> 2 -> 1 and a message whose parent lives in another chat.
    await t.db.update(messages).set({ parentId: messageId(3) }).where(eq(messages.id, messageId(1)))
    await t.db.insert(messages).values({ id: messageId(4), chatId: id, parentId: messageId(9), seq: 3, role: 'user', parts: [{ type: 'text', text: 'four' }] })
    expect(ids(await service.listPath(id, messageId(3)))).toEqual([1, 2, 3].map(messageId))
    expect(ids(await service.listPath(id, messageId(4)))).toEqual([messageId(4)])
    await service.setActiveLeaf(id, messageId(3))
    const detail = await service.get(id)
    expect(ids(detail.messages)).toEqual([1, 2, 3].map(messageId))
    expect(detail.branches).toEqual({ [messageId(1)]: { siblings: [messageId(1), messageId(4)], index: 0 } })
    expect(ids((await service.switchBranch(id, messageId(1))).messages)).toEqual([1, 2, 3].map(messageId))
  })

  it('transaction commits store operations together and rolls back on error', async () => {
    const id = await insertChat(1, 1000)
    await service.transaction(async (store) => {
      await store.appendMessage(id, userMessage(messageId(1), 'q1'), null)
      await store.upsertMessage(id, assistantMessage(messageId(2), 'a1'), messageId(1))
      expect(ids(await store.listPath(id, messageId(2)))).toEqual([messageId(1), messageId(2)])
      expect(await store.setActiveLeaf(id, messageId(2), [null])).toBe(true)
    })
    expect(ids((await service.get(id)).messages)).toEqual([messageId(1), messageId(2)])
    await expect(service.transaction(async (store) => {
      await store.appendMessage(id, userMessage(messageId(3), 'q2'), messageId(2))
      await store.setActiveLeaf(id, messageId(3))
      throw new Error('pipeline failed')
    })).rejects.toThrow('pipeline failed')
    expect(ids(await service.listMessages(id))).toEqual([messageId(1), messageId(2)])
    expect((await service.find(id))?.activeLeafId).toBe(messageId(2))
    const failed = await rejection(service.transaction(async (store) => {
      await store.appendMessage(id, userMessage(messageId(4), 'q3'), messageId(2))
      await store.appendMessage(id, userMessage(messageId(4), 'q3 again'), messageId(2))
    }))
    expect(failed.toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    expect(ids(await service.listMessages(id))).toEqual([messageId(1), messageId(2)])
    expect(await service.transaction(async store => (await store.listMessages(id)).length)).toBe(2)
  })
})

describe('export', () => {
  it('writes JSON version 2 with every version, the parents and the active leaf; Markdown shows the active path', async () => {
    await service.create(treeInput())
    await service.switchBranch(chatId(1), messageId(1))
    const file = await service.export(chatId(1), 'json')
    const exported = chatExportSchema.parse(JSON.parse(file.body))
    expect(exported.chat).toMatchObject({ id: chatId(1), title: 'Branches', running: false, pendingApproval: false, activeLeafId: messageId(4) })
    expect(ids(exported.chat.messages)).toEqual([1, 2, 3, 4, 5, 6].map(messageId))
    expect(exported.chat.parentIds).toEqual([null, messageId(1), messageId(2), messageId(3), null, messageId(5)])
    expect(exported.chat).not.toHaveProperty('branches')
    const markdown = (await service.export(chatId(1), 'md')).body
    expect(markdown).toContain('alpha question')
    expect(markdown).toContain('bravo answer')
    expect(markdown).not.toContain('charlie')
    expect((await rejection(service.export(chatId(9), 'json'))).code).toBe('not_found')
  })

  it('exports the effective parents of damaged data, so the export imports again', async () => {
    await service.create(treeInput())
    await t.db.update(messages).set({ parentId: messageId(4) }).where(eq(messages.id, messageId(2)))
    const exported = chatExportSchema.parse(JSON.parse((await service.export(chatId(1), 'json')).body))
    expect(exported.chat.parentIds[1]).toBeNull()
    await service.remove(chatId(1))
    expect(await service.importChat({ exported, id: 'keep', restore: true })).toEqual({ id: chatId(1), messages: 6 })
  })
})

describe('importChat', () => {
  async function exportedTree() {
    await service.create(treeInput())
    await service.update(chatId(1), { pinned: true, archived: true, modelRef: 'mock:reasoning', settings: { toolMode: 'auto', instructions: 'Be brief.' } })
    await t.db.update(chats).set({ createdAt: 1000, updatedAt: 2000 }).where(eq(chats.id, chatId(1)))
    await service.switchBranch(chatId(1), messageId(3))
    return chatExportSchema.parse(JSON.parse((await service.export(chatId(1), 'json')).body))
  }

  it('round-trips an export v2 with keep + restore: ids, versions, active leaf, title, flags, dates and settings', async () => {
    const exported = await exportedTree()
    const before = await service.get(chatId(1))
    await service.remove(chatId(1))
    events.clear()
    expect(await service.importChat({ exported, id: 'keep', restore: true })).toEqual({ id: chatId(1), messages: 6 })
    const restored = await service.get(chatId(1))
    expect(restored).toEqual(before)
    expect(restored).toMatchObject({
      title: 'Branches',
      titleSource: 'user',
      pinned: true,
      archived: true,
      createdAt: 1000,
      updatedAt: 2000,
      modelRef: 'mock:reasoning',
      settings: { toolMode: 'auto', instructions: 'Be brief.' },
      pendingApproval: false,
    })
    expect(ids(restored.messages)).toEqual([1, 2, 3, 4].map(messageId))
    expect(await parentsOf(chatId(1))).toEqual(Object.fromEntries(exported.chat.messages.map((message, index) => [message.id, exported.chat.parentIds[index]])))
    const created = events.ofType('chat.created')
    expect(created.map(event => event.data)).toEqual([expect.objectContaining({ id: chatId(1), title: 'Branches', pinned: true, updatedAt: 2000 })])

    const again = await rejection(service.importChat({ exported, id: 'keep', restore: true }))
    expect(again.toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'exists', chatId: chatId(1) } })
  })

  it('keep: message ids that are used elsewhere are replaced, their children follow', async () => {
    const exported = await exportedTree()
    await service.remove(chatId(1))
    await service.create({ id: chatId(2), messages: [userMessage(messageId(2), 'squatter')] })
    await service.importChat({ exported, id: 'keep', restore: true })
    const detail = await service.get(chatId(1))
    const [a, ra, b, rb] = detail.messages
    expect([a!.id, b!.id, rb!.id]).toEqual([messageId(1), messageId(3), messageId(4)])
    expect(ra!.id).not.toBe(messageId(2))
    expect(textOf(ra)).toBe('alpha answer')
    const parents = await parentsOf(chatId(1))
    expect(parents[messageId(3)]).toBe(ra!.id)
    expect(parents[ra!.id]).toBe(messageId(1))
  })

  it('new: a new chat id and new message ids, the same tree; restore false imports only the conversation', async () => {
    const exported = await exportedTree()
    const before = Date.now()
    const result = await service.importChat({ exported, id: 'new', restore: false })
    expect(result.id).toMatch(CHAT_ID_PATTERN)
    expect(result.id).not.toBe(chatId(1))
    expect(result.messages).toBe(6)
    const copy = await service.get(result.id)
    expect(copy).toMatchObject({ title: null, titleSource: null, pinned: false, archived: false, modelRef: 'mock:reasoning', settings: { toolMode: 'auto', instructions: 'Be brief.' } })
    expect(copy.createdAt).toBeGreaterThanOrEqual(before)
    const all = await service.listMessages(result.id)
    expect(all.map(textOf)).toEqual(exported.chat.messages.map(textOf))
    expect(ids(all).some(id => ids(exported.chat.messages).includes(id))).toBe(false)
    expect(copy.messages.map(textOf)).toEqual(['alpha question', 'alpha answer', 'bravo question', 'bravo answer'])
    expect(Object.values(copy.branches)).toEqual([{ siblings: [all[0]!.id, all[4]!.id], index: 0 }])
    // The source chat is untouched.
    expect(ids((await service.get(chatId(1))).messages)).toEqual([1, 2, 3, 4].map(messageId))
  })

  it('imports an export v1 as a linear chat', async () => {
    const v1: ChatExportV1 = {
      format: 'harness-forge.chat',
      version: 1,
      exportedAt: 1,
      chat: {
        id: chatId(7),
        title: 'Old',
        titleSource: 'auto',
        modelRef: 'mock:echo',
        pinned: false,
        archived: true,
        running: false,
        pendingApproval: false,
        createdAt: 5,
        updatedAt: 6,
        settings: {},
        totals: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null },
        messages: [userMessage(messageId(1), 'q1'), assistantMessage(messageId(2), 'a1'), userMessage(messageId(3), 'q2'), pendingMessage(messageId(4))],
      },
    }
    expect(await service.importChat({ exported: v1, id: 'keep', restore: true })).toEqual({ id: chatId(7), messages: 4 })
    const detail = await service.get(chatId(7))
    expect(detail).toMatchObject({ title: 'Old', titleSource: 'auto', archived: true, createdAt: 5, updatedAt: 6, branches: {}, pendingApproval: false })
    expect(ids(detail.messages)).toEqual([1, 2, 3, 4].map(messageId))
    expect(detail.messages[3]!.parts[0]).toMatchObject({ state: 'output-denied', approval: { reason: IMPORT_DENIAL_REASON } })
    expect(await parentsOf(chatId(7))).toEqual({ [messageId(1)]: null, [messageId(2)]: messageId(1), [messageId(3)]: messageId(2), [messageId(4)]: messageId(3) })
  })

  it('imports the sample export and an empty chat', async () => {
    expect(await service.importChat({ exported: SAMPLE_CHAT_EXPORT, id: 'keep', restore: true })).toEqual({ id: SAMPLE_CHAT_EXPORT.chat.id, messages: 1 })
    const empty = { ...SAMPLE_CHAT_EXPORT, chat: { ...SAMPLE_CHAT_EXPORT.chat, messages: [], parentIds: [], activeLeafId: null } }
    const result = await service.importChat({ exported: empty, id: 'new', restore: true })
    expect(await service.get(result.id)).toMatchObject({ title: 'Sample chat', messages: [], branches: {} })
    expect((await service.find(result.id))?.activeLeafId).toBeNull()
  })

  it('reports an invalid export under chat and imports nothing', async () => {
    const exported = await exportedTree()
    await service.remove(chatId(1))
    events.clear()
    const cases: Array<[unknown, unknown[]]> = [
      [{ ...exported, chat: { ...exported.chat, parentIds: [null, messageId(3), messageId(2), messageId(3), null, messageId(5)] } }, ['chat', 'parentIds', 1]],
      [{ ...exported, chat: { ...exported.chat, parentIds: [null] } }, ['chat', 'parentIds']],
      [{ ...exported, chat: { ...exported.chat, activeLeafId: 'msg_unknown000000001' } }, ['chat', 'activeLeafId']],
      [{ ...exported, chat: { ...exported.chat, messages: exported.chat.messages.map((message, index) => (index === 2 ? { ...message, metadata: { modelRef: 'no-colon', startedAt: 1 } } : message)) } }, ['chat', 'messages', 2, 'metadata']],
      [{ ...exported, chat: { ...exported.chat, settings: { color: 'red' } } }, ['chat', 'settings']],
    ]
    for (const [input, path] of cases) {
      const error = await rejection(service.importChat({ exported: input as typeof exported, id: 'keep', restore: true }))
      expect(error.code).toBe('validation_error')
      expect(issuePaths(error)[0]?.slice(0, path.length), JSON.stringify(path)).toEqual(path)
    }
    const unknownVersion = await rejection(service.importChat({ exported: { ...exported, version: 3 } as unknown as typeof exported, id: 'keep', restore: true }))
    expect(unknownVersion.code).toBe('validation_error')
    expect(await service.allIds()).toEqual([])
    expect(await t.db.select().from(messages)).toEqual([])
    expect(events.events).toHaveLength(0)
  })
})

describe('bulk data: allIds and removeAll', () => {
  it('allIds lists every chat, archived included, in id order', async () => {
    await insertChat(3, 1000)
    await insertChat(1, 3000, { archived: true })
    await insertChat(2, 2000)
    expect(await service.allIds()).toEqual([chatId(1), chatId(2), chatId(3)])
  })

  it('removeAll deletes every chat, message version and share link in one batch; usage rows are detached', async () => {
    await service.create(treeInput())
    await service.create({ id: chatId(2), messages: [userMessage(messageId(10), 'hello')] })
    await service.ensure(chatId(3))
    const usageRow = { messageId: null, purpose: 'chat' as const, providerId: 'mock', modelId: 'echo', inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null }
    await service.addUsage({ ...usageRow, chatId: chatId(1) })
    await service.addUsage({ ...usageRow, chatId: null })
    await t.db.insert(chatShares).values({
      id: 'shr_0000000000000001',
      chatId: chatId(1),
      options: { reasoning: false, toolDetails: false, attachments: true },
      snapshot: { title: null, messages: [] },
      snapshotAt: 1,
    })
    events.clear()
    expect(await service.removeAll({ usage: false })).toEqual({ chatIds: [chatId(1), chatId(2), chatId(3)], messages: 7, usageRows: 0 })
    expect(events.ofType('chat.deleted').map(event => event.data.id)).toEqual([chatId(1), chatId(2), chatId(3)])
    expect(await t.db.select().from(chats)).toEqual([])
    expect(await t.db.select().from(messages)).toEqual([])
    expect(await t.db.select().from(chatShares)).toEqual([])
    expect(await t.db.select({ chatId: usage.chatId }).from(usage)).toEqual([{ chatId: null }, { chatId: null }])
    expect(await service.allIds()).toEqual([])
    expect(await service.removeAll({ usage: false })).toEqual({ chatIds: [], messages: 0, usageRows: 0 })
  })

  it('removeAll with usage deletes every usage row, detached ones included', async () => {
    await service.create({ id: chatId(1), messages: [userMessage(messageId(1), 'hello')] })
    const usageRow = { messageId: null, purpose: 'chat' as const, providerId: 'mock', modelId: 'echo', inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null }
    await service.addUsage({ ...usageRow, chatId: chatId(1) })
    await service.addUsage({ ...usageRow, chatId: null })
    await service.addUsage({ ...usageRow, chatId: chatId(1), purpose: 'title' })
    expect(await service.removeAll({ usage: true })).toEqual({ chatIds: [chatId(1)], messages: 1, usageRows: 3 })
    expect(await t.db.select().from(usage)).toEqual([])
  })
})
