import type { HarnessUIMessage } from '@harness-forge/shared'
import type { ChatRunner } from '../../chat/types.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { RecordingEventBus } from '../../testing/fakes.ts'
import type { ChatsService } from './types.ts'
import { CHAT_ID_PATTERN, chatDetailSchema, chatSummarySchema, HarnessError, serverEventSchema } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chats, messages, usage } from '../../db/schema.ts'
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

beforeEach(async () => {
  events = createRecordingEventBus()
  activeRuns = new Set()
  const runs: ChatRunner = {
    start: async () => new Response(null),
    resume: () => null,
    stop: async () => false,
    isActive: id => activeRuns.has(id),
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
      totals: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null },
    })
    expect(detail.createdAt).toBe(detail.updatedAt)
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

  it('sums the chat usage rows (purpose chat) into totals', async () => {
    const id = chatId(1)
    await service.create({ id })
    const base = { chatId: id, messageId: null, providerId: 'mock', modelId: 'echo', reasoningTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3 }
    await service.addUsage({ ...base, purpose: 'chat', inputTokens: 10, outputTokens: 20, costUsd: null })
    await service.addUsage({ ...base, purpose: 'chat', inputTokens: 5, outputTokens: 5, costUsd: 0.25 })
    await service.addUsage({ ...base, purpose: 'title', inputTokens: 100, outputTokens: 100, costUsd: 1 })
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

describe('import', () => {
  it('imports messages in order, fixing ids and resolving pending approvals', async () => {
    await service.create({ id: chatId(1), messages: [userMessage(messageId(1), 'taken elsewhere')] })
    const pending = {
      id: messageId(3),
      role: 'assistant',
      parts: [{ type: 'tool-web_fetch', toolCallId: 'c1', state: 'approval-requested', input: { url: 'u' }, approval: { id: 'a1' } }],
    } as unknown as HarnessUIMessage
    const detail = await service.create({
      id: chatId(2),
      title: 'Imported',
      messages: [userMessage(messageId(1), 'first'), userMessage('bad-id', 'second'), pending, userMessage(messageId(3), 'dup')],
    })
    expect(detail.messages.map(message => (message.parts[0] as { text?: string }).text ?? 'tool')).toEqual(['first', 'second', 'tool', 'dup'])
    const ids = detail.messages.map(message => message.id)
    expect(new Set(ids).size).toBe(4)
    expect(ids).not.toContain(messageId(1))
    expect(ids[2]).toBe(messageId(3))
    expect(detail.messages[2]!.parts[0]).toMatchObject({ state: 'output-denied', approval: { approved: false, reason: IMPORT_DENIAL_REASON } })
    expect(detail.pendingApproval).toBe(false)
    const rows = await t.db.select({ seq: messages.seq }).from(messages).where(eq(messages.chatId, chatId(2)))
    expect(rows.map(row => row.seq).sort()).toEqual([0, 1, 2, 3])
    expect((await service.list({ q: 'second' })).items.map(chat => chat.id)).toEqual([chatId(2)])
  })

  it('rejects invalid messages with validation_error and creates nothing', async () => {
    const invalid = { id: messageId(1), role: 'assistant', parts: [{ type: 'data-unknown', data: 1 }] } as unknown as HarnessUIMessage
    const error = await rejection(service.create({ id: chatId(1), messages: [invalid] }))
    expect(error.code).toBe('validation_error')
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
    const ids: string[] = []
    let cursor: string | undefined
    do {
      const page = await service.list({ limit: 2, cursor })
      ids.push(...page.items.map(chat => chat.id))
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    expect(ids).toEqual([5, 4, 3, 2, 1].map(chatId))
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
    await service.upsertMessage(id, userMessage(messageId(n), text))
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

  it('deletes the chat and its messages, keeps usage rows detached, emits chat.deleted', async () => {
    const id = chatId(1)
    await service.create({ id, messages: [userMessage(messageId(1), 'hello')] })
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
    expect(first.chat).toMatchObject({ id, modelRef: 'mock:echo', settings: { toolMode: 'auto' } })
    const second = await service.ensure(id, { modelRef: 'mock:reasoning', settings: { reasoningEffort: 'low' } })
    expect(second.created).toBe(false)
    expect(second.chat).toMatchObject({ modelRef: 'mock:reasoning', settings: { toolMode: 'auto', reasoningEffort: 'low' } })
    expect(events.events.map(event => event.type)).toEqual(['chat.created'])
    expect((await rejection(service.ensure('not-a-uuid'))).code).toBe('validation_error')
    expect((await rejection(service.ensure(chatId(2), { modelRef: 'nope' }))).code).toBe('validation_error')
  })

  it('touch moves updatedAt forward only and sets the given fields', async () => {
    const id = await insertChat(1, 1000)
    const touched = await service.touch(id, { at: 5000, pendingApproval: true, modelRef: 'mock:echo', settings: { toolMode: 'off' } })
    expect(touched).toMatchObject({ updatedAt: 5000, pendingApproval: true, modelRef: 'mock:echo' })
    expect((await service.touch(id, { at: 10 })).updatedAt).toBe(5000)
    expect((await service.find(id))!.settings).toEqual({ toolMode: 'off' })
    expect(events.ofType('chat.updated')).toHaveLength(2)
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

describe('messages', () => {
  it('upserts by id: appends new ids, replaces existing ones in place', async () => {
    const id = await insertChat(1, 1000)
    await service.upsertMessage(id, userMessage(messageId(1), 'hello'))
    await service.upsertMessage(id, assistantMessage(messageId(2), 'first answer'))
    await service.upsertMessage(id, assistantMessage(messageId(2), 'edited answer'))
    await service.upsertMessage(id, assistantMessage(messageId(2), 'edited answer'))
    const list = await service.listMessages(id)
    expect(list.map(message => message.id)).toEqual([messageId(1), messageId(2)])
    expect(list[1]!.parts[1]).toMatchObject({ text: 'edited answer' })
    expect(await service.getMessage(id, messageId(2))).toEqual(list[1])
    await expect(service.getMessage(id, messageId(9))).resolves.toBeNull()
    const rows = await t.db.select({ seq: messages.seq, searchText: messages.searchText }).from(messages).where(eq(messages.id, messageId(2)))
    expect(rows).toEqual([{ seq: 1, searchText: 'edited answer' }])
    expect(events.events).toHaveLength(0)
  })

  it('keeps metadata absent when the message has none', async () => {
    const id = await insertChat(1, 1000)
    await service.upsertMessage(id, { id: messageId(1), role: 'user', parts: [{ type: 'text', text: 'x' }] })
    expect(await service.getMessage(id, messageId(1))).toEqual({ id: messageId(1), role: 'user', parts: [{ type: 'text', text: 'x' }] })
  })

  it('refuses unknown chats, foreign ids and malformed messages', async () => {
    const id = await insertChat(1, 1000)
    const other = await insertChat(2, 1000)
    await service.upsertMessage(id, userMessage(messageId(1), 'mine'))
    expect((await rejection(service.upsertMessage(chatId(3), userMessage(messageId(2), 'x')))).code).toBe('not_found')
    expect((await rejection(service.upsertMessage(other, userMessage(messageId(1), 'steal')))).code).toBe('conflict')
    expect((await rejection(service.upsertMessage(id, userMessage('msg_short', 'x')))).code).toBe('validation_error')
    expect((await service.getMessage(id, messageId(1)))!.parts[0]).toMatchObject({ text: 'mine' })
  })

  it('replaceFrom handles edit and regenerate', async () => {
    const id = await insertChat(1, 1000)
    for (const message of [userMessage(messageId(1), 'q1'), assistantMessage(messageId(2), 'a1'), userMessage(messageId(3), 'q2'), assistantMessage(messageId(4), 'a2')])
      await service.upsertMessage(id, message)
    // Edit q2: replace it and drop a2.
    expect(await service.replaceFrom(id, messageId(3), [userMessage(messageId(3), 'q2 edited')])).toBe(2)
    expect((await service.listMessages(id)).map(message => (message.parts.at(-1) as { text: string }).text)).toEqual(['q1', 'a1', 'q2 edited'])
    // Regenerate a1: drop it and everything after.
    expect(await service.replaceFrom(id, messageId(2), [])).toBe(2)
    expect((await service.listMessages(id)).map(message => message.id)).toEqual([messageId(1)])
    await service.upsertMessage(id, assistantMessage(messageId(5), 'a1 again'))
    const rows = await t.db.select({ id: messages.id, seq: messages.seq }).from(messages).where(eq(messages.chatId, id))
    expect(rows.sort((a, b) => a.seq - b.seq)).toEqual([{ id: messageId(1), seq: 0 }, { id: messageId(5), seq: 1 }])
    expect((await rejection(service.replaceFrom(id, messageId(9), []))).code).toBe('not_found')
  })

  it('replaceFrom fails atomically when a new message id belongs to another chat', async () => {
    const id = await insertChat(1, 1000)
    const other = await insertChat(2, 1000)
    await service.upsertMessage(other, userMessage(messageId(9), 'other chat'))
    await service.upsertMessage(id, userMessage(messageId(1), 'q1'))
    await service.upsertMessage(id, assistantMessage(messageId(2), 'a1'))
    expect((await rejection(service.replaceFrom(id, messageId(2), [userMessage(messageId(9), 'x')]))).code).toBe('conflict')
    expect((await service.listMessages(id)).map(message => message.id)).toEqual([messageId(1), messageId(2)])
  })

  it('transaction commits store operations together and rolls back on error', async () => {
    const id = await insertChat(1, 1000)
    await service.transaction(async (store) => {
      await store.upsertMessage(id, userMessage(messageId(1), 'q1'))
      await store.upsertMessage(id, assistantMessage(messageId(2), 'a1'))
      await store.replaceFrom(id, messageId(2), [assistantMessage(messageId(3), 'a1 bis')])
    })
    expect((await service.listMessages(id)).map(message => message.id)).toEqual([messageId(1), messageId(3)])
    await expect(service.transaction(async (store) => {
      await store.upsertMessage(id, userMessage(messageId(4), 'q2'))
      throw new Error('pipeline failed')
    })).rejects.toThrow('pipeline failed')
    expect((await service.listMessages(id)).map(message => message.id)).toEqual([messageId(1), messageId(3)])
    const result = await service.transaction(async store => (await store.listMessages(id)).length)
    expect(result).toBe(2)
  })
})
