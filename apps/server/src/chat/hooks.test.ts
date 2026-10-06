// The hooks of a run (Phase 11, C37-T1): `RunHooks` over the C36 fake snapshot — PreToolUse once per call (replayed
// for answered calls and stored decisions), the `updatedInput` rewrite, PostToolUse model texts and stop requests, the
// hooks piece of the step composer, the `Stop` gate (held `finish`, follow-up, cap notice, abort, approval requests,
// queued messages), the child hooks of sub-agents (nothing stored) and the empty snapshot.
import type { HarnessUIMessage, HarnessUIMessagePart, HookData } from '@harness-forge/shared'
import type { HookEventResult } from '../services/hooks/types.ts'
import type { HarnessUIMessageChunk } from './generated-files.ts'
import type { HookGateInput, RunHookHost } from './hooks.ts'
import type { HarnessDataChunk } from './pipeline.ts'
import type { RunReleaseFollowUp } from './types.ts'
import { hookDataSchema, hookModelText, LIMITS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { createSilentLogger } from '../logger.ts'
import { createFakeHookSnapshot, fakeHookRecord, fakeHookResult, hookTargetKey } from '../testing/fake-hooks.ts'
import {
  answeredToolCalls,
  ChildHooks,
  createRunHooks,
  detachedHooks,
  hookModelMessage,
  NO_HOOK_RESULT,
  noHookSnapshot,
  PERMISSION_PROMPT,
  permissionPromptMessage,
  storedDecision,
  storedDecisions,
} from './hooks.ts'
import { NOTICES } from './notices.ts'

const signal = new AbortController().signal

interface FakeHost extends RunHookHost {
  injected: { chunk: HarnessDataChunk, step: number }[]
  transient: HarnessDataChunk[]
}

function fakeHost(): FakeHost {
  const host: FakeHost = {
    stepNumber: -1,
    injected: [],
    transient: [],
    inject: (chunk, step) => host.injected.push({ chunk, step }),
    writeTransient: chunk => host.transient.push(chunk),
  }
  return host
}

function runHooks(options: Parameters<typeof createFakeHookSnapshot>[0] = {}, continued: HarnessUIMessage | null = null, mcpServerNames?: ReadonlyMap<string, string>) {
  const snapshot = createFakeHookSnapshot(options)
  const host = fakeHost()
  const hooks = createRunHooks({ snapshot, host, continued, messageId: 'msg_a000000000000001', logger: createSilentLogger(), ...(mcpServerNames === undefined ? {} : { mcpServerNames }) })
  return { snapshot, host, hooks }
}

function toolPart(toolCallId: string, extra: Record<string, unknown>): HarnessUIMessagePart {
  return { type: 'tool-shell', toolCallId, input: { command: 'ls' }, ...extra } as unknown as HarnessUIMessagePart
}

function hookPart(data: HookData): HarnessUIMessagePart {
  return { type: 'data-hook', data }
}

describe('answeredToolCalls / storedDecisions', () => {
  it('lists the calls with an approval response and the stored PreToolUse decisions', () => {
    const rewritten = fakeHookRecord('PreToolUse', 'rewritten', { toolCallId: 'call_2', toolName: 'shell', updatedInput: { command: 'echo rewritten' } })
    const denied = fakeHookRecord('PreToolUse', 'denied', { toolCallId: 'call_3', reason: 'no' })
    const continued: HarnessUIMessage = {
      id: 'msg_a000000000000001',
      role: 'assistant',
      parts: [
        toolPart('call_1', { state: 'approval-responded', approval: { id: 'ap_1', approved: true } }),
        toolPart('call_2', { state: 'approval-requested', approval: { id: 'ap_2' } }),
        toolPart('call_3', { state: 'output-denied', approval: { id: 'ap_3', approved: false } }),
        hookPart(rewritten),
        hookPart(denied),
        hookPart(fakeHookRecord('PostToolUse', 'context', { toolCallId: 'call_1', context: 'x' })),
        { type: 'data-hook', data: { id: 'bad' } } as unknown as HarnessUIMessagePart,
      ],
    }
    expect([...answeredToolCalls(continued)].sort()).toEqual(['call_1', 'call_3'])
    expect(answeredToolCalls(null).size).toBe(0)
    const decisions = storedDecisions(continued)
    expect([...decisions.keys()].sort()).toEqual(['call_2', 'call_3'])
    expect(decisions.get('call_2')).toEqual({ decision: null, reason: null, updatedInput: { command: 'echo rewritten' } })
    expect(decisions.get('call_3')).toEqual({ decision: 'deny', reason: 'no' })
    expect(storedDecision(fakeHookRecord('PreToolUse', 'asked'))).toEqual({ decision: 'ask', reason: null })
    expect(storedDecision(fakeHookRecord('PreToolUse', 'allowed', { reason: 'fine' }))).toEqual({ decision: 'allow', reason: 'fine' })
  })
})

describe('runHooks: PreToolUse', () => {
  it('runs once per call with the tool, its aliases and the run signal; injects the record for the next step', async () => {
    const record = fakeHookRecord('PreToolUse', 'denied', { toolCallId: 'call_1', toolName: 'shell', reason: 'no rm' })
    const { snapshot, host, hooks } = runHooks({ results: { PreToolUse: fakeHookResult({ decision: 'deny', reason: 'no rm', record }) } })
    host.stepNumber = 2
    const call = { toolName: 'shell', toolCallId: 'call_1', input: { command: 'rm -rf x' } }
    expect(await hooks.preToolUse(call, signal)).toEqual({ decision: 'deny', reason: 'no rm' })
    expect(await hooks.preToolUse(call, signal)).toEqual({ decision: 'deny', reason: 'no rm' })
    expect(snapshot.calls).toHaveLength(1)
    expect(snapshot.calls[0]).toMatchObject({
      event: 'PreToolUse',
      input: { messageId: 'msg_a000000000000001', tool: { name: 'shell', callId: 'call_1', input: { command: 'rm -rf x' } } },
      options: { target: 'shell', aliases: ['shell', 'Bash'] },
    })
    expect(host.injected).toEqual([{ chunk: { type: 'data-hook', data: record }, step: 3 }])
    expect(host.transient).toEqual([
      { type: 'data-activity', data: { kind: 'hooks', event: 'PreToolUse', toolCallId: 'call_1' } },
      { type: 'data-activity', data: { kind: 'idle' } },
    ])
  })

  it('treats a block as a deny, keeps an updatedInput only without a deny, and records a stop request', async () => {
    const { hooks } = runHooks({
      targets: {
        [hookTargetKey('PreToolUse', 'shell')]: fakeHookResult({ block: true, reason: 'exit 2', updatedInput: { command: 'x' } }),
        [hookTargetKey('PreToolUse', 'write_file')]: fakeHookResult({ decision: 'allow', updatedInput: { path: 'a.txt', content: 'b' }, continue: false, stopReason: 'done' }),
      },
    })
    expect(await hooks.preToolUse({ toolName: 'shell', toolCallId: 'c1', input: {} }, signal)).toEqual({ decision: 'deny', reason: 'exit 2' })
    expect(hooks.updatedInput('c1')).toBeNull()
    expect(hooks.stopRequested).toBe(false)
    expect(await hooks.preToolUse({ toolName: 'write_file', toolCallId: 'c2', input: {} }, signal)).toEqual({ decision: 'allow', reason: null, updatedInput: { path: 'a.txt', content: 'b' } })
    expect(hooks.updatedInput('c2')).toEqual({ input: { path: 'a.txt', content: 'b' } })
    expect(hooks.stopRequested).toBe(true)
    expect(hooks.stopReason).toBe('done')
    expect(await hooks.stopCondition({ steps: [] })).toBe(true)
  })

  it('never runs again for a call answered in the continued message: the stored decision is replayed', async () => {
    const record = fakeHookRecord('PreToolUse', 'rewritten', { toolCallId: 'call_1', toolName: 'shell', updatedInput: { command: 'echo rewritten' } })
    const continued: HarnessUIMessage = {
      id: 'msg_a000000000000001',
      role: 'assistant',
      parts: [toolPart('call_1', { state: 'approval-responded', approval: { id: 'ap_1', approved: true } }), hookPart(record), toolPart('call_9', { state: 'approval-responded', approval: { id: 'ap_9', approved: true } })],
    }
    const { snapshot, hooks, host } = runHooks({ results: { PreToolUse: fakeHookResult({ decision: 'deny' }) } }, continued)
    expect(await hooks.preToolUse({ toolName: 'shell', toolCallId: 'call_1', input: {} }, signal)).toEqual({ decision: null, reason: null, updatedInput: { command: 'echo rewritten' } })
    expect(hooks.updatedInput('call_1')).toEqual({ input: { command: 'echo rewritten' } })
    // An answered call without a stored record (its hooks were silent): nothing to replay, nothing runs.
    expect(await hooks.preToolUse({ toolName: 'shell', toolCallId: 'call_9', input: {} }, signal)).toBeNull()
    expect(hooks.isAnswered('call_9')).toBe(true)
    expect(snapshot.calls).toHaveLength(0)
    expect(host.injected).toHaveLength(0)
    // A new call of the continuation runs.
    expect(await hooks.preToolUse({ toolName: 'shell', toolCallId: 'call_10', input: {} }, signal)).toMatchObject({ decision: 'deny' })
    expect(snapshot.calls).toHaveLength(1)
  })

  it('is free without PreToolUse hooks and matches project MCP tools by their .mcp.json name too', async () => {
    const free = runHooks()
    expect(await free.hooks.preToolUse({ toolName: 'shell', toolCallId: 'c1', input: {} }, signal)).toBeNull()
    expect(free.snapshot.calls).toHaveLength(0)
    expect(free.host.transient).toHaveLength(0)
    const { hooks, snapshot } = runHooks({ present: ['PreToolUse'] }, null, new Map([['my-server-v2', 'My_Server.v2']]))
    expect(hooks.aliases('mcp__my-server-v2__echo')).toEqual(['mcp__my-server-v2__echo', 'mcp__My_Server.v2__echo'])
    expect(hooks.aliases('mcp__other__echo')).toEqual(['mcp__other__echo'])
    expect(await hooks.preToolUse({ toolName: 'mcp__my-server-v2__echo', toolCallId: 'c2', input: {} }, signal)).toEqual({ decision: null, reason: null })
    expect(snapshot.calls[0]?.options.aliases).toEqual(['mcp__my-server-v2__echo', 'mcp__My_Server.v2__echo'])
  })

  it('rejects on abort (the approval function asks then; the run is ending)', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('stopped', 'AbortError'))
    const { hooks } = runHooks({ present: ['PreToolUse'] })
    await expect(hooks.preToolUse({ toolName: 'shell', toolCallId: 'c1', input: {} }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('runHooks: PostToolUse and the hooks piece', () => {
  it('queues the model text of the record for the next step, after the step number is recorded', async () => {
    const record = fakeHookRecord('PostToolUse', 'context', { toolCallId: 'call_1', toolName: 'shell', context: 'lint ok' })
    const { snapshot, host, hooks } = runHooks({ results: { PostToolUse: fakeHookResult({ context: 'lint ok', record }) } })
    const piece = hooks.stepPiece()
    expect(await piece({ stepNumber: 0, messages: [], instructions: undefined, steps: [] })).toBeUndefined()
    expect(host.stepNumber).toBe(0)
    await hooks.postToolUse({ toolName: 'shell', toolCallId: 'call_1', input: { command: 'ls' }, output: { exitCode: 0 } }, signal)
    expect(snapshot.calls[0]).toMatchObject({ event: 'PostToolUse', input: { tool: { name: 'shell', callId: 'call_1', input: { command: 'ls' }, output: { exitCode: 0 } } }, options: { target: 'shell' } })
    expect(host.injected).toEqual([{ chunk: { type: 'data-hook', data: record }, step: 1 }])
    const text = hookModelText(record, 'assistant')!
    expect(text).toContain('<hook-context event="PostToolUse" tool="shell">')
    const messages = [{ role: 'user' as const, content: 'hi' }]
    expect(await piece({ stepNumber: 1, messages, instructions: undefined, steps: [] })).toEqual({ messages: [...messages, hookModelMessage(text)] })
    expect(host.stepNumber).toBe(1)
    // Taken once.
    expect(await piece({ stepNumber: 2, messages, instructions: undefined, steps: [] })).toBeUndefined()
  })

  it('feeds a block back, stops on continue: false, and never throws', async () => {
    const blocked = fakeHookRecord('PostToolUse', 'blocked', { toolCallId: 'c1', toolName: 'shell', reason: 'nope' })
    const { hooks } = runHooks({ results: { PostToolUse: fakeHookResult({ block: true, reason: 'nope', continue: false, stopReason: 'halt', record: blocked }) } })
    await hooks.postToolUse({ toolName: 'shell', toolCallId: 'c1', input: {}, output: 'x' }, signal)
    expect(hooks.takeQueued()).toEqual([hookModelMessage(hookModelText(blocked, 'assistant')!)])
    expect(hooks.stopRequested).toBe(true)
    const failing = runHooks({ results: { PostToolUse: () => {
      throw new Error('broken')
    } } })
    await expect(failing.hooks.postToolUse({ toolName: 'shell', toolCallId: 'c1', input: {}, output: 'x' }, signal)).resolves.toBeUndefined()
    const controller = new AbortController()
    controller.abort()
    await expect(failing.hooks.postToolUse({ toolName: 'shell', toolCallId: 'c1', input: {}, output: 'x' }, controller.signal)).resolves.toBeUndefined()
  })

  it('does nothing without PostToolUse hooks and queues nothing for a display-only record', async () => {
    const free = runHooks()
    await free.hooks.postToolUse({ toolName: 'shell', toolCallId: 'c1', input: {}, output: 'x' }, signal)
    expect(free.snapshot.calls).toHaveLength(0)
    const errorRecord = fakeHookRecord('PostToolUse', 'error', { toolCallId: 'c1', toolName: 'shell' })
    const { hooks, host } = runHooks({ results: { PostToolUse: fakeHookResult({ record: errorRecord }) } })
    await hooks.postToolUse({ toolName: 'shell', toolCallId: 'c1', input: {}, output: 'x' }, signal)
    expect(host.injected).toHaveLength(1)
    expect(hooks.takeQueued()).toEqual([])
  })

  it('records and queues the context of the plugin tool.after handlers (plugin API 1.5.0), even without hooks', async () => {
    const { hooks, host, snapshot } = runHooks()
    await hooks.postToolUse({ toolName: 'shell', toolCallId: 'c1', input: {}, output: 'x', pluginContext: '  lint: 2 warnings  ' }, signal)
    expect(snapshot.calls).toHaveLength(0)
    expect(host.injected).toHaveLength(1)
    const record = (host.injected[0]!.chunk as { data: HookData }).data
    expect(record).toMatchObject({ event: 'PostToolUse', outcome: 'context', toolCallId: 'c1', toolName: 'shell', context: 'lint: 2 warnings', hooks: [{ source: 'plugin', label: 'tool.after', exitCode: null }] })
    expect(hookDataSchema.safeParse(record).success).toBe(true)
    expect(hooks.takeQueued()).toEqual([hookModelMessage(hookModelText(record, 'assistant')!)])
    await hooks.postToolUse({ toolName: 'shell', toolCallId: 'c2', input: {}, output: 'x', pluginContext: '   ' }, signal)
    expect(host.injected).toHaveLength(1)
  })
})

/** Runs `chunks` through a gate and returns what came out, the follow-up and the tracked chunks. */
async function gate(hooks: ReturnType<typeof runHooks>['hooks'], chunks: HarnessUIMessageChunk[], overrides: Partial<HookGateInput> = {}) {
  const tracked: HarnessDataChunk[] = []
  let followUp: RunReleaseFollowUp | null = null
  const input: HookGateInput = {
    signal,
    origin: 'request',
    history: [],
    queued: () => false,
    followUp: (value) => {
      followUp = value
    },
    track: chunk => tracked.push(chunk),
    ...overrides,
  }
  const out: HarnessUIMessageChunk[] = []
  const stream = new ReadableStream<HarnessUIMessageChunk>({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(chunk)
      controller.close()
    },
  }).pipeThrough(hooks.hookGate(input))
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done)
      break
    out.push(value)
  }
  return { out, tracked, followUp: followUp as RunReleaseFollowUp | null }
}

const ENDING: HarnessUIMessageChunk[] = [{ type: 'start' }, { type: 'start-step' }, { type: 'text-start', id: 't' }, { type: 'text-end', id: 't' }, { type: 'finish-step' }, { type: 'finish' }]

function carrier(id: string): HarnessUIMessage {
  return { id, role: 'user', parts: [hookPart(fakeHookRecord('Stop', 'continued', { reason: 'again' }))] }
}

describe('runHooks.hookGate (Stop)', () => {
  const stopRecord = (): HookData => fakeHookRecord('Stop', 'continued', { reason: 'run the tests' })

  it('is a pass-through without Stop hooks', async () => {
    const { hooks, snapshot } = runHooks()
    const { out, followUp } = await gate(hooks, ENDING)
    expect(out).toEqual(ENDING)
    expect(followUp).toBeNull()
    expect(snapshot.calls).toHaveLength(0)
  })

  it('holds finish, runs the Stop hooks once, writes the record before finish and hands a follow-up over', async () => {
    const record = stopRecord()
    const { hooks, snapshot, host } = runHooks({ results: { Stop: fakeHookResult({ block: true, reason: 'run the tests', record }) } })
    const { out, tracked, followUp } = await gate(hooks, ENDING)
    expect(out.map(chunk => chunk.type)).toEqual(['start', 'start-step', 'text-start', 'text-end', 'finish-step', 'data-hook', 'finish'])
    expect(out.at(-2)).toEqual({ type: 'data-hook', data: record })
    expect(tracked).toEqual([{ type: 'data-hook', data: record }])
    expect(followUp).toEqual({ kind: 'hook', data: record })
    expect(snapshot.calls).toHaveLength(1)
    expect(snapshot.calls[0]).toMatchObject({ event: 'Stop', input: { messageId: 'msg_a000000000000001', stopHookActive: false } })
    expect(host.transient).toEqual([{ type: 'data-activity', data: { kind: 'hooks', event: 'Stop' } }, { type: 'data-activity', data: { kind: 'idle' } }])
  })

  it('passes stop_hook_active in a hook turn and stops the chain at the cap with the notice', async () => {
    const record = stopRecord()
    const { hooks, snapshot } = runHooks({ results: { Stop: fakeHookResult({ block: true, record }) } })
    const user: HarnessUIMessage = { id: 'msg_u000000000000001', role: 'user', parts: [{ type: 'text', text: 'go' }] }
    const below = Array.from({ length: LIMITS.hookContinuationsMax - 1 }, (_, index) => carrier(`msg_c00000000000000${index}`))
    const first = await gate(hooks, ENDING, { origin: 'hook', history: [user, ...below] })
    expect(first.followUp).toEqual({ kind: 'hook', data: record })
    expect(snapshot.calls[0]?.input.stopHookActive).toBe(true)
    const capped = await gate(hooks, ENDING, { origin: 'hook', history: [user, ...below, carrier('msg_c000000000000009')] })
    expect(capped.followUp).toBeNull()
    expect(capped.out.map(chunk => chunk.type).slice(-3)).toEqual(['data-hook', 'data-notice', 'finish'])
    expect(capped.out.at(-2)).toEqual({ type: 'data-notice', data: NOTICES.hookContinuationLimit() })
    expect(NOTICES.hookContinuationLimit().message).toBe('Stopped after 5 hook continuations in a row.')
  })

  it('skips the hooks after an error, a user approval request, with queued messages or a hook stop', async () => {
    const results = { Stop: fakeHookResult({ block: true, record: stopRecord() }) }
    const errorRun = runHooks({ results })
    expect((await gate(errorRun.hooks, [{ type: 'start' }, { type: 'error', errorText: 'x' }, { type: 'finish' }])).followUp).toBeNull()
    expect(errorRun.snapshot.calls).toHaveLength(0)
    const approval = runHooks({ results })
    await gate(approval.hooks, [{ type: 'start' }, { type: 'tool-approval-request', approvalId: 'a', toolCallId: 'c' }, { type: 'finish' }])
    expect(approval.snapshot.calls).toHaveLength(0)
    // An automatic approval (approved or denied without a card) does not count.
    const automatic = runHooks({ results })
    expect((await gate(automatic.hooks, [{ type: 'start' }, { type: 'tool-approval-request', approvalId: 'a', toolCallId: 'c', isAutomatic: true }, { type: 'finish' }])).followUp).not.toBeNull()
    const queued = runHooks({ results })
    expect((await gate(queued.hooks, ENDING, { queued: () => true })).followUp).toBeNull()
    expect(queued.snapshot.calls).toHaveLength(0)
    const stopped = runHooks({ results })
    stopped.hooks.requestStop('halt')
    expect((await gate(stopped.hooks, ENDING)).followUp).toBeNull()
    expect(stopped.snapshot.calls).toHaveLength(0)
  })

  it('cancels the follow-up on an abort during the hooks, and never continues for continue: false', async () => {
    const controller = new AbortController()
    const record = stopRecord()
    const aborting = runHooks({ results: { Stop: () => {
      controller.abort(new DOMException('stopped', 'AbortError'))
      return fakeHookResult({ block: true, record })
    } } })
    const aborted = await gate(aborting.hooks, ENDING, { signal: controller.signal })
    expect(aborted.followUp).toBeNull()
    expect(aborted.out.at(-1)).toEqual({ type: 'finish' })
    const halting = runHooks({ results: { Stop: fakeHookResult({ block: true, continue: false, record: fakeHookRecord('Stop', 'stopped') }) } })
    const halted = await gate(halting.hooks, ENDING)
    expect(halted.followUp).toBeNull()
    expect(halted.out.map(chunk => chunk.type)).toContain('data-hook')
    const aborted2 = new AbortController()
    aborted2.abort()
    const before = runHooks({ results: { Stop: fakeHookResult({ block: true, record }) } })
    expect((await gate(before.hooks, ENDING, { signal: aborted2.signal })).followUp).toBeNull()
    expect(before.snapshot.calls).toHaveLength(0)
  })
})

describe('child hooks (sub-agents)', () => {
  it('run PreToolUse / PostToolUse with the run snapshot, store nothing and write no activity', async () => {
    const record = fakeHookRecord('PostToolUse', 'context', { toolCallId: 'call_t/c1', toolName: 'read_file', context: 'note' })
    const { hooks, host, snapshot } = runHooks({ results: { PreToolUse: fakeHookResult({ decision: 'ask' }), PostToolUse: fakeHookResult({ context: 'note', record }) } })
    const child = hooks.forChild('call_t/')
    expect(child).toBeInstanceOf(ChildHooks)
    expect(child.callIdPrefix).toBe('call_t/')
    expect(await child.preToolUse({ toolName: 'read_file', toolCallId: 'call_t/c1', input: {} }, signal)).toEqual({ decision: 'ask', reason: null })
    await child.postToolUse({ toolName: 'read_file', toolCallId: 'call_t/c1', input: {}, output: 'x' }, signal)
    expect(snapshot.calls.map(call => call.event)).toEqual(['PreToolUse', 'PostToolUse'])
    expect(host.injected).toEqual([])
    expect(host.transient).toEqual([])
    const piece = child.stepPiece()
    expect(await piece({ stepNumber: 1, messages: [], instructions: undefined, steps: [] })).toEqual({ messages: [hookModelMessage(hookModelText(record, 'assistant')!)] })
    expect(host.stepNumber).toBe(-1)
    // The parent's queue stays empty.
    expect(hooks.takeQueued()).toEqual([])
  })

  it('subagentStop runs SubagentStop with the task call, or answers that nothing ran', async () => {
    const result: HookEventResult = fakeHookResult({ block: true, reason: 'more' })
    const { hooks, snapshot } = runHooks({ results: { SubagentStop: result } })
    const child = hooks.forChild('call_t/')
    expect(await child.subagentStop({ stopHookActive: false, task: { callId: 'call_t', input: { type: 'general' }, output: 'report' } }, signal)).toBe(result)
    expect(snapshot.calls[0]).toMatchObject({ event: 'SubagentStop', input: { stopHookActive: false, tool: { name: 'task', callId: 'call_t', input: { type: 'general' }, output: 'report' } } })
    expect(await runHooks().hooks.forChild('p/').subagentStop({ stopHookActive: false }, signal)).toBe(NO_HOOK_RESULT)
  })

  it('detachedHooks gives a background child the same handle over its own snapshot', async () => {
    const snapshot = createFakeHookSnapshot({ results: { PreToolUse: fakeHookResult({ decision: 'deny', reason: 'no' }) } })
    const source = detachedHooks({ snapshot, messageId: 'msg_a000000000000002', logger: createSilentLogger() })
    const child = source.forChild('call_bg/')
    expect(await child.preToolUse({ toolName: 'shell', toolCallId: 'call_bg/c1', input: {} }, signal)).toEqual({ decision: 'deny', reason: 'no' })
    expect(snapshot.calls[0]?.input.messageId).toBe('msg_a000000000000002')
  })
})

describe('noHookSnapshot', () => {
  it('has no event and answers that nothing ran; rejects on abort', async () => {
    const snapshot = noHookSnapshot({ chatId: 'c', projectId: null, workspace: null, toolMode: 'ask', origin: 'request', modelRef: 'mock:echo' })
    expect(snapshot.has('Stop')).toBe(false)
    expect(await snapshot.run('Stop', {}, { signal })).toBe(NO_HOOK_RESULT)
    const controller = new AbortController()
    controller.abort()
    await expect(snapshot.run('Stop', {}, { signal: controller.signal })).rejects.toBeDefined()
  })
})

describe('runHooks: PreCompact and Notification (W11.2 seams)', () => {
  it('preCompact runs observe-only with the trigger and places the record for the next step', async () => {
    const record = fakeHookRecord('PreCompact', 'error')
    const { hooks, host, snapshot } = runHooks({ results: { PreCompact: fakeHookResult({ continue: false, record }) } })
    host.stepNumber = 3
    const result = await hooks.preCompact({ trigger: 'auto', customInstructions: null }, signal)
    expect(result.record).toBe(record)
    expect(snapshot.calls[0]).toMatchObject({ event: 'PreCompact', input: { trigger: 'auto', customInstructions: null } })
    expect(host.injected).toEqual([{ chunk: { type: 'data-hook', data: record }, step: 4 }])
    // Observe only: no stop request.
    expect(hooks.stopRequested).toBe(false)
    expect(await runHooks().hooks.preCompact({ trigger: 'manual', customInstructions: 'focus' }, signal)).toBe(NO_HOOK_RESULT)
  })

  it('notification runs fire-and-forget without a record or activity and never rejects', async () => {
    const { hooks, host, snapshot } = runHooks({ results: { Notification: fakeHookResult({ record: fakeHookRecord('Notification', 'error') }) } })
    await hooks.notification({ message: 'm', notificationType: PERMISSION_PROMPT }, signal)
    expect(snapshot.calls[0]).toMatchObject({ event: 'Notification', input: { message: 'm', notificationType: 'permission_prompt' } })
    expect(host.injected).toEqual([])
    expect(host.transient).toEqual([])
    const failing = runHooks({ results: { Notification: () => {
      throw new Error('broken')
    } } })
    await expect(failing.hooks.notification({ message: 'm', notificationType: PERMISSION_PROMPT }, signal)).resolves.toBeUndefined()
  })

  it('permissionPromptMessage names the tools waiting for an approval (Claude Code names first)', () => {
    const message = (parts: HarnessUIMessagePart[]): HarnessUIMessage => ({ id: 'msg_a000000000000001', role: 'assistant', parts })
    expect(permissionPromptMessage(null)).toBeNull()
    expect(permissionPromptMessage(message([toolPart('c1', { state: 'output-available' })]))).toBeNull()
    expect(permissionPromptMessage(message([toolPart('c1', { state: 'approval-requested' }), toolPart('c2', { state: 'approval-requested' })]))).toBe('The agent needs your permission to use Bash.')
    const many = ['a', 'b', 'c', 'd', 'e'].map((name, index) => ({ type: `tool-${name}`, toolCallId: `c${index}`, state: 'approval-requested', input: {} }) as unknown as HarnessUIMessagePart)
    expect(permissionPromptMessage(message([...many, { type: 'dynamic-tool', toolName: 'mcp__x__y', toolCallId: 'd1', state: 'approval-requested', input: {} } as unknown as HarnessUIMessagePart]))).toBe('The agent needs your permission to use a, b, c and 3 more.')
  })
})
