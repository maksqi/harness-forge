import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { ChatDetail, HarnessErrorInit, HarnessUIMessage, McpServer, ServerEvent } from '@harness-forge/shared'
import type { MediaTestApp } from '../../chat/testing.ts'
import type { McpManager, ToolPref, ToolService } from '../../mcp/types.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeProjectService } from '../../testing/fake-projects.ts'
import { Buffer } from 'node:buffer'
import { chatDetailSchema, chatStopResultSchema, createMessageId, harnessErrorEnvelopeSchema, harnessErrorInitSchema, LIMITS, queueItemSchema } from '@harness-forge/shared'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BUILTIN_COMMANDS } from '../../builtin-plugins/core-commands/commands.ts'
import { expandTemplate } from '../../chat/commands.ts'
import { SUPERSEDED_REASON } from '../../chat/history.ts'
import { createChatRunnerWith } from '../../chat/index.ts'
import {
  chatBody,
  createMediaTestApp,
  messageText,
  nextEvent,
  postChat,
  readSse,
  readUntil,
  runnerOf,
  streamedText,
  testChatId,
  userMessage,
  words,
} from '../../chat/testing.ts'
import { PNG } from '../../services/files/fixtures.test-util.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeProjectService } from '../../testing/fake-projects.ts'

let t: TestApp
let events: ServerEvent[]
let nextChat = 100
const disposables: Disposable[] = []

/** Models of the `testkit` provider, set per test. */
const scripted = new Map<string, LanguageModelV4>()

function newChatId(): string {
  nextChat += 1
  return testChatId(nextChat)
}

async function detailOf(chatId: string): Promise<ChatDetail> {
  const response = await t.request(`/api/chats/${chatId}`)
  expect(response.status).toBe(200)
  return chatDetailSchema.parse(await response.json())
}

/** `POST /api/chats/:id/branch`: shows the most recent leaf under `messageId`. */
async function switchTo(chatId: string, messageId: string): Promise<ChatDetail> {
  const response = await t.request(`/api/chats/${chatId}/branch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageId }) })
  expect(response.status).toBe(200)
  return chatDetailSchema.parse(await response.json())
}

async function errorOf(response: Response): Promise<HarnessErrorInit> {
  return harnessErrorEnvelopeSchema.parse(await response.json()).error
}

function finishPart(input = 1, output = 1): LanguageModelV4StreamPart {
  return {
    type: 'finish',
    usage: { inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: output, text: output, reasoning: 0 } },
    finishReason: { unified: 'stop', raw: 'stop' },
  }
}

function textParts(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    finishPart(),
  ]
}

/** A model whose answer is computed from the call options (calls are recorded). */
function scriptedModel(script: (options: LanguageModelV4CallOptions, call: number) => LanguageModelV4StreamPart[]): { model: LanguageModelV4, calls: LanguageModelV4CallOptions[] } {
  const calls: LanguageModelV4CallOptions[] = []
  const model = new MockLanguageModelV4({
    provider: 'testkit',
    modelId: 'scripted',
    doStream: async (options) => {
      calls.push(options)
      return { stream: convertArrayToReadableStream(script(options, calls.length)) }
    },
  })
  return { model, calls }
}

function lastIsToolResult(options: LanguageModelV4CallOptions): boolean {
  return options.prompt.at(-1)?.role === 'tool'
}

/** Marks every pending approval of `message` as answered (the client side of `addToolApprovalResponse`). */
function answered(message: HarnessUIMessage, approved: boolean, reason?: string): HarnessUIMessage {
  return {
    ...message,
    parts: message.parts.map((part) => {
      const value = part as unknown as Record<string, unknown>
      if (value.state !== 'approval-requested')
        return part
      return { ...value, state: 'approval-responded', approval: { ...(value.approval as object), approved, ...(reason === undefined ? {} : { reason }) } } as unknown as typeof part
    }),
  }
}

function toolPart(message: HarnessUIMessage | undefined): Record<string, unknown> | undefined {
  return message?.parts.find(part => part.type.startsWith('tool-') || part.type === 'dynamic-tool') as Record<string, unknown> | undefined
}

async function waitRunFinished(chatId: string): Promise<Extract<ServerEvent, { type: 'run.finished' }>> {
  return nextEvent(t, 'run.finished', event => event.data.chatId === chatId, 15_000)
}

/** Registers the `testkit` provider (models from `scripted`) on an app, as a builtin contribution of `mock`. */
function registerTestkit(app: TestApp): Disposable {
  return app.deps.registry.providers.register('mock', {
    id: 'testkit',
    name: 'Test kit',
    credentials: [],
    seedModels: [
      { id: 'tools', name: 'Tools', contextWindow: 32_000, capabilities: { tools: true }, cost: { input: 1, output: 2 } },
      { id: 'tiny', name: 'Tiny', contextWindow: 200, capabilities: { tools: false } },
      { id: 'plain', name: 'Plain', contextWindow: 32_000, capabilities: { tools: false } },
    ],
    createLanguageModel: (modelId) => {
      const model = scripted.get(modelId)
      if (model === undefined)
        throw new Error(`No scripted model "${modelId}".`)
      return model
    },
  })
}

beforeAll(async () => {
  t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
  t.deps.events.subscribe(event => events.push(event))
  disposables.push(registerTestkit(t))
})

beforeEach(() => {
  events = []
  scripted.clear()
})

afterAll(async () => {
  for (const disposable of disposables)
    disposable.dispose()
  await t.close()
})

describe('pOST /api/chat: streaming and persistence', () => {
  it('streams mock:echo as a UI message stream and persists both messages with metadata', async () => {
    const chatId = newChatId()
    const body = chatBody(chatId, 'one two three')
    const response = await postChat(t, body)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
    const { chunks, done } = await readSse(response)
    expect(done).toBe(true)
    expect(streamedText(chunks)).toBe('one two three')
    const start = chunks[0]
    expect(start).toMatchObject({ type: 'start', messageMetadata: { modelRef: 'mock:echo' } })
    expect(start?.type === 'start' ? start.messageId : undefined).toMatch(/^msg_[\dA-Z]{16}$/i)
    const finish = chunks.at(-1)
    expect(finish).toMatchObject({ type: 'finish', finishReason: 'stop', messageMetadata: { finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 3 }, costUsd: 0.000009 } })

    const detail = await detailOf(chatId)
    expect(detail.running).toBe(false)
    expect(detail.pendingApproval).toBe(false)
    expect(detail.settings).toMatchObject({ toolMode: 'ask', reasoningEffort: 'auto' })
    expect(detail.modelRef).toBe('mock:echo')
    const [user, assistant] = detail.messages
    expect(user).toMatchObject({ id: body.message.id, role: 'user', metadata: { modelRef: 'mock:echo' } })
    expect(assistant?.id).toBe(start?.type === 'start' ? start.messageId : '')
    expect(messageText(assistant)).toBe('one two three')
    expect(assistant?.metadata).toMatchObject({ modelRef: 'mock:echo', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6, contextTokens: 6 }, costUsd: 0.000009 })
    expect(assistant?.metadata?.durationMs).toBeGreaterThanOrEqual(0)
    expect(assistant?.metadata?.finishedAt).toBeGreaterThanOrEqual(assistant?.metadata?.startedAt ?? 0)
    // Usage row (purpose chat) with the catalog price: 3 input tokens at 1 USD / 1M, 3 output tokens at 2 USD / 1M.
    expect(detail.totals).toMatchObject({ inputTokens: 3, outputTokens: 3, costUsd: 0.000009 })

    const types = events.map(event => event.type)
    expect(types).toContain('run.started')
    expect(types.indexOf('run.started')).toBeLessThan(types.indexOf('run.finished'))
    const finished = events.find(event => event.type === 'run.finished')
    expect(finished?.data).toMatchObject({ chatId, outcome: 'completed', awaitingApproval: false })
    await runnerOf(t).idle()
  })

  it('streams reasoning and records reasoningMs', async () => {
    const chatId = newChatId()
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'think about this', { modelRef: 'mock:reasoning', reasoningEffort: 'medium' })))
    expect(chunks.some(chunk => chunk.type === 'reasoning-delta')).toBe(true)
    expect(streamedText(chunks)).toBe('Answer: think about this')
    const assistant = (await detailOf(chatId)).messages[1]
    const reasoning = assistant?.parts.find(part => part.type === 'reasoning')
    expect(reasoning).toMatchObject({ type: 'reasoning', text: 'Thinking about "think about this" with effort medium.', state: 'done' })
    // Eight reasoning chunks, 100 ms apart.
    expect(assistant?.metadata?.reasoningMs).toBeGreaterThanOrEqual(600)
    expect(assistant?.metadata?.usage?.reasoningTokens).toBe(8)
    await runnerOf(t).idle()
  })

  it('sends no reasoning option for effort auto and maps off to none', async () => {
    const auto = newChatId()
    const autoChunks = (await readSse(await postChat(t, chatBody(auto, 'hi', { modelRef: 'mock:reasoning', reasoningEffort: 'auto' })))).chunks
    expect(autoChunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.type === 'reasoning-delta' ? chunk.delta : '').join('')).toContain('provider-default')
    const off = newChatId()
    const offChunks = (await readSse(await postChat(t, chatBody(off, 'hi', { modelRef: 'mock:reasoning', reasoningEffort: 'off' })))).chunks
    expect(offChunks.some(chunk => chunk.type === 'reasoning-start')).toBe(false)
    expect(streamedText(offChunks)).toBe('Answer: hi')
    await runnerOf(t).idle()
  })

  it('generates a title on the first turn and pushes chat.updated', async () => {
    const chatId = newChatId()
    const titled = nextEvent(t, 'chat.updated', event => event.data.id === chatId && event.data.title !== null)
    await readSse(await postChat(t, chatBody(chatId, 'The quick brown fox jumps over the lazy dog again')))
    const event = await titled
    // mock:echo is the small model of the mock provider: it echoes, the title keeps the first 8 words.
    expect(event.data).toMatchObject({ title: 'The quick brown fox jumps over the lazy', titleSource: 'auto' })
    await runnerOf(t).idle()
    const second = nextEvent(t, 'chat.updated', event => event.data.id === chatId, 3000)
    await readSse(await postChat(t, chatBody(chatId, 'something else entirely')))
    await second
    await runnerOf(t).idle()
    expect((await detailOf(chatId)).title).toBe('The quick brown fox jumps over the lazy')
  })

  it('never overwrites a user title', async () => {
    const chatId = newChatId()
    await t.request('/api/chats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: chatId, title: 'My title' }) })
    await readSse(await postChat(t, chatBody(chatId, 'hello there')))
    await runnerOf(t).idle()
    expect((await detailOf(chatId))).toMatchObject({ title: 'My title', titleSource: 'user' })
  })
})

describe('pOST /api/chat: errors before the stream', () => {
  it('answers 400 provider_not_configured without streaming or storing the message', async () => {
    const chatId = newChatId()
    const response = await postChat(t, chatBody(chatId, 'hello', { modelRef: 'anthropic:claude-sonnet-4-5' }))
    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await errorOf(response)).toMatchObject({ code: 'provider_not_configured', action: 'configure-provider', providerId: 'anthropic' })
    expect((await detailOf(chatId)).messages).toEqual([])
    expect(events.some(event => event.type === 'run.started')).toBe(false)
    // The run slot is free again.
    expect(runnerOf(t).isActive(chatId)).toBe(false)
    const again = await postChat(t, chatBody(chatId, 'hello'))
    expect(again.status).toBe(200)
    await readSse(again)
    await runnerOf(t).idle()
  })

  it('reports an unknown provider as provider_not_configured', async () => {
    const response = await postChat(t, chatBody(newChatId(), 'hello', { modelRef: 'nosuchprovider:model' }))
    expect(response.status).toBe(400)
    expect(await errorOf(response)).toMatchObject({ code: 'provider_not_configured', providerId: 'nosuchprovider' })
  })

  it('answers 404 model_not_found for a model the catalog does not know', async () => {
    const response = await postChat(t, chatBody(newChatId(), 'hello', { modelRef: 'mock:does-not-exist' }))
    expect(response.status).toBe(404)
    expect(await errorOf(response)).toMatchObject({ code: 'model_not_found', action: 'refresh-models' })
  })

  it('validates the body (strict schema, ids, roles, parts)', async () => {
    const chatId = newChatId()
    const cases: unknown[] = [
      { ...chatBody(chatId, 'x'), extra: true },
      { ...chatBody(chatId, 'x'), chatId: 'not-a-uuid' },
      { ...chatBody(chatId, 'x'), message: { id: 'bad', role: 'user', parts: [{ type: 'text', text: 'x' }] } },
      { ...chatBody(chatId, 'x'), message: { ...userMessage('x'), role: 'system' } },
      { ...chatBody(chatId, 'x'), message: { ...userMessage('x'), parts: [{ type: 'reasoning', text: 'x' }] } },
      { ...chatBody(chatId, 'x'), message: { ...userMessage('x'), parts: [] } },
      { ...chatBody(chatId, 'x'), message: { ...userMessage('x'), parts: [{ type: 'file', mediaType: 'image/png', url: 'https://example.com/a.png' }] } },
      { ...chatBody(chatId, 'x'), message: { ...userMessage('x'), parts: [{ type: 'file', mediaType: 'image/png', url: '/api/files/file_0000000000000000' }] } },
    ]
    for (const body of cases) {
      const response = await postChat(t, body)
      expect(response.status, JSON.stringify(body)).toBe(400)
      expect((await errorOf(response)).code).toBe('validation_error')
    }
    expect((await detailOf(chatId)).messages).toEqual([])
  })

  it('answers 409 conflict while a run is active, then accepts again', async () => {
    const chatId = newChatId()
    const first = await postChat(t, chatBody(chatId, words(400)))
    expect(first.status).toBe(200)
    const second = await postChat(t, chatBody(chatId, 'second'))
    expect(second.status).toBe(409)
    expect(await errorOf(second)).toMatchObject({ code: 'conflict', details: { reason: 'run-active', chatId } })
    const stop = await t.request(`/api/chat/${chatId}/stop`, { method: 'POST' })
    expect(chatStopResultSchema.parse(await stop.json())).toEqual({ stopped: true })
    await first.body?.cancel()
    const third = await postChat(t, chatBody(chatId, 'third'))
    expect(third.status).toBe(200)
    expect(streamedText((await readSse(third)).chunks)).toBe('third')
    await runnerOf(t).idle()
  })

  it('rejects a reused message id with 409 exists', async () => {
    const chatId = newChatId()
    const body = chatBody(chatId, 'once')
    await readSse(await postChat(t, body))
    const again = await postChat(t, { ...body, message: { ...body.message } })
    expect(again.status).toBe(409)
    expect(await errorOf(again)).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    // An id of another chat fails the history commit the same way, before anything streams.
    const other = newChatId()
    const stolen = await postChat(t, { ...chatBody(other, 'twice'), message: { ...body.message } })
    expect(stolen.status).toBe(409)
    expect(await errorOf(stolen)).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    expect((await detailOf(other)).messages).toEqual([])
    expect(runnerOf(t).hasRun(other)).toBe(false)
    await runnerOf(t).idle()
  })
})

describe('pOST /api/chat: in-stream errors', () => {
  it('maps a provider 401 to auth_invalid and sends the envelope as errorText', async () => {
    const chatId = newChatId()
    const finished = waitRunFinished(chatId)
    const response = await postChat(t, chatBody(chatId, 'hello', { modelRef: 'mock:error' }))
    expect(response.status).toBe(200)
    const { chunks } = await readSse(response)
    const error = chunks.find(chunk => chunk.type === 'error')
    expect(error).toBeDefined()
    const envelope = harnessErrorEnvelopeSchema.parse(JSON.parse(error?.type === 'error' ? error.errorText : '{}'))
    expect(envelope.error).toMatchObject({ code: 'auth_invalid', status: 401, providerId: 'mock', action: 'configure-provider' })
    const event = await finished
    expect(event.data).toMatchObject({ outcome: 'failed', awaitingApproval: false, error: { code: 'auth_invalid' } })
    const assistant = (await detailOf(chatId)).messages[1]
    expect(harnessErrorInitSchema.parse(assistant?.metadata?.error)).toMatchObject({ code: 'auth_invalid' })
    expect(assistant?.metadata?.finishReason).toBe('error')
    await runnerOf(t).idle()
  })
})

describe('pOST /api/chat: stop, disconnect and resume', () => {
  it('stop mid-stream persists the partial message with aborted: true', async () => {
    const chatId = newChatId()
    const response = await postChat(t, chatBody(chatId, words(400)))
    await readUntil(response, chunks => chunks.filter(chunk => chunk.type === 'text-delta').length >= 3)
    const finished = waitRunFinished(chatId)
    const stop = await t.request(`/api/chat/${chatId}/stop`, { method: 'POST' })
    expect(stop.status).toBe(200)
    expect(await stop.json()).toEqual({ stopped: true })
    // `stop` waits for the persistence: the message is there when it answers.
    const assistant = (await detailOf(chatId)).messages[1]
    expect(assistant?.metadata).toMatchObject({ aborted: true })
    const text = messageText(assistant)
    expect(text.startsWith('w1 w2 w3')).toBe(true)
    expect(text.split(' ').length).toBeLessThan(400)
    expect(assistant?.parts.find(part => part.type === 'text')).toMatchObject({ state: 'done' })
    expect((await finished).data).toMatchObject({ outcome: 'aborted' })
    expect(runnerOf(t).isActive(chatId)).toBe(false)
    expect((await t.request(`/api/chat/${chatId}/stream`)).status).toBe(204)
    await runnerOf(t).idle()
  })

  it('stop without a run answers stopped: false', async () => {
    const response = await t.request(`/api/chat/${newChatId()}/stop`, { method: 'POST' })
    expect(await response.json()).toEqual({ stopped: false })
  })

  it('stop empties the steer queue first and answers the queued messages as dropped, oldest first (Phase 9)', async () => {
    const chatId = newChatId()
    const response = await postChat(t, chatBody(chatId, words(400)))
    await readUntil(response, chunks => chunks.some(chunk => chunk.type === 'text-delta'))
    const queued = []
    for (const text of ['first queued', '/compact']) {
      const added = await t.request(`/api/chat/${chatId}/queue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: { id: createMessageId(), role: 'user', parts: [{ type: 'text', text }] }, modelRef: 'mock:echo', reasoningEffort: 'auto', toolMode: 'ask' }),
      })
      expect(added.status).toBe(201)
      queued.push(queueItemSchema.parse(await added.json()))
    }
    const stop = await t.request(`/api/chat/${chatId}/stop`, { method: 'POST' })
    expect(stop.status).toBe(200)
    const result = chatStopResultSchema.parse(await stop.json())
    expect(result).toEqual({ stopped: true, dropped: queued })
    expect(events.filter(event => event.type === 'queue.changed' && event.data.removed !== undefined).map(event => event.data))
      .toEqual([{ chatId, items: [], removed: queued.map(item => ({ id: item.id, reason: 'stopped' })) }])
    expect((await t.request(`/api/chat/${chatId}/queue`)).json()).resolves.toEqual({ items: [] })
    // Nothing queued starts a turn: the path ends with the aborted reply.
    expect((await detailOf(chatId)).messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(events.filter(event => event.type === 'run.started' && event.data.chatId === chatId)).toHaveLength(1)
    await runnerOf(t).idle()
  })

  it('stop of a chat waiting for an approval drops its queue without a run (stopped: false)', async () => {
    const chatId = newChatId()
    await readSse(await postChat(t, chatBody(chatId, 'echo me', { modelRef: 'mock:tool-approval' })))
    const added = await t.request(`/api/chat/${chatId}/queue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: { id: createMessageId(), role: 'user', parts: [{ type: 'text', text: 'waiting' }] }, modelRef: 'mock:tool-approval', reasoningEffort: 'auto', toolMode: 'ask' }),
    })
    const item = queueItemSchema.parse(await added.json())
    const stop = await t.request(`/api/chat/${chatId}/stop`, { method: 'POST' })
    expect(await stop.json()).toEqual({ stopped: false, dropped: [item] })
    expect(t.deps.runs.queueList(chatId)).toEqual([])
  })

  it('a client disconnect keeps the run alive; resume replays it from the first chunk', async () => {
    const chatId = newChatId()
    const text = words(30)
    const response = await postChat(t, chatBody(chatId, text))
    const partial = await readUntil(response, chunks => chunks.filter(chunk => chunk.type === 'text-delta').length >= 2)
    expect(partial.done).toBe(false)
    expect(runnerOf(t).isActive(chatId)).toBe(true)
    expect(runnerOf(t).active().map(run => run.chatId)).toContain(chatId)
    expect((await detailOf(chatId)).running).toBe(true)

    const resumed = await t.request(`/api/chat/${chatId}/stream`)
    expect(resumed.status).toBe(200)
    expect(resumed.headers.get('content-type')).toContain('text/event-stream')
    const replay = await readSse(resumed)
    expect(replay.done).toBe(true)
    expect(replay.chunks[0]?.type).toBe('start')
    expect(streamedText(replay.chunks)).toBe(text)

    const assistant = (await detailOf(chatId)).messages[1]
    expect(messageText(assistant)).toBe(text)
    expect(assistant?.metadata?.aborted).toBeUndefined()
    expect((await t.request(`/api/chat/${chatId}/stream`)).status).toBe(204)
    await runnerOf(t).idle()
  })

  it('gET /api/chat/:id/stream answers 204 for an idle or unknown chat', async () => {
    expect((await t.request(`/api/chat/${newChatId()}/stream`)).status).toBe(204)
    expect((await t.request('/api/chat/not-a-chat-id/stream')).status).toBe(400)
  })
})

describe('pOST /api/chat: the message tree (ADR-023)', () => {
  it('an edit adds a sibling version; switching back restores the later messages', async () => {
    const chatId = newChatId()
    const first = chatBody(chatId, 'first question')
    await readSse(await postChat(t, first))
    await readSse(await postChat(t, chatBody(chatId, 'second question')))
    const before = await detailOf(chatId)
    expect(before.messages).toHaveLength(4)
    expect(before.branches).toEqual({})

    // An edit of the first question: a new user message (new id) whose parent is the edited message's parent.
    const edit = chatBody(chatId, 'first question edited', { parentId: null })
    expect(streamedText((await readSse(await postChat(t, edit))).chunks)).toBe('first question edited')
    const edited = await detailOf(chatId)
    expect(edited.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(edited.messages[0]?.id).toBe(edit.message.id)
    expect(edited.branches).toEqual({ [edit.message.id]: { siblings: [first.message.id, edit.message.id], index: 1 } })

    // The old version and everything after it are still there.
    const back = await switchTo(chatId, first.message.id)
    expect(back.messages.map(message => message.id)).toEqual(before.messages.map(message => message.id))
    expect(back.branches).toEqual({ [first.message.id]: { siblings: [first.message.id, edit.message.id], index: 0 } })

    // Without parentId a new message continues the active leaf (the version shown).
    await readSse(await postChat(t, chatBody(chatId, 'third question')))
    const continued = await detailOf(chatId)
    expect(continued.messages.map(message => messageText(message))).toEqual([
      'first question',
      'first question',
      'second question',
      'second question',
      'third question',
      'third question',
    ])
    await runnerOf(t).idle()
  })

  it('an edit in the middle keeps the earlier messages and versions the edited one', async () => {
    const chatId = newChatId()
    await readSse(await postChat(t, chatBody(chatId, 'one')))
    const second = chatBody(chatId, 'two')
    await readSse(await postChat(t, second))
    const firstReply = (await detailOf(chatId)).messages[1]!
    const edit = chatBody(chatId, 'two, edited', { parentId: firstReply.id })
    await readSse(await postChat(t, edit))
    const detail = await detailOf(chatId)
    expect(detail.messages.map(message => messageText(message))).toEqual(['one', 'one', 'two, edited', 'two, edited'])
    expect(detail.branches).toEqual({ [edit.message.id]: { siblings: [second.message.id, edit.message.id], index: 1 } })
    await runnerOf(t).idle()
  })

  it('regenerate in the middle of a transcript adds a sibling reply; nothing is deleted', async () => {
    const chatId = newChatId()
    const first = chatBody(chatId, 'alpha')
    await readSse(await postChat(t, first))
    await readSse(await postChat(t, chatBody(chatId, 'beta')))
    const before = await detailOf(chatId)
    const firstReply = before.messages[1]!
    const response = await postChat(t, { ...first, trigger: 'regenerate-message', messageId: firstReply.id })
    const { chunks } = await readSse(response)
    expect(streamedText(chunks)).toBe('alpha')
    const after = await detailOf(chatId)
    expect(after.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(after.messages[0]?.id).toBe(first.message.id)
    const newReply = after.messages[1]!
    expect(newReply.id).not.toBe(firstReply.id)
    expect(chunks[0]).toMatchObject({ type: 'start', messageId: newReply.id })
    expect(after.branches).toEqual({ [newReply.id]: { siblings: [firstReply.id, newReply.id], index: 1 } })
    expect((await switchTo(chatId, firstReply.id)).messages.map(message => message.id)).toEqual(before.messages.map(message => message.id))

    // Without messageId: the active leaf (the last reply of the version shown).
    await readSse(await postChat(t, { ...first, trigger: 'regenerate-message' }))
    const again = await detailOf(chatId)
    expect(again.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(again.branches[again.messages[3]!.id]?.siblings).toEqual([before.messages[3]!.id, again.messages[3]!.id])
    const unknown = await postChat(t, { ...first, trigger: 'regenerate-message', messageId: 'msg_0000000000000000' })
    expect(unknown.status).toBe(404)
    await runnerOf(t).idle()
  })

  it('regenerate on a user message answers that message', async () => {
    const chatId = newChatId()
    const first = chatBody(chatId, 'alpha')
    await readSse(await postChat(t, first))
    const second = chatBody(chatId, 'beta')
    await readSse(await postChat(t, second))
    const before = await detailOf(chatId)
    const { chunks } = await readSse(await postChat(t, { ...second, trigger: 'regenerate-message', messageId: second.message.id }))
    expect(streamedText(chunks)).toBe('beta')
    const after = await detailOf(chatId)
    expect(after.messages.slice(0, 3).map(message => message.id)).toEqual(before.messages.slice(0, 3).map(message => message.id))
    expect(after.branches).toEqual({ [after.messages[3]!.id]: { siblings: [before.messages[3]!.id, after.messages[3]!.id], index: 1 } })
    // The first question answered again: a sibling of the first reply.
    await readSse(await postChat(t, { ...first, trigger: 'regenerate-message', messageId: first.message.id }))
    const firstAgain = await detailOf(chatId)
    expect(firstAgain.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(firstAgain.branches[firstAgain.messages[1]!.id]?.siblings).toHaveLength(2)
    await runnerOf(t).idle()
  })

  it('rejects messageId on a user message and parentId on a regenerate or a continuation (400)', async () => {
    const chatId = newChatId()
    const body = chatBody(chatId, 'x')
    await readSse(await postChat(t, body))
    const cases: unknown[] = [
      chatBody(chatId, 'edited in place', { messageId: body.message.id }),
      chatBody(chatId, 'edited in place', { messageId: body.message.id, parentId: null }),
      { ...body, trigger: 'regenerate-message', parentId: null },
      { ...body, trigger: 'regenerate-message', parentId: body.message.id },
      { ...chatBody(chatId, ''), message: (await detailOf(chatId)).messages[1], parentId: body.message.id },
    ]
    for (const request of cases) {
      const response = await postChat(t, request)
      expect(response.status, JSON.stringify(request)).toBe(400)
      expect((await errorOf(response)).code).toBe('validation_error')
    }
    expect((await detailOf(chatId)).messages).toHaveLength(2)
    await runnerOf(t).idle()
  })

  it('answers 404 for an unknown parent or one of another chat, 400 for a regenerate without a user message', async () => {
    const other = newChatId()
    const foreign = chatBody(other, 'elsewhere')
    await readSse(await postChat(t, foreign))
    const chatId = newChatId()
    const unknown = await postChat(t, chatBody(chatId, 'x', { parentId: 'msg_0000000000000000' }))
    expect(unknown.status).toBe(404)
    expect((await errorOf(unknown)).code).toBe('not_found')
    expect((await postChat(t, chatBody(chatId, 'x', { parentId: foreign.message.id }))).status).toBe(404)
    const empty = await postChat(t, { ...chatBody(chatId, 'x'), trigger: 'regenerate-message' })
    expect(empty.status).toBe(400)
    expect(await errorOf(empty)).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['messageId'] }] } })
    expect((await detailOf(chatId)).messages).toEqual([])
    expect(events.some(event => event.type === 'run.started' && event.data.chatId === chatId)).toBe(false)
    await runnerOf(t).idle()
  })

  it('gET during a regenerate run ends at the answered user message; resume replays the reply exactly once', async () => {
    const chatId = newChatId()
    const text = words(10)
    const first = chatBody(chatId, text)
    await readSse(await postChat(t, first))
    const oldReply = (await detailOf(chatId)).messages[1]!
    const response = await postChat(t, { ...first, trigger: 'regenerate-message', messageId: oldReply.id })
    const partial = await readUntil(response, chunks => chunks.filter(chunk => chunk.type === 'text-delta').length >= 2)
    expect(partial.done).toBe(false)

    const during = await detailOf(chatId)
    expect(during.running).toBe(true)
    expect(during.messages.map(message => message.id)).toEqual([first.message.id])
    expect(during.branches).toEqual({})

    const replay = await readSse(await t.request(`/api/chat/${chatId}/stream`))
    expect(replay.done).toBe(true)
    const starts = replay.chunks.filter(chunk => chunk.type === 'start')
    expect(starts).toHaveLength(1)
    const newId = starts[0]?.type === 'start' ? starts[0].messageId : undefined
    expect(newId).not.toBe(oldReply.id)
    expect(streamedText(replay.chunks)).toBe(text)

    const after = await detailOf(chatId)
    expect(after.messages.map(message => message.id)).toEqual([first.message.id, newId])
    expect(messageText(after.messages[1])).toBe(text)
    expect(after.branches).toEqual({ [newId!]: { siblings: [oldReply.id, newId], index: 1 } })
    await runnerOf(t).idle()
  })

  it('an approval pending on another version is re-armed by a switch and its continuation completes', async () => {
    const chatId = newChatId()
    const ask = chatBody(chatId, 'echo me', { modelRef: 'mock:tool-approval' })
    await readSse(await postChat(t, ask))
    const pending = await detailOf(chatId)
    expect(pending.pendingApproval).toBe(true)
    const assistant = pending.messages[1]!

    // An edit of the question: the approval of the other version is not superseded.
    const edit = chatBody(chatId, 'never mind', { parentId: null })
    const edited = await readSse(await postChat(t, edit))
    expect(edited.chunks.some(chunk => chunk.type === 'data-notice' && (chunk.data as { code?: string }).code === 'approvals-superseded')).toBe(false)
    expect((await detailOf(chatId)).pendingApproval).toBe(false)
    const continuation = { ...chatBody(chatId, '', { modelRef: 'mock:tool-approval' }), message: answered(assistant, true) }
    // Not the active leaf: 404.
    expect((await postChat(t, continuation)).status).toBe(404)

    const back = await switchTo(chatId, ask.message.id)
    expect(back.pendingApproval).toBe(true)
    expect(toolPart(back.messages[1])).toMatchObject({ state: 'approval-requested' })
    const finished = waitRunFinished(chatId)
    const response = await postChat(t, continuation)
    expect(response.status).toBe(200)
    expect(streamedText((await readSse(response)).chunks)).toBe('Tool result: {"echoed":"echo me"}')
    expect((await finished).data).toMatchObject({ outcome: 'completed', awaitingApproval: false, messageId: assistant.id })
    const done = await detailOf(chatId)
    expect(done.pendingApproval).toBe(false)
    expect(done.messages.map(message => message.id)).toEqual([ask.message.id, assistant.id])
    expect(toolPart(done.messages[1])).toMatchObject({ state: 'output-available', approval: { approved: true } })
    expect(done.branches).toEqual({ [ask.message.id]: { siblings: [ask.message.id, edit.message.id], index: 0 } })
    await runnerOf(t).idle()
  })

  it('the persisted reply never overwrites an active leaf moved during the run', async () => {
    const chatId = newChatId()
    const first = chatBody(chatId, 'first')
    await readSse(await postChat(t, first))
    const text = words(12)
    const second = chatBody(chatId, text)
    const response = await postChat(t, second)
    await readUntil(response, chunks => chunks.some(chunk => chunk.type === 'text-delta'))
    // Only the pipeline and a switch move the leaf, and a switch is refused during a run: this simulates a lost race.
    const firstReply = (await t.deps.chats.listMessages(chatId))[1]!
    expect(await t.deps.chats.setActiveLeaf(chatId, firstReply.id)).toBe(true)
    const finished = waitRunFinished(chatId)
    await readSse(await t.request(`/api/chat/${chatId}/stream`))
    expect((await finished).data).toMatchObject({ outcome: 'completed', awaitingApproval: false })
    const detail = await detailOf(chatId)
    expect(detail.messages.map(message => message.id)).toEqual([first.message.id, firstReply.id])
    // The reply is stored under its user message, as a version that is not shown.
    const all = await t.deps.chats.listMessages(chatId)
    expect(all.map(message => messageText(message))).toEqual(['first', 'first', text, text])
    expect((await switchTo(chatId, second.message.id)).messages.map(message => messageText(message))).toEqual(['first', 'first', text, text])
    await runnerOf(t).idle()
  })

  it('a new message supersedes only the approvals on its own path', async () => {
    const chatId = newChatId()
    const ask = chatBody(chatId, 'first tool', { modelRef: 'mock:tool-approval' })
    await readSse(await postChat(t, ask))
    const firstPending = (await detailOf(chatId)).messages[1]!
    // A second version of the question that also waits for an approval.
    await readSse(await postChat(t, chatBody(chatId, 'second tool', { modelRef: 'mock:tool-approval', parentId: null })))
    const secondPending = (await detailOf(chatId)).messages[1]!
    // A follow-up on the second version supersedes its approval only.
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'moving on', { parentId: secondPending.id })))
    expect(chunks.find(chunk => chunk.type === 'data-notice')).toMatchObject({ data: { code: 'approvals-superseded' } })
    expect(toolPart((await detailOf(chatId)).messages[1])).toMatchObject({ state: 'output-denied', approval: { reason: SUPERSEDED_REASON } })
    const first = await switchTo(chatId, ask.message.id)
    expect(first.pendingApproval).toBe(true)
    expect(toolPart(first.messages[1])).toMatchObject({ state: 'approval-requested' })
    expect(first.messages[1]?.id).toBe(firstPending.id)
    await runnerOf(t).idle()
  })
})

describe('pOST /api/chat: slash commands', () => {
  it('expands a template command: the transcript keeps the text, the model gets the expansion', async () => {
    const chatId = newChatId()
    const summarize = BUILTIN_COMMANDS.find(command => command.name === 'summarize')!
    const expansion = expandTemplate(summarize.template, 'hello world')
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, '/summarize hello world')))
    // mock:echo streams the user text it received, which is the expansion.
    expect(streamedText(chunks)).toBe(expansion.trim())
    const user = (await detailOf(chatId)).messages[0]
    expect(messageText(user)).toBe('/summarize hello world')
    expect(user?.metadata?.command).toEqual({ name: 'summarize', input: 'hello world', type: 'prompt', expansion })
    await runnerOf(t).idle()
  })

  it('writes the reply of a reply command without a model call', async () => {
    const registration = t.deps.registry.commands.register('mock', {
      name: 'pingpong',
      description: 'Replies pong',
      run: async ({ input }) => ({ type: 'reply', markdown: `pong ${input}`.trim() }),
    })
    try {
      const chatId = newChatId()
      // mock:error would fail if it were called.
      const { chunks } = await readSse(await postChat(t, chatBody(chatId, '/pingpong  loud', { modelRef: 'mock:error' })))
      expect(chunks.some(chunk => chunk.type === 'error')).toBe(false)
      expect(streamedText(chunks)).toBe('pong loud')
      const [user, assistant] = (await detailOf(chatId)).messages
      expect(user?.metadata?.command).toEqual({ name: 'pingpong', input: 'loud', type: 'reply' })
      expect(messageText(assistant)).toBe('pong loud')
      expect(assistant?.metadata).toMatchObject({ modelRef: 'mock:error', finishReason: 'stop' })
      expect(assistant?.metadata?.usage).toBeUndefined()
      await runnerOf(t).idle()
    }
    finally {
      registration.dispose()
    }
  })

  it('shows a failing run command as plugin_error in the chat', async () => {
    const registration = t.deps.registry.commands.register('mock', {
      name: 'broken',
      description: 'Throws',
      run: async () => {
        throw new Error('command exploded')
      },
    })
    try {
      const chatId = newChatId()
      const { chunks } = await readSse(await postChat(t, chatBody(chatId, '/broken')))
      const error = chunks.find(chunk => chunk.type === 'error')
      expect(JSON.parse(error?.type === 'error' ? error.errorText : '{}')).toMatchObject({ error: { code: 'plugin_error', message: 'command exploded' } })
      const assistant = (await detailOf(chatId)).messages[1]
      expect(assistant?.metadata?.error).toMatchObject({ code: 'plugin_error' })
      await runnerOf(t).idle()
    }
    finally {
      registration.dispose()
    }
  })

  it('gET /api/commands lists server-side commands sorted by name', async () => {
    const response = await t.request('/api/commands')
    expect(response.status).toBe(200)
    const { items } = await response.json() as { items: { name: string, pluginId: string }[] }
    // Phase 9: the harness command `compact` (plugin `core-agent`) is listed with the builtin commands.
    expect(items.map(item => item.name)).toEqual([...BUILTIN_COMMANDS.map(command => command.name), 'compact'].sort())
    expect(items.every(item => item.pluginId === (item.name === 'compact' ? 'core-agent' : 'core-commands'))).toBe(true)
  })
})

describe('pOST /api/chat: tools and approvals', () => {
  it('ask mode: approval requested, then the continuation executes the tool and answers', async () => {
    const chatId = newChatId()
    const first = await readSse(await postChat(t, chatBody(chatId, 'echo me', { modelRef: 'mock:tool-approval' })))
    expect(first.chunks.some(chunk => chunk.type === 'tool-approval-request')).toBe(true)
    const pending = await detailOf(chatId)
    expect(pending.pendingApproval).toBe(true)
    const assistant = pending.messages[1]!
    expect(toolPart(assistant)).toMatchObject({ state: 'approval-requested', input: { text: 'echo me' } })
    expect((toolPart(assistant)?.approval as { signature?: string }).signature).toBeTypeOf('string')

    const finished = waitRunFinished(chatId)
    const response = await postChat(t, { ...chatBody(chatId, '', { modelRef: 'mock:tool-approval' }), message: answered(assistant, true) })
    expect(response.status).toBe(200)
    const { chunks } = await readSse(response)
    expect(chunks[0]).toMatchObject({ type: 'start', messageId: assistant.id })
    expect(chunks.find(chunk => chunk.type === 'tool-output-available')).toMatchObject({ output: { echoed: 'echo me' } })
    expect(streamedText(chunks)).toBe('Tool result: {"echoed":"echo me"}')
    expect((await finished).data).toMatchObject({ outcome: 'completed', awaitingApproval: false, messageId: assistant.id })

    const done = await detailOf(chatId)
    expect(done.pendingApproval).toBe(false)
    expect(done.messages).toHaveLength(2)
    const final = done.messages[1]!
    expect(final.id).toBe(assistant.id)
    expect(toolPart(final)).toMatchObject({ state: 'output-available', output: { echoed: 'echo me' }, approval: { approved: true } })
    expect(messageText(final)).toBe('Tool result: {"echoed":"echo me"}')
    // The continuation extends the metadata of the message: usage and cost add up.
    expect(final.metadata?.startedAt).toBe(assistant.metadata?.startedAt)
    expect(final.metadata?.usage?.inputTokens).toBeGreaterThan(assistant.metadata?.usage?.inputTokens ?? 0)
    await runnerOf(t).idle()
  })

  it('deny path: the tool does not run and the model is told', async () => {
    const chatId = newChatId()
    await readSse(await postChat(t, chatBody(chatId, 'do it', { modelRef: 'mock:tool-approval' })))
    const assistant = (await detailOf(chatId)).messages[1]!
    const { chunks } = await readSse(await postChat(t, { ...chatBody(chatId, '', { modelRef: 'mock:tool-approval' }), message: answered(assistant, false, 'not now') }))
    expect(chunks.some(chunk => chunk.type === 'tool-output-denied')).toBe(true)
    expect(streamedText(chunks)).toBe('The tool call was denied.')
    const final = (await detailOf(chatId)).messages[1]
    expect(toolPart(final)).toMatchObject({ state: 'output-denied', approval: { approved: false, reason: 'not now' } })
    await runnerOf(t).idle()
  })

  it('a continuation that does not match the last assistant message is 404; one without decisions is 400', async () => {
    const chatId = newChatId()
    await readSse(await postChat(t, chatBody(chatId, 'do it', { modelRef: 'mock:tool-approval' })))
    const assistant = (await detailOf(chatId)).messages[1]!
    const wrongId = await postChat(t, { ...chatBody(chatId, '', { modelRef: 'mock:tool-approval' }), message: { ...answered(assistant, true), id: 'msg_0000000000000000' } })
    expect(wrongId.status).toBe(404)
    const noDecision = await postChat(t, { ...chatBody(chatId, '', { modelRef: 'mock:tool-approval' }), message: assistant })
    expect(noDecision.status).toBe(400)
    // Client changes other than the decisions are ignored (the stored input and signature are used).
    const tampered = answered(assistant, true)
    const part = toolPart(tampered)!
    part.input = { text: 'something else' }
    const { chunks } = await readSse(await postChat(t, { ...chatBody(chatId, '', { modelRef: 'mock:tool-approval' }), message: tampered }))
    expect(chunks.find(chunk => chunk.type === 'tool-output-available')).toMatchObject({ output: { echoed: 'do it' } })
    await runnerOf(t).idle()
  })

  it('a new message supersedes pending approvals (denied with reason superseded + notice)', async () => {
    const chatId = newChatId()
    await readSse(await postChat(t, chatBody(chatId, 'do it', { modelRef: 'mock:tool-approval' })))
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'never mind')))
    expect(chunks.find(chunk => chunk.type === 'data-notice')).toMatchObject({ data: { code: 'approvals-superseded' } })
    const detail = await detailOf(chatId)
    expect(detail.pendingApproval).toBe(false)
    expect(toolPart(detail.messages[1])).toMatchObject({ state: 'output-denied', approval: { approved: false, reason: SUPERSEDED_REASON } })
    expect(detail.messages[3]?.parts.find(part => part.type === 'data-notice')).toMatchObject({ data: { code: 'approvals-superseded' } })
    await runnerOf(t).idle()
  })

  it('auto mode runs policy-ask tools without a card; off mode sends no tools', async () => {
    const auto = newChatId()
    const autoChunks = (await readSse(await postChat(t, chatBody(auto, 'go', { modelRef: 'mock:tool-approval', toolMode: 'auto' })))).chunks
    expect(autoChunks.some(chunk => chunk.type === 'tool-approval-request')).toBe(false)
    expect(streamedText(autoChunks)).toBe('Tool result: {"echoed":"go"}')
    expect((await detailOf(auto)).settings.toolMode).toBe('auto')

    const off = newChatId()
    const offChunks = (await readSse(await postChat(t, chatBody(off, 'go', { modelRef: 'mock:tool-approval', toolMode: 'off' })))).chunks
    expect(streamedText(offChunks)).toBe('Tools are disabled.')
    expect(offChunks.some(chunk => chunk.type === 'tool-input-start')).toBe(false)
    await runnerOf(t).idle()
  })

  it('caps a tool output above 64 KB', async () => {
    const tool = t.deps.registry.tools.register('mock', {
      name: 'big_output',
      description: 'Returns a large text.',
      inputSchema: z.object({}),
      policy: 'safe',
      execute: async () => ({ text: 'x'.repeat(100_000) }),
    })
    const { model } = scriptedModel(options => lastIsToolResult(options)
      ? textParts('done')
      : [{ type: 'tool-call', toolCallId: 'call_big', toolName: 'big_output', input: '{}' }, { ...finishPart(), finishReason: { unified: 'tool-calls', raw: 'tool_calls' } } as LanguageModelV4StreamPart])
    scripted.set('tools', model)
    try {
      const chatId = newChatId()
      const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'go', { modelRef: 'testkit:tools' })))
      expect(streamedText(chunks)).toBe('done')
      const output = toolPart((await detailOf(chatId)).messages[1])?.output as { truncated: boolean, originalBytes: number, preview: string }
      expect(output.truncated).toBe(true)
      expect(output.originalBytes).toBe(JSON.stringify({ text: 'x'.repeat(100_000) }).length)
      expect(Buffer.byteLength(output.preview)).toBe(LIMITS.toolOutputBytes)
      expect(output.preview.startsWith('{"text":"xxx')).toBe(true)
      await runnerOf(t).idle()
    }
    finally {
      tool.dispose()
    }
  })

  it('a throwing tool.before hook blocks the call (output-error), the run goes on', async () => {
    const hook = t.deps.registry.hooks.on('mock', 'tool.before', () => {
      throw new Error('not allowed today')
    })
    try {
      const chatId = newChatId()
      const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'go', { modelRef: 'mock:tool-approval', toolMode: 'auto' })))
      expect(chunks.find(chunk => chunk.type === 'tool-output-error')).toMatchObject({ errorText: 'Blocked by mock: not allowed today' })
      expect(chunks.some(chunk => chunk.type === 'error')).toBe(false)
      expect(toolPart((await detailOf(chatId)).messages[1])).toMatchObject({ state: 'output-error', errorText: 'Blocked by mock: not allowed today' })
      await runnerOf(t).idle()
    }
    finally {
      hook.dispose()
    }
  })
})

describe('pOST /api/chat: params, files and context', () => {
  it('sends global + chat instructions changed by chat.params and headers from chat.headers', async () => {
    const { model, calls } = scriptedModel(() => textParts('ok'))
    scripted.set('plain', model)
    await t.deps.settings.update({ instructions: 'Global rules.' })
    const params = t.deps.registry.hooks.on('mock', 'chat.params', (_input, output) => {
      output.instructions = `${output.instructions}\n\nFrom a hook.`
      output.temperature = 0.3
      output.maxSteps = 1000
    })
    const headers = t.deps.registry.hooks.on('mock', 'chat.headers', (_input, output) => {
      output.headers['x-plugin'] = 'yes'
      output.headers['bad header'] = 'dropped'
    })
    try {
      const chatId = newChatId()
      await t.request('/api/chats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: chatId, settings: { instructions: 'Chat rules.' } }) })
      await readSse(await postChat(t, chatBody(chatId, 'hi', { modelRef: 'testkit:plain' })))
      const call = calls[0]!
      expect(call.prompt[0]).toEqual({ role: 'system', content: 'Global rules.\n\nChat rules.\n\nFrom a hook.' })
      expect(call.temperature).toBe(0.3)
      expect(call.headers).toMatchObject({ 'x-plugin': 'yes' })
      expect(call.headers?.['bad header']).toBeUndefined()
      await runnerOf(t).idle()
    }
    finally {
      params.dispose()
      headers.dispose()
      await t.deps.settings.update({ instructions: '' })
    }
  })

  it('sends uploaded images as bytes to a vision model', async () => {
    const file = await t.deps.files.upload(new File([PNG], 'pixel.png', { type: 'image/png' }))
    const chatId = newChatId()
    const message = { ...userMessage('look'), parts: [{ type: 'file' as const, mediaType: 'image/png', filename: 'x.png', url: file.url }, { type: 'text' as const, text: 'look' }] }
    const { chunks } = await readSse(await postChat(t, { ...chatBody(chatId, 'look'), message }))
    expect(streamedText(chunks)).toBe('look\n\n[files: 1]')
    const stored = (await detailOf(chatId)).messages[0]
    // The stored part is rewritten from the files row.
    expect(stored?.parts[0]).toEqual({ type: 'file', mediaType: 'image/png', filename: 'pixel.png', url: file.url })
    await runnerOf(t).idle()
  })

  it('keeps images away from a model without vision and says so', async () => {
    const { model, calls } = scriptedModel(() => textParts('ok'))
    scripted.set('plain', model)
    const file = await t.deps.files.upload(new File([PNG], 'pixel.png', { type: 'image/png' }))
    const chatId = newChatId()
    const message = { ...userMessage('look'), parts: [{ type: 'file' as const, mediaType: 'image/png', url: file.url }, { type: 'text' as const, text: 'look' }] }
    const { chunks } = await readSse(await postChat(t, { ...chatBody(chatId, 'look', { modelRef: 'testkit:plain' }), message }))
    expect(chunks.filter(chunk => chunk.type === 'data-notice').map(chunk => chunk.type === 'data-notice' ? chunk.data : null)).toContainEqual(expect.objectContaining({ message: 'This model cannot read the attached file, so it was not sent.' }))
    const user = calls[0]?.prompt.find(entry => entry.role === 'user')
    expect(user?.content).toEqual([{ type: 'text', text: 'look' }])
    await runnerOf(t).idle()
  })

  it('leaves out the oldest turns above 85 percent of the context window (automatic compaction off)', async () => {
    const { model, calls } = scriptedModel(() => textParts('ok'))
    scripted.set('tiny', model)
    const chatId = newChatId()
    // Phase 9 (ADR-040): with `autoCompact` on, the context guard compacts instead of trimming.
    await t.deps.settings.update({ autoCompact: false })
    try {
      for (const text of [words(200, 'a'), words(200, 'b'), 'last question'])
        await readSse(await postChat(t, chatBody(chatId, text, { modelRef: 'testkit:tiny' })))
    }
    finally {
      await t.deps.settings.update({ autoCompact: true })
    }
    const lastCall = calls.at(-1)!
    expect(lastCall.prompt.filter(message => message.role === 'user')).toHaveLength(1)
    expect(JSON.stringify(lastCall.prompt)).toContain('last question')
    const assistant = (await detailOf(chatId)).messages.at(-1)
    expect(assistant?.parts.find(part => part.type === 'data-notice' && part.data.code === 'context-trimmed')).toBeDefined()
    // The tools-unsupported notice is shown once per chat and model, not on every reply.
    const notices = (await detailOf(chatId)).messages.flatMap(message => message.parts.filter(part => part.type === 'data-notice' && part.data.code === 'tools-unsupported'))
    expect(notices).toHaveLength(1)
    await runnerOf(t).idle()
  })
})

describe('with fake tool services (preferences, MCP servers)', () => {
  let app: TestApp
  let testkit: Disposable
  const prefs = new Map<string, ToolPref>()

  beforeAll(async () => {
    const tools: ToolService = {
      list: async () => [],
      update: async () => {
        throw new Error('not used')
      },
      prefs: async () => prefs,
    }
    const unused = async (): Promise<never> => {
      throw new Error('not used')
    }
    const mcp: McpManager = {
      start: async () => {},
      stop: async () => {},
      list: async () => [{ id: 'demo', status: 'connected' }, { id: 'down', status: 'error' }] as McpServer[],
      get: unused,
      create: unused,
      update: unused,
      remove: unused,
      reconnect: unused,
    }
    app = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, overrides: { tools, mcp } })
    testkit = registerTestkit(app)
  })

  beforeEach(() => {
    prefs.clear()
  })

  afterAll(async () => {
    testkit.dispose()
    await app.close()
  })

  it('sends tools of connected MCP servers as dynamic tools, not those of other servers', async () => {
    const lookup = app.deps.registry.tools.register('mock', {
      name: 'mcp__demo__lookup',
      description: 'Looks something up.',
      inputSchema: z.object({ q: z.string() }),
      policy: 'safe',
      execute: async input => ({ found: (input as { q: string }).q }),
    }, { mcpServerId: 'demo', title: 'Lookup' })
    const offline = app.deps.registry.tools.register('mock', {
      name: 'mcp__down__lookup',
      description: 'Unreachable.',
      inputSchema: z.object({}),
      policy: 'safe',
      execute: async () => ({}),
    }, { mcpServerId: 'down' })
    const { model, calls } = scriptedModel(options => lastIsToolResult(options)
      ? textParts('found it')
      : [{ type: 'tool-call', toolCallId: 'call_mcp', toolName: 'mcp__demo__lookup', input: '{"q":"cats"}' }, { ...finishPart(), finishReason: { unified: 'tool-calls', raw: 'tool_calls' } } as LanguageModelV4StreamPart])
    scripted.set('tools', model)
    try {
      const chatId = testChatId(950)
      const { chunks } = await readSse(await postChat(app, chatBody(chatId, 'go', { modelRef: 'testkit:tools' })))
      expect(streamedText(chunks)).toBe('found it')
      const sent = (calls[0]?.tools ?? []).map(entry => entry.name)
      expect(sent).toContain('mcp__demo__lookup')
      expect(sent).not.toContain('mcp__down__lookup')
      const detail = chatDetailSchema.parse(await (await app.request(`/api/chats/${chatId}`)).json())
      expect(toolPart(detail.messages[1])).toMatchObject({ type: 'dynamic-tool', toolName: 'mcp__demo__lookup', state: 'output-available', output: { found: 'cats' }, toolMetadata: { mcpServerId: 'demo' } })
      await runnerOf(app).idle()
    }
    finally {
      lookup.dispose()
      offline.dispose()
    }
  })

  it('override allow runs an ask-policy tool without a card in ask mode', async () => {
    prefs.set('mock_approval_tool', { enabled: true, override: 'allow' })
    const chatId = testChatId(900)
    const { chunks } = await readSse(await postChat(app, chatBody(chatId, 'go', { modelRef: 'mock:tool-approval' })))
    expect(streamedText(chunks)).toBe('Tool result: {"echoed":"go"}')
    const detail = chatDetailSchema.parse(await (await app.request(`/api/chats/${chatId}`)).json())
    expect(toolPart(detail.messages[1])).toMatchObject({ state: 'output-available', approval: { approved: true, isAutomatic: true } })
    await runnerOf(app).idle()
  })

  it('a disabled tool or override deny is not sent', async () => {
    for (const pref of [{ enabled: false, override: null }, { enabled: true, override: 'deny' as const }]) {
      prefs.set('mock_approval_tool', pref)
      const { chunks } = await readSse(await postChat(app, chatBody(testChatId(901 + (pref.enabled ? 1 : 0)), 'go', { modelRef: 'mock:tool-approval' })))
      expect(streamedText(chunks)).toBe('Tools are disabled.')
    }
    await runnerOf(app).idle()
  })
})

describe('robustness', () => {
  it('a model stream that errors mid-way ends the run as failed with the envelope', async () => {
    const model = new MockLanguageModelV4({
      provider: 'testkit',
      modelId: 'broken',
      doStream: async () => ({
        stream: (() => {
          const parts: LanguageModelV4StreamPart[] = [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'partial ' }]
          return new ReadableStream<LanguageModelV4StreamPart>({
            pull(controller) {
              const next = parts.shift()
              if (next === undefined)
                controller.error(new Error('connection reset by peer'))
              else
                controller.enqueue(next)
            },
          })
        })(),
      }),
    })
    scripted.set('plain', model)
    const chatId = newChatId()
    const finished = waitRunFinished(chatId)
    const { chunks, done } = await readSse(await postChat(t, chatBody(chatId, 'go', { modelRef: 'testkit:plain' })))
    expect(done).toBe(true)
    expect(streamedText(chunks)).toBe('partial ')
    const error = chunks.find(chunk => chunk.type === 'error')
    expect(JSON.parse(error?.type === 'error' ? error.errorText : '{}').error).toMatchObject({ code: 'provider_error', providerId: 'testkit' })
    expect((await finished).data.outcome).toBe('failed')
    const assistant = (await detailOf(chatId)).messages[1]
    expect(assistant?.metadata?.error?.code).toBe('provider_error')
    expect(runnerOf(t).isActive(chatId)).toBe(false)
    await runnerOf(t).idle()
  })

  it('a stream that fails before its end callback is still persisted and released', async () => {
    // A text delta without its text-start (a provider bug) makes the UI message processing throw.
    const { model } = scriptedModel(() => [
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'before ' },
      { type: 'text-end', id: 't' },
      { type: 'text-delta', id: 'orphan', delta: 'lost' },
      finishPart(),
    ])
    scripted.set('plain', model)
    const chatId = newChatId()
    const finished = waitRunFinished(chatId)
    const response = await postChat(t, chatBody(chatId, 'go', { modelRef: 'testkit:plain' }))
    await response.text().catch(() => '')
    const event = await finished
    expect(event.data.outcome).toBe('failed')
    expect(runnerOf(t).isActive(chatId)).toBe(false)
    const detail = await detailOf(chatId)
    expect(detail.messages).toHaveLength(2)
    expect(detail.messages[1]?.metadata?.error).toBeDefined()
    // The chat is not locked.
    scripted.set('plain', scriptedModel(() => textParts('fine')).model)
    expect(streamedText((await readSse(await postChat(t, chatBody(chatId, 'again', { modelRef: 'testkit:plain' })))).chunks)).toBe('fine')
    await runnerOf(t).idle()
  })

  it('dELETE /api/chats/:id stops the run first', async () => {
    const chatId = newChatId()
    const response = await postChat(t, chatBody(chatId, words(400)))
    await readUntil(response, chunks => chunks.some(chunk => chunk.type === 'text-delta'))
    const deleted = await t.request(`/api/chats/${chatId}`, { method: 'DELETE' })
    expect(deleted.status).toBe(204)
    expect(runnerOf(t).isActive(chatId)).toBe(false)
    expect((await t.request(`/api/chats/${chatId}`)).status).toBe(404)
    await runnerOf(t).idle()
  })

  it('a stop while the request is being prepared cancels it without storing anything', async () => {
    let started!: () => void
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const registration = t.deps.registry.commands.register('mock', {
      name: 'slowcmd',
      description: 'Waits until stopped',
      run: ({ signal }) => new Promise((_resolve, reject) => {
        started()
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    })
    try {
      const chatId = newChatId()
      const pending = postChat(t, chatBody(chatId, '/slowcmd'))
      await running
      expect(runnerOf(t).isActive(chatId)).toBe(false)
      const stop = await t.request(`/api/chat/${chatId}/stop`, { method: 'POST' })
      expect(await stop.json()).toEqual({ stopped: true })
      const response = await pending
      expect(response.status).toBe(409)
      expect((await detailOf(chatId)).messages).toEqual([])
      expect(events.some(event => event.type === 'run.started' && event.data.chatId === chatId)).toBe(false)
    }
    finally {
      registration.dispose()
    }
  })

  it('fires message.completed after persistence and applies chat.messages changes', async () => {
    const completed: { chatId: string, aborted: boolean, text: string }[] = []
    const hookCompleted = t.deps.registry.hooks.on('mock', 'message.completed', (input) => {
      completed.push({ chatId: input.chatId, aborted: input.aborted, text: messageText(input.message as HarnessUIMessage) })
    })
    const hookMessages = t.deps.registry.hooks.on('mock', 'chat.messages', (_input, output) => {
      output.messages.push({ role: 'user', content: 'added by a hook' })
    })
    try {
      const chatId = newChatId()
      const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'original')))
      // mock:echo answers the last user message: the one the hook added.
      expect(streamedText(chunks)).toBe('added by a hook')
      await runnerOf(t).idle()
      expect(completed).toEqual([{ chatId, aborted: false, text: 'added by a hook' }])
    }
    finally {
      hookCompleted.dispose()
      hookMessages.dispose()
    }
  })

  it('ignores invalid chat.messages output', async () => {
    const hook = t.deps.registry.hooks.on('mock', 'chat.messages', (_input, output) => {
      (output as { messages: unknown }).messages = [{ role: 'nobody' }]
    })
    try {
      const chatId = newChatId()
      expect(streamedText((await readSse(await postChat(t, chatBody(chatId, 'kept')))).chunks)).toBe('kept')
      await runnerOf(t).idle()
    }
    finally {
      hook.dispose()
    }
  })
})

describe('a provider that ignores the abort signal', () => {
  it('is force-released after the stop wait, so the chat is not locked', async () => {
    const app = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, factories: { runs: deps => createChatRunnerWith(deps, { stopWaitMs: 200 }) } })
    const testkit = registerTestkit(app)
    try {
      // A stream that never produces a chunk and never ends, whatever the signal says.
      scripted.set('plain', new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream<LanguageModelV4StreamPart>({ pull: () => new Promise<void>(() => {}) }) }) }))
      const chatId = testChatId(980)
      const finished = nextEvent(app, 'run.finished', event => event.data.chatId === chatId)
      const response = await postChat(app, chatBody(chatId, 'hang', { modelRef: 'testkit:plain' }))
      expect(response.status).toBe(200)
      const stop = await app.request(`/api/chat/${chatId}/stop`, { method: 'POST' })
      expect(await stop.json()).toEqual({ stopped: true })
      expect((await finished).data).toMatchObject({ outcome: 'aborted', awaitingApproval: false })
      expect(app.deps.runs.isActive(chatId)).toBe(false)
      // Nothing was stored for the run: the active path ends at its user message.
      const stopped = chatDetailSchema.parse(await (await app.request(`/api/chats/${chatId}`)).json())
      expect(stopped.messages.map(message => messageText(message))).toEqual(['hang'])
      void response.body?.cancel()
      const again = await postChat(app, chatBody(chatId, 'again'))
      expect(again.status).toBe(200)
      expect(streamedText((await readSse(again)).chunks)).toBe('again')
    }
    finally {
      testkit.dispose()
      await app.close()
    }
  })
})

describe('shutdown', () => {
  it('stopAll aborts active runs and persists them as aborted', async () => {
    const app = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
    try {
      const chatId = testChatId(990)
      const response = await postChat(app, chatBody(chatId, words(400)))
      await readUntil(response, chunks => chunks.some(chunk => chunk.type === 'text-delta'))
      await app.deps.runs.stopAll()
      expect(app.deps.runs.active()).toEqual([])
      const detail = chatDetailSchema.parse(await (await app.request(`/api/chats/${chatId}`)).json())
      expect(detail.messages[1]?.metadata?.aborted).toBe(true)
    }
    finally {
      await app.close()
    }
  })
})

describe('pOST /api/chat: image options and image turns (ADR-028)', () => {
  let media: MediaTestApp
  let chat = 700

  function mediaChatId(): string {
    chat += 1
    return testChatId(chat)
  }

  async function mediaDetail(chatId: string): Promise<ChatDetail> {
    return chatDetailSchema.parse(await (await media.request(`/api/chats/${chatId}`)).json())
  }

  /** A request refused before streaming: 400 validation_error on `path`, nothing stored, no run started. */
  async function refused(body: unknown, path: (string | number)[]): Promise<HarnessErrorInit> {
    media.events.length = 0
    const response = await postChat(media, body)
    expect(response.status, JSON.stringify(body).slice(0, 300)).toBe(400)
    expect(response.headers.get('content-type')).toContain('application/json')
    const error = await errorOf(response)
    expect(error.code).toBe('validation_error')
    expect((error.details as { issues: { path: unknown[] }[] }).issues[0]?.path).toEqual(path)
    const chatId = (body as { chatId: string }).chatId
    expect(media.events.some(event => event.type === 'run.started' && event.data.chatId === chatId)).toBe(false)
    expect(media.deps.runs.hasRun(chatId)).toBe(false)
    return error
  }

  beforeAll(async () => {
    media = await createMediaTestApp()
  })

  afterAll(async () => {
    await media.close()
  })

  it('refuses imageOptions for a model that generates no images (mock:echo)', async () => {
    const chatId = mediaChatId()
    for (const imageOptions of [{}, { aspectRatio: '1:1' as const }, { n: 1 }, { editPrevious: true }])
      await refused(chatBody(chatId, 'hello', { imageOptions }), ['imageOptions'])
    expect((await mediaDetail(chatId)).messages).toEqual([])
    // Without imageOptions the same request streams.
    const ok = await postChat(media, chatBody(chatId, 'hello'))
    expect(ok.status).toBe(200)
    await readSse(ok)
    await runnerOf(media).idle()
  })

  it('takes only the aspect ratio for a chat model with image output', async () => {
    const chatId = mediaChatId()
    const error = await refused(chatBody(chatId, 'a fox', { modelRef: 'mock:image-chat', imageOptions: { n: 2 } }), ['imageOptions'])
    expect(error.message).toContain('aspect ratio')
    await refused(chatBody(chatId, 'a fox', { modelRef: 'mock:image-chat', imageOptions: { editPrevious: false } }), ['imageOptions'])
    await refused(chatBody(chatId, 'a fox', { modelRef: 'mock:image-chat', imageOptions: { n: 1, aspectRatio: '16:9' } }), ['imageOptions'])
    const ok = await postChat(media, chatBody(chatId, 'a fox', { modelRef: 'mock:image-chat', imageOptions: { aspectRatio: '16:9' } }))
    expect(ok.status).toBe(200)
    expect(streamedText((await readSse(ok)).chunks)).toBe('Image for: a fox')
    await runnerOf(media).idle()
  })

  it('validates the image options of an image model (strict schema, 1-4 images, known aspect ratios)', async () => {
    const chatId = mediaChatId()
    for (const imageOptions of [{ n: 5 }, { n: 0 }, { n: 1.5 }, { aspectRatio: '5:4' }, { quality: 'high' }, { editPrevious: 'yes' }]) {
      const response = await postChat(media, { ...chatBody(chatId, 'a fox', { modelRef: 'mock:image' }), imageOptions })
      expect(response.status, JSON.stringify(imageOptions)).toBe(400)
      expect((await errorOf(response)).code).toBe('validation_error')
    }
    expect(media.images.calls.filter(call => call.chatId === chatId)).toEqual([])
    // Every option of an image model is accepted.
    const ok = await postChat(media, chatBody(chatId, 'a fox', { modelRef: 'mock:image', imageOptions: { n: 4, aspectRatio: '9:16', editPrevious: false } }))
    expect(ok.status).toBe(200)
    expect((await readSse(ok)).chunks.filter(chunk => chunk.type === 'file')).toHaveLength(4)
    await runnerOf(media).idle()
  })

  it('needs a text prompt of at most 32000 characters for an image turn', async () => {
    const chatId = mediaChatId()
    await refused(chatBody(chatId, '   ', { modelRef: 'mock:image' }), ['message', 'parts'])
    const tooLong = await refused(chatBody(chatId, 'x'.repeat(LIMITS.imagePromptMaxChars + 1), { modelRef: 'mock:image' }), ['message', 'parts'])
    expect(tooLong.message).toBe('Image prompts are limited to 32000 characters.')
    // An attached image alone is no prompt.
    const upload = await media.deps.files.upload(new File([PNG], 'only.png', { type: 'image/png' }))
    await refused({ ...chatBody(chatId, '', { modelRef: 'mock:image' }), message: { ...userMessage(''), parts: [{ type: 'file', mediaType: 'image/png', url: upload.url }] } }, ['message', 'parts'])
    expect((await mediaDetail(chatId)).messages).toEqual([])
    expect(media.images.calls.filter(call => call.chatId === chatId)).toEqual([])
  })

  it('refuses to regenerate a message without text with an image model', async () => {
    const chatId = mediaChatId()
    const upload = await media.deps.files.upload(new File([PNG], 'photo.png', { type: 'image/png' }))
    const body = { ...chatBody(chatId, ''), message: { ...userMessage(''), parts: [{ type: 'file' as const, mediaType: 'image/png', url: upload.url }] } }
    await readSse(await postChat(media, body))
    const reply = (await mediaDetail(chatId)).messages[1]!
    await refused({ ...body, modelRef: 'mock:image', trigger: 'regenerate-message', messageId: reply.id }, ['message', 'parts'])
    expect((await mediaDetail(chatId)).messages.map(message => message.id)).toEqual([body.message.id, reply.id])
    await runnerOf(media).idle()
  })

  it('refuses an approval continuation with an image model', async () => {
    const chatId = mediaChatId()
    await readSse(await postChat(media, chatBody(chatId, 'echo me', { modelRef: 'mock:tool-approval' })))
    const pending = (await mediaDetail(chatId)).messages[1]!
    await refused({ ...chatBody(chatId, '', { modelRef: 'mock:image' }), message: answered(pending, true) }, ['modelRef'])
    expect((await mediaDetail(chatId)).pendingApproval).toBe(true)
    await runnerOf(media).idle()
  })

  it('sends the expansion of a prompt command as the image prompt; a reply command needs no image model call', async () => {
    const template = media.deps.registry.commands.register('mock', { name: 'sketch', description: 'A pencil sketch', template: 'A pencil sketch of {{input}}' })
    const reply = media.deps.registry.commands.register('mock', { name: 'noimage', description: 'Answers itself', run: async () => ({ type: 'reply', markdown: 'Nothing to draw.' }) })
    try {
      const chatId = mediaChatId()
      const body = chatBody(chatId, '/sketch a cat', { modelRef: 'mock:image' })
      await readSse(await postChat(media, body))
      expect(media.images.calls.at(-1)).toMatchObject({ chatId, prompt: 'A pencil sketch of a cat' })
      const user = (await mediaDetail(chatId)).messages[0]
      expect(messageText(user)).toBe('/sketch a cat')
      expect(user?.metadata?.command).toMatchObject({ name: 'sketch', type: 'prompt', expansion: 'A pencil sketch of a cat' })

      const other = mediaChatId()
      const { chunks } = await readSse(await postChat(media, chatBody(other, '/noimage', { modelRef: 'mock:image' })))
      expect(streamedText(chunks)).toBe('Nothing to draw.')
      expect(chunks[0]?.type === 'start' ? (chunks[0].messageMetadata as { image?: unknown }).image : 'missing').toBeUndefined()
      expect(media.images.calls.filter(call => call.chatId === other)).toEqual([])
      await runnerOf(media).idle()
    }
    finally {
      template.dispose()
      reply.dispose()
    }
  })

  it('answers an image turn of an unknown image provider or model like a chat run', async () => {
    const unknownModel = await postChat(media, chatBody(mediaChatId(), 'a fox', { modelRef: 'mock:image-none' }))
    expect(unknownModel.status).toBe(404)
    expect((await errorOf(unknownModel)).code).toBe('model_not_found')
  })
})

describe('pOST /api/chat: the project of a new chat (Phase 7, ADR-031)', () => {
  let app: TestApp
  let projects: FakeProjectService
  const seen: ServerEvent[] = []

  beforeAll(async () => {
    app = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, factories: { projects: createFakeProjectService } })
    projects = app.deps.projects as FakeProjectService
    app.deps.events.subscribe(event => seen.push(event))
  })

  afterAll(async () => {
    await app.close()
  })

  async function projectOf(chatId: string): Promise<string | null> {
    const response = await app.request(`/api/chats/${chatId}`)
    expect(response.status).toBe(200)
    return chatDetailSchema.parse(await response.json()).projectId
  }

  it('puts the new chat in the project and opens its folder for the run', async () => {
    const project = await projects.add({ name: 'Route demo' })
    const chatId = testChatId(5001)
    const response = await postChat(app, chatBody(chatId, 'hello', { projectId: project.id }))
    expect(response.status).toBe(200)
    expect(streamedText((await readSse(response)).chunks)).toBe('hello')
    expect(await projectOf(chatId)).toBe(project.id)
    expect(seen.find(event => event.type === 'chat.created' && event.data.id === chatId)?.data).toMatchObject({ projectId: project.id })
    expect(projects.opened).toContain(project.id)
    await runnerOf(app).idle()
  })

  it('answers 404 for an unknown project before the chat row exists', async () => {
    const chatId = testChatId(5002)
    seen.length = 0
    const response = await postChat(app, chatBody(chatId, 'hello', { projectId: 'prj_0000000000000000' }))
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect((harnessErrorEnvelopeSchema.parse(await response.json())).error.code).toBe('not_found')
    expect((await app.request(`/api/chats/${chatId}`)).status).toBe(404)
    expect(seen.some(event => event.type === 'chat.created' || event.type === 'run.started')).toBe(false)
    expect(runnerOf(app).hasRun(chatId)).toBe(false)
  })

  it('ignores projectId for an existing chat (a known or an unknown project)', async () => {
    const project = await projects.add({ name: 'Ignored' })
    const chatId = testChatId(5003)
    await readSse(await postChat(app, chatBody(chatId, 'first')))
    for (const projectId of [project.id, 'prj_0000000000000000']) {
      const response = await postChat(app, chatBody(chatId, 'again', { projectId }))
      expect(response.status).toBe(200)
      await readSse(response)
      expect(await projectOf(chatId)).toBeNull()
    }
    expect(projects.opened).not.toContain(project.id)
    await runnerOf(app).idle()
  })

  it('rejects a malformed projectId with 400', async () => {
    const response = await postChat(app, chatBody(testChatId(5004), 'hello', { projectId: 'nope' }))
    expect(response.status).toBe(400)
    expect((await errorOf(response)).code).toBe('validation_error')
  })
})
