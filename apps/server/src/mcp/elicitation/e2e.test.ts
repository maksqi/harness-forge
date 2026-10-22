// MCP elicitation end to end (Phase 14, ADR-060; W14.3-T8): `createTestApp()` with the real MCP manager, the real
// elicitation broker and the real chat runner, `mock:hooks` (`call mcp__fake__<tool> {}`, `agent <prompt>`) and the C53
// OAuth MCP fixture on loopback (toggle `noAuth`: no sign-in; MCP OAuth is the fake service). Covered: accept (the
// answer reaches the server; the stored message keeps no value), decline, cancel, Stop, a reload (the resume replays the
// card), a second answer (409), an invalid one (400), a sub-agent's call (declined), two chats at once (both declined),
// the timeout (`HF_TEST_ELICITATION_WAIT_MS`), `awaitingInput` through `chat.updated` and the `Notification` code hook
// (`elicitation_dialog`).
import type { HarnessUIMessage, McpElicitation, McpElicitationRecord, ServerEvent } from '@harness-forge/shared'
import type { UIMessageChunk } from 'ai'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { OAuthMcpServer } from '../__fixtures__/oauth-mcp-server.mjs'
import type { ElicitationBroker } from './types.ts'
import { chatDetailSchema, mcpElicitationRecordSchema, mcpToolProgressSchema } from '@harness-forge/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chatBody, parseSse, postChat, readUntil, runnerOf, streamedText, testChatId } from '../../chat/testing.ts'
import { elicitationBrokerOptions } from '../../deps.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { waitFor } from '../__fixtures__/harness.ts'
import { startOAuthMcpServer } from '../__fixtures__/oauth-mcp-server.mjs'
import { createElicitationBroker } from './broker.ts'

const SECRET_VALUE = 'e2e-secret-name-5c7a'
const BASIC_FIELDS = ['name', 'email', 'count', 'subscribe', 'color']
const BASIC_MESSAGE = 'The OAuth MCP fixture needs a few details.'

/** Deferred `end()` of the calls while closed (the two-chat test keeps both calls in flight until both requests came). */
const gate: { closed: boolean, deferred: Array<() => void> } = { closed: false, deferred: [] }

/** The real broker whose handles' `end()` waits while the gate is closed. */
function gatedBroker(broker: ElicitationBroker): ElicitationBroker {
  return {
    ...broker,
    begin: (call) => {
      const handle = broker.begin(call)
      return {
        ...handle,
        end: () => {
          if (gate.closed)
            gate.deferred.push(handle.end)
          else
            handle.end()
        },
      }
    },
  }
}

interface LiveStream {
  readonly chunks: UIMessageChunk[]
  readonly done: Promise<void>
}

/** Reads the SSE body in the background (chunks appear as they arrive). */
function live(response: Response): LiveStream {
  const chunks: UIMessageChunk[] = []
  const done = (async () => {
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done: ended, value } = await reader.read()
      if (ended)
        break
      buffer += decoder.decode(value, { stream: true })
      const end = buffer.lastIndexOf('\n\n')
      if (end === -1)
        continue
      chunks.push(...parseSse(buffer.slice(0, end + 2)).chunks)
      buffer = buffer.slice(end + 2)
    }
  })()
  return { chunks, done }
}

/** The pending card of the chunks so far (the latest `input-required` preliminary output), or null. */
function cardOf(chunks: readonly UIMessageChunk[]): McpElicitation | null {
  let card: McpElicitation | null = null
  for (const chunk of chunks) {
    if (chunk.type !== 'tool-output-available' || chunk.preliminary !== true)
      continue
    const progress = mcpToolProgressSchema.safeParse(chunk.output)
    if (progress.success)
      card = progress.data.status === 'input-required' ? progress.data.elicitation : null
  }
  return card
}

/** The elicitation records of the stored tool outputs of `messages`. */
function recordsOf(messages: readonly HarnessUIMessage[]): McpElicitationRecord[] {
  return messages.flatMap(message => message.parts.flatMap((part) => {
    const output = (part as { output?: unknown }).output
    const records = typeof output === 'object' && output !== null ? (output as { elicitations?: unknown }).elicitations : undefined
    return Array.isArray(records) ? records.map(record => mcpElicitationRecordSchema.parse(record)) : []
  }))
}

describe('mcp elicitation end to end (W14.3-T8)', () => {
  let fixture: OAuthMcpServer
  let t: TestApp
  let events: ServerEvent[] = []
  const notifications: Array<{ chatId: string, type: string, message: string }> = []
  let nextChat = 0xEE00

  function newChatId(): string {
    nextChat += 1
    return testChatId(nextChat)
  }

  beforeAll(async () => {
    fixture = await startOAuthMcpServer({ toggles: { noAuth: true } })
    t = await createTestApp({
      env: { HF_MOCK_PROVIDER: '1' },
      mcpAuth: 'fake',
      factories: { elicitations: deps => gatedBroker(createElicitationBroker(deps, elicitationBrokerOptions(deps.env))) },
    })
    t.deps.events.subscribe(event => void events.push(event))
    t.deps.registry.hooks.on('mock', 'notification', (input) => {
      notifications.push({ chatId: input.chatId, type: input.type, message: input.message })
    })
    await t.deps.mcp.create({ id: 'fake', name: 'Fake', transport: { type: 'http', url: fixture.url } })
    await waitFor(async () => (await t.deps.mcp.get('fake')).status === 'connected')
  })

  beforeEach(() => {
    events = []
    notifications.length = 0
    fixture.resetCounters()
  })

  afterAll(async () => {
    await t?.close()
    await fixture?.stop()
  })

  async function start(chatId: string, text: string): Promise<LiveStream> {
    const response = await postChat(t, chatBody(chatId, text, { modelRef: 'mock:hooks', toolMode: 'auto' }))
    expect(response.status).toBe(200)
    return live(response)
  }

  function answer(chatId: string, elicitationId: string, body: unknown): Promise<Response> {
    return t.request(`/api/chat/${chatId}/elicitations/${elicitationId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  }

  async function finished(stream: LiveStream): Promise<string> {
    await stream.done
    await runnerOf(t).idle()
    return streamedText(stream.chunks)
  }

  async function stored(chatId: string): Promise<HarnessUIMessage[]> {
    return chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId}`)).json()).messages
  }

  function awaiting(chatId: string): boolean[] {
    return events.flatMap(event => (event.type === 'chat.updated' && event.data.id === chatId && event.data.awaitingInput !== undefined ? [event.data.awaitingInput] : []))
  }

  it('accept: the card is the tool part\'s preliminary output; 400 for an invalid answer, 200, then 409; no value is stored', async () => {
    const chatId = newChatId()
    const stream = await start(chatId, 'call mcp__fake__ask {}')
    const card = await waitFor(() => cardOf(stream.chunks))
    expect(card).toMatchObject({ serverId: 'fake', serverName: 'Fake', message: BASIC_MESSAGE })
    expect(card.form.fields.map(field => field.name)).toEqual(BASIC_FIELDS)
    expect(t.deps.elicitations.pendingCount(chatId)).toBe(1)
    await waitFor(() => awaiting(chatId).length === 1)
    const detail = chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId}`)).json())
    expect(detail.awaitingInput).toBe(true)

    const invalid = await answer(chatId, card.id, { action: 'accept', content: { name: SECRET_VALUE, count: 99 } })
    expect(invalid.status).toBe(400)
    const accepted = await answer(chatId, card.id, { action: 'accept', content: { name: SECRET_VALUE, email: 'ada@example.com', count: 3, subscribe: true, color: 'green' } })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({ action: 'accept' })
    expect((await answer(chatId, card.id, { action: 'decline' })).status).toBe(409)

    const text = await finished(stream)
    expect(text).toContain('Called mcp__fake__ask: ok')
    expect(text).toContain('"action":"accept","fields":["name","email","count","subscribe","color"]')
    // The card came first; `running` may be coalesced with the final output by the 250 ms preliminary throttle.
    const progress = stream.chunks.flatMap((chunk) => {
      const parsed = chunk.type === 'tool-output-available' && chunk.preliminary === true ? mcpToolProgressSchema.safeParse(chunk.output) : null
      return parsed?.success === true ? [parsed.data.status] : []
    })
    expect(progress[0]).toBe('input-required')
    const messages = await stored(chatId)
    expect(recordsOf(messages)).toEqual([{ id: card.id, message: BASIC_MESSAGE, fields: BASIC_FIELDS, action: 'accept', reason: 'user' }])
    expect(JSON.stringify(messages)).not.toContain(SECRET_VALUE)
    expect(t.logs.text()).not.toContain(SECRET_VALUE)
    expect(t.logs.text()).not.toContain(BASIC_MESSAGE)
    expect(awaiting(chatId)).toEqual([true, false])
    // The Notification code hook ran once with the request message (never an answer).
    expect(notifications).toEqual([{ chatId, type: 'elicitation_dialog', message: BASIC_MESSAGE }])
    expect(fixture.counters().elicitations).toBe(1)
  })

  it('ask_echo: the accepted content reaches the MCP server', async () => {
    const chatId = newChatId()
    const stream = await start(chatId, 'call mcp__fake__ask_echo {}')
    const card = await waitFor(() => cardOf(stream.chunks))
    expect((await answer(chatId, card.id, { action: 'accept', content: { name: 'Ada', color: 'blue' } })).status).toBe(200)
    expect(await finished(stream)).toContain('{"action":"accept","content":{"name":"Ada","color":"blue"}}')
  })

  it('decline and cancel reach the MCP server without content', async () => {
    for (const action of ['decline', 'cancel'] as const) {
      const chatId = newChatId()
      const stream = await start(chatId, 'call mcp__fake__ask {}')
      const card = await waitFor(() => cardOf(stream.chunks))
      expect((await answer(chatId, card.id, { action })).status).toBe(200)
      expect(await finished(stream)).toContain(`Called mcp__fake__ask: ok | {"action":"${action}","fields":[]}`)
      expect(recordsOf(await stored(chatId))).toEqual([expect.objectContaining({ id: card.id, action, reason: 'user', fields: BASIC_FIELDS })])
    }
  })

  it('a reload replays the card (GET /chat/:id/stream), then the answer completes the run', async () => {
    const chatId = newChatId()
    const stream = await start(chatId, 'call mcp__fake__ask {}')
    const card = await waitFor(() => cardOf(stream.chunks))
    const resumed = await t.request(`/api/chat/${chatId}/stream`)
    expect(resumed.status).toBe(200)
    const replay = await readUntil(resumed, chunks => cardOf(chunks) !== null)
    expect(cardOf(replay.chunks)).toEqual(card)
    expect((await answer(chatId, card.id, { action: 'decline' })).status).toBe(200)
    expect(await finished(stream)).toContain('"action":"decline"')
  })

  it('stop cancels the wait (the MCP server gets cancel); a late answer is 409 and nothing waits', async () => {
    const chatId = newChatId()
    const stream = await start(chatId, 'call mcp__fake__ask {}')
    const card = await waitFor(() => cardOf(stream.chunks))
    expect((await t.request(`/api/chat/${chatId}/stop`, { method: 'POST' })).status).toBe(200)
    await finished(stream)
    expect(t.deps.elicitations.pendingCount(chatId)).toBe(0)
    const late = await answer(chatId, card.id, { action: 'accept', content: { name: 'Ada' } })
    expect(late.status).toBe(409)
    await waitFor(() => awaiting(chatId).length === 2)
    expect(awaiting(chatId)).toEqual([true, false])
    expect(t.logs.records.some(record => record.msg === 'mcp elicitation ended' && record.elicitationId === card.id && record.action === 'cancel' && record.reason === 'stopped')).toBe(true)
  })

  it('a sub-agent\'s call is declined (not-interactive): no card, no notification', async () => {
    const chatId = newChatId()
    const stream = await start(chatId, 'agent call mcp__fake__ask {}')
    const text = await finished(stream)
    expect(text).toContain('Agent report:')
    expect(fixture.counters().elicitations).toBe(1)
    expect(cardOf(stream.chunks)).toBeNull()
    expect(stream.chunks.some(chunk => chunk.type === 'tool-output-available' && JSON.stringify(chunk.output).includes('input-required'))).toBe(false)
    expect(t.logs.records.some(record => record.msg === 'mcp elicitation declined' && record.reason === 'not-interactive')).toBe(true)
    expect(notifications).toEqual([])
    expect(awaiting(chatId)).toEqual([])
  })

  it('two chats with calls on the same server at once: both requests are declined (ambiguous)', async () => {
    gate.closed = true
    try {
      const a = newChatId()
      const b = newChatId()
      // `slow_ask` waits 2 s before it asks: both calls are in flight when the first request arrives.
      const first = await start(a, 'call mcp__fake__slow_ask {}')
      const second = await start(b, 'call mcp__fake__slow_ask {}')
      const [textA, textB] = await Promise.all([finished(first), finished(second)])
      for (const text of [textA, textB])
        expect(text).toContain('Called mcp__fake__slow_ask: ok | {"action":"decline","fields":[]}')
      expect(fixture.counters().elicitations).toBe(2)
      expect(t.logs.records.filter(record => record.msg === 'mcp elicitation declined' && record.reason === 'ambiguous')).toHaveLength(2)
      expect([cardOf(first.chunks), cardOf(second.chunks)]).toEqual([null, null])
    }
    finally {
      gate.closed = false
      for (const end of gate.deferred.splice(0))
        end()
    }
  })
})

describe('mcp elicitation timeout end to end (HF_TEST_ELICITATION_WAIT_MS)', () => {
  it('an unanswered card is cancelled after the wait (reason timeout) and the run goes on', async () => {
    const fixture = await startOAuthMcpServer({ toggles: { noAuth: true } })
    const t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1', HF_TEST_ELICITATION_WAIT_MS: '1000' }, mcpAuth: 'fake' })
    try {
      await t.deps.mcp.create({ id: 'fake', name: 'Fake', transport: { type: 'http', url: fixture.url } })
      await waitFor(async () => (await t.deps.mcp.get('fake')).status === 'connected')
      const chatId = testChatId(0xEF01)
      const response = await postChat(t, chatBody(chatId, 'call mcp__fake__ask {}', { modelRef: 'mock:hooks', toolMode: 'auto' }))
      const stream = live(response)
      const card = await waitFor(() => cardOf(stream.chunks))
      expect(card.expiresAt - Date.now()).toBeLessThanOrEqual(1000)
      await stream.done
      await runnerOf(t).idle()
      expect(streamedText(stream.chunks)).toContain('Called mcp__fake__ask: ok | {"action":"cancel","fields":[]}')
      const messages = chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId}`)).json()).messages
      expect(recordsOf(messages)).toEqual([expect.objectContaining({ id: card.id, action: 'cancel', reason: 'timeout' })])
      expect((await t.request(`/api/chat/${chatId}/elicitations/${card.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"decline"}' })).status).toBe(409)
    }
    finally {
      await t.close()
      await fixture.stop()
    }
  })
})
