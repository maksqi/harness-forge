// SubagentStop (W11.2-T5) and the hooks of children (W11.2-T8): a blocking `SubagentStop` hook continues a child for one
// more round (a feedback user message after its last assistant message, `stop_hook_active` from the second round), at
// most `LIMITS.subagentStopContinuationsMax` times, never after a failure, a stop request or a `continue: false`; a
// background child takes the hooks of its task's snapshot; end to end with `mock:hooks` (`Agent report: Child continued:
// <reason>`) and a child `ask` hook denied without an approval card.
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { ChatDetail, HarnessUIMessage, ServerEvent, Settings, TaskInput, TaskOutput } from '@harness-forge/shared'
import type { ResolvedModel } from '../../providers/types.ts'
import type { UsageInput } from '../../services/chats/types.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeHookResult, FakeHookService } from '../../testing/fake-hooks.ts'
import type { BackgroundLaunchInput } from '../background/types.ts'
import type { RunSession } from '../pipeline.ts'
import { chatDetailSchema, DEFAULT_SETTINGS, HarnessError, hookModelText, LIMITS } from '@harness-forge/shared'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createMemoryLogger, createSilentLogger } from '../../logger.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeBackgroundTasks } from '../../testing/fake-background-tasks.ts'
import { createFakeCustomizationService } from '../../testing/fake-customizations.ts'
import { createFakeHookSnapshot, fakeHookRecord, fakeHookResult, hookTargetKey } from '../../testing/fake-hooks.ts'
import { createBackgroundTasks } from '../background/index.ts'
import { recordingHost, scriptedChildren } from '../background/testing.ts'
import { createRunHooks } from '../hooks.ts'
import { chatBody, messageText, postChat, readSse, runnerOf, testCatalog, testChatId } from '../testing.ts'
import { createSubagentRunner } from './index.ts'

const MESSAGE_ID = 'msg_a000000000000001'
const TASK: TaskInput = { description: 'Check the build', prompt: 'Build the project and report.', type: 'general' }
const REASON_SECRET = 'subagent-reason-5c0d'

function finishPart(): LanguageModelV4StreamPart {
  return {
    type: 'finish',
    usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
    finishReason: { unified: 'stop', raw: 'stop' },
  }
}

function textParts(text: string): LanguageModelV4StreamPart[] {
  return [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, finishPart()]
}

function scripted(script: (call: number, options: LanguageModelV4CallOptions) => LanguageModelV4StreamPart[]) {
  const calls: LanguageModelV4CallOptions[] = []
  const model = new MockLanguageModelV4({
    provider: 'testkit',
    modelId: 'child',
    doStream: async (options) => {
      calls.push(options)
      return { stream: convertArrayToReadableStream(script(calls.length, options)) }
    },
  })
  return { model, calls }
}

function resolvedModel(model: LanguageModelV4): ResolvedModel {
  return {
    modelRef: 'testkit:child',
    providerId: 'testkit',
    modelId: 'child',
    info: { id: 'child', name: 'child' },
    entry: {
      ref: 'testkit:child',
      kind: 'chat',
      contextWindow: 128_000,
      capabilities: { tools: true, vision: false, pdf: false, reasoning: false, structuredOutput: false, imageOutput: false },
      reasoningEfforts: [],
      cost: { input: 1, output: 2 },
    },
    provider: { definition: {}, pluginId: 'testkit' },
    model,
  } as unknown as ResolvedModel
}

/** A parent run (no tools) whose hooks answer `SubagentStop` with `result`. */
function parent(result: FakeHookResult | undefined, settings: Partial<Settings> = {}) {
  const usage: UsageInput[] = []
  const logs = createMemoryLogger()
  const run = new AbortController()
  const snapshot = createFakeHookSnapshot(result === undefined ? {} : { results: { SubagentStop: result } })
  const deps = {
    registry: {
      tools: { list: () => [], get: () => undefined, register: () => ({ dispose() {} }) },
      hooks: { run: async () => {}, on: () => ({ dispose() {} }), list: () => [] },
    },
    plugins: { guard: async <T>(_id: string, fn: (signal: AbortSignal) => T | Promise<T>) => fn(new AbortController().signal), isActive: () => true },
    tools: { prefs: async () => new Map() },
    mcp: { list: async () => [] },
    env: { workspaceShell: true },
    providers: {
      resolveModel: async (ref: string) => {
        throw new HarnessError({ code: 'model_not_found', message: `No model ${ref}.` })
      },
      mapError: (_providerId: string, error: unknown) => new HarnessError({ code: 'provider_error', message: `Upstream: ${error instanceof Error ? error.message : 'error'}` }),
    },
    chats: { addUsage: async (row: UsageInput) => void usage.push(row) },
    redactor: { redactText: (text: string) => text },
    customizations: createFakeCustomizationService(),
  }
  const session = {
    chatId: 'chat',
    assistantId: MESSAGE_ID,
    notices: [],
    addExtraCost: () => {},
    inject: () => {},
    writeTransient: () => {},
    ctx: {
      deps,
      prepared: { settings: { instructions: null, subagentModelRef: null, subagentMaxSteps: 30, autoCompact: false, compactModelRef: null, ...settings }, chat: { settings: {} }, history: [] },
      reasoningEffort: 'auto',
      run: { signal: run.signal },
      now: () => Date.now(),
      logger: logs.logger,
    },
  } as unknown as RunSession
  const hooks = createRunHooks({ snapshot, host: { stepNumber: 0, inject: () => {}, writeTransient: () => {} }, continued: null, messageId: MESSAGE_ID, logger: logs.logger })
  Object.assign(session, { hooks })
  return { session, snapshot, usage, logs, run }
}

async function runChild(session: RunSession, model: LanguageModelV4): Promise<TaskOutput[]> {
  const runner = createSubagentRunner({
    session,
    model: resolvedModel(model),
    toolMode: 'auto',
    workspace: null,
    scope: null,
    catalog: testCatalog(),
    background: createFakeBackgroundTasks(),
    origin: 'request',
  })
  const outputs: TaskOutput[] = []
  for await (const output of runner.run(TASK, { toolCallId: 'call_parent', signal: new AbortController().signal }))
    outputs.push(output)
  return outputs
}

function lastMessages(call: LanguageModelV4CallOptions | undefined, count: number) {
  return (call?.prompt ?? []).slice(-count)
}

const feedback = (reason: string): string => hookModelText({ event: 'SubagentStop', outcome: 'continued', reason }, 'user')!

describe('subagentStop of a foreground child (W11.2-T5)', () => {
  it('a block continues the child once with a feedback user message; the report and the usage cover both rounds', async () => {
    const p = parent(input => (input.stopHookActive === true ? fakeHookResult() : fakeHookResult({ block: true, reason: REASON_SECRET, record: fakeHookRecord('SubagentStop', 'blocked', { reason: REASON_SECRET }) })))
    const { model, calls } = scripted(call => textParts(call === 1 ? 'Child done' : 'Fixed the build.'))
    const outputs = await runChild(p.session, model)
    const final = outputs.at(-1)!
    expect(final).toMatchObject({ status: 'completed', report: 'Fixed the build.', usage: { inputTokens: 200, outputTokens: 20 } })
    expect(final.error).toBeUndefined()
    expect(calls).toHaveLength(2)
    // The second round: the first prompt, the child's answer, then the feedback (a user message after an assistant one).
    expect(lastMessages(calls[1], 3)).toEqual([
      { role: 'user', content: [{ type: 'text', text: TASK.prompt }], providerOptions: undefined },
      { role: 'assistant', content: [{ type: 'text', text: 'Child done', providerOptions: undefined }], providerOptions: undefined },
      { role: 'user', content: [{ type: 'text', text: feedback(REASON_SECRET) }], providerOptions: undefined },
    ])
    // W12.6: the child's agent (`agent_id` = the parent's task call id, `agent_type`) and the matcher target.
    const agent = { id: 'call_parent', type: 'general' }
    expect(p.snapshot.calls.map(call => call.input)).toEqual([
      { messageId: MESSAGE_ID, stopHookActive: false, tool: { name: 'task', callId: 'call_parent', input: TASK, output: 'Child done' }, agent },
      { messageId: MESSAGE_ID, stopHookActive: true, tool: { name: 'task', callId: 'call_parent', input: TASK, output: 'Fixed the build.' }, agent },
    ])
    expect(p.snapshot.calls.map(call => [call.options.target, call.options.aliases])).toEqual([['general', ['general', 'general-purpose']], ['general', ['general', 'general-purpose']]])
    expect(p.usage).toHaveLength(1)
    expect(p.usage[0]).toMatchObject({ purpose: 'subagent', inputTokens: 200, outputTokens: 20 })
    expect(p.logs.text()).not.toContain(REASON_SECRET)
  })

  it('an always-blocking hook: at most two extra rounds, then the child ends with its last report', async () => {
    const p = parent(fakeHookResult({ block: true, reason: 'more' }))
    const { model, calls } = scripted(call => textParts(`Round ${call}`))
    const final = (await runChild(p.session, model)).at(-1)!
    expect(calls).toHaveLength(1 + LIMITS.subagentStopContinuationsMax)
    expect(final).toMatchObject({ status: 'completed', report: `Round ${1 + LIMITS.subagentStopContinuationsMax}` })
    expect(p.snapshot.calls.map(call => call.input.stopHookActive)).toEqual([false, true, true])
    expect(p.logs.records.some(record => record.level === 'info' && record.msg.includes('blocked again'))).toBe(true)
  })

  it('no extra round for continue: false, a failed child, a child at its step limit, or without SubagentStop hooks', async () => {
    const stopped = parent(fakeHookResult({ block: true, continue: false, stopReason: 'enough' }))
    const one = scripted(() => textParts('Done'))
    expect((await runChild(stopped.session, one.model)).at(-1)).toMatchObject({ status: 'completed', report: 'Done' })
    expect(one.calls).toHaveLength(1)
    expect(stopped.snapshot.calls).toHaveLength(1)

    const failing = parent(fakeHookResult({ block: true, reason: 'x' }))
    const broken = new MockLanguageModelV4({ doStream: async () => {
      throw new Error('upstream down')
    } })
    expect((await runChild(failing.session, broken)).at(-1)?.status).toBe('failed')
    expect(failing.snapshot.calls).toEqual([])

    const limited = parent(fakeHookResult({ block: true, reason: 'x' }), { subagentMaxSteps: 1 })
    const single = scripted(() => textParts('Last words'))
    expect((await runChild(limited.session, single.model)).at(-1)?.status).toBe('limit')
    expect(limited.snapshot.calls).toEqual([])

    const quiet = parent(undefined)
    const plain = scripted(() => textParts('Done'))
    expect((await runChild(quiet.session, plain.model)).at(-1)).toMatchObject({ status: 'completed', usage: { inputTokens: 100, outputTokens: 10 } })
    expect(plain.calls).toHaveLength(1)
  })

  it('an extra round gets only the steps left: the finalize nudge, then the limit', async () => {
    const p = parent(fakeHookResult({ block: true, reason: 'again' }), { subagentMaxSteps: 2 })
    const { model, calls } = scripted(call => textParts(`Round ${call}`))
    const final = (await runChild(p.session, model)).at(-1)!
    expect(calls).toHaveLength(2)
    expect(final).toMatchObject({ status: 'limit', report: 'Round 2' })
  })
})

describe('subagentStop and child hooks end to end (W11.2-T5, T8)', () => {
  let t: TestApp
  let hooks: FakeHookService
  let events: ServerEvent[] = []

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, hooks: 'fake' })
    hooks = t.deps.hooks as FakeHookService
    t.deps.events.subscribe(event => void events.push(event))
    t.deps.registry.tools.register('mock', {
      name: 'child_probe',
      description: 'Records nothing.',
      inputSchema: z.object({ text: z.string() }),
      policy: 'safe',
      execute: async () => ({ ok: true }),
    })
  })

  beforeEach(() => {
    events = []
    hooks.results.clear()
    hooks.targets.clear()
    hooks.present.clear()
    hooks.runCalls.length = 0
  })

  afterAll(async () => {
    await t.close()
  })

  async function reply(chatId: string): Promise<HarnessUIMessage> {
    await runnerOf(t).idle()
    const detail: ChatDetail = chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId}`)).json())
    return detail.messages.at(-1)!
  }

  it('mock:hooks agent …: a blocking SubagentStop → "Agent report: Child continued: <reason>"', async () => {
    hooks.results.set('SubagentStop', input => (input.stopHookActive === true ? fakeHookResult() : fakeHookResult({ block: true, reason: 'add the tests' })))
    const chatId = testChatId(0xD401)
    await readSse(await postChat(t, chatBody(chatId, 'agent check the build', { modelRef: 'mock:hooks', toolMode: 'auto' })))
    const last = await reply(chatId)
    expect(messageText(last)).toBe('Agent report: Child continued: add the tests')
    // Nothing of the child's hooks is stored in the reply.
    expect(last.parts.some(part => part.type === 'data-hook')).toBe(false)
    expect(hooks.runCalls.filter(call => call.event === 'SubagentStop').map(call => call.input.stopHookActive)).toEqual([false, true])
  })

  it('a child PreToolUse ask is a denial: no approval card, the parent goes on', async () => {
    hooks.targets.set(hookTargetKey('PreToolUse', 'child_probe'), fakeHookResult({ decision: 'ask', reason: 'ask me', record: fakeHookRecord('PreToolUse', 'asked') }))
    const chatId = testChatId(0xD402)
    await readSse(await postChat(t, chatBody(chatId, 'agent call child_probe {"text":"a"}', { modelRef: 'mock:hooks', toolMode: 'auto' })))
    const last = await reply(chatId)
    expect(messageText(last)).toBe('Agent report: Child done')
    expect(last.parts.some(part => (part as { state?: string }).state === 'approval-requested')).toBe(false)
    const task = last.parts.find(part => part.type === 'tool-task') as { output?: TaskOutput } | undefined
    expect(task?.output?.steps.map(step => [step.toolName, step.state])).toEqual([['child_probe', 'denied']])
    expect(events.find(event => event.type === 'run.finished' && event.data.chatId === chatId)?.data).toMatchObject({ awaitingApproval: false })
    expect(hooks.runCalls.map(call => [call.event, call.input.tool?.callId?.includes('/')])).toContainEqual(['PreToolUse', true])
  })
})

describe('subagentStop of a background child (W11.2-T5)', () => {
  let t: TestApp
  let hooks: FakeHookService

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, hooks: 'fake' })
    hooks = t.deps.hooks as FakeHookService
  })

  afterAll(async () => {
    await t.close()
  })

  function launchInput(chatId: string, model: LanguageModelV4): BackgroundLaunchInput {
    return {
      chatId,
      messageId: MESSAGE_ID,
      toolCallId: 'call_bg',
      task: { ...TASK, background: true },
      origin: 'request',
      model: resolvedModel(model),
      toolMode: 'auto',
      workspace: null,
      scope: null,
      settings: DEFAULT_SETTINGS,
      reasoningEffort: 'auto',
      chatInstructions: undefined,
      catalog: testCatalog(),
      logger: createSilentLogger(),
    }
  }

  it('the detached host carries the hooks of one snapshot of the launching chat\'s scope', async () => {
    const kids = scriptedChildren()
    const tasks = createBackgroundTasks(t.deps, recordingHost(), { runChild: kids.runChild })
    const chatId = testChatId(0xD403)
    await t.deps.chats.create({ id: chatId, modelRef: 'mock:hooks', settings: {} })
    hooks.snapshots.length = 0
    const { model } = scripted(() => textParts('x'))
    await tasks.launch({ ...launchInput(chatId, model), toolMode: 'plan' })
    const child = await kids.started(1)
    expect(child.input.session.hooks).not.toBeNull()
    expect(typeof child.input.session.hooks?.forChild).toBe('function')
    expect(hooks.snapshots.map(snapshot => snapshot.scope)).toEqual([{ chatId, projectId: null, workspace: null, toolMode: 'plan', origin: 'request', modelRef: 'testkit:child' }])
    child.end()
    await tasks.stopAll()
  })

  it('a blocking SubagentStop continues the detached child; its result carries the last report', async () => {
    hooks.results.set('SubagentStop', input => (input.stopHookActive === true ? fakeHookResult() : fakeHookResult({ block: true, reason: 'one more pass' })))
    const tasks = createBackgroundTasks(t.deps, recordingHost())
    const chatId = testChatId(0xD404)
    await t.deps.chats.create({ id: chatId, modelRef: 'mock:hooks', settings: {} })
    const { model, calls } = scripted(call => textParts(call === 1 ? 'First pass' : 'Second pass'))
    const launched = await tasks.launch(launchInput(chatId, model))
    expect(launched.status).toBe('background')
    await vi.waitFor(async () => {
      const [task] = await tasks.list(chatId)
      expect(task?.status).toBe('completed')
    }, { timeout: 5000, interval: 5 })
    const [task] = await tasks.list(chatId)
    expect(task?.output.report).toBe('Second pass')
    expect(calls).toHaveLength(2)
    expect(lastMessages(calls[1], 1)).toEqual([{ role: 'user', content: [{ type: 'text', text: feedback('one more pass') }], providerOptions: undefined }])
    await tasks.stopAll()
  })
})
