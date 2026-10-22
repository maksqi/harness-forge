// The elicitation broker (Phase 14, ADR-060; W14.3-T1, T2, T6, T7): attribution (one chat, two chats, a sub-agent, no
// call), requests (the MCP specification examples, URL mode, unsupported schemas, a second request), answers (validation,
// 404, 409 `stale`), every cancel path (timeout, Stop, the call's end, chat delete, key rotation, shutdown), the pending
// counts and `chat.updated` transitions. A memory logger, the recording event bus and a scripted chats double stand in
// for the app; timers are fake wherever a wait is timed.
import type { ElicitationRequest, ElicitResult } from '@ai-sdk/mcp'
import type { ChatSummary, McpElicitation } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { ElicitationBroker, ElicitationCall, ElicitationCallHandle } from './types.ts'
import { chatUpdatedDataSchema, createServerEvent, ELICITATION_ID_PATTERN, LIMITS, mcpElicitationSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryLogger } from '../../logger.ts'
import { createRecordingEventBus } from '../../testing/fakes.ts'
import { createElicitationBroker, ELICITATION_RECORDS_MAX, STALE_ELICITATION_MESSAGE } from './broker.ts'

const CHAT_A = '0199a8f0-0000-7000-8000-0000000000a1'
const CHAT_B = '0199a8f0-0000-7000-8000-0000000000b2'
const KEY = 'mcp:docs#1'
const SECRET_VALUE = 'Monalisa-Octocat-7f3e'
const SECRET_MESSAGE = 'Which repository-c41d should I use?'

/** The simple text request of the MCP specification. */
const SIMPLE_SCHEMA = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
/** The structured data request of the MCP specification (2025-06-18). */
const CONTACT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Your full name' },
    email: { type: 'string', format: 'email', description: 'Your email address' },
    age: { type: 'number', minimum: 18, description: 'Your age' },
  },
  required: ['name', 'email'],
}

function summaryOf(id: string): ChatSummary {
  return { id, title: 'Chat', titleSource: 'user', modelRef: 'mock:hooks', pinned: false, archived: false, running: true, pendingApproval: false, projectId: null, createdAt: 1, updatedAt: 2 }
}

interface Harness {
  broker: ElicitationBroker
  events: ReturnType<typeof createRecordingEventBus>
  logs: ReturnType<typeof createMemoryLogger>
  /** Chats the scripted chats double knows (others are deleted). */
  chats: Set<string>
}

const open: ElicitationBroker[] = []

afterEach(async () => {
  for (const broker of open.splice(0))
    await broker.stop()
  vi.useRealTimers()
})

function harness(waitMs?: number): Harness {
  const logs = createMemoryLogger()
  const events = createRecordingEventBus()
  const chats = new Set([CHAT_A, CHAT_B])
  const deps = {
    logger: logs.logger,
    events,
    chats: {
      find: async (id: string) => (chats.has(id) ? { id, activeLeafId: null } : null),
      summary: async (id: string) => summaryOf(id),
    },
  } as unknown as AppDeps
  const broker = createElicitationBroker(deps, waitMs === undefined ? {} : { waitMs })
  open.push(broker)
  return { broker, events, logs, chats }
}

let nextCall = 0

function call(overrides: Partial<ElicitationCall> = {}): ElicitationCall & { controller: AbortController } {
  const controller = new AbortController()
  nextCall += 1
  return { runtimeKey: KEY, chatId: CHAT_A, toolCallId: `call_${nextCall}`, serverId: 'docs', serverName: 'Docs', interactive: true, signal: controller.signal, controller, ...overrides }
}

function request(requestedSchema: unknown = SIMPLE_SCHEMA, message = 'Your name?', extra: Record<string, unknown> = {}): ElicitationRequest {
  return { method: 'elicitation/create', params: { message, requestedSchema, ...extra } } as ElicitationRequest
}

/** Asks on `key`; the call shows the card at once (the broker attributes a request synchronously). */
async function ask(h: Harness, handle: ElicitationCallHandle, req: ElicitationRequest = request(), key = KEY): Promise<{ card: McpElicitation, result: Promise<ElicitResult> }> {
  const result = h.broker.handler(key)(req)
  const card = handle.pending()
  expect(card).not.toBeNull()
  return { card: card!, result }
}

async function settled<T>(promise: Promise<T>): Promise<boolean> {
  let done = false
  void promise.then(() => {
    done = true
  }, () => {
    done = true
  })
  await Promise.resolve()
  await Promise.resolve()
  return done
}

function awaitingEvents(h: Harness, chatId: string): boolean[] {
  return h.events.ofType('chat.updated').filter(event => event.data.id === chatId).map(event => event.data.awaitingInput === true)
}

describe('attribution (W14.3-T1)', () => {
  it('one chat: the oldest interactive call gets the request; ended calls do not count', async () => {
    const h = harness()
    const first = h.broker.begin(call())
    const second = h.broker.begin(call())
    const { card, result } = await ask(h, first)
    expect(second.pending()).toBeNull()
    expect(first.waiting()).toBe(true)
    await h.broker.answer(CHAT_A, card.id, { action: 'decline' })
    expect(await result).toEqual({ action: 'decline' })
    first.end()
    // The oldest call ended: the next request goes to the second one.
    const next = await ask(h, second)
    expect(next.card.id).not.toBe(card.id)
    second.end()
    expect(await next.result).toEqual({ action: 'cancel' })
  })

  it('calls of two chats: declined `ambiguous` at once, no card, no record', async () => {
    const h = harness()
    const a = h.broker.begin(call())
    const b = h.broker.begin(call({ chatId: CHAT_B }))
    expect(await h.broker.handler(KEY)(request())).toEqual({ action: 'decline' })
    expect([a.pending(), b.pending(), a.records(), b.records()]).toEqual([null, null, [], []])
    expect(h.logs.records.some(record => record.msg === 'mcp elicitation declined' && record.reason === 'ambiguous' && record.level === 'debug')).toBe(true)
    // Another client's calls never count.
    const other = h.broker.begin(call({ runtimeKey: 'mcp:other#1', chatId: CHAT_B }))
    a.end()
    b.end()
    const only = h.broker.begin(call())
    const { card } = await ask(h, only)
    expect(card.serverId).toBe('docs')
    other.end()
    only.end()
  })

  it('a sub-agent or background call in flight, or no call: declined `not-interactive`', async () => {
    const h = harness()
    expect(await h.broker.handler(KEY)(request())).toEqual({ action: 'decline' })
    const child = h.broker.begin(call({ interactive: false }))
    expect(await h.broker.handler(KEY)(request())).toEqual({ action: 'decline' })
    expect(child.records()).toEqual([])
    // A main-agent call of the same chat next to it does not make it attributable.
    const main = h.broker.begin(call())
    expect(await h.broker.handler(KEY)(request())).toEqual({ action: 'decline' })
    expect(main.pending()).toBeNull()
    const reasons = h.logs.records.filter(record => record.msg === 'mcp elicitation declined').map(record => record.reason)
    expect(reasons).toEqual(['not-interactive', 'not-interactive', 'not-interactive'])
    child.end()
    main.end()
    expect(h.broker.pendingCount(CHAT_A)).toBe(0)
  })
})

describe('requests (W14.3-T2)', () => {
  it('shows the card: an eli_ id, the server, the cleaned message, the normalized form, expiresAt = now + 480 s', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const h = harness()
    const handle = h.broker.begin(call({ serverName: 'Docs server' }))
    const changes = vi.fn()
    handle.onChange(changes)
    const result = h.broker.handler(KEY)(request(CONTACT_SCHEMA, 'Please share\u0007 your contact\u202E details.'))
    await vi.advanceTimersByTimeAsync(0)
    const card = handle.pending()!
    expect(mcpElicitationSchema.parse(card)).toEqual(card)
    expect(card.id).toMatch(ELICITATION_ID_PATTERN)
    expect(card).toMatchObject({ serverId: 'docs', serverName: 'Docs server', message: 'Please share your contact details.', expiresAt: 1_000_000 + LIMITS.mcpElicitationWaitMs })
    expect(card.form.fields.map(field => [field.name, field.type, field.required, field.format ?? null])).toEqual([
      ['name', 'string', true, null],
      ['email', 'string', true, 'email'],
      ['age', 'number', false, null],
    ])
    expect(changes).toHaveBeenCalledOnce()
    expect(h.broker.pendingCount(CHAT_A)).toBe(1)
    await h.broker.answer(CHAT_A, card.id, { action: 'accept', content: { name: SECRET_VALUE, email: 'octocat@github.com', age: 30 } })
    expect(await result).toEqual({ action: 'accept', content: { name: SECRET_VALUE, email: 'octocat@github.com', age: 30 } })
    expect(handle.records()).toEqual([{ id: card.id, message: 'Please share your contact details.', fields: ['name', 'email', 'age'], action: 'accept', reason: 'user' }])
    expect(changes).toHaveBeenCalledTimes(2)
    handle.end()
  })

  it('url mode and schemas outside the subset: declined `unsupported` at once, recorded on the call', async () => {
    const h = harness()
    const handle = h.broker.begin(call())
    const url = request({ type: 'object', properties: {} }, 'Open the page.', { mode: 'url', url: 'https://example.invalid/x', elicitationId: 'e1' })
    expect(await h.broker.handler(KEY)(url)).toEqual({ action: 'decline' })
    const nested = request({ type: 'object', properties: { address: { type: 'object', properties: { street: { type: 'string' } } } } }, 'Where?')
    expect(await h.broker.handler(KEY)(nested)).toEqual({ action: 'decline' })
    expect(await h.broker.handler(KEY)({ method: 'elicitation/create', params: { message: 'No schema' } } as ElicitationRequest)).toEqual({ action: 'decline' })
    // `mode: 'form'` is the form mode.
    const form = h.broker.handler(KEY)(request(SIMPLE_SCHEMA, 'Form mode', { mode: 'form' }))
    expect(handle.waiting()).toBe(true)
    expect(handle.records().map(record => [record.message, record.fields, record.action, record.reason])).toEqual([
      ['Open the page.', [], 'decline', 'unsupported'],
      ['Where?', [], 'decline', 'unsupported'],
      ['No schema', [], 'decline', 'unsupported'],
    ])
    expect(handle.records().every(record => ELICITATION_ID_PATTERN.test(record.id))).toBe(true)
    handle.end()
    expect(await form).toEqual({ action: 'cancel' })
  })

  it('a second request while the first waits: declined `ambiguous` (one pending request per call)', async () => {
    const h = harness()
    const handle = h.broker.begin(call())
    const { card, result } = await ask(h, handle)
    expect(await h.broker.handler(KEY)(request(CONTACT_SCHEMA, 'Again?'))).toEqual({ action: 'decline' })
    expect(handle.pending()?.id).toBe(card.id)
    expect(handle.records()).toEqual([expect.objectContaining({ message: 'Again?', fields: ['name', 'email', 'age'], action: 'decline', reason: 'ambiguous' })])
    expect(h.broker.pendingCount(CHAT_A)).toBe(1)
    await h.broker.answer(CHAT_A, card.id, { action: 'cancel' })
    expect(await result).toEqual({ action: 'cancel' })
    handle.end()
  })

  it('records at most ELICITATION_RECORDS_MAX per call; listeners never see a value', async () => {
    const h = harness()
    const handle = h.broker.begin(call())
    const seen: unknown[] = []
    handle.onChange(() => seen.push({ pending: handle.pending(), records: handle.records() }))
    for (let index = 0; index < ELICITATION_RECORDS_MAX + 5; index++)
      await h.broker.handler(KEY)(request({ type: 'array' }, `Bad ${index}`))
    expect(handle.records()).toHaveLength(ELICITATION_RECORDS_MAX)
    const { card, result } = await ask(h, handle)
    await h.broker.answer(CHAT_A, card.id, { action: 'accept', content: { name: SECRET_VALUE } })
    await result
    expect(JSON.stringify(seen)).not.toContain(SECRET_VALUE)
    expect(JSON.stringify(handle.records())).not.toContain(SECRET_VALUE)
    handle.end()
  })

  it('a request for a call whose signal already aborted is cancelled (`stopped`)', async () => {
    const h = harness()
    const stopped = call()
    const handle = h.broker.begin(stopped)
    stopped.controller.abort(new Error('Stop'))
    expect(await h.broker.handler(KEY)(request())).toEqual({ action: 'cancel' })
    expect(handle.records()).toEqual([expect.objectContaining({ action: 'cancel', reason: 'stopped', fields: ['name'] })])
    expect(h.broker.pendingCount(CHAT_A)).toBe(0)
    handle.end()
  })
})

describe('answers (W14.3-T5)', () => {
  it('validates the content: 400 with field issues on [content, field]; the request keeps waiting', async () => {
    const h = harness()
    const handle = h.broker.begin(call())
    const { card, result } = await ask(h, handle, request(CONTACT_SCHEMA))
    const invalid = h.broker.answer(CHAT_A, card.id, { action: 'accept', content: { name: SECRET_VALUE, email: 'not-an-email', age: 17 } })
    await expect(invalid).rejects.toMatchObject({
      code: 'validation_error',
      details: { issues: [
        { path: ['content', 'email'], code: 'format' },
        { path: ['content', 'age'], code: 'too-small' },
      ] },
    })
    await expect(h.broker.answer(CHAT_A, card.id, { action: 'accept' })).rejects.toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['content', 'name'], code: 'required' }, { path: ['content', 'email'], code: 'required' }] } })
    await expect(h.broker.answer(CHAT_A, card.id, { action: 'accept', content: { name: 'x', email: 'a@b.co', extra: 'y' } })).rejects.toMatchObject({ details: { issues: [{ path: ['content', 'extra'], code: 'unknown-field' }] } })
    expect(await settled(result)).toBe(false)
    expect(handle.waiting()).toBe(true)
    expect(await h.broker.answer(CHAT_A, card.id, { action: 'accept', content: { name: ' Ada ', email: ' ada@example.com ', age: '36' } })).toEqual({ action: 'accept' })
    // Cleaned values reach the server (formats trimmed, numbers as numbers); other strings stay as typed.
    expect(await result).toEqual({ action: 'accept', content: { name: ' Ada ', email: 'ada@example.com', age: 36 } })
    handle.end()
  })

  it('404 for an unknown id or another chat\'s request; 409 stale once answered or after the call ended', async () => {
    const h = harness()
    const handle = h.broker.begin(call())
    const { card, result } = await ask(h, handle)
    await expect(h.broker.answer(CHAT_A, 'eli_AAAAAAAAAAAAAAAA', { action: 'decline' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(h.broker.answer(CHAT_B, card.id, { action: 'decline' })).rejects.toMatchObject({ code: 'not_found' })
    expect(await h.broker.answer(CHAT_A, card.id, { action: 'decline' })).toEqual({ action: 'decline' })
    expect(await result).toEqual({ action: 'decline' })
    await expect(h.broker.answer(CHAT_A, card.id, { action: 'accept', content: { name: 'x' } })).rejects.toMatchObject({ code: 'conflict', message: STALE_ELICITATION_MESSAGE, details: { reason: 'stale' } })
    // Another chat never learns that the id exists.
    await expect(h.broker.answer(CHAT_B, card.id, { action: 'decline' })).rejects.toMatchObject({ code: 'not_found' })

    const second = await ask(h, handle)
    handle.end()
    expect(await second.result).toEqual({ action: 'cancel' })
    await expect(h.broker.answer(CHAT_A, second.card.id, { action: 'decline' })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'stale' } })
  })
})

describe('cancel paths (W14.3-T6)', () => {
  it('the wait times out after waitMs: cancel / timeout, then 409 stale; no timer left', async () => {
    vi.useFakeTimers()
    const h = harness()
    const handle = h.broker.begin(call())
    const { card, result } = await ask(h, handle)
    await vi.advanceTimersByTimeAsync(LIMITS.mcpElicitationWaitMs - 1)
    expect(await settled(result)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toEqual({ action: 'cancel' })
    expect(handle.records()).toEqual([expect.objectContaining({ id: card.id, action: 'cancel', reason: 'timeout' })])
    await expect(h.broker.answer(CHAT_A, card.id, { action: 'decline' })).rejects.toMatchObject({ details: { reason: 'stale' } })
    handle.end()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('an injected waitMs (HF_TEST_ELICITATION_WAIT_MS) bounds the wait and expiresAt; an answer after expiresAt is stale', async () => {
    vi.useFakeTimers({ now: 5000 })
    const h = harness(1500)
    const handle = h.broker.begin(call())
    const { card, result } = await ask(h, handle)
    expect(card.expiresAt).toBe(5000 + 1500)
    // The clock passed expiresAt before the timer ran: the answer is refused and the wait ends with the timeout.
    vi.setSystemTime(5000 + 1500)
    await expect(h.broker.answer(CHAT_A, card.id, { action: 'decline' })).rejects.toMatchObject({ details: { reason: 'stale' } })
    expect(await result).toEqual({ action: 'cancel' })
    expect(handle.records()[0]).toMatchObject({ reason: 'timeout' })
    handle.end()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stop (the call\'s signal) and the call\'s end: cancel / stopped', async () => {
    const h = harness()
    const stopped = call()
    const handle = h.broker.begin(stopped)
    const first = await ask(h, handle)
    stopped.controller.abort(new Error('Stopped by the user'))
    expect(await first.result).toEqual({ action: 'cancel' })
    expect(handle.records()).toEqual([expect.objectContaining({ id: first.card.id, action: 'cancel', reason: 'stopped' })])
    expect(handle.pending()).toBeNull()
    handle.end()

    const other = h.broker.begin(call())
    const second = await ask(h, other)
    other.end()
    other.end()
    expect(await second.result).toEqual({ action: 'cancel' })
    expect(other.records()).toEqual([expect.objectContaining({ id: second.card.id, action: 'cancel', reason: 'stopped' })])
    expect(h.broker.pendingCount(CHAT_A)).toBe(0)
  })

  it('follows the event bus only while a request waits (a call that never elicits leaves no subscriber)', async () => {
    const h = harness()
    const handle = h.broker.begin(call())
    expect(h.events.subscriberCount()).toBe(0)
    const first = await ask(h, handle)
    expect(h.events.subscriberCount()).toBe(1)
    const second = await ask(h, h.broker.begin(call({ runtimeKey: 'mcp:other#1' })), request(), 'mcp:other#1')
    expect(h.events.subscriberCount()).toBe(1)
    await h.broker.answer(CHAT_A, first.card.id, { action: 'decline' })
    expect(h.events.subscriberCount()).toBe(1)
    await h.broker.answer(CHAT_A, second.card.id, { action: 'decline' })
    expect(h.events.subscriberCount()).toBe(0)
    handle.end()
  })

  it('chat delete (chat.deleted, cancelChat) and key rotation (key.rotated): cancel / stopped', async () => {
    const h = harness()
    const a = h.broker.begin(call())
    const first = await ask(h, a)
    h.chats.delete(CHAT_A)
    h.events.emit('chat.deleted', { id: CHAT_A })
    expect(await first.result).toEqual({ action: 'cancel' })
    expect(a.records()[0]).toMatchObject({ action: 'cancel', reason: 'stopped' })
    // The deleted chat's ids are forgotten (404, not 409).
    await expect(h.broker.answer(CHAT_A, first.card.id, { action: 'decline' })).rejects.toMatchObject({ code: 'not_found' })
    a.end()

    const b = h.broker.begin(call({ chatId: CHAT_B, runtimeKey: 'mcp:b#1' }))
    const c = h.broker.begin(call({ chatId: CHAT_A, runtimeKey: 'mcp:a#1' }))
    const second = await ask(h, b, request(), 'mcp:b#1')
    const third = await ask(h, c, request(), 'mcp:a#1')
    expect([h.broker.pendingCount(CHAT_B), h.broker.pendingCount(CHAT_A)]).toEqual([1, 1])
    h.broker.cancelChat(CHAT_B)
    expect(await second.result).toEqual({ action: 'cancel' })
    expect(await settled(third.result)).toBe(false)
    h.events.publish(createServerEvent('key.rotated', { keyVersion: 2, rotatedAt: 1, chatIds: [] }, 1))
    expect(await third.result).toEqual({ action: 'cancel' })
    expect(c.records()[0]).toMatchObject({ action: 'cancel', reason: 'stopped' })
    b.end()
    c.end()
  })

  it('stop(): every wait cancelled (stopped), registries and timers cleared, later requests cancelled; idempotent', async () => {
    vi.useFakeTimers()
    const h = harness()
    const a = h.broker.begin(call())
    const b = h.broker.begin(call({ chatId: CHAT_B, runtimeKey: 'mcp:b#1' }))
    const first = await ask(h, a)
    const second = await ask(h, b, request(), 'mcp:b#1')
    await vi.waitFor(() => expect(awaitingEvents(h, CHAT_A)).toEqual([true]))
    expect(vi.getTimerCount()).toBe(2)
    await h.broker.stop()
    expect(await first.result).toEqual({ action: 'cancel' })
    expect(await second.result).toEqual({ action: 'cancel' })
    expect([a.records()[0]?.reason, b.records()[0]?.reason]).toEqual(['stopped', 'stopped'])
    expect(vi.getTimerCount()).toBe(0)
    expect(h.events.subscriberCount()).toBe(0)
    expect(await h.broker.handler(KEY)(request())).toEqual({ action: 'cancel' })
    expect([h.broker.pendingCount(CHAT_A), h.broker.pendingCount(CHAT_B)]).toEqual([0, 0])
    a.end()
    b.end()
    await expect(h.broker.stop()).resolves.toBeUndefined()
    // No `chat.updated` after the stop.
    expect(awaitingEvents(h, CHAT_A)).toEqual([true])
  })
})

describe('signals (W14.3-T7)', () => {
  it('pendingCount and chat.updated with awaitingInput on every 0 <-> >= 1 transition (summary + active leaf)', async () => {
    const h = harness()
    const a = h.broker.begin(call())
    const b = h.broker.begin(call({ runtimeKey: 'mcp:other#1' }))
    const first = await ask(h, a)
    await vi.waitFor(() => expect(awaitingEvents(h, CHAT_A)).toEqual([true]))
    const event = h.events.ofType('chat.updated')[0]!
    expect(chatUpdatedDataSchema.parse(event.data)).toEqual({ ...summaryOf(CHAT_A), activeLeafId: null, awaitingInput: true })
    // A second pending request of the chat changes nothing on the wire.
    const second = await ask(h, b, request(), 'mcp:other#1')
    expect(h.broker.pendingCount(CHAT_A)).toBe(2)
    await h.broker.answer(CHAT_A, first.card.id, { action: 'decline' })
    expect(h.broker.pendingCount(CHAT_A)).toBe(1)
    await h.broker.answer(CHAT_A, second.card.id, { action: 'decline' })
    expect(h.broker.pendingCount(CHAT_A)).toBe(0)
    await vi.waitFor(() => expect(awaitingEvents(h, CHAT_A)).toEqual([true, false]))
    await first.result
    await second.result
    a.end()
    b.end()
  })

  it('nothing for a deleted chat; a failing chats read is only a debug line', async () => {
    const h = harness()
    h.chats.delete(CHAT_A)
    const a = h.broker.begin(call())
    const first = await ask(h, a)
    a.end()
    await first.result
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(h.events.ofType('chat.updated')).toEqual([])
  })

  it('never logs the request message or a value', async () => {
    const h = harness()
    const handle = h.broker.begin(call())
    const { card, result } = await ask(h, handle, request(SIMPLE_SCHEMA, SECRET_MESSAGE))
    await h.broker.answer(CHAT_A, card.id, { action: 'accept', content: { name: SECRET_VALUE } })
    await result
    await expect(h.broker.answer(CHAT_A, card.id, { action: 'accept', content: { name: SECRET_VALUE } })).rejects.toThrow()
    await h.broker.handler(KEY)(request({ type: 'array' }, SECRET_MESSAGE))
    handle.end()
    await h.broker.handler(KEY)(request(SIMPLE_SCHEMA, SECRET_MESSAGE))
    const text = h.logs.text()
    expect(text).toContain('mcp elicitation ended')
    expect(text).not.toContain(SECRET_MESSAGE)
    expect(text).not.toContain(SECRET_VALUE)
    expect(h.logs.records.filter(record => record.level !== 'debug').map(record => record.msg).sort()).toEqual(['mcp elicitation ended', 'mcp elicitation waiting'])
  })
})
