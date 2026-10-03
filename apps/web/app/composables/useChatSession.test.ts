import type { ChatDetail, ChatRequestBody, FileRef, HarnessUIMessage, QueueAddBody, QueueItem, ShellRule } from '@harness-forge/shared'
import type { UIMessageChunk } from 'ai'
import type { Mock } from 'vitest'
import type { TodoState } from '~/components/chat/agent/todos'
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { useChatsStore } from '~/stores/chats'
import { useModelsStore } from '~/stores/models'
import { useProjectsStore } from '~/stores/projects'
import { useShellRulesStore } from '~/stores/shell-rules'
import { catalogModel, chatDetail, chatId, chatSummary, messageBranch, messageId, projectId, projectSummary, queueItem, shellRule, steerData } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import {
  buildChatRequestBody,
  chatDataPartSchemas,
  isBusyConflict,
  isRunActiveConflict,
  leafMovedElsewhere,
  MAX_CHAT_SESSIONS,
  mergePath,
  resetChatSessions,
  samePathIds,
  useChatSession,
  useChatSessionRegistry,
} from './useChatSession'
import { useImageOptions } from './useImageOptions'
import { dispatchServerEvent } from './useServerEvents'

type TodoStateFn = (messages: readonly HarnessUIMessage[]) => TodoState | null

const mock = vi.hoisted(() => ({
  api: null as unknown,
  fetch: null as unknown,
  /** `todoState` of the todo helpers (W9.10's): the real one unless a test replaces it. */
  todoState: null as unknown as Mock<TodoStateFn>,
  realTodoState: null as TodoStateFn | null,
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api, useApiFetch: () => mock.fetch }))
vi.mock('~/components/chat/agent/todos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/components/chat/agent/todos')>()
  mock.realTodoState ??= actual.todoState
  mock.todoState ??= vi.fn(actual.todoState)
  return { ...actual, todoState: mock.todoState }
})

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
  fail: (status: number, error: { code: string, message: string, providerId?: string, details?: unknown }) => void
  /** The next POST /api/chat never gets an answer (a network error): the server may or may not have it. */
  disconnect: () => void
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
    disconnect: () => replies.push(() => {
      throw new TypeError('fetch failed')
    }),
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
function approvalReply(messageId = ASSISTANT_ID, toolName = 'mock_approval_tool'): StreamWriter {
  return (write) => {
    write({ type: 'start', messageId, messageMetadata: { modelRef: MODEL, startedAt: 1 } })
    write({ type: 'start-step' })
    write({ type: 'tool-input-available', toolCallId: 'call_1', toolName, input: { value: 'x' } })
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
  // One app-wide state: back to the defaults (1 image, Auto, edit the previous image).
  useImageOptions().set({ n: undefined, aspectRatio: undefined, editPrevious: undefined })
  vi.unstubAllGlobals()
})

function newSession(n = 1) {
  const session = useChatSession(chatId(n), { isNew: true })
  session.modelRef.value = MODEL
  return session
}

/** A stored chat with `messages` (and `branches`), loaded by a new session. */
async function loadedSession(n: number, detail: Partial<ChatDetail>) {
  api.chats.get.mockResolvedValueOnce(chatDetail({ id: chatId(n), modelRef: MODEL, ...detail }))
  const session = useChatSession(chatId(n))
  await until(() => session.loaded.value, 'load')
  return session
}

/** The bodies of the POST /api/chat requests so far. */
function chatBodies(): ChatRequestBody[] {
  return server.calls.filter(call => call.method === 'POST' && call.url === '/api/chat').map(call => call.body!)
}

/** Fresh copies (new objects, same ids and content), like a second answer of the server. */
function fromServer(messages: HarnessUIMessage[]): HarnessUIMessage[] {
  return JSON.parse(JSON.stringify(messages)) as HarnessUIMessage[]
}

describe('buildChatRequestBody', () => {
  const base = { chatId: chatId(1), modelRef: MODEL, reasoningEffort: 'auto' as const, toolMode: 'ask' as const }
  const user = userMessage('msg_user000000000001', 'hi')
  const assistant = assistantMessage(ASSISTANT_ID, 'hello')

  it('sends only the last message, its parent on the shown path and the composer state', () => {
    const body = buildChatRequestBody({ ...base, messages: [assistant, user], trigger: 'submit-message', messageId: undefined })
    expect(body).toEqual({ chatId: chatId(1), message: user, trigger: 'submit-message', parentId: ASSISTANT_ID, modelRef: MODEL, reasoningEffort: 'auto', toolMode: 'ask' })
  })

  it('sends a null parent for a first message', () => {
    const body = buildChatRequestBody({ ...base, messages: [user], trigger: 'submit-message', messageId: undefined })
    expect(body.parentId).toBeNull()
    expect(body).toHaveProperty('parentId')
  })

  it('never sends messageId with a user message (in-place edits were removed)', () => {
    const body = buildChatRequestBody({ ...base, messages: [assistant, user], trigger: 'submit-message', messageId: user.id })
    expect(body).not.toHaveProperty('messageId')
    expect(body.parentId).toBe(ASSISTANT_ID)
  })

  it('names the target of a regenerate and no parent', () => {
    const regenerate = buildChatRequestBody({ ...base, messages: [user], trigger: 'regenerate-message', messageId: ASSISTANT_ID })
    expect(regenerate.messageId).toBe(ASSISTANT_ID)
    expect(regenerate).not.toHaveProperty('parentId')
    // Without a target the server regenerates at the active leaf.
    const leaf = buildChatRequestBody({ ...base, messages: [user], trigger: 'regenerate-message', messageId: undefined })
    expect(leaf).not.toHaveProperty('messageId')
    expect(leaf).not.toHaveProperty('parentId')
  })

  it('sends neither id with an approval continuation (the last message is the assistant message)', () => {
    const body = buildChatRequestBody({ ...base, messages: [user, assistant], trigger: 'submit-message', messageId: ASSISTANT_ID })
    expect(body.message).toBe(assistant)
    expect(body).not.toHaveProperty('messageId')
    expect(body).not.toHaveProperty('parentId')
  })

  it('refuses to send without a model', () => {
    expect(() => buildChatRequestBody({ ...base, modelRef: null, messages: [user], trigger: 'submit-message', messageId: undefined })).toThrow(HarnessError)
  })

  it('adds the image options only when given', () => {
    const plain = buildChatRequestBody({ ...base, messages: [user], trigger: 'submit-message', messageId: undefined, imageOptions: undefined })
    expect(plain).not.toHaveProperty('imageOptions')
    const image = buildChatRequestBody({ ...base, messages: [user], trigger: 'submit-message', messageId: undefined, imageOptions: { n: 2 } })
    expect(image.imageOptions).toEqual({ n: 2 })
  })

  it('sends the project with a new user message only', () => {
    const project = projectId(1)
    expect(buildChatRequestBody({ ...base, messages: [user], trigger: 'submit-message', messageId: undefined, projectId: project }).projectId).toBe(project)
    // No project: no key at all (the contract has no null).
    expect(buildChatRequestBody({ ...base, messages: [user], trigger: 'submit-message', messageId: undefined, projectId: null })).not.toHaveProperty('projectId')
    expect(buildChatRequestBody({ ...base, messages: [user], trigger: 'submit-message', messageId: undefined })).not.toHaveProperty('projectId')
    // A regenerate and an approval continuation never create a chat.
    expect(buildChatRequestBody({ ...base, messages: [user], trigger: 'regenerate-message', messageId: undefined, projectId: project })).not.toHaveProperty('projectId')
    expect(buildChatRequestBody({ ...base, messages: [user, assistant], trigger: 'submit-message', messageId: ASSISTANT_ID, projectId: project })).not.toHaveProperty('projectId')
  })
})

describe('leafMovedElsewhere', () => {
  const A = 'msg_a000000000000001'
  const B = 'msg_b000000000000001'
  const U = 'msg_u000000000000001'
  const path = [userMessage(A, 'a'), assistantMessage(B, 'b')]

  it('is true when the last message shown is not the leaf', () => {
    expect(leafMovedElsewhere(path, B, null)).toBe(false)
    expect(leafMovedElsewhere(path, A, null)).toBe(true)
    expect(leafMovedElsewhere(path, 'msg_c000000000000001', null)).toBe(true)
    expect(leafMovedElsewhere(path, null, null)).toBe(true)
    expect(leafMovedElsewhere([], null, null)).toBe(false)
    expect(leafMovedElsewhere([], B, null)).toBe(true)
  })

  it('ignores a trailing message the server never stored', () => {
    const failed = [...path, userMessage(U, 'refused')]
    expect(leafMovedElsewhere(failed, B, U)).toBe(false)
    expect(leafMovedElsewhere(failed, B, null)).toBe(true)
    expect(leafMovedElsewhere(failed, 'msg_c000000000000001', U)).toBe(true)
    // An id that is not shown changes nothing.
    expect(leafMovedElsewhere(path, B, U)).toBe(false)
  })
})

describe('path helpers', () => {
  it('keeps the message objects of the shared id prefix', () => {
    const current = [userMessage('msg_a000000000000001', 'a'), assistantMessage('msg_b000000000000001', 'b'), userMessage('msg_c000000000000001', 'c')]
    const next = [userMessage('msg_a000000000000001', 'a'), assistantMessage('msg_b000000000000001', 'b'), userMessage('msg_d000000000000001', 'd')]
    const merged = mergePath(current, next)
    expect(merged.map(message => message.id)).toEqual(next.map(message => message.id))
    expect(merged[0]).toBe(current[0])
    expect(merged[1]).toBe(current[1])
    expect(merged[2]).toBe(next[2])
    expect(mergePath([], next)).not.toBe(next)
  })

  it('tells a conflict with a running reply from other conflicts', () => {
    expect(isRunActiveConflict(new HarnessError({ code: 'conflict', message: 'x', details: { reason: 'run-active' } }))).toBe(true)
    expect(isRunActiveConflict({ error: { code: 'conflict', message: 'x' } })).toBe(true)
    expect(isRunActiveConflict(new HarnessError({ code: 'conflict', message: 'x', details: { reason: 'exists' } }))).toBe(false)
    expect(isRunActiveConflict(new HarnessError({ code: 'conflict', message: 'x', details: { reason: 'busy' } }))).toBe(false)
    expect(isRunActiveConflict(new HarnessError({ code: 'not_found', message: 'x' }))).toBe(false)
  })

  it('tells a maintenance conflict (busy) from other conflicts', () => {
    expect(isBusyConflict(new HarnessError({ code: 'conflict', message: 'x', details: { reason: 'busy' } }))).toBe(true)
    expect(isBusyConflict({ error: { code: 'conflict', message: 'x', details: { reason: 'busy' } } })).toBe(true)
    expect(isBusyConflict(new HarnessError({ code: 'conflict', message: 'x', details: { reason: 'run-active' } }))).toBe(false)
    expect(isBusyConflict({ error: { code: 'conflict', message: 'x' } })).toBe(false)
    expect(isBusyConflict(new HarnessError({ code: 'not_found', message: 'x' }))).toBe(false)
  })

  it('compares paths by message ids', () => {
    const path = [userMessage('msg_a000000000000001', 'a')]
    expect(samePathIds(path, [userMessage('msg_a000000000000001', 'other text')])).toBe(true)
    expect(samePathIds(path, [])).toBe(false)
    expect(samePathIds(path, [userMessage('msg_b000000000000001', 'a')])).toBe(false)
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
    expect(Object.keys(body!).sort()).toEqual(['chatId', 'message', 'modelRef', 'parentId', 'reasoningEffort', 'toolMode', 'trigger'])
    expect(body).toMatchObject({ chatId: chatId(1), trigger: 'submit-message', parentId: null, modelRef: MODEL, reasoningEffort: 'high', toolMode: 'auto' })
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

  it('names the last shown message as the parent of a new message', async () => {
    const session = await loadedSession(2, { messages: [userMessage('msg_user000000000001', 'q'), assistantMessage('msg_asst000000000001', 'a')] })
    server.reply(textReply('next answer'))
    await session.send({ text: 'next', files: [] })
    expect(chatBodies()[0]).toMatchObject({ trigger: 'submit-message', parentId: 'msg_asst000000000001' })
    expect(chatBodies()[0]).not.toHaveProperty('messageId')
  })

  it('edits a user message as a new version: a new id under the same parent, files kept', async () => {
    const file = { type: 'file' as const, mediaType: 'text/plain', filename: 'a.txt', url: '/api/files/file_a000000000000001' }
    const session = await loadedSession(2, {
      messages: [
        userMessage('msg_user000000000001', 'first'),
        assistantMessage('msg_asst000000000001', 'first answer'),
        { id: 'msg_user000000000002', role: 'user', parts: [file, { type: 'text', text: 'second' }] },
        assistantMessage('msg_asst000000000002', 'old answer'),
      ],
    })
    server.reply(textReply('new answer'))
    await session.edit('msg_user000000000002', 'second, edited')

    const body = chatBodies()[0]!
    expect(body).toMatchObject({ trigger: 'submit-message', parentId: 'msg_asst000000000001' })
    expect(body).not.toHaveProperty('messageId')
    expect(body.message.id).toMatch(/^msg_[\dA-Za-z]{16}$/)
    expect(body.message.id).not.toBe('msg_user000000000002')
    expect(body.message.parts).toEqual([file, { type: 'text', text: 'second, edited' }])
    // The local path continues from the new version; the old one stays on the server.
    expect(session.chat.messages.value.map(message => message.id))
      .toEqual(['msg_user000000000001', 'msg_asst000000000001', body.message.id, ASSISTANT_ID])
  })

  it('edits a first message with a null parent', async () => {
    const session = await loadedSession(2, { messages: [userMessage('msg_user000000000001', 'first'), assistantMessage('msg_asst000000000001', 'a')] })
    server.reply(textReply('again'))
    await session.edit('msg_user000000000001', 'first, edited')
    expect(chatBodies()[0]!.parentId).toBeNull()
    expect(session.chat.messages.value).toHaveLength(2)
  })

  it('regenerates any finished reply: messageId names it, the local path ends at its user message', async () => {
    const session = await loadedSession(2, {
      messages: [
        userMessage('msg_user000000000001', 'q1'),
        assistantMessage('msg_asst000000000001', 'a1'),
        userMessage('msg_user000000000002', 'q2'),
        assistantMessage('msg_asst000000000002', 'a2'),
      ],
    })
    server.reply(textReply('a1, again'))
    await session.regenerate('msg_asst000000000001')
    const body = chatBodies()[0]!
    expect(body).toMatchObject({ trigger: 'regenerate-message', messageId: 'msg_asst000000000001' })
    expect(body).not.toHaveProperty('parentId')
    expect(body.message.id).toBe('msg_user000000000001')
    expect(session.chat.messages.value.map(message => message.id)).toEqual(['msg_user000000000001', ASSISTANT_ID])
  })

  it('regenerates the last reply at the active leaf, and answers a last user message by its id', async () => {
    const session = newSession()
    session.chat.messages.value = [userMessage('msg_user000000000001', 'q'), assistantMessage('msg_old0000000000001', 'a')]
    server.reply(textReply('again'))
    await session.regenerate()
    expect(chatBodies()[0]).toMatchObject({ trigger: 'regenerate-message' })
    expect(chatBodies()[0]).not.toHaveProperty('messageId')

    // A stored user message without a reply (e.g. its regenerate was refused) is answered by name.
    session.chat.messages.value = [userMessage('msg_user000000000001', 'q')]
    server.reply(textReply('an answer'))
    await session.regenerate()
    expect(chatBodies()[1]).toMatchObject({ trigger: 'regenerate-message', messageId: 'msg_user000000000001' })
  })
})

describe('useChatSession: failed unstored messages', () => {
  it('retries a request that failed with an HTTP error by sending the message again (new id, same parent)', async () => {
    const session = newSession()
    server.fail(400, { code: 'provider_not_configured', message: 'No key.', providerId: 'anthropic' })
    await session.send({ text: 'hello', files: [] })
    expect(session.chat.status.value).toBe('error')
    expect(HarnessError.from(session.chat.error.value).code).toBe('provider_not_configured')
    const failedId = session.chat.messages.value[0]!.id

    server.reply(textReply('hi'))
    await session.regenerate()
    const body = chatBodies()[1]!
    expect(body.trigger).toBe('submit-message')
    expect(body.parentId).toBeNull()
    expect(body.message.parts).toEqual([{ type: 'text', text: 'hello' }])
    expect(body.message.id).not.toBe(failedId)
    expect(session.chat.messages.value.map(message => message.role)).toEqual(['user', 'assistant'])
  })

  it('drops it before the next send, so it is never named as a parent', async () => {
    const session = await loadedSession(2, { messages: [userMessage('msg_user000000000001', 'q'), assistantMessage('msg_asst000000000001', 'a')] })
    server.fail(409, { code: 'conflict', message: 'A run is active.', details: { reason: 'run-active', chatId: chatId(2) } })
    await session.send({ text: 'refused', files: [] })
    const refusedId = chatBodies()[0]!.message.id
    expect(session.chat.messages.value.at(-1)!.id).toBe(refusedId)

    server.reply(textReply('ok'))
    await session.send({ text: 'accepted', files: [] })
    expect(chatBodies()[1]!.parentId).toBe('msg_asst000000000001')
    expect(session.chat.messages.value.map(message => message.id)).not.toContain(refusedId)
    expect(session.chat.messages.value).toHaveLength(4)
  })

  it('hands it back once (takeBackUnstored), e.g. for the composer', async () => {
    const session = newSession()
    server.fail(409, { code: 'conflict', message: 'A run is active.' })
    await session.send({ text: 'take me back', files: [] })
    const taken = session.takeBackUnstored()
    expect(taken?.parts).toEqual([{ type: 'text', text: 'take me back' }])
    expect(session.chat.messages.value).toEqual([])
    expect(session.takeBackUnstored()).toBeNull()
  })

  it('keeps a stored user message whose regenerate failed, and a message whose request never got an answer', async () => {
    const session = await loadedSession(2, { messages: [userMessage('msg_user000000000001', 'q'), assistantMessage('msg_asst000000000001', 'a')] })
    server.fail(400, { code: 'provider_not_configured', message: 'No key.', providerId: 'anthropic' })
    await session.regenerate('msg_asst000000000001')
    expect(session.chat.messages.value.map(message => message.id)).toEqual(['msg_user000000000001'])
    expect(session.takeBackUnstored()).toBeNull()

    // A network error: the server may have stored it, so it stays the parent of the next message.
    server.disconnect()
    await session.send({ text: 'lost?', files: [] })
    const lostId = chatBodies()[1]!.message.id
    server.reply(textReply('ok'))
    await session.send({ text: 'next', files: [] })
    expect(chatBodies()[2]!.parentId).toBe(lostId)
  })

  it('keeps a message the server reports as already stored (409 exists)', async () => {
    const session = newSession()
    server.fail(409, { code: 'conflict', message: 'The message already exists.', details: { reason: 'exists' } })
    await session.send({ text: 'stored already', files: [] })
    const storedId = chatBodies()[0]!.message.id
    expect(session.takeBackUnstored()).toBeNull()
    server.reply(textReply('ok'))
    await session.send({ text: 'next', files: [] })
    expect(chatBodies()[1]!.parentId).toBe(storedId)
  })

  it('reloads a stale path after a 404 and clears the error', async () => {
    const shown = [userMessage('msg_user000000000001', 'q'), assistantMessage('msg_asst000000000001', 'a')]
    const session = await loadedSession(2, { messages: shown })
    // Another tab showed another version meanwhile; this one names a parent the server does not know.
    const latest = [...fromServer(shown), userMessage('msg_user000000000009', 'elsewhere'), assistantMessage('msg_asst000000000009', 'b')]
    api.chats.get.mockResolvedValueOnce(chatDetail({ id: chatId(2), messages: latest }))
    server.fail(404, { code: 'not_found', message: 'Message not found.' })
    await session.send({ text: 'hi', files: [] })
    await until(() => session.chat.messages.value.length === 4, 'reload')
    expect(session.chat.messages.value.map(message => message.id)).toEqual(latest.map(message => message.id))
    expect(session.chat.status.value).toBe('ready')
    expect(session.chat.error.value).toBeUndefined()
  })
})

describe('useChatSession: versions', () => {
  const U1 = 'msg_user000000000001'
  const A1 = 'msg_asst000000000001'
  const U2 = 'msg_user000000000002'
  const A2 = 'msg_asst000000000002'
  const U2B = 'msg_user00000000002b'
  const A2B = 'msg_asst00000000002b'

  function versionOne(): HarnessUIMessage[] {
    return [userMessage(U1, 'q1'), assistantMessage(A1, 'a1'), userMessage(U2, 'q2'), assistantMessage(A2, 'a2')]
  }

  function versionTwo(): HarnessUIMessage[] {
    return [userMessage(U1, 'q1'), assistantMessage(A1, 'a1'), userMessage(U2B, 'q2, edited'), assistantMessage(A2B, 'a2b')]
  }

  it('shows the versions of the loaded path', async () => {
    const session = await loadedSession(3, { messages: versionOne(), branches: { [U2]: messageBranch([U2, U2B], 0) } })
    expect(session.branches.value).toEqual({ [U2]: { siblings: [U2, U2B], index: 0 } })
    expect(session.summary.value).not.toHaveProperty('branches')
  })

  it('switches to another version: the returned path, the shared prefix objects kept, new versions', async () => {
    const session = await loadedSession(3, { messages: versionOne(), branches: { [U2]: messageBranch([U2, U2B], 0) } })
    const before = session.chat.messages.value
    let answer!: (detail: ChatDetail) => void
    api.chats.switchBranch.mockImplementationOnce(() => new Promise((resolve) => {
      answer = resolve
    }))
    const switching = session.switchBranch(U2B)
    expect(session.switching.value).toBe(true)
    expect(api.chats.switchBranch).toHaveBeenCalledWith({ params: { id: chatId(3) }, body: { messageId: U2B } })
    answer(chatDetail({ id: chatId(3), messages: fromServer(versionTwo()), branches: { [U2B]: messageBranch([U2, U2B], 1) } }))
    await switching

    const after = session.chat.messages.value
    expect(after.map(message => message.id)).toEqual([U1, A1, U2B, A2B])
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
    expect(session.branches.value).toEqual({ [U2B]: { siblings: [U2, U2B], index: 1 } })
    expect(session.switching.value).toBe(false)
  })

  it('does not switch while a request is in flight', async () => {
    const session = await loadedSession(3, { messages: versionOne(), branches: { [U2]: messageBranch([U2, U2B], 0) } })
    const gate = deferred()
    server.reply(textReply('busy', ASSISTANT_ID, gate.promise))
    const sending = session.send({ text: 'q3', files: [] })
    await until(() => session.chat.status.value === 'streaming', 'streaming')
    await session.switchBranch(U2B)
    expect(api.chats.switchBranch).not.toHaveBeenCalled()
    expect(session.switching.value).toBe(false)
    gate.resolve()
    await sending
  })

  it('a send waits for the switch in flight and continues the path it shows', async () => {
    const session = await loadedSession(3, { messages: versionOne(), branches: { [U2]: messageBranch([U2, U2B], 0) } })
    let answer!: (detail: ChatDetail) => void
    api.chats.switchBranch.mockImplementationOnce(() => new Promise((resolve) => {
      answer = resolve
    }))
    const switching = session.switchBranch(U2B)
    server.reply(textReply('on version two'))
    const sending = session.send({ text: 'q3', files: [] })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(chatBodies()).toHaveLength(0)
    answer(chatDetail({ id: chatId(3), messages: fromServer(versionTwo()), branches: {} }))
    await switching
    await sending
    expect(chatBodies()[0]!.parentId).toBe(A2B)
  })

  it('a switch refused because a run holds the chat (409) shows the run\'s path and follows it', async () => {
    const session = await loadedSession(3, { messages: versionOne(), branches: { [U2]: messageBranch([U2, U2B], 0) } })
    api.chats.switchBranch.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'A run is active.', details: { reason: 'run-active', chatId: chatId(3) } }))
    // The run answers version two, started in another tab.
    const running = versionTwo().slice(0, 3)
    api.chats.get
      .mockResolvedValueOnce(chatDetail({ id: chatId(3), running: true, messages: running, branches: { [U2B]: messageBranch([U2, U2B], 1) } }))
      .mockResolvedValueOnce(chatDetail({ id: chatId(3), messages: versionTwo(), branches: { [U2B]: messageBranch([U2, U2B], 1) } }))
    server.resume(textReply('a2b', A2B))

    await expect(session.switchBranch(U2B)).rejects.toMatchObject({ code: 'conflict' })
    expect(session.switching.value).toBe(false)
    await until(() => server.calls.some(call => call.url === `/api/chat/${chatId(3)}/stream`), 'resume')
    await until(() => session.chat.status.value === 'ready' && api.chats.get.mock.calls.length === 3, 'reload after the replay')
    expect(session.chat.messages.value.map(message => message.id)).toEqual([U1, A1, U2B, A2B])
  })

  it('a switch to a message the server does not know (404) reloads the chat', async () => {
    const session = await loadedSession(3, { messages: versionOne() })
    api.chats.switchBranch.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Message not found.' }))
    api.chats.get.mockResolvedValueOnce(chatDetail({ id: chatId(3), messages: versionTwo() }))
    await expect(session.switchBranch('msg_gone000000000001')).rejects.toMatchObject({ code: 'not_found' })
    await until(() => session.chat.messages.value.at(-1)?.id === A2B, 'reload')
  })

  it('refreshes the versions once its own edit finished: same path, message objects kept', async () => {
    const session = await loadedSession(3, { messages: versionOne().slice(0, 2) })
    server.reply(textReply('a1, second version', 'msg_asst00000000001b'))
    await session.edit(U1, 'q1, edited')
    const edited = chatBodies()[0]!.message.id
    const before = session.chat.messages.value

    api.chats.get.mockResolvedValueOnce(chatDetail({
      id: chatId(3),
      messages: fromServer(before),
      branches: { [edited]: messageBranch([U1, edited], 1) },
    }))
    dispatchServerEvent({ type: 'run.finished', data: { chatId: chatId(3), messageId: 'msg_asst00000000001b', outcome: 'completed', awaitingApproval: false }, at: 1 })
    await until(() => session.branches.value[edited] !== undefined, 'versions')
    expect(session.branches.value[edited]).toEqual({ siblings: [U1, edited], index: 1 })
    expect(session.chat.messages.value).toBe(before)
  })

  it('refreshBranches applies another path whole, keeping the shared prefix', async () => {
    const session = await loadedSession(3, { messages: versionOne() })
    const before = session.chat.messages.value
    api.chats.get.mockResolvedValueOnce(chatDetail({ id: chatId(3), messages: fromServer(versionTwo()), branches: { [U2B]: messageBranch([U2, U2B], 1) } }))
    await session.refreshBranches()
    const after = session.chat.messages.value
    expect(after.map(message => message.id)).toEqual([U1, A1, U2B, A2B])
    expect(after[1]).toBe(before[1])
    expect(session.branches.value[U2B]).toEqual({ siblings: [U2, U2B], index: 1 })
  })
})

describe('useChatSession: attachments on edit', () => {
  const U1 = 'msg_user000000000001'
  const A1 = 'msg_asst000000000001'
  const kept = { type: 'file' as const, mediaType: 'image/png', filename: 'a.png', url: '/api/files/file_a000000000000001' }
  const added = { type: 'file' as const, mediaType: 'text/plain', filename: 'b.txt', url: '/api/files/file_b000000000000001' }

  async function withAttachment() {
    return loadedSession(8, {
      messages: [{ id: U1, role: 'user', parts: [kept, { type: 'text', text: 'look' }] }, assistantMessage(A1, 'a picture')],
    })
  }

  it('sends exactly the editor\'s files: removed ones are gone, new ones are added', async () => {
    const session = await withAttachment()
    server.reply(textReply('another look'))
    await session.edit(U1, 'look again', [added])
    expect(chatBodies()[0]!.message.parts).toEqual([added, { type: 'text', text: 'look again' }])
  })

  it('keeps the edited message\'s files when none are given (the ↑ flow)', async () => {
    const session = await withAttachment()
    server.reply(textReply('same picture'))
    await session.edit(U1, 'look again')
    expect(chatBodies()[0]!.message.parts).toEqual([kept, { type: 'text', text: 'look again' }])
  })

  it('removes every file with an empty set, and sends a message of files only', async () => {
    const session = await withAttachment()
    server.reply(textReply('no picture'))
    await session.edit(U1, 'no picture now', [])
    expect(chatBodies()[0]!.message.parts).toEqual([{ type: 'text', text: 'no picture now' }])

    const again = await loadedSession(9, {
      messages: [{ id: U1, role: 'user', parts: [kept, { type: 'text', text: 'look' }] }, assistantMessage(A1, 'a picture')],
    })
    server.reply(textReply('files only'))
    await again.edit(U1, '  ', [added])
    expect(chatBodies()[1]!.message.parts).toEqual([added])
  })

  it('sends nothing without text and files', async () => {
    const session = await withAttachment()
    await session.edit(U1, ' ', [])
    expect(chatBodies()).toHaveLength(0)
    expect(session.chat.messages.value.map(message => message.id)).toEqual([U1, A1])
  })
})

describe('useChatSession: deleting a version', () => {
  const U1 = 'msg_user000000000001'
  const A1 = 'msg_asst000000000001'
  const U2 = 'msg_user000000000002'
  const A2 = 'msg_asst000000000002'
  const U2B = 'msg_user00000000002b'
  const A2B = 'msg_asst00000000002b'

  function versionOne(): HarnessUIMessage[] {
    return [userMessage(U1, 'q1'), assistantMessage(A1, 'a1'), userMessage(U2, 'q2'), assistantMessage(A2, 'a2')]
  }

  function versionTwo(): HarnessUIMessage[] {
    return [userMessage(U1, 'q1'), assistantMessage(A1, 'a1'), userMessage(U2B, 'q2, edited'), assistantMessage(A2B, 'a2b')]
  }

  function shownVersionTwo() {
    return loadedSession(10, { messages: versionTwo(), branches: { [U2B]: messageBranch([U2, U2B], 1) } })
  }

  it('deletes the shown version and shows the returned path, keeping the shared prefix objects', async () => {
    const session = await shownVersionTwo()
    const before = session.chat.messages.value
    let answer!: (detail: ChatDetail) => void
    api.chats.deleteMessage.mockImplementationOnce(() => new Promise((resolve) => {
      answer = resolve
    }))
    const deleting = session.deleteVersion(U2B)
    expect(session.switching.value).toBe(true)
    expect(api.chats.deleteMessage).toHaveBeenCalledWith({ params: { id: chatId(10), messageId: U2B } })
    answer(chatDetail({ id: chatId(10), messages: fromServer(versionOne()), branches: {} }))
    await deleting

    const after = session.chat.messages.value
    expect(after.map(message => message.id)).toEqual([U1, A1, U2, A2])
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
    expect(session.branches.value).toEqual({})
    expect(session.switching.value).toBe(false)
  })

  it('a send waits for the deletion in flight and continues the path it shows', async () => {
    const session = await shownVersionTwo()
    let answer!: (detail: ChatDetail) => void
    api.chats.deleteMessage.mockImplementationOnce(() => new Promise((resolve) => {
      answer = resolve
    }))
    const deleting = session.deleteVersion(U2B)
    server.reply(textReply('on version one'))
    const sending = session.send({ text: 'q3', files: [] })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(chatBodies()).toHaveLength(0)
    answer(chatDetail({ id: chatId(10), messages: fromServer(versionOne()), branches: {} }))
    await deleting
    await sending
    expect(chatBodies()[0]!.parentId).toBe(A2)
  })

  it('a deletion refused because a run holds the chat (409 run-active) shows the run\'s path and follows it', async () => {
    const session = await shownVersionTwo()
    api.chats.deleteMessage.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'A run is active.', details: { reason: 'run-active', chatId: chatId(10) } }))
    api.chats.get
      .mockResolvedValueOnce(chatDetail({ id: chatId(10), running: true, messages: versionTwo().slice(0, 3), branches: { [U2B]: messageBranch([U2, U2B], 1) } }))
      .mockResolvedValueOnce(chatDetail({ id: chatId(10), messages: versionTwo(), branches: { [U2B]: messageBranch([U2, U2B], 1) } }))
    server.resume(textReply('a2b', A2B))

    await expect(session.deleteVersion(U2B)).rejects.toMatchObject({ code: 'conflict' })
    expect(session.switching.value).toBe(false)
    await until(() => server.calls.some(call => call.url === `/api/chat/${chatId(10)}/stream`), 'resume')
    await until(() => session.chat.status.value === 'ready' && api.chats.get.mock.calls.length === 3, 'reload after the replay')
    expect(session.chat.messages.value.map(message => message.id)).toEqual([U1, A1, U2B, A2B])
  })

  it('a deletion of a message the server does not know (404) reloads the chat', async () => {
    const session = await shownVersionTwo()
    api.chats.deleteMessage.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Message not found.' }))
    api.chats.get.mockResolvedValueOnce(chatDetail({ id: chatId(10), messages: versionOne() }))
    await expect(session.deleteVersion(U2B)).rejects.toMatchObject({ code: 'not_found' })
    await until(() => session.chat.messages.value.at(-1)?.id === A2, 'reload')
  })

  it('the only version (409 only-version) is refused without reloading', async () => {
    const session = await shownVersionTwo()
    api.chats.deleteMessage.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'The message has no other version.', details: { reason: 'only-version' } }))
    await expect(session.deleteVersion(U2B)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'only-version' } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(api.chats.get).toHaveBeenCalledTimes(1)
    expect(useChatsStore().runState[chatId(10)]).toBeUndefined()
    expect(session.chat.messages.value.map(message => message.id)).toEqual([U1, A1, U2B, A2B])
  })

  it('does nothing while a request is in flight', async () => {
    const session = await shownVersionTwo()
    const gate = deferred()
    server.reply(textReply('busy', ASSISTANT_ID, gate.promise))
    const sending = session.send({ text: 'q3', files: [] })
    await until(() => session.chat.status.value === 'streaming', 'streaming')
    await session.deleteVersion(U2B)
    expect(api.chats.deleteMessage).not.toHaveBeenCalled()
    gate.resolve()
    await sending
  })
})

describe('useChatSession: other tabs', () => {
  const U1 = 'msg_user000000000001'
  const A1 = 'msg_asst000000000001'
  const U2 = 'msg_user000000000002'
  const A2 = 'msg_asst000000000002'
  const U2B = 'msg_user00000000002b'
  const A2B = 'msg_asst00000000002b'
  const A2C = 'msg_asst00000000002c'

  function versionOne(): HarnessUIMessage[] {
    return [userMessage(U1, 'q1'), assistantMessage(A1, 'a1'), userMessage(U2, 'q2'), assistantMessage(A2, 'a2')]
  }

  function versionTwo(last = A2B): HarnessUIMessage[] {
    return [userMessage(U1, 'q1'), assistantMessage(A1, 'a1'), userMessage(U2B, 'q2, edited'), assistantMessage(last, 'a2b')]
  }

  /** `chat.updated` of chat `n` as the server sends it: the summary plus the active leaf. */
  function chatUpdated(n: number, activeLeafId: string | null, title = 'Chat') {
    dispatchServerEvent({ type: 'chat.updated', data: { ...chatSummary({ id: chatId(n), title }), activeLeafId }, at: 1 })
  }

  const settle = () => new Promise(resolve => setTimeout(resolve, 20))

  it('follows a version switch made in another tab: the path reloads, the shared prefix objects are kept', async () => {
    const session = await loadedSession(11, { messages: versionOne(), branches: { [U2]: messageBranch([U2, U2B], 0) } })
    const before = session.chat.messages.value
    api.chats.get.mockResolvedValueOnce(chatDetail({ id: chatId(11), messages: fromServer(versionTwo()), branches: { [U2B]: messageBranch([U2, U2B], 1) } }))
    chatUpdated(11, A2B, 'Renamed elsewhere')
    // The summary never keeps the leaf.
    expect(session.summary.value).toMatchObject({ id: chatId(11), title: 'Renamed elsewhere' })
    expect(session.summary.value).not.toHaveProperty('activeLeafId')

    await until(() => session.chat.messages.value.at(-1)?.id === A2B, 'follow')
    expect(api.chats.get).toHaveBeenCalledTimes(2)
    const after = session.chat.messages.value
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
    expect(session.branches.value).toEqual({ [U2B]: { siblings: [U2, U2B], index: 1 } })
  })

  it('does not reload for the leaf it already shows (a title change, its own run)', async () => {
    const session = await loadedSession(11, { messages: versionOne() })
    chatUpdated(11, A2, 'New title')
    await settle()
    expect(api.chats.get).toHaveBeenCalledTimes(1)
    expect(session.summary.value?.title).toBe('New title')
  })

  it('does not reload while a request is in flight', async () => {
    const session = await loadedSession(11, { messages: versionOne() })
    const gate = deferred()
    server.reply(textReply('busy', ASSISTANT_ID, gate.promise))
    const sending = session.send({ text: 'q3', files: [] })
    await until(() => session.chat.status.value === 'streaming', 'streaming')
    // Its own user message was stored meanwhile.
    chatUpdated(11, chatBodies()[0]!.message.id)
    chatUpdated(11, A2B)
    await settle()
    gate.resolve()
    await sending
    // The reply of its own run ends the path.
    chatUpdated(11, ASSISTANT_ID)
    await settle()
    expect(api.chats.get).toHaveBeenCalledTimes(1)
  })

  it('does not reload for its own switch, whether the event comes before or after the answer', async () => {
    const session = await loadedSession(11, { messages: versionOne(), branches: { [U2]: messageBranch([U2, U2B], 0) } })
    let answer!: (detail: ChatDetail) => void
    api.chats.switchBranch.mockImplementationOnce(() => new Promise((resolve) => {
      answer = resolve
    }))
    const switching = session.switchBranch(U2B)
    chatUpdated(11, A2B)
    answer(chatDetail({ id: chatId(11), messages: fromServer(versionTwo()), branches: { [U2B]: messageBranch([U2, U2B], 1) } }))
    await switching
    // Idle again when the event of its own switch arrives late.
    await settle()
    chatUpdated(11, A2B)
    await settle()
    expect(api.chats.get).toHaveBeenCalledTimes(1)
    expect(session.chat.messages.value.at(-1)?.id).toBe(A2B)
  })

  it('ignores a trailing message the server never stored', async () => {
    const session = await loadedSession(11, { messages: versionOne() })
    server.fail(400, { code: 'provider_not_configured', message: 'No key.', providerId: 'anthropic' })
    await session.send({ text: 'refused', files: [] })
    expect(session.chat.messages.value).toHaveLength(5)
    chatUpdated(11, A2)
    await settle()
    expect(api.chats.get).toHaveBeenCalledTimes(1)
    expect(session.chat.messages.value).toHaveLength(5)

    // A leaf that really moved is still followed.
    api.chats.get.mockResolvedValueOnce(chatDetail({ id: chatId(11), messages: versionTwo() }))
    chatUpdated(11, A2B)
    await until(() => session.chat.messages.value.at(-1)?.id === A2B, 'follow')
  })

  it('coalesces a burst into one reload, and reloads once more for a leaf announced meanwhile', async () => {
    const session = await loadedSession(11, { messages: versionOne() })
    let answer!: (detail: ChatDetail) => void
    api.chats.get.mockImplementationOnce(() => new Promise((resolve) => {
      answer = resolve
    }))
    chatUpdated(11, A2B)
    chatUpdated(11, A2C)
    expect(api.chats.get).toHaveBeenCalledTimes(2)
    // The reload already shows the newest leaf: no second request.
    answer(chatDetail({ id: chatId(11), messages: versionTwo(A2C) }))
    await until(() => session.chat.messages.value.at(-1)?.id === A2C, 'follow')
    await settle()
    expect(api.chats.get).toHaveBeenCalledTimes(2)

    // The reload answered before the second switch: one more reload shows it.
    api.chats.get.mockImplementationOnce(() => new Promise((resolve) => {
      answer = resolve
    }))
    api.chats.get.mockResolvedValueOnce(chatDetail({ id: chatId(11), messages: versionOne() }))
    chatUpdated(11, 'msg_asst00000000002d')
    chatUpdated(11, A2)
    answer(chatDetail({ id: chatId(11), messages: versionTwo('msg_asst00000000002d') }))
    await until(() => session.chat.messages.value.at(-1)?.id === A2, 'second follow')
    expect(api.chats.get).toHaveBeenCalledTimes(4)
  })

  it('reloads once for a stored leaf its path cannot end at (null or dangling), not for every event repeating it', async () => {
    const session = await loadedSession(11, { messages: versionOne() })
    // The server shows its newest path for a leaf it cannot find.
    api.chats.get.mockResolvedValue(chatDetail({ id: chatId(11), messages: versionOne() }))
    chatUpdated(11, 'msg_gone000000000001')
    await settle()
    expect(api.chats.get).toHaveBeenCalledTimes(2)
    chatUpdated(11, 'msg_gone000000000001', 'Renamed')
    chatUpdated(11, 'msg_gone000000000001', 'Pinned')
    await settle()
    expect(api.chats.get).toHaveBeenCalledTimes(2)
    expect(session.summary.value?.title).toBe('Pinned')

    chatUpdated(11, null)
    await settle()
    expect(api.chats.get).toHaveBeenCalledTimes(3)
    chatUpdated(11, null)
    await settle()
    expect(api.chats.get).toHaveBeenCalledTimes(3)

    // A leaf that really moved is followed again, and so is the dangling one after it.
    api.chats.get.mockResolvedValue(chatDetail({ id: chatId(11), messages: versionTwo() }))
    chatUpdated(11, A2B)
    await until(() => session.chat.messages.value.at(-1)?.id === A2B, 'follow')
    chatUpdated(11, 'msg_gone000000000001')
    await until(() => api.chats.get.mock.calls.length === 5, 'dangling again')
    await settle()
    expect(api.chats.get).toHaveBeenCalledTimes(5)
  })

  it('followActiveLeaf() reloads the path on demand, but not while a switch is pending', async () => {
    const session = await loadedSession(11, { messages: versionOne() })
    api.chats.get.mockResolvedValueOnce(chatDetail({ id: chatId(11), messages: versionTwo() }))
    await session.followActiveLeaf()
    expect(session.chat.messages.value.at(-1)?.id).toBe(A2B)

    let answer!: (detail: ChatDetail) => void
    api.chats.switchBranch.mockImplementationOnce(() => new Promise((resolve) => {
      answer = resolve
    }))
    const switching = session.switchBranch(U2)
    await session.followActiveLeaf()
    expect(api.chats.get).toHaveBeenCalledTimes(2)
    answer(chatDetail({ id: chatId(11), messages: versionOne() }))
    await switching
  })
})

describe('useChatSession: image options', () => {
  const IMAGE_MODEL = 'mock:image'
  const IMAGE_CHAT_MODEL = 'mock:image-chat'
  const capabilities = { tools: false, vision: true, pdf: false, reasoning: false, structuredOutput: false, imageOutput: false }

  beforeEach(() => {
    useModelsStore().items = [
      catalogModel({ providerId: 'mock', id: 'image', kind: 'image', capabilities }),
      catalogModel({ providerId: 'mock', id: 'image-chat', kind: 'chat', capabilities: { ...capabilities, imageOutput: true } }),
      catalogModel({ providerId: 'mock', id: 'echo', kind: 'chat', capabilities }),
    ]
    useImageOptions().set({ n: 2, aspectRatio: '16:9', editPrevious: false })
  })

  async function bodyFor(modelRef: string): Promise<ChatRequestBody> {
    const session = useChatSession(chatId(12), { isNew: true })
    session.modelRef.value = modelRef
    server.reply(textReply('done'))
    await session.send({ text: 'a red fox', files: [] })
    return chatBodies().at(-1)!
  }

  it('an image model sends the number of images, the aspect ratio and editPrevious', async () => {
    expect((await bodyFor(IMAGE_MODEL)).imageOptions).toEqual({ n: 2, aspectRatio: '16:9', editPrevious: false })
  })

  it('a chat model with image output sends the aspect ratio only', async () => {
    expect((await bodyFor(IMAGE_CHAT_MODEL)).imageOptions).toEqual({ aspectRatio: '16:9' })
  })

  it('other models (and unknown ones) send no image options', async () => {
    expect(await bodyFor(MODEL)).not.toHaveProperty('imageOptions')
    resetChatSessions()
    expect(await bodyFor('mock:unknown')).not.toHaveProperty('imageOptions')
  })

  it('a regenerate with an image model sends them too; Auto sends no aspect ratio', async () => {
    useImageOptions().set({ aspectRatio: undefined })
    const session = await loadedSession(13, { messages: [userMessage('msg_user000000000001', 'a red fox'), assistantMessage(ASSISTANT_ID, '')] })
    session.modelRef.value = IMAGE_MODEL
    server.reply(textReply('again'))
    await session.regenerate(ASSISTANT_ID)
    expect(chatBodies()[0]).toMatchObject({ trigger: 'regenerate-message', imageOptions: { n: 2, editPrevious: false } })
    expect(chatBodies()[0]!.imageOptions).not.toHaveProperty('aspectRatio')
  })
})

describe('useChatSession: data parts', () => {
  it('registers every data-part schema under its chunk type as well (AI SDK 7 looks up `data-<name>`)', () => {
    expect(Object.keys(chatDataPartSchemas).sort()).toEqual(['activity', 'compaction', 'data-activity', 'data-compaction', 'data-notice', 'data-steer', 'notice', 'steer'])
    expect(chatDataPartSchemas['data-notice' as 'notice']).toBe(chatDataPartSchemas.notice)
  })

  it('streams valid notices into the reply', async () => {
    const session = newSession()
    const notice = { level: 'warning', code: 'attachments-unsupported', message: 'This model cannot read the attached file, so it was not sent.' }
    server.reply((write) => {
      write({ type: 'start', messageId: ASSISTANT_ID, messageMetadata: { modelRef: MODEL, startedAt: 1 } })
      write({ type: 'data-notice', data: notice } as UIMessageChunk)
      write({ type: 'finish', finishReason: 'stop' })
    })
    await session.send({ text: 'look', files: [] })
    expect(session.chat.messages.value[1]!.parts).toContainEqual({ type: 'data-notice', data: notice })
    expect(session.chat.status.value).toBe('ready')
  })

  it('rejects a malformed notice instead of rendering it', async () => {
    const session = newSession()
    server.reply((write) => {
      write({ type: 'start', messageId: ASSISTANT_ID, messageMetadata: { modelRef: MODEL, startedAt: 1 } })
      write({ type: 'data-notice', data: { level: 'fatal', code: 'nope', message: 42 } } as UIMessageChunk)
      write({ type: 'finish', finishReason: 'stop' })
    })
    await session.send({ text: 'look', files: [] })
    expect(session.chat.status.value).toBe('error')
    const parts = session.chat.messages.value.flatMap(message => message.parts)
    expect(parts.some(part => part.type === 'data-notice')).toBe(false)
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

  it('"Accept all edits in this chat" switches the mode to edits (saved on the chat) before the approval goes out', async () => {
    const session = newSession()
    session.toolMode.value = 'ask'
    server.reply(approvalReply(ASSISTANT_ID, 'edit_file'))
    await session.send({ text: 'fix the parser', files: [] })
    expect(session.runState.value).toBe('approval')

    server.reply(textReply('edited', ASSISTANT_ID))
    await session.approve({ id: 'appr_1', approved: true, toolName: 'edit_file', alwaysAllow: false, acceptEdits: true })
    await until(() => server.calls.length === 2 && session.runState.value === 'idle', 'continuation')

    expect(session.toolMode.value).toBe('edits')
    // The continuation already runs in edits mode, and the choice was saved first.
    expect(chatBodies()[1]).toMatchObject({ toolMode: 'edits', message: { role: 'assistant' } })
    expect(api.chats.update).toHaveBeenCalledWith({ params: { id: chatId(1) }, body: { settings: { toolMode: 'edits' } } })
    const saved = api.chats.update.mock.invocationCallOrder[0]!
    const continued = (mock.fetch as Mock).mock.invocationCallOrder[1]!
    expect(saved).toBeLessThan(continued)
    // No tool override: accepting edits is a chat setting, not "Always allow".
    expect(api.tools.update).not.toHaveBeenCalled()
  })

  it('a denial with "Accept all edits" checked keeps the mode', async () => {
    const session = newSession()
    session.toolMode.value = 'ask'
    server.reply(approvalReply(ASSISTANT_ID, 'edit_file'))
    await session.send({ text: 'fix the parser', files: [] })
    server.reply(textReply('ok, not edited', ASSISTANT_ID))
    await session.approve({ id: 'appr_1', approved: false, toolName: 'edit_file', alwaysAllow: false, acceptEdits: true })
    await until(() => server.calls.length === 2, 'continuation')
    expect(session.toolMode.value).toBe('ask')
    expect(chatBodies()[1]!.toolMode).toBe('ask')
    expect(api.chats.update).not.toHaveBeenCalled()
  })
})

describe('useChatSession: workspace 2.0 additions (Phase 8)', () => {
  const P1 = projectId(1)

  function shellPart(endCwd: string | undefined, toolCallId = 'call_sh') {
    return {
      type: 'tool-shell',
      toolCallId,
      state: 'output-available',
      input: { command: 'cd sub' },
      output: { command: 'cd sub', cwd: '.', exitCode: 0, signal: null, timedOut: false, durationMs: 1, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, ...(endCwd === undefined ? {} : { endCwd }) },
    }
  }

  function shellReply(endCwd: string): HarnessUIMessage {
    return { id: 'msg_assistant0000009', role: 'assistant', metadata: { modelRef: MODEL, startedAt: 1 }, parts: [shellPart(endCwd)] } as HarnessUIMessage
  }

  /** A new chat in project 1 whose first reply waits for the approval of a shell call. */
  async function shellApproval() {
    useProjectsStore().items = [projectSummary({ id: P1, name: 'Website' })]
    const session = newSession()
    await session.setProject(P1)
    server.reply(approvalReply(ASSISTANT_ID, 'shell'))
    await session.send({ text: 'run the tests', files: [] })
    expect(session.runState.value).toBe('approval')
    return session
  }

  function spyCreate(implementation?: (input: { projectId: string | null, prefix: string }) => Promise<ShellRule>) {
    return vi.spyOn(useShellRulesStore(), 'create').mockImplementation(implementation
      ?? (async input => shellRule({ projectId: input.projectId, prefix: input.prefix })))
  }

  it('cwd: the project folder (null) without a shell call, else where the last one on the shown path ended', async () => {
    expect(newSession().cwd.value).toBeNull()
    const session = await loadedSession(2, {
      messages: [userMessage('msg_user000000000001', 'go'), shellReply('packages/web')],
    })
    expect(session.cwd.value).toBe('packages/web')
    // Another version of the reply (a switch shows another path): its own folder.
    session.chat.messages.value = [userMessage('msg_user000000000001', 'go'), shellReply('src')]
    expect(session.cwd.value).toBe('src')
    // A later output without endCwd (not reported, or saved before v1.4) leaves the folder as it was.
    const unreported = { ...shellReply('x'), id: 'msg_assistant0000010', parts: [shellPart(undefined)] } as HarnessUIMessage
    session.chat.messages.value = [userMessage('msg_user000000000001', 'go'), shellReply('src'), userMessage('msg_user000000000002', 'again'), unreported]
    expect(session.cwd.value).toBe('src')
    // Only such outputs: the project folder.
    session.chat.messages.value = [userMessage('msg_user000000000001', 'go'), unreported]
    expect(session.cwd.value).toBeNull()
  })

  it('approve(): saves each rule of allowRules before the approval goes out', async () => {
    const session = await shellApproval()
    const gate = deferred()
    const create = spyCreate(async (input) => {
      await gate.promise
      return shellRule({ projectId: input.projectId, prefix: input.prefix })
    })
    server.reply(textReply('ran', ASSISTANT_ID))
    const approving = session.approve({ id: 'appr_1', approved: true, toolName: 'shell', alwaysAllow: false, allowRules: { prefixes: ['pnpm test', 'git status'], scope: 'project' } })
    await until(() => create.mock.calls.length === 1, 'first rule')
    await new Promise(resolve => setTimeout(resolve, 20))
    // Nothing is answered while a rule is being saved.
    expect(server.calls).toHaveLength(1)
    gate.resolve()
    await approving
    await until(() => server.calls.length === 2 && session.runState.value === 'idle', 'continuation')
    expect(create.mock.calls.map(([input]) => input)).toEqual([
      { projectId: P1, prefix: 'pnpm test' },
      { projectId: P1, prefix: 'git status' },
    ])
    const continued = (mock.fetch as Mock).mock.invocationCallOrder[1]!
    expect(Math.max(...create.mock.invocationCallOrder)).toBeLessThan(continued)
    // The approval itself is unchanged, and no tool override is written for the shell.
    expect(chatBodies()[1]!.message.parts.find(part => part.type === 'tool-shell')).toMatchObject({ state: 'approval-responded', approval: { id: 'appr_1', approved: true } })
    expect(api.tools.update).not.toHaveBeenCalled()
  })

  it('approve(): All projects saves global rules; an existing rule (409 exists) counts as saved', async () => {
    const session = await shellApproval()
    const create = spyCreate(async (input) => {
      if (input.prefix === 'ls')
        throw new HarnessError({ code: 'conflict', message: 'This rule already exists.', details: { reason: 'exists' } })
      return shellRule({ projectId: input.projectId, prefix: input.prefix })
    })
    server.reply(textReply('ran', ASSISTANT_ID))
    await session.approve({ id: 'appr_1', approved: true, toolName: 'shell', alwaysAllow: false, allowRules: { prefixes: ['ls', 'pnpm test'], scope: 'global' } })
    await until(() => server.calls.length === 2, 'continuation')
    expect(create.mock.calls.map(([input]) => input)).toEqual([{ projectId: null, prefix: 'ls' }, { projectId: null, prefix: 'pnpm test' }])
  })

  it('approve(): a rule that could not be saved still sends the approval, then rethrows (the other rules are tried)', async () => {
    const session = await shellApproval()
    const create = spyCreate(async (input) => {
      if (input.prefix === 'pnpm test')
        throw new HarnessError({ code: 'validation_error', message: 'This project already has 200 rules.' })
      return shellRule({ projectId: input.projectId, prefix: input.prefix })
    })
    server.reply(textReply('ran', ASSISTANT_ID))
    const failure = await session.approve({ id: 'appr_1', approved: true, toolName: 'shell', alwaysAllow: false, allowRules: { prefixes: ['pnpm test', 'git status'], scope: 'project' } })
      .then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(HarnessError)
    expect(failure).toMatchObject({ code: 'validation_error', message: 'This project already has 200 rules.' })
    expect(create).toHaveBeenCalledTimes(2)
    await until(() => server.calls.length === 2, 'continuation')
    expect(chatBodies()[1]!.message.parts.find(part => part.type === 'tool-shell')).toMatchObject({ approval: { approved: true } })
  })

  it('approve(): "This project" in a chat without a project saves nothing, answers, then reports it', async () => {
    const session = newSession()
    server.reply(approvalReply(ASSISTANT_ID, 'shell'))
    await session.send({ text: 'run the tests', files: [] })
    const create = spyCreate()
    server.reply(textReply('ran', ASSISTANT_ID))
    await expect(session.approve({ id: 'appr_1', approved: true, toolName: 'shell', alwaysAllow: false, allowRules: { prefixes: ['pnpm test'], scope: 'project' } }))
      .rejects
      .toMatchObject({ code: 'validation_error' })
    expect(create).not.toHaveBeenCalled()
    await until(() => server.calls.length === 2, 'continuation')
  })

  it('approve(): a denial saves no rule', async () => {
    const session = await shellApproval()
    const create = spyCreate()
    server.reply(textReply('skipped', ASSISTANT_ID))
    await session.approve({ id: 'appr_1', approved: false, toolName: 'shell', alwaysAllow: true, allowRules: { prefixes: ['pnpm test'], scope: 'project' } })
    await until(() => server.calls.length === 2, 'continuation')
    expect(create).not.toHaveBeenCalled()
    expect(api.tools.update).not.toHaveBeenCalled()
  })

  it('approve(): "Always allow" never writes an allow override for the shell (shell rules replace it)', async () => {
    const session = await shellApproval()
    server.reply(textReply('ran', ASSISTANT_ID))
    await session.approve({ id: 'appr_1', approved: true, toolName: 'shell', alwaysAllow: true })
    await until(() => server.calls.length === 2, 'continuation')
    expect(api.tools.update).not.toHaveBeenCalled()
  })
})

describe('useChatSession: project', () => {
  const P1 = projectId(1)
  const P2 = projectId(2)

  beforeEach(() => {
    useProjectsStore().items = [projectSummary({ id: P1, name: 'Website' }), projectSummary({ id: P2, name: 'Notes', path: '/srv/workspaces/notes' })]
  })

  function projectChanged(id: string, project: ReturnType<typeof projectSummary> | null) {
    dispatchServerEvent({ type: 'project.changed', data: { id, project }, at: 1 })
  }

  it('a new chat has no project by default, or the project the list is filtered by when it is known', async () => {
    const chats = useChatsStore()
    const session = newSession()
    expect(session.projectId.value).toBeNull()
    for (const filter of ['all', 'none', 'prj_unknown000000001']) {
      chats.projectFilter = filter
      expect(session.projectId.value, filter).toBeNull()
    }
    chats.projectFilter = P2
    expect(session.projectId.value).toBe(P2)
    // Once the project is gone from the store, the filter no longer names a known project.
    useProjectsStore().items = []
    expect(session.projectId.value).toBeNull()
  })

  it('the pick wins over the filter (No project too), and another filter drops the pick', async () => {
    const chats = useChatsStore()
    chats.projectFilter = P1
    const session = newSession()
    await session.setProject(P2)
    expect(session.projectId.value).toBe(P2)
    await session.setProject(null)
    expect(session.projectId.value).toBeNull()
    // A local choice: nothing is sent until the first message.
    expect(api.chats.update).not.toHaveBeenCalled()
    expect(server.calls).toHaveLength(0)

    chats.projectFilter = P2
    await nextTick()
    expect(session.projectId.value).toBe(P2)
  })

  it('sends the project with the first request only, then shows it until the server describes the chat', async () => {
    const session = newSession()
    await session.setProject(P1)
    server.reply(textReply('first'))
    await session.send({ text: 'hello', files: [] })
    expect(chatBodies()[0]!.projectId).toBe(P1)
    expect(session.persisted.value).toBe(true)
    expect(session.summary.value).toBeNull()
    expect(session.projectId.value).toBe(P1)

    // A later pick changes nothing: the chat exists now.
    server.reply(textReply('second', 'msg_assistant0000002'))
    await session.send({ text: 'again', files: [] })
    expect(chatBodies()[1]).not.toHaveProperty('projectId')
    server.reply(textReply('regenerated', 'msg_assistant0000003'))
    await session.regenerate()
    expect(chatBodies()[2]).not.toHaveProperty('projectId')
  })

  it('sends the project again when the first request was refused before the chat existed', async () => {
    const session = newSession()
    useChatsStore().projectFilter = P2
    server.fail(400, { code: 'provider_not_configured', message: 'No key.', providerId: 'anthropic' })
    await session.send({ text: 'hello', files: [] })
    expect(chatBodies()[0]!.projectId).toBe(P2)
    expect(session.persisted.value).toBe(false)
    server.reply(textReply('hi'))
    await session.regenerate()
    expect(chatBodies()[1]).toMatchObject({ trigger: 'submit-message', projectId: P2 })
  })

  it('a new chat without a project sends no project', async () => {
    const session = newSession()
    useChatsStore().projectFilter = 'none'
    server.reply(textReply('hi'))
    await session.send({ text: 'hello', files: [] })
    expect(chatBodies()[0]).not.toHaveProperty('projectId')
    expect(session.projectId.value).toBeNull()
  })

  it('a saved chat: what the chats store row or the summary reported last; it never sends the project', async () => {
    const chats = useChatsStore()
    const session = await loadedSession(20, { projectId: P1, messages: [userMessage('msg_user000000000001', 'q'), assistantMessage(ASSISTANT_ID, 'a')] })
    expect(session.projectId.value).toBe(P1)
    // The list is filtered elsewhere: the filter does not move a saved chat.
    chats.projectFilter = P2
    expect(session.projectId.value).toBe(P1)

    // A move through the chats store (useMoveChat: the header and sidebar menus) shows at once and rolls back with it.
    let refuse!: (error: unknown) => void
    api.chats.update.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      refuse = reject
    }))
    const moving = chats.update(chatId(20), { projectId: P2 }).catch(() => {})
    expect(session.projectId.value).toBe(P2)
    expect(session.summary.value?.projectId).toBe(P1)
    refuse(new HarnessError({ code: 'conflict', message: 'A run is active.', details: { reason: 'run-active' } }))
    await moving
    expect(session.projectId.value).toBe(P1)

    api.chats.update.mockResolvedValueOnce(chatSummary({ id: chatId(20), projectId: null }))
    await chats.update(chatId(20), { projectId: null })
    expect(session.projectId.value).toBeNull()

    server.reply(textReply('next', 'msg_assistant0000002'))
    await session.send({ text: 'next', files: [] })
    expect(chatBodies()[0]).not.toHaveProperty('projectId')
  })

  it('a saved chat follows chat.updated (a move in another tab)', async () => {
    const session = await loadedSession(21, { projectId: null })
    expect(session.projectId.value).toBeNull()
    dispatchServerEvent({ type: 'chat.updated', data: { ...chatSummary({ id: chatId(21), projectId: P2 }), activeLeafId: null }, at: 1 })
    expect(session.projectId.value).toBe(P2)
  })

  it('setProject moves a saved chat with PATCH and shows the answer', async () => {
    const session = await loadedSession(22, { projectId: null })
    let answer!: (summary: ReturnType<typeof chatSummary>) => void
    api.chats.update.mockImplementationOnce(() => new Promise((resolve) => {
      answer = resolve
    }))
    const moving = session.setProject(P1)
    expect(api.chats.update).toHaveBeenCalledWith({ params: { id: chatId(22) }, body: { projectId: P1 } })
    // Optimistic: the chip moves at once.
    expect(session.projectId.value).toBe(P1)
    answer(chatSummary({ id: chatId(22), projectId: P1, title: 'Moved' }))
    await moving
    expect(session.summary.value).toMatchObject({ projectId: P1, title: 'Moved' })

    api.chats.update.mockResolvedValueOnce(chatSummary({ id: chatId(22), projectId: null }))
    await session.setProject(null)
    expect(api.chats.update).toHaveBeenLastCalledWith({ params: { id: chatId(22) }, body: { projectId: null } })
    expect(session.projectId.value).toBeNull()
  })

  it('setProject throws the HarnessError of a refused move (409 run-active, 404) and rolls back', async () => {
    const session = await loadedSession(23, { projectId: P1 })
    api.chats.update.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'A run is active.', details: { reason: 'run-active', chatId: chatId(23) } }))
    const refused = await session.setProject(P2).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(HarnessError)
    expect(refused).toMatchObject({ code: 'conflict', details: { reason: 'run-active' } })
    expect(session.projectId.value).toBe(P1)

    api.chats.update.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Project not found.' }))
    await expect(session.setProject(P2)).rejects.toMatchObject({ code: 'not_found' })
    expect(session.projectId.value).toBe(P1)
  })

  it('a deleted project leaves the pick, the first request\'s project and the summary', async () => {
    const picked = newSession(24)
    await picked.setProject(P1)
    projectChanged(P1, null)
    expect(picked.projectId.value).toBeNull()

    const saved = await loadedSession(25, { projectId: P2 })
    projectChanged(P1, projectSummary({ id: P1, name: 'Renamed' }))
    expect(saved.projectId.value).toBe(P2)
    projectChanged(P2, null)
    expect(saved.projectId.value).toBeNull()
    expect(saved.summary.value?.projectId).toBeNull()
  })
})

describe('useChatSession: master-key rotation', () => {
  function keyRotated(...ids: string[]) {
    dispatchServerEvent({ type: 'key.rotated', data: { keyVersion: 2, rotatedAt: 1, chatIds: ids }, at: 1 })
  }

  it('a listed chat reloads its path (the pending approval expired); other chats do not', async () => {
    const pending: HarnessUIMessage = {
      id: ASSISTANT_ID,
      role: 'assistant',
      metadata: { modelRef: MODEL, startedAt: 1 },
      parts: [{ type: 'tool-mock_approval_tool', toolCallId: 'call_1', state: 'approval-requested', input: { value: 'x' }, approval: { id: 'appr_1' } }],
    }
    const session = await loadedSession(30, { messages: [userMessage('msg_user000000000001', 'q'), pending] })
    const other = await loadedSession(31, { messages: [userMessage('msg_user000000000002', 'q')] })
    expect(session.runState.value).toBe('approval')
    expect(api.chats.get).toHaveBeenCalledTimes(2)

    const denied: HarnessUIMessage = {
      ...pending,
      parts: [{ type: 'tool-mock_approval_tool', toolCallId: 'call_1', state: 'output-denied', input: { value: 'x' }, approval: { id: 'appr_1', approved: false, reason: 'Expired after a key rotation.' } }],
    }
    api.chats.get.mockResolvedValueOnce(chatDetail({ id: chatId(30), modelRef: MODEL, messages: [userMessage('msg_user000000000001', 'q'), denied] }))
    keyRotated(chatId(30), chatId(99))
    await until(() => session.runState.value === 'idle', 'reload')
    expect(api.chats.get).toHaveBeenCalledTimes(3)
    expect(api.chats.get).toHaveBeenLastCalledWith({ params: { id: chatId(30) } })
    expect(other.chat.messages.value).toHaveLength(1)
  })

  it('a chat streaming when the rotation stopped its run reloads once the request ended', async () => {
    const session = newSession(32)
    const gate = deferred()
    server.reply(textReply('cut short', ASSISTANT_ID, gate.promise))
    const sending = session.send({ text: 'long answer', files: [] })
    await until(() => session.chat.status.value === 'streaming', 'streaming')
    api.chats.get.mockResolvedValueOnce(chatDetail({ id: chatId(32), modelRef: MODEL, messages: [userMessage('msg_user000000000001', 'long answer')] }))
    keyRotated(chatId(32))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(api.chats.get).not.toHaveBeenCalled()
    gate.resolve()
    await sending
    await until(() => api.chats.get.mock.calls.length === 1, 'reload after the request')
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

// ---------- Agent 2.0 (Phase 9, W9.9) ----------

const README_FILE: FileRef = { id: 'file_readme000000000', name: 'README.md', mime: 'text/markdown', size: 12, url: '/api/files/file_readme000000000' }

/** `POST /chat/:id/queue` answers with the stored item, like the server (W9.2). */
function acceptQueue() {
  api.chatQueue.add.mockImplementation(async ({ body }: { body: QueueAddBody }): Promise<QueueItem> => ({
    id: body.message.id,
    message: body.message,
    modelRef: body.modelRef,
    reasoningEffort: body.reasoningEffort,
    toolMode: body.toolMode,
    createdAt: 1,
    turnOnly: false,
  }))
}

function conflict(reason: string): HarnessError {
  return new HarnessError({ code: 'conflict', message: 'Conflict.', details: { reason } })
}

/** A session streaming a reply that waits for `gate` before it finishes. */
async function streamingSession(n = 1) {
  const session = newSession(n)
  const gate = deferred()
  server.reply(textReply('working on it', ASSISTANT_ID, gate.promise))
  const sending = session.submit({ text: 'Fix the parser', files: [] })
  await until(() => session.chat.status.value === 'streaming', 'streaming')
  return { session, gate, sending }
}

/** A writer that waits for `gate` before anything is written (the request is in flight meanwhile). */
function afterGate(gate: Promise<void>, writer: StreamWriter): StreamWriter {
  return async (write) => {
    await gate
    await writer(write)
  }
}

/** A reply whose `exit_plan_mode` call waits for the plan decision (ADR-041). */
function planReply(messageId = ASSISTANT_ID): StreamWriter {
  return (write) => {
    write({ type: 'start', messageId, messageMetadata: { modelRef: MODEL, startedAt: 1 } })
    write({ type: 'start-step' })
    write({ type: 'tool-input-available', toolCallId: 'call_plan', toolName: 'exit_plan_mode', input: { plan: '# Plan\n1. Write notes.txt' } })
    write({ type: 'tool-approval-request', approvalId: 'appr_plan', toolCallId: 'call_plan' })
    write({ type: 'finish-step' })
    write({ type: 'finish', finishReason: 'tool-calls' })
  }
}

const ids = (messages: readonly HarnessUIMessage[]) => messages.map(message => message.id)

describe('useChatSession: submit and the queue (Phase 9)', () => {
  it('sends while idle', async () => {
    const session = newSession()
    expect(session.queue.value).toEqual([])
    server.reply(textReply('Hello back'))
    expect(await session.submit({ text: 'Hello', files: [] })).toBe('sent')
    expect(chatBodies()).toHaveLength(1)
    expect(api.chatQueue.add).not.toHaveBeenCalled()
    expect(session.chat.messages.value.map(message => message.role)).toEqual(['user', 'assistant'])
  })

  it('queues while its own request streams: a client message id, the text and files, the composer state', async () => {
    const { session, gate, sending } = await streamingSession()
    acceptQueue()
    session.reasoningEffort.value = 'high'
    expect(await session.submit({ text: 'Also update the README', files: [README_FILE] })).toBe('queued')

    expect(api.chatQueue.add).toHaveBeenCalledOnce()
    const [{ params, body }] = api.chatQueue.add.mock.calls[0]! as [{ params: { id: string }, body: QueueAddBody }]
    expect(params).toEqual({ id: chatId(1) })
    expect(body.message.id).toMatch(/^msg_/)
    expect(body).toEqual({
      message: {
        id: body.message.id,
        role: 'user',
        parts: [
          { type: 'text', text: 'Also update the README' },
          { type: 'file', mediaType: 'text/markdown', filename: 'README.md', url: '/api/files/file_readme000000000' },
        ],
      },
      modelRef: MODEL,
      reasoningEffort: 'high',
      toolMode: session.toolMode.value,
    })
    // Never a second chat request during the run, and the message stays out of the transcript.
    expect(chatBodies()).toHaveLength(1)
    expect(session.chat.messages.value.map(message => message.id)).not.toContain(body.message.id)
    expect(session.queue.value.map(item => item.id)).toEqual([body.message.id])
    gate.resolve()
    expect(await sending).toBe('sent')
  })

  it('queues a files-only message, and sends nothing for an empty one', async () => {
    const { session, gate } = await streamingSession()
    acceptQueue()
    expect(await session.submit({ text: '  ', files: [README_FILE] })).toBe('queued')
    expect((api.chatQueue.add.mock.calls[0]![0] as { body: QueueAddBody }).body.message.parts.map(part => part.type)).toEqual(['file'])
    await session.submit({ text: ' ', files: [] })
    expect(api.chatQueue.add).toHaveBeenCalledOnce()
    gate.resolve()
  })

  it('queues while the chats store reports a run of another tab', async () => {
    api.chatQueue.list.mockResolvedValue({ items: [] })
    const session = await loadedSession(2, { messages: [userMessage('msg_user000000000001', 'q'), assistantMessage(ASSISTANT_ID, 'a')] })
    useChatsStore().setRunState(chatId(2), 'running')
    acceptQueue()
    expect(await session.submit({ text: 'And the docs', files: [] })).toBe('queued')
    expect(api.chatQueue.add).toHaveBeenCalledWith(expect.objectContaining({ params: { id: chatId(2) } }))
    expect(server.calls.filter(call => call.url === '/api/chat')).toHaveLength(0)
  })

  it('fetches the chat\'s queue when the chat loads', async () => {
    api.chatQueue.list.mockResolvedValue({ items: [queueItem()] })
    const session = await loadedSession(3, {})
    await until(() => session.queue.value.length === 1, 'queue')
    expect(api.chatQueue.list).toHaveBeenCalledWith({ params: { id: chatId(3) } })
  })

  it('409 run-idle: the run ended in between, so the message is sent once this tab is idle', async () => {
    const { session, gate, sending } = await streamingSession()
    api.chatQueue.add.mockRejectedValue(conflict('run-idle'))
    server.reply(textReply('second answer', 'msg_assistant0000002'))
    const submitting = session.submit({ text: 'Next step', files: [] })
    await until(() => api.chatQueue.add.mock.calls.length === 1, 'queue attempt')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(chatBodies()).toHaveLength(1)
    gate.resolve()
    await sending
    expect(await submitting).toBe('sent')
    expect(chatBodies()).toHaveLength(2)
    expect(chatBodies()[1]!.message.parts).toEqual([{ type: 'text', text: 'Next step' }])
    expect(session.chat.messages.value.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  it('throws the other failures and sends nothing (409 queue-full)', async () => {
    const { session, gate } = await streamingSession()
    api.chatQueue.add.mockRejectedValue(conflict('queue-full'))
    await expect(session.submit({ text: 'One more', files: [] }))
      .rejects
      .toSatisfy((error: HarnessError) => error instanceof HarnessError && (error.details as { reason: string }).reason === 'queue-full')
    expect(chatBodies()).toHaveLength(1)
    gate.resolve()
  })

  it('cancels through the queue route: 204 cancelled, 404 gone', async () => {
    const session = newSession()
    const first = queueItem()
    const second = queueItem({ id: messageId('queued2') })
    dispatchServerEvent(createServerEvent('queue.changed', { chatId: chatId(1), items: [first, second] }))
    dispatchServerEvent(createServerEvent('queue.changed', { chatId: chatId(2), items: [queueItem({ id: messageId('other1') })] }))
    expect(session.queue.value).toEqual([first, second])
    api.chatQueue.remove.mockResolvedValueOnce(undefined)
    expect(await session.cancelQueued(first.id)).toBe('cancelled')
    api.chatQueue.remove.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Not queued.' }))
    expect(await session.cancelQueued(second.id)).toBe('gone')
    expect(api.chatQueue.remove.mock.calls).toEqual([[{ params: { id: chatId(1), itemId: first.id } }], [{ params: { id: chatId(1), itemId: second.id } }]])
    expect(session.queue.value).toEqual([])
  })

  it('stop resolves with the dropped messages and takes them out of the list', async () => {
    const { session, gate, sending } = await streamingSession()
    const item = queueItem()
    dispatchServerEvent(createServerEvent('queue.changed', { chatId: chatId(1), items: [item] }))
    api.chat.stop.mockResolvedValue({ stopped: true, dropped: [item] })
    const stopping = session.stop()
    gate.resolve()
    expect(await stopping).toEqual([item])
    await sending
    expect(session.queue.value).toEqual([])
    expect(session.chat.messages.value.at(-1)!.metadata?.aborted).toBe(true)
    // Nothing queued: nothing dropped.
    api.chat.stop.mockResolvedValue({ stopped: false })
    expect(await session.stop()).toEqual([])
  })
})

describe('useChatSession: stream data (Phase 9)', () => {
  it('a steer chunk marks its queued message delivered before the event arrives', async () => {
    const session = newSession()
    const item = queueItem()
    const other = queueItem({ id: messageId('queued2') })
    dispatchServerEvent(createServerEvent('queue.changed', { chatId: chatId(1), items: [item, other] }))
    const delivered = deferred()
    const gate = deferred()
    server.reply(async (write) => {
      write({ type: 'start', messageId: ASSISTANT_ID, messageMetadata: { modelRef: MODEL, startedAt: 1 } })
      write({ type: 'start-step' })
      write({ type: 'text-start', id: 't1' })
      write({ type: 'text-delta', id: 't1', delta: 'Running the tests.' })
      write({ type: 'text-end', id: 't1' })
      write({ type: 'finish-step' })
      write({ type: 'data-steer', data: steerData({ id: item.id }) } as UIMessageChunk)
      delivered.resolve()
      await gate.promise
      write({ type: 'start-step' })
      write({ type: 'finish-step' })
      write({ type: 'finish', finishReason: 'stop' })
    })
    const sending = session.submit({ text: 'Run the tests', files: [] })
    await delivered.promise
    await until(() => session.queue.value.length === 1, 'delivered')
    expect(session.queue.value.map(entry => entry.id)).toEqual([other.id])
    // The steer stays in the reply where it was delivered.
    await until(() => session.chat.messages.value[1]?.parts.some(part => part.type === 'data-steer') === true, 'steer part')
    expect(session.chat.messages.value[1]!.parts).toContainEqual({ type: 'data-steer', data: steerData({ id: item.id }) })
    gate.resolve()
    await sending
  })

  it('the transient activity drives `activity` and is never stored', async () => {
    const session = newSession()
    const gates = [deferred(), deferred(), deferred()]
    const reached = [deferred(), deferred(), deferred()]
    server.reply(async (write) => {
      write({ type: 'start', messageId: ASSISTANT_ID, messageMetadata: { modelRef: MODEL, startedAt: 1 } })
      write({ type: 'data-activity', data: { kind: 'compacting' }, transient: true } as UIMessageChunk)
      reached[0]!.resolve()
      await gates[0]!.promise
      write({ type: 'data-activity', data: { kind: 'idle' }, transient: true } as UIMessageChunk)
      reached[1]!.resolve()
      await gates[1]!.promise
      write({ type: 'data-activity', data: { kind: 'compacting' }, transient: true } as UIMessageChunk)
      reached[2]!.resolve()
      await gates[2]!.promise
      // The stream ends without `idle` (a stop, a failure).
      write({ type: 'finish', finishReason: 'stop' })
    })
    expect(session.activity.value).toBeNull()
    const sending = session.submit({ text: '/compact', files: [] })
    await reached[0]!.promise
    await until(() => session.activity.value === 'compacting', 'compacting')
    gates[0]!.resolve()
    await reached[1]!.promise
    await until(() => session.activity.value === null, 'idle')
    gates[1]!.resolve()
    await reached[2]!.promise
    await until(() => session.activity.value === 'compacting', 'compacting again')
    gates[2]!.resolve()
    await sending
    await nextTick()
    expect(session.activity.value).toBeNull()
    expect(session.chat.messages.value.flatMap(message => message.parts).some(part => part.type === 'data-activity')).toBe(false)
  })
})

describe('useChatSession: plan approval (Phase 9)', () => {
  it('approving with a mode sets the mode (saved on the chat) before the response, so the continuation runs in it', async () => {
    const session = newSession()
    session.toolMode.value = 'plan'
    server.reply(planReply())
    await session.submit({ text: 'Plan the notes file', files: [] })
    expect(session.runState.value).toBe('approval')

    server.reply(textReply('notes.txt written', ASSISTANT_ID))
    await session.approve({ id: 'appr_plan', approved: true, toolName: 'exit_plan_mode', alwaysAllow: false, planMode: 'edits' })
    await until(() => chatBodies().length === 2 && session.runState.value === 'idle', 'continuation')

    expect(session.toolMode.value).toBe('edits')
    expect(chatBodies()[0]!.toolMode).toBe('plan')
    expect(chatBodies()[1]).toMatchObject({ toolMode: 'edits', message: { role: 'assistant' } })
    const tool = chatBodies()[1]!.message.parts.find(part => part.type === 'tool-exit_plan_mode')
    expect(tool).toMatchObject({ state: 'approval-responded', approval: { id: 'appr_plan', approved: true } })
    expect(tool).not.toHaveProperty('approval.reason')
    expect(api.chats.update).toHaveBeenCalledWith({ params: { id: chatId(1) }, body: { settings: { toolMode: 'edits' } } })
    // The mode is saved before the continuation goes out.
    const saved = api.chats.update.mock.invocationCallOrder[0]!
    const continued = (mock.fetch as Mock).mock.invocationCallOrder[1]!
    expect(saved).toBeLessThan(continued)
    expect(api.tools.update).not.toHaveBeenCalled()
  })

  it('"Approve, ask before edits" switches to ask', async () => {
    const session = newSession()
    session.toolMode.value = 'plan'
    server.reply(planReply())
    await session.submit({ text: 'Plan it', files: [] })
    server.reply(textReply('asking first', ASSISTANT_ID))
    await session.approve({ id: 'appr_plan', approved: true, toolName: 'exit_plan_mode', alwaysAllow: false, planMode: 'ask' })
    await until(() => chatBodies().length === 2, 'continuation')
    expect(chatBodies()[1]!.toolMode).toBe('ask')
  })

  it('"Keep planning" sends the feedback as the reason and keeps plan', async () => {
    const session = newSession()
    session.toolMode.value = 'plan'
    server.reply(planReply())
    await session.submit({ text: 'Plan the notes file', files: [] })
    server.reply(planReply())
    await session.approve({ id: 'appr_plan', approved: false, toolName: 'exit_plan_mode', alwaysAllow: false, planMode: 'edits', reason: '  Keep the old API  ' })
    await until(() => chatBodies().length === 2, 'continuation')
    expect(session.toolMode.value).toBe('plan')
    expect(chatBodies()[1]!.toolMode).toBe('plan')
    const tool = chatBodies()[1]!.message.parts.find(part => part.type === 'tool-exit_plan_mode')
    expect(tool).toMatchObject({ approval: { id: 'appr_plan', approved: false, reason: 'Keep the old API' } })
    expect(api.chats.update).not.toHaveBeenCalled()
  })
})

describe('useChatSession: todos (Phase 9)', () => {
  it('derives the todo state from the shown path (todoState)', async () => {
    const state = { todos: [], done: 1, total: 3, current: null, messageId: ASSISTANT_ID, live: true }
    mock.todoState.mockImplementation((messages: readonly HarnessUIMessage[]) => (messages.length > 1 ? state : null))
    try {
      const session = newSession()
      expect(session.todos.value).toBeNull()
      server.reply(textReply('Planning the work'))
      await session.submit({ text: 'Plan it', files: [] })
      expect(session.todos.value).toBe(state)
      expect(mock.todoState).toHaveBeenLastCalledWith(session.chat.messages.value)
    }
    finally {
      mock.todoState.mockImplementation(mock.realTodoState!)
    }
  })
})

describe('useChatSession: turns the server starts from the queue (Phase 9)', () => {
  const U1 = 'msg_user000000000001'
  const QUEUED = messageId('queued1')
  const A2 = 'msg_assistant0000002'

  it('an idle tab reloads the path before it resumes, so the queued message shows before its reply', async () => {
    api.chatQueue.list.mockResolvedValue({ items: [] })
    const session = await loadedSession(4, { messages: [userMessage(U1, 'q'), assistantMessage(ASSISTANT_ID, 'a')] })
    api.chats.get.mockResolvedValueOnce(chatDetail({ id: chatId(4), modelRef: MODEL, running: true, messages: [userMessage(U1, 'q'), assistantMessage(ASSISTANT_ID, 'a'), userMessage(QUEUED, 'Also update the README')] }))
    api.chats.get.mockResolvedValueOnce(chatDetail({ id: chatId(4), modelRef: MODEL, messages: [userMessage(U1, 'q'), assistantMessage(ASSISTANT_ID, 'a'), userMessage(QUEUED, 'Also update the README'), assistantMessage(A2, 'README updated')] }))
    let shownAtResume: string[] = []
    server.resume((write) => {
      shownAtResume = ids(session.chat.messages.value)
      return textReply('README updated', A2)(write)
    })
    dispatchServerEvent(createServerEvent('run.started', { chatId: chatId(4), messageId: A2, modelRef: MODEL, origin: 'queue', userMessageId: QUEUED }))
    await until(() => ids(session.chat.messages.value).at(-1) === A2 && session.chat.status.value === 'ready', 'resumed')
    expect(shownAtResume).toEqual([U1, ASSISTANT_ID, QUEUED])
    const reload = api.chats.get.mock.invocationCallOrder[1]!
    const resume = (mock.fetch as Mock).mock.invocationCallOrder[0]!
    expect(reload).toBeLessThan(resume)
    await until(() => api.chats.get.mock.calls.length === 3, 'reconciled')
    expect(ids(session.chat.messages.value)).toEqual([U1, ASSISTANT_ID, QUEUED, A2])
  })

  it('ignores runs started by a request, and queued turns whose message it already shows', async () => {
    api.chatQueue.list.mockResolvedValue({ items: [] })
    const session = await loadedSession(5, { messages: [userMessage(U1, 'q'), userMessage(QUEUED, 'shown')] })
    dispatchServerEvent(createServerEvent('run.started', { chatId: chatId(5), messageId: A2, modelRef: MODEL }))
    dispatchServerEvent(createServerEvent('run.started', { chatId: chatId(5), messageId: A2, modelRef: MODEL, origin: 'queue', userMessageId: QUEUED }))
    dispatchServerEvent(createServerEvent('run.started', { chatId: chatId(6), messageId: A2, modelRef: MODEL, origin: 'queue', userMessageId: messageId('elsewhere') }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(api.chats.get).toHaveBeenCalledTimes(1)
    expect(server.calls).toHaveLength(0)
    expect(session.chat.status.value).toBe('ready')
  })

  it('two tabs: the tab that queued follows once its own reply ended, the other one at once', async () => {
    // Tab A: this module. Tab B: its own copy of the app modules and stores (another browser tab), same server.
    api.chatQueue.list.mockResolvedValue({ items: [] })
    const n = 7
    let phase: 'initial' | 'queued-turn' | 'done' = 'initial'
    let userId = ''
    let queuedId = ''
    const path = (): HarnessUIMessage[] => {
      const base = [userMessage(U1, 'q'), assistantMessage('msg_assistant0000000', 'a')]
      if (phase === 'initial')
        return base
      const turn = [...base, userMessage(userId, 'Fix the parser'), assistantMessage(ASSISTANT_ID, 'working on it'), userMessage(queuedId, 'Also update the README')]
      return phase === 'done' ? [...turn, assistantMessage(A2, 'README updated')] : turn
    }
    api.chats.get.mockImplementation(async () => chatDetail({ id: chatId(n), modelRef: MODEL, running: phase === 'queued-turn', messages: path() }))

    const tabA = useChatSession(chatId(n))
    await until(() => tabA.loaded.value, 'tab A load')
    vi.resetModules()
    const piniaB = createPinia()
    setActivePinia(piniaB)
    const tabBSessions = await import('./useChatSession')
    const tabBEvents = await import('./useServerEvents')
    const tabB = tabBSessions.useChatSession(chatId(n))
    await until(() => tabB.loaded.value, 'tab B load')
    setActivePinia(pinia)
    try {
      // Tab A sends, then queues while its reply streams.
      const gateR1 = deferred()
      server.reply(textReply('working on it', ASSISTANT_ID, gateR1.promise))
      const sending = tabA.submit({ text: 'Fix the parser', files: [] })
      await until(() => tabA.chat.status.value === 'streaming', 'tab A streams')
      userId = chatBodies()[0]!.message.id
      acceptQueue()
      expect(await tabA.submit({ text: 'Also update the README', files: [] })).toBe('queued')
      queuedId = (api.chatQueue.add.mock.calls[0]![0] as { body: QueueAddBody }).body.message.id

      // The run completes and the server starts the queued message as the next turn.
      const gateB = deferred()
      const gateA = deferred()
      let tabBAtResume: string[] = []
      let tabAAtResume: string[] = []
      server.resume(afterGate(gateB.promise, (write) => {
        tabBAtResume = ids(tabB.chat.messages.value)
        return textReply('README updated', A2)(write)
      }))
      server.resume(afterGate(gateA.promise, (write) => {
        tabAAtResume = ids(tabA.chat.messages.value)
        return textReply('README updated', A2)(write)
      }))
      phase = 'queued-turn'
      const started = createServerEvent('run.started', { chatId: chatId(n), messageId: A2, modelRef: MODEL, origin: 'queue', userMessageId: queuedId })
      dispatchServerEvent(started)
      setActivePinia(piniaB)
      tabBEvents.dispatchServerEvent(started)
      setActivePinia(pinia)

      // Tab B (idle) reloads, shows the queued message, then follows the reply.
      const streamCalls = () => server.calls.filter(call => call.url === `/api/chat/${chatId(n)}/stream`).length
      await until(() => streamCalls() === 1, 'tab B resumes')
      expect(ids(tabB.chat.messages.value)).toEqual([U1, 'msg_assistant0000000', userId, ASSISTANT_ID, queuedId])
      // Tab A still streams its own reply: it waits.
      expect(tabA.chat.status.value).toBe('streaming')
      expect(ids(tabA.chat.messages.value)).not.toContain(queuedId)

      gateR1.resolve()
      await sending
      await until(() => streamCalls() === 2, 'tab A resumes')
      expect(ids(tabA.chat.messages.value)).toEqual([U1, 'msg_assistant0000000', userId, ASSISTANT_ID, queuedId])
      expect(useChatsStore().runState[chatId(n)]).toBe('running')

      phase = 'done'
      gateB.resolve()
      gateA.resolve()
      const final = [U1, 'msg_assistant0000000', userId, ASSISTANT_ID, queuedId, A2]
      await until(() => tabA.chat.status.value === 'ready' && ids(tabA.chat.messages.value).join() === final.join(), 'tab A done')
      await until(() => tabB.chat.status.value === 'ready' && ids(tabB.chat.messages.value).join() === final.join(), 'tab B done')
      expect(tabBAtResume).toEqual(final.slice(0, 5))
      expect(tabAAtResume).toEqual(final.slice(0, 5))
      // One POST /chat in all: the next turn was started by the server.
      expect(chatBodies()).toHaveLength(1)
    }
    finally {
      tabBSessions.resetChatSessions()
      disposePinia(piniaB)
      setActivePinia(pinia)
    }
  })
})
