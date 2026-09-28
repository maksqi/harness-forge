import type { ChatRequestBody, HarnessUIMessage } from '@harness-forge/shared'
import type { UIMessageChunk } from 'ai'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { useChatsStore } from '~/stores/chats'
import { useModelsStore } from '~/stores/models'
import { chatDetail, chatId, chatSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import {
  buildChatRequestBody,
  MAX_CHAT_SESSIONS,
  resetChatSessions,
  useChatSession,
  useChatSessionRegistry,
} from './useChatSession'
import { dispatchServerEvent } from './useServerEvents'

const mock = vi.hoisted(() => ({ api: null as unknown, fetch: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api, useApiFetch: () => mock.fetch }))

const MODEL = 'mock:echo'
const ASSISTANT_ID = 'msg_assistant0000001'

// ---------- fake server ----------

interface ChatCall {
  url: string
  method: string
  body: ChatRequestBody | null
}

type StreamWriter = (write: (chunk: UIMessageChunk) => void) => Promise<void> | void

interface FakeServer {
  calls: ChatCall[]
  /** Replies to the next POST /api/chat. */
  reply: (writer: StreamWriter) => void
  /** Replies to the next GET /api/chat/:id/stream (default 204). */
  resume: (writer: StreamWriter | null) => void
  /** Rejects the next POST /api/chat with an error envelope. */
  fail: (status: number, error: { code: string, message: string, providerId?: string }) => void
}

function streamResponse(writer: StreamWriter): Response {
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute: async ({ writer: out }) => {
        await writer(chunk => out.write(chunk as never))
      },
    }),
  })
}

function createFakeServer(): FakeServer {
  const calls: ChatCall[] = []
  const replies: Array<(() => Response)> = []
  const resumes: Array<StreamWriter | null> = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as ChatRequestBody : null
    calls.push({ url, method, body })
    if (method === 'POST' && url === '/api/chat') {
      const next = replies.shift()
      if (!next)
        throw new Error('unexpected POST /api/chat')
      return next()
    }
    if (method === 'GET' && url.endsWith('/stream')) {
      const writer = resumes.shift() ?? null
      return writer ? streamResponse(writer) : new Response(null, { status: 204 })
    }
    throw new Error(`unexpected request ${method} ${url}`)
  })
  mock.fetch = fetchMock
  return {
    calls,
    reply: writer => replies.push(() => streamResponse(writer)),
    resume: writer => resumes.push(writer),
    fail: (status, error) => replies.push(() => new Response(JSON.stringify({ error }), {
      status,
      headers: { 'content-type': 'application/json' },
    })),
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** A text reply: start (with metadata), one text part, finish. */
function textReply(text: string, messageId = ASSISTANT_ID, gate?: Promise<void>): StreamWriter {
  return async (write) => {
    write({ type: 'start', messageId, messageMetadata: { modelRef: MODEL, startedAt: 1 } })
    write({ type: 'start-step' })
    write({ type: 'text-start', id: 't1' })
    write({ type: 'text-delta', id: 't1', delta: text })
    await gate
    write({ type: 'text-end', id: 't1' })
    write({ type: 'finish-step' })
    write({ type: 'finish', finishReason: 'stop', messageMetadata: { modelRef: MODEL, startedAt: 1, finishedAt: 2, durationMs: 1 } })
  }
}

/** A reply that ends with a tool call waiting for approval. */
function approvalReply(messageId = ASSISTANT_ID): StreamWriter {
  return (write) => {
    write({ type: 'start', messageId, messageMetadata: { modelRef: MODEL, startedAt: 1 } })
    write({ type: 'start-step' })
    write({ type: 'tool-input-available', toolCallId: 'call_1', toolName: 'mock_approval_tool', input: { value: 'x' } })
    write({ type: 'tool-approval-request', approvalId: 'appr_1', toolCallId: 'call_1' })
    write({ type: 'finish-step' })
    write({ type: 'finish', finishReason: 'tool-calls' })
  }
}

async function until(check: () => boolean, label = 'condition') {
  for (let i = 0; i < 200; i++) {
    if (check())
      return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function userMessage(id: string, text: string): HarnessUIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

function assistantMessage(id: string, text: string): HarnessUIMessage {
  return { id, role: 'assistant', metadata: { modelRef: MODEL, startedAt: 1 }, parts: [{ type: 'text', text, state: 'done' }] }
}

// ---------- setup ----------

let pinia: ReturnType<typeof createPinia>
let api: MockApi
let server: FakeServer

beforeEach(() => {
  stubLocalStorage()
  api = createMockApi()
  mock.api = api
  server = createFakeServer()
  pinia = createPinia()
  setActivePinia(pinia)
  // The default model comes from the settings store (`defaultModelRef`).
  useModelsStore()
  api.chat.stop.mockResolvedValue({ stopped: true })
  api.chats.update.mockImplementation(async ({ params }: { params: { id: string } }) => chatSummary({ id: params.id }))
})

afterEach(() => {
  resetChatSessions()
  disposePinia(pinia)
  vi.unstubAllGlobals()
})

function newSession(n = 1) {
  const session = useChatSession(chatId(n), { isNew: true })
  session.modelRef.value = MODEL
  return session
}

describe('buildChatRequestBody', () => {
  const base = { chatId: chatId(1), modelRef: MODEL, reasoningEffort: 'auto' as const, toolMode: 'ask' as const }
  const user = userMessage('msg_user000000000001', 'hi')
  const assistant = assistantMessage(ASSISTANT_ID, 'hello')

  it('sends only the last message and the composer state', () => {
    const body = buildChatRequestBody({ ...base, messages: [assistant, user], trigger: 'submit-message', messageId: undefined })
    expect(body).toEqual({ chatId: chatId(1), message: user, trigger: 'submit-message', modelRef: MODEL, reasoningEffort: 'auto', toolMode: 'ask' })
  })

  it('keeps the message id of an edit and a regenerate', () => {
    expect(buildChatRequestBody({ ...base, messages: [user], trigger: 'submit-message', messageId: user.id }).messageId).toBe(user.id)
    expect(buildChatRequestBody({ ...base, messages: [user], trigger: 'regenerate-message', messageId: ASSISTANT_ID }).messageId).toBe(ASSISTANT_ID)
  })

  it('drops the id of an approval continuation (the last message is the assistant message)', () => {
    const body = buildChatRequestBody({ ...base, messages: [user, assistant], trigger: 'submit-message', messageId: ASSISTANT_ID })
    expect(body.message).toBe(assistant)
    expect(body).not.toHaveProperty('messageId')
  })

  it('refuses to send without a model', () => {
    expect(() => buildChatRequestBody({ ...base, modelRef: null, messages: [user], trigger: 'submit-message', messageId: undefined })).toThrow(HarnessError)
  })
})

describe('useChatSession: requests', () => {
  it('posts the last user message with a client id and streams the reply', async () => {
    const session = newSession()
    session.reasoningEffort.value = 'high'
    session.toolMode.value = 'auto'
    server.reply(textReply('pong'))
    await session.send({ text: 'ping', files: [] })

    expect(server.calls).toHaveLength(1)
    const { url, method, body } = server.calls[0]!
    expect([method, url]).toEqual(['POST', '/api/chat'])
    expect(Object.keys(body!).sort()).toEqual(['chatId', 'message', 'modelRef', 'reasoningEffort', 'toolMode', 'trigger'])
    expect(body).toMatchObject({ chatId: chatId(1), trigger: 'submit-message', modelRef: MODEL, reasoningEffort: 'high', toolMode: 'auto' })
    expect(body!.message.role).toBe('user')
    expect(body!.message.id).toMatch(/^msg_[\dA-Za-z]{16}$/)
    expect(body!.message.parts).toEqual([{ type: 'text', text: 'ping' }])

    const messages = session.chat.messages.value
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(messages[1]!.id).toBe(ASSISTANT_ID)
    expect(messages[1]!.parts.find(part => part.type === 'text')).toMatchObject({ text: 'pong' })
    expect(messages[1]!.metadata).toMatchObject({ modelRef: MODEL, durationMs: 1 })
    expect(session.runState.value).toBe('idle')
  })

  it('sends uploaded files as file parts', async () => {
    const session = newSession()
    server.reply(textReply('ok'))
    await session.send({ text: '', files: [{ id: 'file_a000000000000001', name: 'a.png', mime: 'image/png', size: 3, url: '/api/files/file_a000000000000001' }] })
    expect(server.calls[0]!.body!.message.parts).toEqual([
      { type: 'file', mediaType: 'image/png', filename: 'a.png', url: '/api/files/file_a000000000000001' },
    ])
  })

  it('refuses to send without a model', async () => {
    const session = useChatSession(chatId(1), { isNew: true })
    session.modelRef.value = null
    await expect(session.send({ text: 'hi', files: [] })).rejects.toThrow('Choose a model first.')
    expect(server.calls).toHaveLength(0)
  })

  it('edits a user message: same id, later messages dropped, files kept', async () => {
    const session = newSession()
    const file = { type: 'file' as const, mediaType: 'text/plain', filename: 'a.txt', url: '/api/files/file_a000000000000001' }
    session.chat.messages.value = [
      { id: 'msg_user000000000001', role: 'user', parts: [file, { type: 'text', text: 'first' }] },
      assistantMessage('msg_old0000000000001', 'old'),
    ]
    server.reply(textReply('new answer'))
    await session.edit('msg_user000000000001', 'first, edited')
    const body = server.calls[0]!.body!
    expect(body).toMatchObject({ trigger: 'submit-message', messageId: 'msg_user000000000001' })
    expect(body.message.id).toBe('msg_user000000000001')
    expect(body.message.parts).toEqual([file, { type: 'text', text: 'first, edited' }])
    expect(session.chat.messages.value.map(message => message.id)).toEqual(['msg_user000000000001', ASSISTANT_ID])
  })

  it('regenerates the last assistant message', async () => {
    const session = newSession()
    session.chat.messages.value = [userMessage('msg_user000000000001', 'q'), assistantMessage('msg_old0000000000001', 'a')]
    server.reply(textReply('again'))
    await session.regenerate('msg_old0000000000001')
    expect(server.calls[0]!.body).toMatchObject({ trigger: 'regenerate-message', messageId: 'msg_old0000000000001' })
    expect(server.calls[0]!.body!.message.id).toBe('msg_user000000000001')
  })

  it('retries a request that failed before streaming by sending the user message again', async () => {
    const session = newSession()
    server.fail(400, { code: 'provider_not_configured', message: 'No key.', providerId: 'anthropic' })
    await session.send({ text: 'hello', files: [] })
    expect(session.chat.status.value).toBe('error')
    expect(HarnessError.from(session.chat.error.value).code).toBe('provider_not_configured')
    const failedId = session.chat.messages.value[0]!.id

    server.reply(textReply('hi'))
    await session.regenerate()
    const body = server.calls[1]!.body!
    expect(body.trigger).toBe('submit-message')
    expect(body.message.parts).toEqual([{ type: 'text', text: 'hello' }])
    expect(body.message.id).not.toBe(failedId)
    expect(session.chat.messages.value.map(message => message.role)).toEqual(['user', 'assistant'])
  })
})

describe('useChatSession: approvals', () => {
  it('continues automatically after the decision and saves "Always allow"', async () => {
    const session = newSession()
    api.tools.update.mockResolvedValue({})
    server.reply(approvalReply())
    await session.send({ text: 'use the tool', files: [] })
    expect(session.runState.value).toBe('approval')
    expect(useChatsStore().runState[chatId(1)]).toBe('approval')

    server.reply(textReply('done', ASSISTANT_ID))
    await session.approve({ id: 'appr_1', approved: true, toolName: 'mock_approval_tool', alwaysAllow: true })
    await until(() => server.calls.length === 2 && session.runState.value === 'idle', 'continuation')

    expect(api.tools.update).toHaveBeenCalledWith({ params: { name: 'mock_approval_tool' }, body: { override: 'allow' } })
    const body = server.calls[1]!.body!
    expect(body.trigger).toBe('submit-message')
    expect(body.message.role).toBe('assistant')
    expect(body).not.toHaveProperty('messageId')
    const tool = body.message.parts.find(part => part.type === 'tool-mock_approval_tool')
    expect(tool).toMatchObject({ state: 'approval-responded', approval: { id: 'appr_1', approved: true } })
    expect(useChatsStore().runState[chatId(1)]).toBeUndefined()
  })

  it('a denial does not touch the tool preference', async () => {
    const session = newSession()
    server.reply(approvalReply())
    await session.send({ text: 'use the tool', files: [] })
    server.reply(textReply('ok, skipped', ASSISTANT_ID))
    await session.approve({ id: 'appr_1', approved: false, toolName: 'mock_approval_tool', alwaysAllow: true })
    await until(() => server.calls.length === 2, 'continuation')
    expect(api.tools.update).not.toHaveBeenCalled()
    expect(server.calls[1]!.body!.message.parts.find(part => part.type === 'tool-mock_approval_tool'))
      .toMatchObject({ approval: { approved: false } })
  })
})

describe('useChatSession: stop and run state', () => {
  it('marks the chat running while streaming, stops on the server first and keeps the partial reply', async () => {
    const session = newSession()
    const gate = deferred()
    server.reply(textReply('partial', ASSISTANT_ID, gate.promise))
    const sending = session.send({ text: 'long answer please', files: [] })
    await until(() => session.chat.status.value === 'streaming', 'streaming')
    expect(useChatsStore().runState[chatId(1)]).toBe('running')

    await session.stop()
    gate.resolve()
    await sending
    expect(api.chat.stop).toHaveBeenCalledWith({ params: { id: chatId(1) } })
    const reply = session.chat.messages.value[1]!
    expect(reply.parts.find(part => part.type === 'text')).toMatchObject({ text: 'partial' })
    expect(reply.metadata?.aborted).toBe(true)
    await nextTick()
    expect(useChatsStore().runState[chatId(1)]).toBeUndefined()
  })
})

describe('useChatSession: loading and resume', () => {
  it('loads the history and the chat settings', async () => {
    api.chats.get.mockResolvedValue(chatDetail({
      id: chatId(2),
      modelRef: 'anthropic:claude-sonnet-5',
      settings: { toolMode: 'off', reasoningEffort: 'low' },
      messages: [userMessage('msg_user000000000001', 'q'), assistantMessage(ASSISTANT_ID, 'a')],
    }))
    const session = useChatSession(chatId(2))
    await until(() => session.loaded.value, 'load')
    expect(session.chat.messages.value).toHaveLength(2)
    expect(session.modelRef.value).toBe('anthropic:claude-sonnet-5')
    expect(session.toolMode.value).toBe('off')
    expect(session.reasoningEffort.value).toBe('low')
    expect(session.persisted.value).toBe(true)
  })

  it('reports an unknown chat', async () => {
    api.chats.get.mockRejectedValue(new HarnessError({ code: 'not_found', message: 'Chat not found.' }))
    const session = useChatSession(chatId(3))
    await until(() => session.notFound.value, 'not found')
    expect(session.loaded.value).toBe(false)
  })

  it('resumes an active run on load and applies the replay', async () => {
    api.chats.get
      .mockResolvedValueOnce(chatDetail({ id: chatId(4), running: true, messages: [userMessage('msg_user000000000001', 'q')] }))
      .mockResolvedValueOnce(chatDetail({ id: chatId(4), messages: [userMessage('msg_user000000000001', 'q'), assistantMessage(ASSISTANT_ID, 'resumed text')] }))
    server.resume(textReply('resumed text'))
    const session = useChatSession(chatId(4))
    await until(() => server.calls.some(call => call.url === `/api/chat/${chatId(4)}/stream`), 'resume request')
    await until(() => session.chat.messages.value.length === 2 && session.chat.status.value === 'ready', 'replay')
    expect(session.chat.messages.value[1]!.parts.find(part => part.type === 'text')).toMatchObject({ text: 'resumed text' })
    // The replay is reconciled with the stored history afterwards.
    await until(() => api.chats.get.mock.calls.length === 2, 'reload')
  })

  it('clears a stale running dot when there is nothing to resume (204)', async () => {
    api.chats.get.mockResolvedValue(chatDetail({ id: chatId(5), running: true }))
    const session = useChatSession(chatId(5))
    await until(() => server.calls.length === 1, 'resume request')
    await until(() => useChatsStore().runState[chatId(5)] === undefined, 'cleared')
    expect(session.chat.status.value).toBe('ready')
  })

  it('reloads the history when a run this session did not stream finishes', async () => {
    api.chats.get.mockResolvedValue(chatDetail({ id: chatId(6) }))
    const session = useChatSession(chatId(6))
    await until(() => session.loaded.value, 'load')
    api.chats.get.mockResolvedValue(chatDetail({ id: chatId(6), messages: [userMessage('msg_user000000000001', 'from another tab')] }))
    dispatchServerEvent({ type: 'run.finished', data: { chatId: chatId(6), messageId: 'msg_other00000000001', outcome: 'completed', awaitingApproval: false }, at: 1 })
    await until(() => session.chat.messages.value.length === 1, 'reload')
  })

  it('does not reload after its own completed run', async () => {
    const session = newSession(7)
    session.persisted.value = true
    server.reply(textReply('mine', 'msg_mine000000000001'))
    await session.send({ text: 'q', files: [] })
    dispatchServerEvent({ type: 'run.finished', data: { chatId: chatId(7), messageId: 'msg_mine000000000001', outcome: 'completed', awaitingApproval: false }, at: 1 })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(api.chats.get).not.toHaveBeenCalled()
  })
})

describe('useChatSession: registry', () => {
  it('returns the same live session for an id (navigating away and back keeps the stream)', async () => {
    const component = effectScope()
    const gate = deferred()
    server.reply(textReply('still streaming', ASSISTANT_ID, gate.promise))
    const first = component.run(() => newSession(1))!
    const sending = first.send({ text: 'q', files: [] })
    await until(() => first.chat.status.value === 'streaming', 'streaming')
    component.stop()

    // Other chats come and go meanwhile.
    for (let n = 2; n <= MAX_CHAT_SESSIONS + 2; n++)
      newSession(n)

    const again = useChatSession(chatId(1))
    expect(again).toBe(first)
    expect(again.chat.status.value).toBe('streaming')
    gate.resolve()
    await sending
    expect(again.chat.messages.value[1]!.parts.find(part => part.type === 'text')).toMatchObject({ text: 'still streaming' })
  })

  it('keeps the 8 most recent sessions: the 9th evicts the least recently used idle one', () => {
    const registry = useChatSessionRegistry()
    for (let n = 1; n <= MAX_CHAT_SESSIONS; n++)
      newSession(n)
    // Using chat 1 again makes chat 2 the least recently used.
    useChatSession(chatId(1))
    newSession(9)
    expect(registry.get(chatId(2))).toBeUndefined()
    expect(registry.get(chatId(1))).toBeDefined()
    expect(registry.ids.value).toHaveLength(MAX_CHAT_SESSIONS)
    expect(registry.ids.value[0]).toBe(chatId(9))
  })

  it('never evicts a streaming session or one shown by a mounted component', async () => {
    const registry = useChatSessionRegistry()
    const gate = deferred()
    server.reply(textReply('busy', ASSISTANT_ID, gate.promise))
    const streaming = newSession(1)
    const sending = streaming.send({ text: 'q', files: [] })
    await until(() => streaming.chat.status.value === 'streaming', 'streaming')

    const component = effectScope()
    component.run(() => newSession(2))
    for (let n = 3; n <= MAX_CHAT_SESSIONS + 1; n++)
      newSession(n)

    expect(registry.get(chatId(1))).toBe(streaming)
    expect(registry.get(chatId(2))).toBeDefined()
    expect(registry.get(chatId(3))).toBeUndefined()
    gate.resolve()
    await sending
    component.stop()
  })
})
