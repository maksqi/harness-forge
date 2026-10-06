// Stop continuation turns (W11.2-T4) and the Notification hooks of a run waiting for an approval (W11.2-T7) through the
// chat runner, with the C36 fake hook service and `mock:hooks`: a blocking `Stop` hook starts one hook turn (origin
// `hook`, a carrier user message holding only the record, `Hook continuation: <reason>`, `stop_hook_active`), an
// always-blocking hook stops after five hook turns with the notice `hook-continuation-limit`, a queued item goes first,
// no hook turn while an approval is pending or after a Stop, a background result is delivered inside the hook turn, and
// `startHookTurn` itself (the carrier, the dropped race, only `Stop` records).
import type { HarnessUIMessage, HookData, ServerEvent, TaskOutput } from '@harness-forge/shared'
import type { TestApp } from '../testing/create-test-app.ts'
import type { FakeBackgroundTasks } from '../testing/fake-background-tasks.ts'
import type { FakeHookService } from '../testing/fake-hooks.ts'
import type { BackgroundLaunchInput } from './background/types.ts'
import type { HookTurnInput } from './index.ts'
import { chatDetailSchema, createMessageId, LIMITS } from '@harness-forge/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createMemoryLogger } from '../logger.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { fakeHookRecord, fakeHookResult } from '../testing/fake-hooks.ts'
import { hookCarrierMessage, hookRequestId, startHookTurn } from './index.ts'
import { runConflict } from './runs.ts'
import { chatBody, messageText, postChat, readSse, runnerOf, testChatId } from './testing.ts'

const STOP_REASON = 'run the tests'

let nextChat = 0xD300

function newChatId(): string {
  nextChat += 1
  return testChatId(nextChat)
}

function stopRecord(reason = STOP_REASON): HookData {
  return fakeHookRecord('Stop', 'continued', { reason })
}

/** `stop-once`: blocks unless `stop_hook_active`. */
function stopOnce(): ReturnType<typeof fakeHookResult> | ((input: { stopHookActive?: boolean }) => ReturnType<typeof fakeHookResult>) {
  return input => (input.stopHookActive === true ? fakeHookResult() : fakeHookResult({ block: true, reason: STOP_REASON, record: stopRecord() }))
}

function recordsOf(message: HarnessUIMessage | undefined): HookData[] {
  return (message?.parts ?? []).flatMap(part => (part.type === 'data-hook' ? [(part as { data: HookData }).data] : []))
}

interface Harness {
  t: TestApp
  hooks: FakeHookService
  events: ServerEvent[]
}

async function harness(options: { background?: boolean } = {}): Promise<Harness> {
  const t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, hooks: 'fake', ...(options.background === true ? { backgroundTasks: 'fake' as const } : {}) })
  const events: ServerEvent[] = []
  t.deps.events.subscribe(event => void events.push(event))
  return { t, hooks: t.deps.hooks as FakeHookService, events }
}

function started(h: Harness, chatId: string) {
  return h.events.flatMap(event => (event.type === 'run.started' && event.data.chatId === chatId ? [event.data] : []))
}

async function finished(h: Harness, chatId: string, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(h.events.filter(event => event.type === 'run.finished' && event.data.chatId === chatId)).toHaveLength(count)
  }, { timeout: 10_000, interval: 5 })
  await runnerOf(h.t).idle()
}

async function messages(h: Harness, chatId: string): Promise<HarnessUIMessage[]> {
  return chatDetailSchema.parse(await (await h.t.request(`/api/chats/${chatId}`)).json()).messages
}

describe('stop continuation turns (W11.2-T4) and Notification (W11.2-T7)', () => {
  let h: Harness

  beforeAll(async () => {
    h = await harness()
    h.t.deps.registry.tools.register('mock', {
      name: 'stop_ask',
      description: 'Asks before it runs.',
      inputSchema: z.object({ text: z.string() }),
      policy: 'ask',
      execute: async () => ({ ok: true }),
    })
  })

  beforeEach(() => {
    h.events.length = 0
    h.hooks.results.clear()
    h.hooks.targets.clear()
    h.hooks.present.clear()
    h.hooks.runCalls.length = 0
    h.hooks.snapshots.length = 0
  })

  afterAll(async () => {
    await h.t.close()
  })

  it('stop-once: one hook turn from a carrier user message, "Hook continuation:", then the chain stops', async () => {
    h.hooks.results.set('Stop', stopOnce())
    h.hooks.present.add('UserPromptSubmit')
    const chatId = newChatId()
    await readSse(await postChat(h.t, chatBody(chatId, 'hi', { modelRef: 'mock:hooks', toolMode: 'auto' })))
    await finished(h, chatId, 2)
    const stored = await messages(h, chatId)
    expect(stored.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(messageText(stored[1])).toBe('Hooks mock: hi')
    const record = recordsOf(stored[1])[0]!
    expect(record).toMatchObject({ event: 'Stop', outcome: 'continued', reason: STOP_REASON })
    expect(stored[1]!.parts.at(-1)).toEqual({ type: 'data-hook', data: record })
    expect(stored[2]!.parts).toEqual([{ type: 'data-hook', data: record }])
    expect(messageText(stored[3])).toBe(`Hook continuation: ${STOP_REASON}`)
    expect(recordsOf(stored[3])).toEqual([])
    // `run.started`: the request, then the hook turn with its carrier; `stop_hook_active` only in the hook turn.
    expect(started(h, chatId).map(data => [data.origin, data.userMessageId])).toEqual([['request', undefined], ['hook', stored[2]!.id]])
    expect(h.hooks.runCalls.filter(call => call.event === 'Stop').map(call => call.input.stopHookActive)).toEqual([false, true])
    // The hook turn's carrier runs no prompt hook; its snapshot has the origin `hook` and the request's model and mode.
    expect(h.hooks.runCalls.filter(call => call.event === 'UserPromptSubmit')).toHaveLength(1)
    expect(h.hooks.snapshots.at(-1)!.scope).toMatchObject({ chatId, origin: 'hook', modelRef: 'mock:hooks', toolMode: 'auto' })
  })

  it('an always-blocking Stop hook: five hook turns, then the notice hook-continuation-limit', async () => {
    h.hooks.results.set('Stop', () => fakeHookResult({ block: true, reason: 'again', record: stopRecord('again') }))
    const chatId = newChatId()
    await readSse(await postChat(h.t, chatBody(chatId, 'hi', { modelRef: 'mock:hooks' })))
    await finished(h, chatId, LIMITS.hookContinuationsMax + 1)
    // Give a sixth turn the chance to start: there is none.
    await new Promise(resolve => setTimeout(resolve, 50))
    await runnerOf(h.t).idle()
    expect(started(h, chatId).map(data => data.origin)).toEqual(['request', ...Array.from({ length: LIMITS.hookContinuationsMax }).fill('hook')])
    const stored = await messages(h, chatId)
    expect(stored).toHaveLength(2 + 2 * LIMITS.hookContinuationsMax)
    const last = stored.at(-1)!
    expect(messageText(last)).toBe('Hook continuation: again')
    expect(last.parts.some(part => part.type === 'data-notice' && (part.data as { code?: string }).code === 'hook-continuation-limit')).toBe(true)
    expect(h.hooks.runCalls.filter(call => call.event === 'Stop').map(call => call.input.stopHookActive)).toEqual([false, true, true, true, true, true])
  })

  it('a message queued while the Stop hooks run goes first: the hook turn is dropped', async () => {
    const chatId = newChatId()
    const queuedId = createMessageId()
    let calls = 0
    h.hooks.results.set('Stop', async () => {
      calls += 1
      if (calls === 1) {
        const response = await h.t.request(`/api/chat/${chatId}/queue`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: { id: queuedId, role: 'user', parts: [{ type: 'text', text: 'queued' }] }, modelRef: 'mock:hooks', reasoningEffort: 'auto', toolMode: 'ask' }),
        })
        expect(response.status).toBe(201)
        return fakeHookResult({ block: true, reason: STOP_REASON, record: stopRecord() })
      }
      return fakeHookResult()
    })
    await readSse(await postChat(h.t, chatBody(chatId, 'hi', { modelRef: 'mock:hooks' })))
    await finished(h, chatId, 2)
    await new Promise(resolve => setTimeout(resolve, 50))
    await runnerOf(h.t).idle()
    expect(started(h, chatId).map(data => data.origin)).toEqual(['request', 'queue'])
    const stored = await messages(h, chatId)
    expect(stored.map(message => messageText(message))).toEqual(['hi', 'Hooks mock: hi', 'queued', 'Hooks mock: queued'])
  })

  it('a run waiting for an approval runs no Stop hook and no hook turn; its Notification fires once', async () => {
    h.hooks.results.set('Stop', () => fakeHookResult({ block: true, reason: STOP_REASON, record: stopRecord() }))
    h.hooks.present.add('Notification')
    const chatId = newChatId()
    await readSse(await postChat(h.t, chatBody(chatId, 'call stop_ask {"text":"a"}', { modelRef: 'mock:hooks', toolMode: 'ask' })))
    await finished(h, chatId, 1)
    const stored = await messages(h, chatId)
    expect(stored[1]!.parts.some(part => (part as { state?: string }).state === 'approval-requested')).toBe(true)
    expect(h.hooks.runCalls.map(call => call.event)).toEqual(['Notification'])
    expect(h.hooks.runCalls[0]!.input).toEqual({ messageId: stored[1]!.id, message: 'The agent needs your permission to use stop_ask.', notificationType: 'permission_prompt' })
    expect(started(h, chatId)).toHaveLength(1)
    expect(h.events.find(event => event.type === 'run.finished' && event.data.chatId === chatId)?.data).toMatchObject({ awaitingApproval: true })
  })

  it('a Stop during the Stop hooks ends the chain: no hook turn', async () => {
    const chatId = newChatId()
    h.hooks.results.set('Stop', async (_input, options) => {
      void h.t.request(`/api/chat/${chatId}/stop`, { method: 'POST' })
      await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }))
      return fakeHookResult({ block: true, reason: STOP_REASON, record: stopRecord() })
    })
    await readSse(await postChat(h.t, chatBody(chatId, 'hi', { modelRef: 'mock:hooks' })))
    await finished(h, chatId, 1)
    await new Promise(resolve => setTimeout(resolve, 50))
    await runnerOf(h.t).idle()
    // The model had answered already: the run completes, but an aborted run hands over no follow-up.
    expect(started(h, chatId)).toHaveLength(1)
    const stored = await messages(h, chatId)
    expect(stored.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(recordsOf(stored[1])).toEqual([])
  })
})

describe('a hook turn and background results (W11.2-T4)', () => {
  let h: Harness
  let fake: FakeBackgroundTasks

  beforeAll(async () => {
    h = await harness({ background: true })
    fake = h.t.backgroundTasks as FakeBackgroundTasks
  })

  afterAll(async () => {
    await h.t.close()
  })

  function launchInput(chatId: string): BackgroundLaunchInput {
    return {
      chatId,
      messageId: 'msg_aaaaaaaaaaaaaaaa',
      toolCallId: 'call_bg',
      task: { description: 'Look around', prompt: 'List files.', type: 'explore', background: true },
      origin: 'request',
      model: { modelRef: 'mock:hooks' },
    } as unknown as BackgroundLaunchInput
  }

  it('the hook turn\'s step 0 takes a result that finished during the run; the idle delivery waits for its end', async () => {
    const chatId = newChatId()
    let taskId = ''
    h.hooks.results.set('Stop', async (input) => {
      if (input.stopHookActive === true)
        return fakeHookResult()
      // The task finishes while the run is still held by its Stop hooks: the result waits in the inbox.
      const output: TaskOutput = await fake.launch(launchInput(chatId))
      taskId = output.taskId!
      fake.finish(taskId, { report: 'Found it.' })
      return fakeHookResult({ block: true, reason: STOP_REASON, record: stopRecord() })
    })
    await readSse(await postChat(h.t, chatBody(chatId, 'hi', { modelRef: 'mock:hooks' })))
    await finished(h, chatId, 2)
    const stored = await messages(h, chatId)
    expect(stored.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    const results = stored[3]!.parts.filter(part => part.type === 'data-task-result')
    expect(results.map(part => (part.data as { taskId: string }).taskId)).toEqual([taskId])
    expect(stored[2]!.parts.map(part => part.type)).toEqual(['data-hook'])
    // `onChatIdle` ran once: after the hook turn, not after the run that handed it over.
    expect(fake.idle.filter(id => id === chatId)).toHaveLength(1)
  })

  it('a hook turn that cannot start leaves the chat idle: the background delivery runs', async () => {
    const chatId = newChatId()
    // A record the carrier cannot hold (its reason is over the schema cap): the hook turn fails while it is prepared.
    h.hooks.results.set('Stop', () => fakeHookResult({ block: true, reason: 'x', record: stopRecord('x'.repeat(LIMITS.hookReasonMaxChars + 1)) }))
    await readSse(await postChat(h.t, chatBody(chatId, 'hi', { modelRef: 'mock:hooks' })))
    await finished(h, chatId, 1)
    await vi.waitFor(() => expect(fake.idle).toContain(chatId), { timeout: 5000, interval: 5 })
    expect(started(h, chatId)).toHaveLength(1)
  })
})

describe('startHookTurn (unit)', () => {
  function input(overrides: Partial<HookTurnInput> = {}) {
    const logs = createMemoryLogger()
    const calls: Parameters<HookTurnInput['start']>[] = []
    const value: HookTurnInput = {
      chatId: testChatId(0xD3FF),
      data: stopRecord(),
      previous: { modelRef: 'mock:hooks', reasoningEffort: 'high', toolMode: 'plan' },
      options: { logger: logs.logger, requestId: 'req_prev' },
      events: { emit: () => {} },
      start: async (...args) => {
        calls.push(args)
        return new Response('data: [DONE]\n\n')
      },
      ...overrides,
    }
    return { value, calls, logs }
  }

  it('starts origin hook with a carrier holding only the record and the previous model, effort and mode', async () => {
    const { value, calls } = input()
    expect(startHookTurn(value)).toBe(true)
    expect(calls).toHaveLength(1)
    const [body, options, origin, prepareOptions] = calls[0]!
    expect(origin).toBe('hook')
    expect(prepareOptions).toEqual({ serverMessage: true })
    expect(options.requestId).toMatch(/^hook_[\da-z]+_[\da-z]+$/)
    expect(body).toEqual({
      chatId: value.chatId,
      message: { id: expect.stringMatching(/^msg_/), role: 'user', parts: [{ type: 'data-hook', data: value.data }] },
      trigger: 'submit-message',
      modelRef: 'mock:hooks',
      reasoningEffort: 'high',
      toolMode: 'plan',
    })
    expect(hookRequestId()).not.toBe(hookRequestId())
    expect(hookCarrierMessage(value.data).parts).toEqual([{ type: 'data-hook', data: value.data }])
  })

  it('a lost race drops the turn quietly; another failure is logged; a record that is not Stop starts nothing', async () => {
    const lost = input({ start: async () => {
      throw runConflict('c')
    } })
    expect(startHookTurn(lost.value)).toBe(true)
    await vi.waitFor(() => expect(lost.logs.records.some(record => record.msg.includes('lost the chat'))).toBe(true))
    expect(lost.logs.records.filter(record => record.level === 'warn')).toEqual([])
    const failed = input({ start: async () => {
      throw new Error('boom')
    } })
    expect(startHookTurn(failed.value)).toBe(true)
    await vi.waitFor(() => expect(failed.logs.records.some(record => record.level === 'warn' && record.msg.includes('could not start'))).toBe(true))
    expect(JSON.stringify(failed.logs.records)).not.toContain(STOP_REASON)
    const other = input({ data: fakeHookRecord('UserPromptSubmit', 'blocked') })
    expect(startHookTurn(other.value)).toBe(false)
    expect(other.calls).toEqual([])
  })
})
