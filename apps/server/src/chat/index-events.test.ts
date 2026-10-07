// W12.6-T5 (ADR-057) through the chat runner (`createTestApp()`, `POST /api/chat`, `mock:hooks`) with the C36 fake hook
// service: `Stop` prompt hooks (`ok: false` starts a hook turn with `origin: 'hook'` unless `impossible`; the chain stops
// after `LIMITS.hookContinuationsMax` hook turns), `PostToolUseFailure` after a failing tool (its feedback reaches the
// model at the next step and the reply's record) and `PermissionRequest` before an approval card (`allow` approves an
// `ask` call, `deny` blocks it, a prompt hook's `ok: false` decides nothing: the card stays). The prompt-hook results come
// from `promptHookResult` (the shared `promptHookOutcome`), so the seams are tested against what a prompt hook decides.
import type { HarnessUIMessage, HookData, ServerEvent } from '@harness-forge/shared'
import type { TestApp } from '../testing/create-test-app.ts'
import type { FakeHookService } from '../testing/fake-hooks.ts'
import { chatDetailSchema, LIMITS } from '@harness-forge/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createTestApp } from '../testing/create-test-app.ts'
import { fakeHookRecord, fakeHookResult, hookTargetKey } from '../testing/fake-hooks.ts'
import { promptHookResult } from './hooks-prompt-testing.ts'
import { chatBody, messageText, postChat, readSse, runnerOf, testChatId } from './testing.ts'

const FAILURE_TEXT = 'the probe exploded'
const REASON_SECRET = 'event-reason-sentinel-4d2b'

let nextChat = 0xD800

function newChatId(): string {
  nextChat += 1
  return testChatId(nextChat)
}

function recordsOf(message: HarnessUIMessage | undefined): HookData[] {
  return (message?.parts ?? []).flatMap(part => (part.type === 'data-hook' ? [(part as { data: HookData }).data] : []))
}

describe('run events with prompt hooks and the new events end to end (W12.6-T5)', () => {
  let t: TestApp
  let hooks: FakeHookService
  let events: ServerEvent[] = []
  let probeRuns = 0

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, hooks: 'fake' })
    hooks = t.deps.hooks as FakeHookService
    t.deps.events.subscribe(event => void events.push(event))
    t.deps.registry.tools.register('mock', {
      name: 'fail_probe',
      description: 'Always fails.',
      inputSchema: z.object({ text: z.string() }),
      policy: 'safe',
      execute: async () => {
        throw new Error(FAILURE_TEXT)
      },
    })
    t.deps.registry.tools.register('mock', {
      name: 'perm_probe',
      description: 'Asks before it runs.',
      inputSchema: z.object({ text: z.string() }),
      policy: 'ask',
      execute: async () => {
        probeRuns += 1
        return { ok: true }
      },
    })
  })

  beforeEach(() => {
    events = []
    probeRuns = 0
    hooks.results.clear()
    hooks.targets.clear()
    hooks.present.clear()
    hooks.runCalls.length = 0
    hooks.snapshots.length = 0
  })

  afterAll(async () => {
    await t.close()
  })

  async function finished(chatId: string, count: number): Promise<void> {
    await vi.waitFor(() => {
      expect(events.filter(event => event.type === 'run.finished' && event.data.chatId === chatId)).toHaveLength(count)
    }, { timeout: 10_000, interval: 5 })
    await runnerOf(t).idle()
  }

  async function messages(chatId: string): Promise<HarnessUIMessage[]> {
    return chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId}`)).json()).messages
  }

  function origins(chatId: string): Array<string | undefined> {
    return events.flatMap(event => (event.type === 'run.started' && event.data.chatId === chatId ? [event.data.origin] : []))
  }

  function loudLogs(): string {
    return t.logs.records.filter(entry => entry.level !== 'debug').map(entry => JSON.stringify(entry)).join('\n')
  }

  it('a Stop prompt hook saying no starts one hook turn (origin hook) with its reason', async () => {
    hooks.results.set('Stop', input => (input.stopHookActive === true
      ? promptHookResult('Stop', '{"ok":true}')
      : promptHookResult('Stop', JSON.stringify({ ok: false, reason: REASON_SECRET }))))
    const chatId = newChatId()
    await readSse(await postChat(t, chatBody(chatId, 'hi', { modelRef: 'mock:hooks', toolMode: 'auto' })))
    await finished(chatId, 2)
    expect(origins(chatId)).toEqual(['request', 'hook'])
    const stored = await messages(chatId)
    expect(stored.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    const record = recordsOf(stored[1])[0]!
    expect(record).toMatchObject({ event: 'Stop', outcome: 'continued', reason: REASON_SECRET, hooks: [{ kind: 'prompt' }] })
    expect(stored[2]!.parts).toEqual([{ type: 'data-hook', data: record }])
    expect(messageText(stored[3])).toBe(`Hook continuation: ${REASON_SECRET}`)
    expect(hooks.runCalls.filter(call => call.event === 'Stop').map(call => call.input.stopHookActive)).toEqual([false, true])
    expect(loudLogs()).not.toContain(REASON_SECRET)
  })

  it('an impossible stop ends the run: no hook turn', async () => {
    hooks.results.set('Stop', promptHookResult('Stop', '{"ok":false,"reason":"the tests cannot run here","impossible":true}'))
    const chatId = newChatId()
    await readSse(await postChat(t, chatBody(chatId, 'hi', { modelRef: 'mock:hooks', toolMode: 'auto' })))
    await finished(chatId, 1)
    await new Promise(resolve => setTimeout(resolve, 50))
    await runnerOf(t).idle()
    expect(origins(chatId)).toEqual(['request'])
    expect((await messages(chatId)).map(message => message.role)).toEqual(['user', 'assistant'])
    expect(hooks.runCalls.filter(call => call.event === 'Stop')).toHaveLength(1)
  })

  it('a Stop prompt hook that always says no: five hook turns, then the notice hook-continuation-limit', async () => {
    hooks.results.set('Stop', promptHookResult('Stop', '{"ok":false,"reason":"again"}'))
    const chatId = newChatId()
    await readSse(await postChat(t, chatBody(chatId, 'hi', { modelRef: 'mock:hooks', toolMode: 'auto' })))
    await finished(chatId, LIMITS.hookContinuationsMax + 1)
    await new Promise(resolve => setTimeout(resolve, 50))
    await runnerOf(t).idle()
    expect(origins(chatId)).toEqual(['request', ...Array.from({ length: LIMITS.hookContinuationsMax }).fill('hook')])
    const last = (await messages(chatId)).at(-1)!
    expect(messageText(last)).toBe('Hook continuation: again')
    expect(last.parts.some(part => part.type === 'data-notice' && (part.data as { code?: string }).code === 'hook-continuation-limit')).toBe(true)
  })

  it('postToolUseFailure: a prompt hook\'s no after a failing tool is feedback the model reads at its next step', async () => {
    hooks.targets.set(hookTargetKey('PostToolUseFailure', 'fail_probe'), promptHookResult('PostToolUseFailure', '{"ok":false,"reason":"retry with a smaller input"}'))
    const chatId = newChatId()
    await readSse(await postChat(t, chatBody(chatId, 'call fail_probe {"text":"a"}', { modelRef: 'mock:hooks', toolMode: 'auto' })))
    await finished(chatId, 1)
    const reply = (await messages(chatId))[1]!
    expect(messageText(reply)).toBe(`Called fail_probe: failed | ToolFailure: ${FAILURE_TEXT} | hooks: retry with a smaller input`)
    expect(recordsOf(reply)).toMatchObject([{ event: 'PostToolUseFailure', outcome: 'blocked', reason: 'retry with a smaller input' }])
    const [call] = hooks.runCalls.filter(entry => entry.event === 'PostToolUseFailure')
    expect(call?.input).toMatchObject({ tool: { name: 'fail_probe', input: { text: 'a' } }, error: expect.stringContaining(FAILURE_TEXT) })
    expect(call?.options.target).toBe('fail_probe')
  })

  it('permissionRequest: allow approves an ask call without a card; deny blocks it; a prompt hook\'s no keeps the card', async () => {
    hooks.results.set('PermissionRequest', fakeHookResult({ decision: 'allow', record: fakeHookRecord('PermissionRequest', 'allowed') }))
    const allowed = newChatId()
    await readSse(await postChat(t, chatBody(allowed, 'call perm_probe {"text":"a"}', { modelRef: 'mock:hooks', toolMode: 'ask' })))
    await finished(allowed, 1)
    const allowedReply = (await messages(allowed))[1]!
    expect(messageText(allowedReply)).toBe('Called perm_probe: ok | {"ok":true} | hooks: none')
    expect(probeRuns).toBe(1)
    expect(allowedReply.parts.some(part => (part as { state?: string }).state === 'approval-requested')).toBe(false)
    expect(recordsOf(allowedReply)).toMatchObject([{ event: 'PermissionRequest', outcome: 'allowed' }])
    expect(hooks.runCalls.filter(call => call.event === 'PermissionRequest').map(call => call.input.tool?.name)).toEqual(['perm_probe'])

    hooks.results.set('PermissionRequest', fakeHookResult({ decision: 'deny', reason: 'not now', record: fakeHookRecord('PermissionRequest', 'denied', { reason: 'not now' }) }))
    const denied = newChatId()
    await readSse(await postChat(t, chatBody(denied, 'call perm_probe {"text":"b"}', { modelRef: 'mock:hooks', toolMode: 'ask' })))
    await finished(denied, 1)
    expect(messageText((await messages(denied))[1])).toBe('Called perm_probe: denied | Blocked by hook: not now | hooks: none')
    expect(probeRuns).toBe(1)

    hooks.results.set('PermissionRequest', promptHookResult('PermissionRequest', '{"ok":false,"reason":"looks risky"}'))
    const asked = newChatId()
    await readSse(await postChat(t, chatBody(asked, 'call perm_probe {"text":"c"}', { modelRef: 'mock:hooks', toolMode: 'ask' })))
    await finished(asked, 1)
    const askedReply = (await messages(asked))[1]!
    expect(askedReply.parts.some(part => (part as { state?: string }).state === 'approval-requested')).toBe(true)
    expect(probeRuns).toBe(1)
    expect(events.find(event => event.type === 'run.finished' && event.data.chatId === asked)?.data).toMatchObject({ awaitingApproval: true })
  })
})
