import type { ChatDetail, ChatRequestBody, HarnessUIMessage } from '@harness-forge/shared'
import type { UIMessageChunk } from 'ai'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { useChatsStore } from '~/stores/chats'
import { useModelsStore } from '~/stores/models'
import { chatDetail, chatId, chatSummary, messageBranch } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import {
  buildChatRequestBody,
  chatDataPartSchemas,
  isRunActiveConflict,
  MAX_CHAT_SESSIONS,
  mergePath,
  resetChatSessions,
  samePathIds,
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
    expect(isRunActiveConflict(new HarnessError({ code: 'not_found', message: 'x' }))).toBe(false)
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

describe('useChatSession: data parts', () => {
  it('registers every data-part schema under its chunk type as well (AI SDK 7 looks up `data-<name>`)', () => {
    expect(Object.keys(chatDataPartSchemas).sort()).toEqual(['data-notice', 'notice'])
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
