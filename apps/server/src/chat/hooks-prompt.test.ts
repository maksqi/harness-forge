// `UserPromptSubmit` and `SessionStart` at submit (W11.2-T1 / T3) through `POST /api/chat` with the C36 fake hook
// service and `mock:hooks`: a block stores nothing (no chat row on `/`), a context lands on the user message and in the
// model text, a regenerate and an approval continuation reuse it, an edit runs it again, `SessionStart` `startup` once
// and `compact` after `/compact`; plus the unit rules of `runPromptHooks` (origins, carriers, commands, image turns) and
// `blockingRecord`. Prompts, contexts and reasons never reach the log at `info`.
import type { ChatDetail, ChatRequestBody, HarnessUIMessage, HookData, ServerEvent } from '@harness-forge/shared'
import type { HookEventResult, HookRunInput, HookScope } from '../services/hooks/types.ts'
import type { TestApp } from '../testing/create-test-app.ts'
import type { FakeHookService } from '../testing/fake-hooks.ts'
import type { AppDeps } from '../types.ts'
import type { PromptHooksInput, PromptHooksRun } from './hooks-prompt.ts'
import { chatDetailSchema, HarnessError, hookModelText } from '@harness-forge/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createSilentLogger } from '../logger.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { createFakeHookSnapshot, fakeHookRecord, fakeHookResult } from '../testing/fake-hooks.ts'
import { blockingRecord, hookBlockedError, isHookBlockedError, PROMPT_HOOKS_HEADER, promptText, runPromptHooks, withPromptHooksHeader } from './hooks-prompt.ts'
import { answerApprovals, chatBody, messageText, postChat, readSse, runnerOf, streamedText, testChatId } from './testing.ts'

const PROMPT_SECRET = 'prompt-sentinel-3f9a'
const CONTEXT_SECRET = 'context-sentinel-71bd'
const REASON_SECRET = 'reason-sentinel-c40e'

let nextChat = 0xD100

function newChatId(): string {
  nextChat += 1
  return testChatId(nextChat)
}

function hooksBody(chatId: string, text: string, overrides: Partial<ChatRequestBody> = {}): ChatRequestBody {
  return chatBody(chatId, text, { modelRef: 'mock:hooks', ...overrides })
}

/** The `data-hook` records of a message. */
function recordsOf(message: HarnessUIMessage | undefined): HookData[] {
  return (message?.parts ?? []).flatMap(part => (part.type === 'data-hook' ? [(part as { data: HookData }).data] : []))
}

describe('prompt hooks at submit (W11.2-T1, T3)', () => {
  let t: TestApp
  let hooks: FakeHookService
  let events: ServerEvent[] = []

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, hooks: 'fake' })
    hooks = t.deps.hooks as FakeHookService
    t.deps.events.subscribe(event => void events.push(event))
    t.deps.registry.tools.register('mock', {
      name: 'hook_ask',
      description: 'Asks before it runs.',
      inputSchema: z.object({ text: z.string() }),
      policy: 'ask',
      execute: async (input: unknown) => ({ echoed: (input as { text: string }).text }),
    })
  })

  beforeEach(() => {
    events = []
    hooks.results.clear()
    hooks.targets.clear()
    hooks.present.clear()
    hooks.runCalls.length = 0
    hooks.snapshots.length = 0
  })

  afterAll(async () => {
    await t.close()
  })

  async function detail(chatId: string): Promise<ChatDetail> {
    return chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId}`)).json())
  }

  async function send(body: ChatRequestBody): Promise<string> {
    const { chunks } = await readSse(await postChat(t, body))
    await runnerOf(t).idle()
    return streamedText(chunks)
  }

  function prompts(): HookRunInput[] {
    return hooks.runCalls.filter(call => call.event === 'UserPromptSubmit').map(call => call.input)
  }

  it('a blocked first message on / stores nothing: 409 hook-blocked with the record, no chat row', async () => {
    const record = fakeHookRecord('UserPromptSubmit', 'blocked', { reason: REASON_SECRET })
    hooks.results.set('UserPromptSubmit', fakeHookResult({ block: true, reason: REASON_SECRET, record }))
    const chatId = newChatId()
    const response = await postChat(t, hooksBody(chatId, `my password is ${PROMPT_SECRET}`))
    expect(response.status).toBe(409)
    const envelope = await response.json() as { error: { code: string, message: string, details: unknown } }
    expect(envelope.error).toEqual({ code: 'conflict', message: `A hook blocked this message: ${REASON_SECRET}`, details: { reason: 'hook-blocked', chatId, hook: record } })
    expect((await t.request(`/api/chats/${chatId}`)).status).toBe(404)
    // The row the request created went again (open point 14: `chat.created`, then `chat.deleted`).
    expect(events.filter(event => (event.type === 'chat.created' && event.data.id === chatId) || (event.type === 'chat.deleted' && event.data.id === chatId)).map(event => event.type)).toEqual(['chat.created', 'chat.deleted'])
    expect(events.some(event => event.type === 'run.started')).toBe(false)
    // The payload: the typed text, the scope of the request.
    expect(prompts()).toEqual([{ messageId: expect.any(String), prompt: `my password is ${PROMPT_SECRET}` }])
    expect(hooks.snapshots[0]!.scope).toEqual({ chatId, projectId: null, workspace: null, toolMode: 'ask', origin: 'request', modelRef: 'mock:hooks' })
    await runnerOf(t).idle()
    expect(runnerOf(t).hasRun(chatId)).toBe(false)
  })

  it('a blocked message in an existing chat stores nothing; continue: false blocks with its stop reason', async () => {
    const chatId = newChatId()
    expect(await send(hooksBody(chatId, 'first'))).toBe('Hooks mock: first')
    hooks.results.set('UserPromptSubmit', fakeHookResult({ continue: false, stopReason: 'wait for the review' }))
    const response = await postChat(t, hooksBody(chatId, 'second'))
    expect(response.status).toBe(409)
    const envelope = await response.json() as { error: { message: string, details: { reason: string, hook: HookData } } }
    expect(envelope.error.message).toBe('A hook blocked this message: wait for the review')
    expect(envelope.error.details.hook).toMatchObject({ event: 'UserPromptSubmit', outcome: 'stopped', reason: 'wait for the review', hooks: [] })
    expect((await detail(chatId)).messages.map(message => messageText(message))).toEqual(['first', 'Hooks mock: first'])
  })

  it('a context lands on the user message and in the model text; a regenerate reuses it, an edit runs it again', async () => {
    const record = fakeHookRecord('UserPromptSubmit', 'context', { context: `Branch: main ${CONTEXT_SECRET}` })
    hooks.results.set('UserPromptSubmit', fakeHookResult({ context: record.context!, record }))
    const chatId = newChatId()
    const first = hooksBody(chatId, `context? ${PROMPT_SECRET}`)
    // The trigger is the last line: put the secret on a line before it.
    first.message.parts = [{ type: 'text', text: `${PROMPT_SECRET}\ncontext?` }]
    expect(await send(first)).toBe(`Context: UserPromptSubmit:Branch: main ${CONTEXT_SECRET}`)
    const stored = await detail(chatId)
    expect(stored.messages[0]!.parts).toEqual([{ type: 'text', text: `${PROMPT_SECRET}\ncontext?` }, { type: 'data-hook', data: record }])
    expect(prompts()).toHaveLength(1)

    // A regenerate reuses the stored record (no new run) and the model still reads it.
    expect(await send({ ...first, trigger: 'regenerate-message', messageId: stored.messages[1]!.id })).toBe(`Context: UserPromptSubmit:Branch: main ${CONTEXT_SECRET}`)
    expect(prompts()).toHaveLength(1)

    // An edit (a sibling of the first message) runs it again.
    hooks.results.set('UserPromptSubmit', fakeHookResult())
    expect(await send(hooksBody(chatId, 'context?', { parentId: null }))).toBe('Context: none')
    expect(prompts()).toHaveLength(2)
    const edited = await detail(chatId)
    expect(recordsOf(edited.messages[0])).toEqual([])

    // Nothing of the prompt, the context or the reason at info or above.
    const loud = t.logs.records.filter(entry => entry.level !== 'debug').map(entry => JSON.stringify(entry)).join('\n')
    expect(loud).not.toContain(PROMPT_SECRET)
    expect(loud).not.toContain(CONTEXT_SECRET)
    expect(loud).not.toContain(REASON_SECRET)
  })

  it('an approval continuation reuses the turn\'s record; the model text keeps it', async () => {
    const record = fakeHookRecord('UserPromptSubmit', 'context', { context: 'lint ok' })
    hooks.results.set('UserPromptSubmit', fakeHookResult({ context: 'lint ok', record }))
    const chatId = newChatId()
    const body = hooksBody(chatId, 'call hook_ask {"text":"a"}')
    await send(body)
    const waiting = (await detail(chatId)).messages.at(-1)!
    expect(waiting.parts.some(part => (part as { state?: string }).state === 'approval-requested')).toBe(true)
    expect(await send({ ...body, message: answerApprovals(waiting, true) })).toBe('Called hook_ask: ok | {"echoed":"a"} | hooks: none')
    expect(prompts()).toHaveLength(1)
    expect(recordsOf((await detail(chatId)).messages[0])).toEqual([record])
  })

  it('sessionStart startup fires once, before UserPromptSubmit; compact fires at the first turn after /compact', async () => {
    const started = fakeHookRecord('SessionStart', 'context', { context: 'Session notes' })
    const submitted = fakeHookRecord('UserPromptSubmit', 'context', { context: 'Prompt notes' })
    hooks.results.set('SessionStart', input => fakeHookResult({ context: `Session ${input.sessionSource}`, record: { ...started, id: fakeHookRecord('SessionStart', 'context').id, context: `Session ${input.sessionSource}` } }))
    hooks.results.set('UserPromptSubmit', fakeHookResult({ context: 'Prompt notes', record: submitted }))
    const chatId = newChatId()
    expect(await send(hooksBody(chatId, 'context?'))).toBe('Context: SessionStart:Session startup; UserPromptSubmit:Prompt notes')
    expect(hooks.runCalls.map(call => [call.event, call.input.sessionSource])).toEqual([['SessionStart', 'startup'], ['UserPromptSubmit', undefined]])
    const first = await detail(chatId)
    expect(recordsOf(first.messages[0]).map(data => data.event)).toEqual(['SessionStart', 'UserPromptSubmit'])

    hooks.runCalls.length = 0
    await send(hooksBody(chatId, 'second'))
    expect(hooks.runCalls.map(call => call.event)).toEqual(['UserPromptSubmit'])

    // `/compact` runs no prompt hook; the next turn starts a `compact` session, the one after that none.
    hooks.runCalls.length = 0
    await send(hooksBody(chatId, '/compact'))
    expect(hooks.runCalls.filter(call => call.event === 'UserPromptSubmit' || call.event === 'SessionStart')).toEqual([])
    expect((await detail(chatId)).messages.at(-1)!.parts.some(part => part.type === 'data-compaction')).toBe(true)
    hooks.runCalls.length = 0
    await send(hooksBody(chatId, 'after the compaction'))
    expect(hooks.runCalls.map(call => [call.event, call.input.sessionSource])).toEqual([['SessionStart', 'compact'], ['UserPromptSubmit', undefined]])
    const compacted = await detail(chatId)
    expect(recordsOf(compacted.messages.at(-2)).map(data => [data.event, data.context])).toEqual([['SessionStart', 'Session compact'], ['UserPromptSubmit', 'Prompt notes']])
    hooks.runCalls.length = 0
    await send(hooksBody(chatId, 'again'))
    expect(hooks.runCalls.map(call => call.event)).toEqual(['UserPromptSubmit'])
  })

  it('the accepted response counts the records added to the new user message (W11.19); none without records', async () => {
    hooks.results.set('SessionStart', fakeHookResult({ context: 'Session notes', record: fakeHookRecord('SessionStart', 'context', { context: 'Session notes' }) }))
    hooks.results.set('UserPromptSubmit', fakeHookResult({ context: 'Prompt notes', record: fakeHookRecord('UserPromptSubmit', 'context', { context: 'Prompt notes' }) }))
    const chatId = newChatId()
    const first = hooksBody(chatId, 'context?')
    const response = await postChat(t, first)
    expect(response.status).toBe(200)
    expect(response.headers.get(PROMPT_HOOKS_HEADER)).toBe('2')
    await readSse(response)
    await runnerOf(t).idle()
    const stored = await detail(chatId)
    expect(recordsOf(stored.messages[0])).toHaveLength(2)

    // A regenerate reuses the stored records (no new user message): no header.
    const regenerated = await postChat(t, { ...first, trigger: 'regenerate-message', messageId: stored.messages[1]!.id })
    expect(regenerated.headers.has(PROMPT_HOOKS_HEADER)).toBe(false)
    await readSse(regenerated)
    await runnerOf(t).idle()

    // A message whose hooks said nothing.
    hooks.results.clear()
    hooks.present.add('UserPromptSubmit')
    const plain = await postChat(t, hooksBody(chatId, 'plain', { parentId: (await detail(chatId)).messages.at(-1)!.id }))
    expect(plain.status).toBe(200)
    expect(plain.headers.has(PROMPT_HOOKS_HEADER)).toBe(false)
    await readSse(plain)
    await runnerOf(t).idle()
  })

  it('withPromptHooksHeader: only for a request whose new user message has hook records', () => {
    const record = fakeHookRecord('UserPromptSubmit', 'context', { context: 'c' })
    const hooked = { parts: [{ type: 'text', text: 'hi' }, { type: 'data-hook', data: record }, { type: 'data-hook', data: record }] } as HarnessUIMessage
    expect(withPromptHooksHeader(new Response('x'), hooked, 'request').headers.get(PROMPT_HOOKS_HEADER)).toBe('2')
    expect(withPromptHooksHeader(new Response('x'), hooked, 'queue').headers.has(PROMPT_HOOKS_HEADER)).toBe(false)
    expect(withPromptHooksHeader(new Response('x'), { parts: [{ type: 'text', text: 'hi' }] } as HarnessUIMessage, 'request').headers.has(PROMPT_HOOKS_HEADER)).toBe(false)
    expect(withPromptHooksHeader(new Response('x'), null, 'request').headers.has(PROMPT_HOOKS_HEADER)).toBe(false)
    // Immutable headers (a fetched response) never make it throw.
    const frozen = Response.error()
    expect(withPromptHooksHeader(frozen, hooked, 'request')).toBe(frozen)
  })

  it('sessionStart continue: false blocks the message (409 hook-blocked, nothing stored)', async () => {
    hooks.results.set('SessionStart', fakeHookResult({ continue: false, stopReason: 'not today', record: fakeHookRecord('SessionStart', 'stopped', { reason: 'not today' }) }))
    hooks.present.add('UserPromptSubmit')
    const chatId = newChatId()
    const response = await postChat(t, hooksBody(chatId, 'hi'))
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { details: { hook: HookData } } }).error.details.hook).toMatchObject({ event: 'SessionStart', outcome: 'stopped' })
    expect(hooks.runCalls.map(call => call.event)).toEqual(['SessionStart'])
    expect((await t.request(`/api/chats/${chatId}`)).status).toBe(404)
  })
})

// ---------- unit rules ----------

const SCOPE_CHAT = testChatId(0xD1FF)

function plannedRun(overrides: Partial<PromptHooksRun> = {}): PromptHooksRun {
  const message: HarnessUIMessage = { id: 'msg_u000000000000001', role: 'user', parts: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] }
  return {
    kind: 'new',
    chat: { id: SCOPE_CHAT, projectId: null } as PromptHooksRun['chat'],
    target: { kind: 'chat' } as PromptHooksRun['target'],
    resolved: { modelRef: 'mock:hooks' } as PromptHooksRun['resolved'],
    history: [message],
    userMessage: message,
    command: null,
    workspace: null,
    ...overrides,
  }
}

function promptInput(snapshotResults: Parameters<typeof createFakeHookSnapshot>[0], overrides: Partial<PromptHooksInput> = {}) {
  const snapshot = createFakeHookSnapshot(snapshotResults)
  const scopes: HookScope[] = []
  const deps = { hooks: { snapshot: async (scope: HookScope) => {
    scopes.push(scope)
    return snapshot
  } } } as unknown as AppDeps
  const input: PromptHooksInput = {
    deps,
    prepared: plannedRun(),
    body: chatBody(SCOPE_CHAT, 'hello', { modelRef: 'mock:hooks', toolMode: 'auto' }),
    origin: 'request',
    serverMessage: false,
    signal: new AbortController().signal,
    logger: createSilentLogger(),
    ...overrides,
  }
  return { input, snapshot, scopes }
}

describe('runPromptHooks (unit)', () => {
  const context = (event: 'SessionStart' | 'UserPromptSubmit', text: string): HookEventResult => fakeHookResult({ context: text, record: fakeHookRecord(event, 'context', { context: text }) })

  it('a request runs SessionStart (startup) then UserPromptSubmit with the typed text and the command name', async () => {
    const { input, snapshot, scopes } = promptInput({ results: { SessionStart: context('SessionStart', 's'), UserPromptSubmit: context('UserPromptSubmit', 'u') } })
    const command = { name: 'review', input: 'x', type: 'prompt' as const, expansion: 'Review x' }
    const message: HarnessUIMessage = { id: 'msg_u000000000000002', role: 'user', parts: [{ type: 'text', text: '/review x' }], metadata: { modelRef: 'mock:hooks', startedAt: 1, command } }
    const result = await runPromptHooks({ ...input, prepared: plannedRun({ history: [message], userMessage: message }) })
    expect(result.records.map(record => [record.event, record.context])).toEqual([['SessionStart', 's'], ['UserPromptSubmit', 'u']])
    expect(snapshot.calls.map(call => call.input)).toEqual([
      { messageId: message.id, sessionSource: 'startup' },
      { messageId: message.id, prompt: '/review x', command: 'review' },
    ])
    expect(scopes).toEqual([{ chatId: SCOPE_CHAT, projectId: null, workspace: null, toolMode: 'auto', origin: 'request', modelRef: 'mock:hooks' }])
  })

  it('a queued turn runs SessionStart only and attaches the records of the enqueue after it; no session → no snapshot', async () => {
    const queued = fakeHookRecord('UserPromptSubmit', 'context', { context: 'from the queue' })
    const { input, snapshot, scopes } = promptInput({ results: { SessionStart: context('SessionStart', 's'), UserPromptSubmit: context('UserPromptSubmit', 'u') } })
    const first = await runPromptHooks({ ...input, origin: 'queue', precomputed: [queued] })
    expect(first.records.map(record => record.event)).toEqual(['SessionStart', 'UserPromptSubmit'])
    expect(first.records[1]).toBe(queued)
    expect(snapshot.calls.map(call => call.event)).toEqual(['SessionStart'])
    expect(scopes[0]!.origin).toBe('queue')
    // A path that does not start a session: only the precomputed records, no snapshot.
    const earlier: HarnessUIMessage = { id: 'msg_u000000000000003', role: 'user', parts: [{ type: 'text', text: 'before' }] }
    const run = plannedRun()
    const second = await runPromptHooks({ ...input, origin: 'queue', precomputed: [queued], prepared: { ...run, history: [earlier, ...run.history] } })
    expect(second.records).toEqual([queued])
    expect(scopes).toHaveLength(1)
  })

  it('no hook for carriers, task and hook turns, regenerates, command replies and image turns (precomputed records pass)', async () => {
    const queued = fakeHookRecord('UserPromptSubmit', 'context', { context: 'q' })
    const { input, snapshot } = promptInput({ results: { SessionStart: context('SessionStart', 's'), UserPromptSubmit: context('UserPromptSubmit', 'u') } })
    const cases: PromptHooksInput[] = [
      { ...input, serverMessage: true, origin: 'hook' },
      { ...input, origin: 'task' },
      { ...input, origin: 'hook' },
      { ...input, prepared: plannedRun({ kind: 'regenerate', userMessage: null }) },
      { ...input, prepared: plannedRun({ kind: 'continuation', userMessage: null }) },
      { ...input, prepared: plannedRun({ command: { kind: 'compact' } as PromptHooksRun['command'] }) },
      { ...input, prepared: plannedRun({ target: { kind: 'image' } as PromptHooksRun['target'] }) },
    ]
    for (const entry of cases)
      expect((await runPromptHooks({ ...entry, precomputed: [queued] })).records).toEqual([queued])
    expect(snapshot.calls).toEqual([])
  })

  it('rejects on an abort; a block throws the 409 with the record', async () => {
    const controller = new AbortController()
    controller.abort()
    const { input } = promptInput({ results: { UserPromptSubmit: fakeHookResult({ block: true, reason: 'nope' }) } })
    await expect(runPromptHooks({ ...input, signal: controller.signal })).rejects.toBeDefined()
    const error = await runPromptHooks(input).catch((caught: unknown) => caught)
    expect(isHookBlockedError(error)).toBe(true)
    expect((error as HarnessError).details).toMatchObject({ reason: 'hook-blocked', chatId: SCOPE_CHAT, hook: { event: 'UserPromptSubmit', outcome: 'blocked', reason: 'nope', hooks: [] } })
    expect(isHookBlockedError(hookBlockedError('c', fakeHookRecord('Stop', 'blocked')))).toBe(true)
    expect(hookBlockedError('c', fakeHookRecord('UserPromptSubmit', 'blocked')).message).toBe('A hook blocked this message.')
    expect(hookBlockedError('c', fakeHookRecord('UserPromptSubmit', 'blocked', { reason: '  ' })).message).toBe('A hook blocked this message.')
    expect(isHookBlockedError(new HarnessError({ code: 'conflict', message: 'x', details: { reason: 'run-active' } }))).toBe(false)
  })

  it('blockingRecord completes the reason of the service record or builds one; promptText joins the text parts', () => {
    const record = fakeHookRecord('UserPromptSubmit', 'blocked')
    expect(blockingRecord('UserPromptSubmit', fakeHookResult({ block: true, reason: 'why', record }))).toEqual({ ...record, reason: 'why' })
    const withReason = { ...record, reason: 'own' }
    expect(blockingRecord('UserPromptSubmit', fakeHookResult({ block: true, reason: 'why', record: withReason }))).toBe(withReason)
    expect(blockingRecord('SessionStart', fakeHookResult({ continue: false, stopReason: 'stop', reason: 'other' }), () => 5)).toEqual({ id: expect.stringMatching(/^hev_/), event: 'SessionStart', outcome: 'stopped', createdAt: 5, hooks: [], reason: 'stop' })
    expect(blockingRecord('UserPromptSubmit', fakeHookResult({ block: true }), () => 5)).toEqual({ id: expect.stringMatching(/^hev_/), event: 'UserPromptSubmit', outcome: 'blocked', createdAt: 5, hooks: [] })
    expect(blockingRecord('UserPromptSubmit', fakeHookResult({ block: true, reason: 'x'.repeat(3000) })).reason).toHaveLength(2000)
    expect(promptText([{ type: 'text', text: 'a' }, { type: 'file' }, { type: 'text', text: 'b' }])).toBe('a\nb')
    expect(hookModelText(fakeHookRecord('UserPromptSubmit', 'context', { context: 'c' }), 'user')).toContain('<hook-context event="UserPromptSubmit">')
  })
})
