// `/compact [focus]` (W9.1-T2): through `POST /api/chat` with `mock:compact` (the summarizer answers `MOCK-SUMMARY: …`
// and `seen?` reports what the model still receives), and `compactStream` directly with `MockLanguageModelV4` doubles
// (a failure, an abort).
import type { ChatDetail, CompactionData, HarnessUIMessage } from '@harness-forge/shared'
import type { UIMessageChunk } from 'ai'
import type { TestApp } from '../../testing/create-test-app.ts'
import { chatDetailSchema, createMessageId, LIMITS } from '@harness-forge/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import { chatBody, messageText, postChat, readSse, runnerOf, streamedText, testChatId } from '../testing.ts'
import { compactStream, hasSomethingToCompact, historyToCompact, NOTHING_TO_COMPACT_TEXT } from './stream.ts'
import { assistant, failingModel, fakeSession, hangingModel, mockCompactReply, resolvedModel, seedChat, summaryModel, user } from './testing.ts'

let t: TestApp

beforeAll(async () => {
  t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
})

afterEach(async () => {
  await t.deps.settings.update({ compactModelRef: null, autoCompact: true })
})

afterAll(async () => {
  await t.close()
})

async function detailOf(chatId: string): Promise<ChatDetail> {
  const response = await t.request(`/api/chats/${chatId}`)
  expect(response.status).toBe(200)
  return chatDetailSchema.parse(await response.json())
}

function compactBody(chatId: string, text: string, overrides: Parameters<typeof chatBody>[2] = {}): ReturnType<typeof chatBody> {
  return chatBody(chatId, text, { modelRef: 'mock:compact', ...overrides })
}

async function turn(chatId: string, text: string, overrides: Parameters<typeof chatBody>[2] = {}): Promise<UIMessageChunk[]> {
  const { chunks, done } = await readSse(await postChat(t, compactBody(chatId, text, overrides)))
  expect(done).toBe(true)
  await runnerOf(t).idle()
  return chunks
}

/** Stored turns (a user message and `mock:compact`'s echo each) under the chat's active leaf. */
async function seedTurns(chatId: string, ...texts: string[]): Promise<HarnessUIMessage[]> {
  const messages = texts.flatMap(text => [user(createMessageId(), text), mockCompactReply(createMessageId(), text)])
  await seedChat(t.deps, chatId, messages)
  return messages
}

function markersOf(message: HarnessUIMessage | undefined): CompactionData[] {
  return message?.parts.flatMap(part => (part.type === 'data-compaction' ? [part.data] : [])) ?? []
}

async function compactUsageRows(chatId: string): Promise<{ message_id: string, purpose: string, cost_usd: number | null }[]> {
  const result = await t.database.client.execute({ sql: 'SELECT message_id, purpose, cost_usd FROM usage WHERE chat_id = ? AND purpose = \'compact\'', args: [chatId] })
  return result.rows as unknown as { message_id: string, purpose: string, cost_usd: number | null }[]
}

describe('/compact through POST /chat', () => {
  it('summarizes the history into one manual marker; the next turn sees only the summary', async () => {
    const chatId = testChatId(9111)
    const seeded = await seedTurns(chatId, 'turn one OLD-1', 'turn two OLD-1', 'turn three OLD-1')
    const chunks = await turn(chatId, '/compact keep numbers')
    expect(chunks.map(chunk => chunk.type)).toEqual(['start', 'data-activity', 'data-compaction', 'data-activity', 'finish'])
    expect(chunks.filter(chunk => chunk.type === 'data-activity')).toEqual([
      { type: 'data-activity', data: { kind: 'compacting' }, transient: true },
      { type: 'data-activity', data: { kind: 'idle' }, transient: true },
    ])
    expect(streamedText(chunks)).toBe('')

    const detail = await detailOf(chatId)
    const [compactUser, reply] = detail.messages.slice(-2)
    expect(compactUser?.metadata?.command).toEqual({ name: 'compact', input: 'keep numbers', type: 'compact' })
    expect(reply?.parts.map(part => part.type)).toEqual(['data-compaction'])
    const [data] = markersOf(reply)
    expect(data).toMatchObject({ trigger: 'manual', keep: 'none', focus: 'keep numbers', modelRef: 'mock:compact', messagesCompacted: 6 })
    expect(data?.summary).toMatch(/^MOCK-SUMMARY: .* \| steps-done=0 \| focus=keep numbers \| sentinels=OLD-1$/)
    expect(data!.tokensAfter).toBeLessThan(data!.tokensBefore)
    expect(reply?.metadata?.usage?.contextTokens).toBe(data?.tokensAfter)
    expect(reply?.metadata?.finishReason).toBe('stop')
    expect(reply?.metadata?.costUsd).toBeGreaterThan(0)
    const rows = await compactUsageRows(chatId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ message_id: reply?.id, purpose: 'compact' })

    // The next turn: the summary replaced the old turns.
    const seen = await turn(chatId, 'seen?')
    expect(streamedText(seen)).toBe('summary:yes seen:none')

    // An edit above the marker (a sibling of turn 2) sends the full history again.
    const edited = await turn(chatId, 'seen?', { parentId: seeded[1]!.id })
    expect(streamedText(edited)).toBe('summary:no seen:OLD-1')
  })

  it('a regenerate of the reply compacts again; without a focus the marker has none', async () => {
    const chatId = testChatId(9112)
    await seedTurns(chatId, 'first OLD-2')
    await turn(chatId, '/compact')
    const reply = (await detailOf(chatId)).messages.at(-1)!
    const [first] = markersOf(reply)
    expect(first?.focus).toBeUndefined()
    expect(first?.summary).toContain('focus=none')
    const again = await readSse(await postChat(t, { ...compactBody(chatId, '/compact'), trigger: 'regenerate-message', messageId: reply.id }))
    expect(again.chunks.some(chunk => chunk.type === 'data-compaction')).toBe(true)
    await runnerOf(t).idle()
    const regenerated = (await detailOf(chatId)).messages.at(-1)!
    expect(regenerated.id).not.toBe(reply.id)
    expect(markersOf(regenerated)).toHaveLength(1)
    expect(await compactUsageRows(chatId)).toHaveLength(2)
  })

  it('answers that there is nothing to compact yet for a new chat and right after a compaction', async () => {
    const chatId = testChatId(9113)
    expect(streamedText(await turn(chatId, '/compact'))).toBe(NOTHING_TO_COMPACT_TEXT)
    const nothing = (await detailOf(chatId)).messages.at(-1)
    expect(messageText(nothing)).toBe(NOTHING_TO_COMPACT_TEXT)
    expect(nothing?.metadata?.finishReason).toBe('stop')
    // The `/compact` exchange itself is not something to compact.
    expect(streamedText(await turn(chatId, '/compact'))).toBe(NOTHING_TO_COMPACT_TEXT)
    await seedTurns(chatId, 'real content')
    expect((await turn(chatId, '/compact')).some(chunk => chunk.type === 'data-compaction')).toBe(true)
    expect(streamedText(await turn(chatId, '/compact focus'))).toBe(NOTHING_TO_COMPACT_TEXT)
    expect(await compactUsageRows(chatId)).toHaveLength(1)
  })

  it('a failed summarizer ends the reply as failed: no marker, no trimming, the history unchanged', async () => {
    const chatId = testChatId(9114)
    await seedTurns(chatId, 'keep me OLD-3')
    await t.deps.settings.update({ compactModelRef: 'mock:error' })
    const chunks = await turn(chatId, '/compact')
    expect(chunks.some(chunk => chunk.type === 'data-compaction')).toBe(false)
    const error = chunks.find(chunk => chunk.type === 'error')
    expect(error?.type === 'error' ? JSON.parse(error.errorText) : null).toMatchObject({ error: { code: 'auth_invalid' } })
    const detail = await detailOf(chatId)
    const reply = detail.messages.at(-1)
    expect(markersOf(reply)).toEqual([])
    expect(reply?.metadata).toMatchObject({ finishReason: 'error', error: { code: 'auth_invalid' } })
    await t.deps.settings.update({ compactModelRef: null })
    expect(streamedText(await turn(chatId, 'seen?'))).toBe('summary:no seen:OLD-3')
  })

  it('refuses an image model as the run model with a 400 on modelRef, before anything is stored', async () => {
    const chatId = testChatId(9115)
    await seedTurns(chatId, 'some content')
    const before = (await detailOf(chatId)).messages.length
    const response = await postChat(t, compactBody(chatId, '/compact', { modelRef: 'mock:image' }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'validation_error', details: { issues: [{ path: ['modelRef'] }] } } })
    expect((await detailOf(chatId)).messages).toHaveLength(before)
  })

  it('refuses a focus longer than 1000 characters before anything is stored', async () => {
    const chatId = testChatId(9116)
    const response = await postChat(t, compactBody(chatId, `/compact ${'f'.repeat(LIMITS.compactFocusMaxChars + 1)}`))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'validation_error', details: { issues: [{ path: ['message'] }] } } })
    const detail = await t.request(`/api/chats/${chatId}`)
    if (detail.status === 200)
      expect(chatDetailSchema.parse(await detail.json()).messages).toEqual([])
  })
})

async function collect(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done)
      return chunks
    chunks.push(value)
  }
}

describe('compactStream', () => {
  const history: HarnessUIMessage[] = [
    user('msg_u000000000000001', 'question'),
    assistant('msg_a000000000000001', 'answer'),
    { ...user('msg_u000000000000002', '/compact'), metadata: { modelRef: 'mock:run', startedAt: 1, command: { name: 'compact', input: '', type: 'compact' } } },
  ]

  it('drops the /compact message and skips /compact exchanges when deciding there is something to compact', () => {
    expect(historyToCompact(history)).toEqual(history.slice(0, 2))
    expect(historyToCompact(history.slice(0, 2))).toEqual(history.slice(0, 2))
    expect(hasSomethingToCompact([])).toBe(false)
    expect(hasSomethingToCompact(history.slice(0, 2))).toBe(true)
    expect(hasSomethingToCompact([history[2]!, assistant('msg_a000000000000002', NOTHING_TO_COMPACT_TEXT)])).toBe(false)
  })

  it('a summarizer failure: an error chunk, no marker, the run failed', async () => {
    const fake = fakeSession({ history, target: resolvedModel('mock:run', failingModel(new Error('down'))) })
    const chunks = await collect(await compactStream(fake.session, null))
    expect(chunks.map(chunk => chunk.type)).toEqual(['start', 'data-activity', 'data-activity', 'error'])
    expect(fake.session.fatal?.message).toBe('down')
    expect(fake.usage).toEqual([])
  })

  it('an abort: no marker and no failure', async () => {
    let started!: () => void
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const fake = fakeSession({ history, target: resolvedModel('mock:run', hangingModel(() => started())) })
    const pending = collect(await compactStream(fake.session, 'focus'))
    await running
    fake.controller.abort(new DOMException('The run was stopped.', 'AbortError'))
    const chunks = await pending
    expect(chunks.map(chunk => chunk.type)).toEqual(['start', 'data-activity', 'data-activity', 'abort'])
    expect(fake.session.fatal).toBeNull()
  })

  it('writes the marker with the todo snapshot and the usage of the summarizer as the reply usage', async () => {
    const todos = [{ id: '1', content: 'Read', status: 'completed' as const }]
    const withTodos: HarnessUIMessage[] = [
      history[0]!,
      { id: 'msg_a000000000000001', role: 'assistant', parts: [{ type: 'tool-todo_write', toolCallId: 't1', state: 'output-available', input: { todos }, output: { todos, counts: { pending: 0, inProgress: 0, completed: 1, total: 1 } } } as unknown as HarnessUIMessage['parts'][number], { type: 'text', text: 'ok' }] },
      history[2]!,
    ]
    const fake = fakeSession({ history: withTodos, target: resolvedModel('mock:run', summaryModel('S')) })
    const chunks = await collect(await compactStream(fake.session, null))
    const marker = chunks.find(chunk => chunk.type === 'data-compaction')
    expect(marker?.type === 'data-compaction' ? marker.data : null).toMatchObject({ todos, messagesCompacted: 2, summary: 'S' })
    const finish = chunks.at(-1)
    expect(finish?.type === 'finish' ? finish.messageMetadata : null).toMatchObject({ usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 }, finishReason: 'stop' })
  })
})
