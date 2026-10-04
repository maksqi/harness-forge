// The sub-agent runner (W9.5-T3 / T5, ADR-043) over `MockLanguageModelV4`: snapshots, the report, the usage row and
// cost, the semaphore (five calls: three run, two wait as `queued`), the per-run cap, the abort from the parent, the
// deadline, the step limit with the finalize nudge, denied and failed child calls, the model fallback and the logs.
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { ToolCallContext, ToolDefinition } from '@harness-forge/plugin-sdk'
import type { Settings, TaskInput, TaskOutput, ToolMode } from '@harness-forge/shared'
import type { MemoryLogger } from '../../logger.ts'
import type { ResolvedModel } from '../../providers/types.ts'
import type { RegisteredTool } from '../../registry/types.ts'
import type { UsageInput } from '../../services/chats/types.ts'
import type { CustomizationCatalog } from '../../services/customizations/types.ts'
import type { FakeCustomizationService } from '../../testing/fake-customizations.ts'
import type { AgentRunScope } from '../agent-scope.ts'
import type { BackgroundTasks } from '../background/types.ts'
import type { RunSession } from '../pipeline.ts'
import type { ChildSession, HostSession } from './host.ts'
import type { SubagentRunner, SubagentRunnerInput, SubagentRunnerLimits } from './index.ts'
import { HarnessError, LIMITS, taskOutputSchema } from '@harness-forge/shared'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createMemoryLogger } from '../../logger.ts'
import { createFakeBackgroundTasks } from '../../testing/fake-background-tasks.ts'
import { catalogEntryKey, createFakeCustomizationService } from '../../testing/fake-customizations.ts'
import { agentScopeOf } from '../agent-scope.ts'
import { BACKGROUND_STOPPED_TEXT } from '../background/types.ts'
import { SUBAGENT_INSTRUCTIONS_MARKER } from '../markers.ts'
import { catalogEntry, testCatalog } from '../testing.ts'
import { createDetachedSession } from './host.ts'
import {
  agentSnapshot,
  availableAgentTypes,
  BACKGROUND_DEADLINE_TEXT,
  createSubagentRunner,
  createSubagentRunnerWith,
  finalizeStep,
  normalizeAgentType,
  resolveAgentType,
  runDetachedChild,
  SUBAGENT_EXPLORE_TEXT,
  SUBAGENT_FINALIZE_TEXT,
  SUBAGENT_RUN_LIMIT_TEXT,
  SUBAGENT_STOPPED_TEXT,
  subagentDeadlineText,
  SubagentSlots,
  subagentStepLimitText,
  unknownAgentTypeText,
} from './index.ts'
import { SUBAGENT_APPROVAL_DENIED_TEXT } from './tools.ts'

const MESSAGE_ID = 'msg_a000000000000001'
const PROMPT = 'List the project files and report the secret-free summary.'
const TASK: TaskInput = { description: 'List the files', prompt: PROMPT, type: 'general' }

afterEach(() => {
  vi.useRealTimers()
})

// ---------- model helpers ----------

function finishPart(reason: 'stop' | 'tool-calls' = 'stop'): LanguageModelV4StreamPart {
  return {
    type: 'finish',
    usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
    finishReason: { unified: reason, raw: reason },
  }
}

function textParts(text: string): LanguageModelV4StreamPart[] {
  return [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, finishPart()]
}

function callParts(toolCallId: string, toolName: string, input: unknown): LanguageModelV4StreamPart[] {
  return [{ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) }, finishPart('tool-calls')]
}

/** A model whose answer is computed from the call options (calls are recorded). */
function scripted(script: (options: LanguageModelV4CallOptions, call: number) => LanguageModelV4StreamPart[] | ReadableStream<LanguageModelV4StreamPart>) {
  const calls: LanguageModelV4CallOptions[] = []
  const model = new MockLanguageModelV4({
    provider: 'testkit',
    modelId: 'child',
    doStream: async (options) => {
      calls.push(options)
      const parts = script(options, calls.length)
      return { stream: Array.isArray(parts) ? convertArrayToReadableStream(parts) : parts }
    },
  })
  return { model, calls }
}

/** A stream that sends `before`, then waits until the call aborts (and fails with its reason). */
function hangingStream(options: LanguageModelV4CallOptions, before: LanguageModelV4StreamPart[] = []): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of before)
        controller.enqueue(part)
      const signal = options.abortSignal
      const fail = (): void => controller.error(signal?.reason ?? new DOMException('aborted', 'AbortError'))
      if (signal?.aborted)
        fail()
      else
        signal?.addEventListener('abort', fail, { once: true })
    },
  })
}

function toolNames(call: LanguageModelV4CallOptions | undefined): string[] {
  return (call?.tools ?? []).flatMap(tool => (tool.type === 'function' ? [tool.name] : [])).sort()
}

function systemOf(call: LanguageModelV4CallOptions | undefined): string {
  const first = call?.prompt[0]
  return first?.role === 'system' ? first.content : ''
}

function resolvedModel(model: LanguageModelV4, modelId = 'child'): ResolvedModel {
  return {
    modelRef: `testkit:${modelId}`,
    providerId: 'testkit',
    modelId,
    info: { id: modelId, name: modelId },
    entry: {
      ref: `testkit:${modelId}`,
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

// ---------- a fake parent run ----------

interface Harness {
  session: RunSession
  usage: UsageInput[]
  extraCosts: number[]
  logs: MemoryLogger
  run: AbortController
  toolContexts: Array<{ name: string, c: ToolCallContext, agent: AgentRunScope | null }>
}

function registered(pluginId: string, definition: Partial<ToolDefinition> & { name: string }, toolContexts: Harness['toolContexts']): RegisteredTool {
  return {
    pluginId,
    mcpServerId: null,
    title: null,
    definition: {
      description: definition.name,
      inputSchema: z.object({ path: z.string().optional(), command: z.string().optional() }),
      policy: 'safe',
      execute: async (_input: unknown, c: ToolCallContext) => {
        toolContexts.push({ name: definition.name, c, agent: agentScopeOf(c) })
        return `${definition.name} result`
      },
      ...definition,
    } as ToolDefinition,
  }
}

interface HarnessOptions {
  settings?: Partial<Settings>
  tools?: (contexts: Harness['toolContexts']) => RegisteredTool[]
  resolve?: (ref: string) => Promise<ResolvedModel>
  /** The customization service custom agents load their definitions from (Phase 10). */
  customizations?: FakeCustomizationService
}

function harness(options: HarnessOptions = {}): Harness {
  const usage: UsageInput[] = []
  const extraCosts: number[] = []
  const logs = createMemoryLogger()
  const run = new AbortController()
  const toolContexts: Harness['toolContexts'] = []
  const tools = options.tools?.(toolContexts) ?? [
    registered('acme', { name: 'probe' }, toolContexts),
    registered('core-agent', { name: 'task' }, toolContexts),
    registered('core-agent', { name: 'todo_write' }, toolContexts),
  ]
  const deps = {
    registry: {
      tools: { list: () => tools, get: (name: string) => tools.find(entry => entry.definition.name === name), register: () => ({ dispose() {} }) },
      hooks: { run: async () => {}, on: () => ({ dispose() {} }), list: () => [] },
    },
    plugins: {
      guard: async <T>(_pluginId: string, fn: (signal: AbortSignal) => T | Promise<T>, guardOptions: { signal?: AbortSignal }) => {
        const controller = new AbortController()
        guardOptions.signal?.addEventListener('abort', () => controller.abort(guardOptions.signal?.reason), { once: true })
        return fn(controller.signal)
      },
      isActive: () => true,
    },
    tools: { prefs: async () => new Map() },
    mcp: { list: async () => [] },
    env: { workspaceShell: true },
    providers: {
      resolveModel: options.resolve ?? (async (ref: string) => {
        throw new HarnessError({ code: 'model_not_found', message: `No model ${ref}.` })
      }),
      mapError: (_providerId: string, error: unknown) => new HarnessError({ code: 'provider_error', message: `Upstream: ${error instanceof Error ? error.message : 'error'}` }),
    },
    chats: { addUsage: async (row: UsageInput) => void usage.push(row) },
    redactor: { redactText: (text: string) => text },
    customizations: options.customizations ?? createFakeCustomizationService(),
  }
  const settings = { instructions: 'Global rules.', subagentModelRef: null, subagentMaxSteps: 30, autoCompact: false, compactModelRef: null, ...options.settings }
  const session = {
    chatId: 'chat',
    assistantId: MESSAGE_ID,
    notices: [],
    addExtraCost: (usd: number) => void extraCosts.push(usd),
    inject: () => {},
    writeTransient: () => {},
    ctx: {
      deps,
      prepared: { settings, chat: { settings: {} }, history: [] },
      reasoningEffort: 'auto',
      run: { signal: run.signal },
      now: () => Date.now(),
      logger: logs.logger,
    },
  } as unknown as RunSession
  return { session, usage, extraCosts, logs, run, toolContexts }
}

function runner(h: Harness, model: LanguageModelV4, toolMode: ToolMode = 'ask', limits?: SubagentRunnerLimits, background?: BackgroundTasks, catalog?: CustomizationCatalog): SubagentRunner {
  const input: SubagentRunnerInput = {
    session: h.session,
    model: resolvedModel(model),
    toolMode,
    workspace: null,
    scope: null,
    catalog: catalog ?? testCatalog(),
    background: background ?? createFakeBackgroundTasks(),
    origin: 'request',
  }
  return limits === undefined ? createSubagentRunner(input) : createSubagentRunnerWith(input, limits)
}

async function collect(iterable: AsyncIterable<TaskOutput>): Promise<TaskOutput[]> {
  const outputs: TaskOutput[] = []
  for await (const output of iterable)
    outputs.push(output)
  return outputs
}

function callOptions(signal: AbortSignal = new AbortController().signal, toolCallId = 'call_parent') {
  return { toolCallId, signal }
}

// ---------- tests ----------

describe('createSubagentRunner: one child', () => {
  it('streams snapshots and ends with the report, the steps, the usage row and the cost', async () => {
    const h = harness()
    const { model, calls } = scripted((_options, call) => (call === 1 ? callParts('c1', 'probe', { path: 'src' }) : textParts('Found 3 files in src.')))
    const outputs = await collect(runner(h, model).run(TASK, callOptions()))

    for (const output of outputs)
      expect(taskOutputSchema.safeParse(output).success).toBe(true)
    expect(outputs[0]).toMatchObject({ status: 'running', steps: [], report: '', modelRef: 'testkit:child', type: 'general', description: 'List the files' })
    expect(outputs.some(output => output.steps[0]?.state === 'running')).toBe(true)
    const final = outputs.at(-1)!
    expect(final).toMatchObject({
      status: 'completed',
      steps: [{ toolCallId: 'c1', toolName: 'probe', summary: 'src', state: 'done', resultPreview: 'probe result' }],
      stepsOmitted: 0,
      report: 'Found 3 files in src.',
      usage: { inputTokens: 200, outputTokens: 20, totalTokens: 220 },
    })
    expect(final.error).toBeUndefined()
    expect(final.finishedAt).toBeGreaterThanOrEqual(final.startedAt)
    const cost = (200 * 1 + 20 * 2) / 1_000_000
    expect(final.costUsd).toBeCloseTo(cost, 12)
    expect(outputs.slice(0, -1).every(output => output.status === 'running' && output.finishedAt === undefined)).toBe(true)

    // One usage row (purpose subagent, the child's model) and the cost added to the reply.
    expect(h.usage).toEqual([expect.objectContaining({ chatId: 'chat', messageId: MESSAGE_ID, purpose: 'subagent', providerId: 'testkit', modelId: 'child', inputTokens: 200, outputTokens: 20 })])
    expect(h.extraCosts).toHaveLength(1)
    expect(h.extraCosts[0]).toBeCloseTo(cost, 12)

    // The child call: the preamble with the marker before the global rules, the prompt as the only user message, no
    // agent tool (no task: depth 1), and no agent scope in the child's tool calls.
    const system = systemOf(calls[0])
    expect(system.startsWith(SUBAGENT_INSTRUCTIONS_MARKER)).toBe(true)
    expect(system.indexOf('Global rules.')).toBeGreaterThan(system.indexOf(SUBAGENT_INSTRUCTIONS_MARKER))
    expect(system).not.toContain(SUBAGENT_EXPLORE_TEXT)
    expect(calls[0]!.prompt.filter(message => message.role === 'user')).toEqual([{ role: 'user', content: [{ type: 'text', text: PROMPT }] }])
    expect(toolNames(calls[0])).toEqual(['probe'])
    expect(h.toolContexts).toHaveLength(1)
    expect(h.toolContexts[0]!.c.toolCallId).toBe('call_parent/c1')
    expect(h.toolContexts[0]!.agent).toBeNull()

    // Nothing of the prompt, the steps or the report reaches the log.
    const logged = JSON.stringify(h.logs.records)
    expect(logged).not.toContain(PROMPT)
    expect(logged).not.toContain('Found 3 files')
  })

  it('tells an explore child that it is read-only', async () => {
    const h = harness()
    const { model, calls } = scripted(() => textParts('Nothing to change.'))
    await collect(runner(h, model, 'auto').run({ ...TASK, type: 'explore' }, callOptions()))
    expect(systemOf(calls[0])).toContain(SUBAGENT_EXPLORE_TEXT)
  })

  it('uses subagentModelRef when it resolves, else falls back to the run model (logged without the prompt)', async () => {
    const own = scripted(() => textParts('From the sub-agent model.'))
    const parent = scripted(() => textParts('From the run model.'))
    const resolving = harness({ settings: { subagentModelRef: 'testkit:small' }, resolve: async () => resolvedModel(own.model, 'small') })
    const outputs = await collect(runner(resolving, parent.model).run(TASK, callOptions()))
    expect(outputs.at(-1)).toMatchObject({ status: 'completed', modelRef: 'testkit:small', report: 'From the sub-agent model.' })
    expect(resolving.usage[0]).toMatchObject({ modelId: 'small' })
    expect(parent.calls).toHaveLength(0)

    const missing = harness({ settings: { subagentModelRef: 'testkit:gone' } })
    const fallback = await collect(runner(missing, parent.model).run(TASK, callOptions()))
    expect(fallback.at(-1)).toMatchObject({ status: 'completed', modelRef: 'testkit:child', report: 'From the run model.' })
    expect(missing.logs.records).toContainEqual(expect.objectContaining({ msg: 'the sub-agent model cannot be resolved; the chat model runs the sub-agent' }))
    expect(JSON.stringify(missing.logs.records)).not.toContain(PROMPT)
  })

  it('a failing model call ends the child as failed with the mapped error', async () => {
    const h = harness()
    const model = new MockLanguageModelV4({
      provider: 'testkit',
      modelId: 'child',
      doStream: async () => {
        throw new Error('upstream exploded')
      },
    })
    const outputs = await collect(runner(h, model).run(TASK, callOptions()))
    expect(outputs.at(-1)).toMatchObject({ status: 'failed', error: 'Upstream: upstream exploded', report: '' })
    expect(h.usage).toEqual([])
  })
})

describe('createSubagentRunner: tool calls that cannot run', () => {
  it('a call that would ask is a denied step (never an approval request); a missing tool is an error step', async () => {
    const h = harness({
      tools: contexts => [
        registered('acme', { name: 'probe' }, contexts),
        // A policy function decides per call: the tool is offered, and its `ask` becomes the sub-agent denial.
        registered('acme', { name: 'writer', policy: () => 'ask' }, contexts),
      ],
    })
    const { model, calls } = scripted((_options, call) => {
      if (call === 1)
        return callParts('c1', 'writer', { path: 'a.txt' })
      if (call === 2)
        return callParts('c2', 'missing_tool', {})
      return textParts('Could not write.')
    })
    const outputs = await collect(runner(h, model, 'ask').run(TASK, callOptions()))
    const final = outputs.at(-1)!
    expect(final.status).toBe('completed')
    expect(final.steps).toEqual([
      { toolCallId: 'c1', toolName: 'writer', summary: 'a.txt', state: 'denied', resultPreview: SUBAGENT_APPROVAL_DENIED_TEXT },
      expect.objectContaining({ toolCallId: 'c2', toolName: 'missing_tool', state: 'error' }),
    ])
    expect(final.steps[1]!.resultPreview).toContain('missing_tool')
    expect(h.toolContexts).toEqual([])
    // The model reads the denial with the sub-agent reason.
    expect(JSON.stringify(calls[1]!.prompt)).toContain(SUBAGENT_APPROVAL_DENIED_TEXT)
  })
})

describe('createSubagentRunner: the step limit', () => {
  it('the last allowed step offers no tool and asks for the report; the status is limit', async () => {
    const h = harness({ settings: { subagentMaxSteps: 2 } })
    const { model, calls } = scripted((options, call) => (toolNames(options).length > 0 ? callParts(`c${call}`, 'probe', { path: '.' }) : textParts('Final report.')))
    const outputs = await collect(runner(h, model).run(TASK, callOptions()))
    expect(calls).toHaveLength(2)
    expect(toolNames(calls[0])).toEqual(['probe'])
    expect(toolNames(calls[1])).toEqual([])
    expect(systemOf(calls[1])).toContain(SUBAGENT_FINALIZE_TEXT)
    expect(systemOf(calls[0])).not.toContain(SUBAGENT_FINALIZE_TEXT)
    expect(outputs.at(-1)).toMatchObject({ status: 'limit', report: 'Final report.', error: subagentStepLimitText(2) })
    expect(h.usage).toHaveLength(1)
  })

  it('finalizeStep applies to the last allowed step only', () => {
    const fired: number[] = []
    const piece = finalizeStep(3, () => fired.push(1))
    const step = (stepNumber: number) => piece({ stepNumber, messages: [], instructions: 'Rules.', steps: [] })
    expect(step(0)).toBeUndefined()
    expect(step(1)).toBeUndefined()
    expect(step(2)).toEqual({ activeTools: [], instructions: `Rules.\n\n${SUBAGENT_FINALIZE_TEXT}` })
    expect(fired).toEqual([1])
    expect(finalizeStep(1, () => {})({ stepNumber: 0, messages: [], instructions: undefined, steps: [] })).toEqual({ activeTools: [], instructions: SUBAGENT_FINALIZE_TEXT })
  })
})

describe('createSubagentRunner: the semaphore and the per-run cap', () => {
  it('five calls: three run, two wait as queued; never more than three at once; all complete', async () => {
    const h = harness()
    let active = 0
    let peak = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const model = new MockLanguageModelV4({
      provider: 'testkit',
      modelId: 'child',
      doStream: async () => {
        active += 1
        peak = Math.max(peak, active)
        await gate
        return {
          stream: convertArrayToReadableStream(textParts('Done.')).pipeThrough(new TransformStream({
            flush() {
              active -= 1
            },
          })),
        }
      },
    })
    const subagents = runner(h, model)
    const outputs: TaskOutput[][] = Array.from({ length: 5 }, () => [])
    const runs = outputs.map(async (list, index) => {
      for await (const output of subagents.run({ ...TASK, description: `Task ${index + 1}` }, callOptions(undefined, `call_${index}`)))
        list.push(output)
    })
    await vi.waitFor(() => expect(active).toBe(3))
    expect(outputs.map(list => list[0]?.status)).toEqual(['running', 'running', 'running', 'queued', 'queued'])
    release()
    await Promise.all(runs)
    expect(peak).toBe(3)
    for (const list of outputs)
      expect(list.at(-1)).toMatchObject({ status: 'completed', report: 'Done.' })
    expect(outputs[3]!.map(output => output.status)).toEqual(['queued', 'running', 'running', 'completed'])
    expect(h.usage).toHaveLength(5)
  })

  it(`starts at most ${LIMITS.subagentsPerRunMax} children per run; later calls fail at once`, async () => {
    const h = harness()
    const { model, calls } = scripted(() => textParts('ok'))
    const subagents = runner(h, model)
    for (let i = 0; i < LIMITS.subagentsPerRunMax; i++)
      expect((await collect(subagents.run(TASK, callOptions()))).at(-1)?.status).toBe('completed')
    const over = await collect(subagents.run(TASK, callOptions()))
    expect(over).toHaveLength(1)
    expect(over[0]).toMatchObject({ status: 'failed', error: SUBAGENT_RUN_LIMIT_TEXT, steps: [], report: '' })
    expect(taskOutputSchema.safeParse(over[0]).success).toBe(true)
    expect(calls).toHaveLength(LIMITS.subagentsPerRunMax)

    const small = runner(harness(), model, 'ask', { perRunMax: 1 })
    await collect(small.run(TASK, callOptions()))
    expect((await collect(small.run(TASK, callOptions())))[0]?.status).toBe('failed')
  })

  it('subagentSlots: first come, first served; an aborted waiter leaves the queue', async () => {
    const slots = new SubagentSlots(1)
    expect(slots.tryAcquire()).toBe(true)
    expect(slots.tryAcquire()).toBe(false)
    const order: string[] = []
    const aborted = new AbortController()
    const a = slots.acquire(new AbortController().signal).then(ok => order.push(`a:${ok}`))
    const b = slots.acquire(aborted.signal).then(ok => order.push(`b:${ok}`))
    const c = slots.acquire(new AbortController().signal).then(ok => order.push(`c:${ok}`))
    expect(slots.waiting).toBe(3)
    aborted.abort()
    await b
    expect(slots.waiting).toBe(2)
    slots.release()
    await a
    slots.release()
    await c
    slots.release()
    expect(order).toEqual(['b:false', 'a:true', 'c:true'])
    expect(slots.free).toBe(1)
    expect(await slots.acquire(aborted.signal)).toBe(false)
  })
})

describe('createSubagentRunner: abort and deadline', () => {
  it('the parent call signal (Stop) aborts the child, which keeps its partial report', async () => {
    const h = harness()
    const { model } = scripted(options => hangingStream(options, [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Looking at src.' }]))
    const controller = new AbortController()
    const outputs: TaskOutput[] = []
    const done = (async () => {
      for await (const output of runner(h, model).run(TASK, callOptions(controller.signal)))
        outputs.push(output)
    })()
    await vi.waitFor(() => expect(outputs.length).toBeGreaterThan(0))
    controller.abort(new DOMException('stopped', 'AbortError'))
    await done
    expect(outputs.at(-1)).toMatchObject({ status: 'aborted', error: SUBAGENT_STOPPED_TEXT })
  })

  it('the run signal ends running and queued children alike', async () => {
    const h = harness()
    const { model } = scripted(options => hangingStream(options))
    const subagents = runner(h, model, 'ask', { parallelMax: 1 })
    const first = collect(subagents.run(TASK, callOptions()))
    const queued: TaskOutput[] = []
    const second = (async () => {
      for await (const output of subagents.run(TASK, callOptions()))
        queued.push(output)
    })()
    await vi.waitFor(() => expect(queued[0]?.status).toBe('queued'))
    h.run.abort(new DOMException('stopped', 'AbortError'))
    expect((await first).at(-1)).toMatchObject({ status: 'aborted', error: SUBAGENT_STOPPED_TEXT })
    await second
    expect(queued.map(output => output.status)).toEqual(['queued', 'aborted'])
    expect(queued.at(-1)?.finishedAt).toBeDefined()
  })

  it('the deadline (570 s) ends the child as limit with its partial report', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = harness()
    const { model } = scripted(options => hangingStream(options, [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Half way.' }]))
    const outputs: TaskOutput[] = []
    const done = (async () => {
      for await (const output of runner(h, model).run(TASK, callOptions()))
        outputs.push(output)
    })()
    // `vi.waitFor` advances the fake clock by its interval while it polls: stay a second short of the deadline.
    await vi.waitFor(() => expect(outputs.length).toBeGreaterThan(0))
    await vi.advanceTimersByTimeAsync(LIMITS.subagentTimeoutMs - 1000)
    expect(outputs.at(-1)?.status).toBe('running')
    await vi.advanceTimersByTimeAsync(1000)
    await done
    expect(outputs.at(-1)).toMatchObject({ status: 'limit', report: 'Half way.', error: subagentDeadlineText(LIMITS.subagentTimeoutMs) })
    expect(subagentDeadlineText(LIMITS.subagentTimeoutMs)).toBe('The sub-agent reached its time limit (570 s).')
  })
})

// ---------- Phase 10 (C31 seams): background launches, the detached child, the structural host ----------

const REVIEWER_PATH = '.harness/agents/reviewer.md'
const REVIEWER_BODY = 'PERSONA: strict reviewer\nReview the diff line by line.'

/** A catalog with the builtins, the project agent `reviewer` and inactive entries (shadowed, invalid, off). */
function customCatalog(extra: Parameters<typeof catalogEntry>[2] = {}): CustomizationCatalog {
  return testCatalog([
    catalogEntry('agent', 'explore'),
    catalogEntry('agent', 'general'),
    catalogEntry('agent', 'reviewer', { source: 'project', path: REVIEWER_PATH, description: 'Reviews the diff.', ...extra }),
    catalogEntry('agent', 'old', { source: 'user', state: 'shadowed' }),
    catalogEntry('agent', 'broken', { source: 'project', state: 'invalid' }),
    catalogEntry('agent', 'paused', { source: 'user', state: 'off' }),
  ])
}

/** A fake customization service whose `reviewer` body has these frontmatter lines. */
function reviewerService(frontmatter: string[] = [], body = REVIEWER_BODY): FakeCustomizationService {
  const service = createFakeCustomizationService()
  const content = ['---', 'name: reviewer', 'description: Reviews the diff.', ...frontmatter, '---', body].join('\n')
  service.bodies.set(catalogEntryKey({ kind: 'agent', source: 'project', name: 'reviewer', path: REVIEWER_PATH }), content)
  return service
}

describe('createSubagentRunner: background launches (Phase 10)', () => {
  const BACKGROUND_TASK: TaskInput = { ...TASK, type: 'explore', background: true }

  it('yields the manager\'s failed launch output (a cap) as it is, without a model call', async () => {
    const h = harness()
    const { model, calls } = scripted(() => textParts('never'))
    const capped = 'At most 3 background agents run per chat. Wait for one to finish.'
    const tasks = createFakeBackgroundTasks({
      launch: input => ({ status: 'failed', type: input.task.type, description: input.task.description, modelRef: input.model.modelRef, steps: [], stepsOmitted: 0, report: '', startedAt: 1, finishedAt: 1, error: capped }),
    })
    const outputs = await collect(runner(h, model, 'ask', undefined, tasks).run(BACKGROUND_TASK, callOptions()))
    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toMatchObject({ status: 'failed', type: 'explore', description: 'List the files', error: capped, steps: [], report: '' })
    expect(outputs[0]!.agent).toBeUndefined()
    expect(taskOutputSchema.safeParse(outputs[0]).success).toBe(true)
    expect(calls).toHaveLength(0)
    expect(h.usage).toEqual([])
  })

  it('launches with the parent\'s values and yields the launch output at once', async () => {
    const h = harness()
    const tasks = createFakeBackgroundTasks()
    const { model, calls } = scripted(() => textParts('never'))
    const parentModel = resolvedModel(model)
    const input: SubagentRunnerInput = {
      session: h.session,
      model: parentModel,
      toolMode: 'edits',
      workspace: null,
      scope: null,
      catalog: testCatalog(),
      background: tasks,
      origin: 'queue',
    }
    const controller = new AbortController()
    const outputs = await collect(createSubagentRunner(input).run(BACKGROUND_TASK, callOptions(controller.signal, 'call_bg')))
    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toMatchObject({ status: 'background', taskId: expect.stringMatching(/^bgt_/) })
    expect(calls).toHaveLength(0)
    expect(tasks.launches).toHaveLength(1)
    const launch = tasks.launches[0]!
    expect(launch).toMatchObject({
      chatId: 'chat',
      messageId: MESSAGE_ID,
      toolCallId: 'call_bg',
      task: BACKGROUND_TASK,
      origin: 'queue',
      toolMode: 'edits',
      workspace: null,
      scope: null,
      reasoningEffort: 'auto',
      settings: expect.objectContaining({ instructions: 'Global rules.', subagentMaxSteps: 30 }),
    })
    expect(launch.model).toBe(parentModel)
    expect(launch.catalog).toBe(input.catalog)
    expect(launch.chatInstructions).toBeUndefined()
  })

  it('counts a launch toward the per-run cap; a launch that throws is a failed output', async () => {
    const h = harness()
    const { model } = scripted(() => textParts('Report.'))
    const tasks = createFakeBackgroundTasks()
    const limited = runner(h, model, 'ask', { perRunMax: 1 }, tasks)
    expect((await collect(limited.run(BACKGROUND_TASK, callOptions())))[0]?.status).toBe('background')
    expect((await collect(limited.run(TASK, callOptions())))).toEqual([expect.objectContaining({ status: 'failed', error: SUBAGENT_RUN_LIMIT_TEXT })])

    const throwing: BackgroundTasks = { ...createFakeBackgroundTasks(), launch: async () => {
      throw new HarnessError({ code: 'internal_error', message: 'The database is locked.' })
    } }
    const failed = await collect(runner(h, model, 'ask', undefined, throwing).run(BACKGROUND_TASK, callOptions()))
    expect(failed).toEqual([expect.objectContaining({ status: 'failed', error: 'The database is locked.' })])
  })

  it('resolves the type before a launch: an unknown type fails without one; the launch carries the resolved name', async () => {
    const h = harness()
    const { model, calls } = scripted(() => textParts('never'))
    const tasks = createFakeBackgroundTasks()
    const catalog = customCatalog()
    const unknown = await collect(runner(h, model, 'ask', undefined, tasks, catalog).run({ ...BACKGROUND_TASK, type: 'nope' }, callOptions()))
    expect(unknown).toEqual([expect.objectContaining({ status: 'failed', type: 'nope', error: unknownAgentTypeText('nope', ['explore', 'general', 'reviewer']) })])
    expect(tasks.launches).toHaveLength(0)

    const alias = await collect(runner(h, model, 'ask', undefined, tasks, catalog).run({ ...BACKGROUND_TASK, type: 'general-purpose' }, callOptions()))
    expect(alias).toEqual([expect.objectContaining({ status: 'background', agent: { source: 'builtin', description: 'The general agent.' } })])
    expect(tasks.launches[0]!.task.type).toBe('general')

    const custom = await collect(runner(h, model, 'ask', undefined, tasks, catalog).run({ ...BACKGROUND_TASK, type: 'reviewer' }, callOptions()))
    expect(custom[0]).toMatchObject({ status: 'background', agent: { source: 'project', description: 'Reviews the diff.', path: REVIEWER_PATH } })
    expect(tasks.launches[1]!.task.type).toBe('reviewer')
    expect(calls).toHaveLength(0)
  })
})

// ---------- Phase 10 (W10.3): custom agent types ----------

describe('custom agent types (Phase 10, W10.3)', () => {
  it('resolveAgentType: builtins (aliases, case), active catalog agents only', () => {
    const catalog = customCatalog()
    expect(normalizeAgentType('  General-Purpose ')).toBe('general')
    expect(resolveAgentType(catalog, 'general-purpose')).toEqual({ name: 'general', base: 'general', entry: null, agent: { source: 'builtin', description: 'The general agent.' } })
    expect(resolveAgentType(catalog, 'EXPLORE')).toMatchObject({ name: 'explore', base: 'explore', entry: null })
    // A builtin is always available, also from a catalog that does not list it (its own description then).
    expect(resolveAgentType(testCatalog([]), 'explore')?.agent.description).toMatch(/^Searches and reads the project/)
    expect(resolveAgentType(catalog, 'reviewer')).toMatchObject({ name: 'reviewer', base: 'general', entry: { name: 'reviewer', source: 'project' }, agent: { source: 'project', path: REVIEWER_PATH } })
    for (const name of ['old', 'broken', 'paused', 'nope'])
      expect(resolveAgentType(catalog, name)).toBeNull()
    expect(availableAgentTypes(catalog)).toEqual(['explore', 'general', 'reviewer'])
    expect(availableAgentTypes(testCatalog([catalogEntry('agent', 'zeta', { source: 'user' }), catalogEntry('agent', 'alpha', { source: 'plugin', pluginId: 'acme' })]))).toEqual(['explore', 'general', 'alpha', 'zeta'])
    expect(agentSnapshot({ source: 'plugin', description: `Line one\n${'d'.repeat(300)}` }).description).toHaveLength(200)
    expect(unknownAgentTypeText('x', ['explore', 'general', 'reviewer'])).toBe('Unknown agent type x. Available: explore, general, reviewer.')
    const many = Array.from({ length: LIMITS.agentTypesListedMax + 2 }, (_, index) => `a${index}`)
    expect(unknownAgentTypeText('x', many)).toMatch(/ and 2 more\.$/)
  })

  it('an unknown or inactive type fails at once with the available types (no model call, no slot, no usage)', async () => {
    const h = harness()
    const { model, calls } = scripted(() => textParts('never'))
    const subagents = runner(h, model, 'ask', { parallelMax: 1 }, undefined, customCatalog())
    for (const type of ['nope', 'old', 'broken', 'paused']) {
      const outputs = await collect(subagents.run({ ...TASK, type }, callOptions()))
      expect(outputs).toHaveLength(1)
      expect(outputs[0]).toMatchObject({ status: 'failed', type, steps: [], report: '', error: `Unknown agent type ${type}. Available: explore, general, reviewer.` })
      expect(outputs[0]!.agent).toBeUndefined()
      expect(taskOutputSchema.safeParse(outputs[0]).success).toBe(true)
    }
    expect(calls).toHaveLength(0)
    expect(h.usage).toEqual([])
  })

  it('a builtin keeps its behavior; the output carries the resolved type and the builtin snapshot', async () => {
    const h = harness()
    const { model, calls } = scripted(() => textParts('Done.'))
    const outputs = await collect(runner(h, model, 'auto', undefined, undefined, customCatalog()).run({ ...TASK, type: 'general-purpose' }, callOptions()))
    expect(outputs.every(output => output.type === 'general' && output.agent?.source === 'builtin')).toBe(true)
    expect(outputs.at(-1)).toMatchObject({ status: 'completed', agent: { source: 'builtin', description: 'The general agent.' } })
    expect(systemOf(calls[0])).not.toContain(SUBAGENT_EXPLORE_TEXT)
    const explore = scripted(() => textParts('Read.'))
    await collect(runner(h, explore.model, 'auto', undefined, undefined, customCatalog()).run({ ...TASK, type: 'explore' }, callOptions()))
    expect(systemOf(explore.calls[0])).toContain(SUBAGENT_EXPLORE_TEXT)
  })

  it('a custom agent: the marker first, then its body, then the global rules; its tools narrow the set; the snapshot', async () => {
    const h = harness({
      customizations: reviewerService(['tools: probe, task, skill, generate_image, missing_tool']),
      tools: contexts => [
        registered('acme', { name: 'probe' }, contexts),
        registered('acme', { name: 'other' }, contexts),
        registered('core-tools', { name: 'generate_image' }, contexts),
        registered('core-agent', { name: 'task' }, contexts),
        registered('core-agent', { name: 'skill' }, contexts),
      ],
    })
    const { model, calls } = scripted((_options, call) => (call === 1 ? callParts('c1', 'probe', { path: 'src' }) : textParts('Looks good.')))
    const outputs = await collect(runner(h, model, 'auto', undefined, undefined, customCatalog()).run({ ...TASK, type: 'reviewer' }, callOptions()))
    const final = outputs.at(-1)!
    expect(final).toMatchObject({ status: 'completed', type: 'reviewer', report: 'Looks good.', agent: { source: 'project', description: 'Reviews the diff.', path: REVIEWER_PATH } })
    expect(outputs.every(output => output.agent?.path === REVIEWER_PATH)).toBe(true)
    expect(taskOutputSchema.safeParse(final).success).toBe(true)

    const system = systemOf(calls[0])
    expect(system.startsWith(SUBAGENT_INSTRUCTIONS_MARKER)).toBe(true)
    const body = system.indexOf('PERSONA: strict reviewer')
    expect(body).toBeGreaterThan(system.indexOf('Do not ask questions back.'))
    expect(system.indexOf('Global rules.')).toBeGreaterThan(body)
    expect(system).not.toContain(SUBAGENT_EXPLORE_TEXT)
    // Only `probe` (listed and under the ceiling): never task, skill or generate_image, never an unlisted tool.
    expect(toolNames(calls[0])).toEqual(['probe'])
    expect(h.toolContexts.map(entry => entry.c.toolCallId)).toEqual(['call_parent/c1'])
    expect(JSON.stringify(h.logs.records)).not.toContain('Review the diff line by line')
  })

  it('an empty tools list runs the agent without tools; no tools key keeps the whole ceiling', async () => {
    const none = harness({ customizations: reviewerService(['tools: []']) })
    const first = scripted(() => textParts('No tools.'))
    expect((await collect(runner(none, first.model, 'auto', undefined, undefined, customCatalog()).run({ ...TASK, type: 'reviewer' }, callOptions()))).at(-1)?.status).toBe('completed')
    expect(toolNames(first.calls[0])).toEqual([])

    const all = harness({ customizations: reviewerService() })
    const second = scripted(() => textParts('All tools.'))
    await collect(runner(all, second.model, 'auto', undefined, undefined, customCatalog()).run({ ...TASK, type: 'reviewer' }, callOptions()))
    expect(toolNames(second.calls[0])).toEqual(['probe'])
  })

  it('a definition that is gone or no longer valid fails the call (logged without the body)', async () => {
    const gone = harness()
    const { model, calls } = scripted(() => textParts('never'))
    const missing = await collect(runner(gone, model, 'ask', undefined, undefined, customCatalog()).run({ ...TASK, type: 'reviewer' }, callOptions()))
    expect(missing.at(-1)).toMatchObject({ status: 'failed', type: 'reviewer', error: 'The agent "reviewer" is no longer available.', agent: { source: 'project' } })
    expect(gone.logs.records).toContainEqual(expect.objectContaining({ msg: 'a custom agent definition cannot be loaded' }))

    // The file lost its description since the catalog was built: the error names what is wrong.
    const service = createFakeCustomizationService()
    service.bodies.set(catalogEntryKey({ kind: 'agent', source: 'project', name: 'reviewer', path: REVIEWER_PATH }), `---\nname: reviewer\n---\n${REVIEWER_BODY}`)
    const invalid = harness({ customizations: service })
    const failed = await collect(runner(invalid, model, 'ask', undefined, undefined, customCatalog()).run({ ...TASK, type: 'reviewer' }, callOptions()))
    expect(failed.at(-1)).toMatchObject({ status: 'failed', error: 'Add a description.' })
    expect(calls).toHaveLength(0)
    expect(JSON.stringify(invalid.logs.records)).not.toContain('PERSONA')
  })

  describe('the model of a custom agent', () => {
    const own = scripted(() => textParts('From the agent model.'))
    const small = scripted(() => textParts('From the sub-agent model.'))
    const resolve = async (ref: string): Promise<ResolvedModel> => {
      if (ref === 'testkit:own')
        return resolvedModel(own.model, 'own')
      if (ref === 'testkit:small')
        return resolvedModel(small.model, 'small')
      throw new HarnessError({ code: 'model_not_found', message: `No model ${ref}.` })
    }

    async function finalOf(frontmatter: string[], settings: Partial<Settings> = {}): Promise<{ output: TaskOutput, logs: MemoryLogger, parent: number }> {
      const h = harness({ customizations: reviewerService(frontmatter), resolve, settings })
      const parent = scripted(() => textParts('From the run model.'))
      const outputs = await collect(runner(h, parent.model, 'ask', undefined, undefined, customCatalog()).run({ ...TASK, type: 'reviewer' }, callOptions()))
      return { output: outputs.at(-1)!, logs: h.logs, parent: parent.calls.length }
    }

    it('a declared model runs the child (output.modelRef is the model that ran)', async () => {
      const { output, parent } = await finalOf(['model: testkit:own'], { subagentModelRef: 'testkit:small' })
      expect(output).toMatchObject({ status: 'completed', modelRef: 'testkit:own', report: 'From the agent model.' })
      expect(parent).toBe(0)
    })

    it('a declared model that cannot be resolved falls back to subagentModelRef, else the parent, with a warning', async () => {
      const toSetting = await finalOf(['model: testkit:gone'], { subagentModelRef: 'testkit:small' })
      expect(toSetting.output).toMatchObject({ status: 'completed', modelRef: 'testkit:small' })
      expect(toSetting.logs.records).toContainEqual(expect.objectContaining({ level: 'warn', msg: 'the agent\'s model cannot be resolved; the default model runs the sub-agent' }))
      const toParent = await finalOf(['model: testkit:gone'])
      expect(toParent.output).toMatchObject({ status: 'completed', modelRef: 'testkit:child', report: 'From the run model.' })
    })

    it('inherit runs the parent model even with subagentModelRef set; no model uses the default', async () => {
      expect((await finalOf(['model: inherit'], { subagentModelRef: 'testkit:small' })).output).toMatchObject({ modelRef: 'testkit:child', report: 'From the run model.' })
      expect((await finalOf([], { subagentModelRef: 'testkit:small' })).output).toMatchObject({ modelRef: 'testkit:small', report: 'From the sub-agent model.' })
      expect((await finalOf([])).output).toMatchObject({ modelRef: 'testkit:child' })
    })

    it('the first snapshot names the declared model while the call waits for a slot', async () => {
      const h = harness({ customizations: reviewerService(['model: testkit:own']), resolve })
      const { model } = scripted(options => hangingStream(options))
      const subagents = runner(h, model, 'ask', { parallelMax: 1 }, undefined, customCatalog({ modelRef: 'testkit:own' }))
      const first = collect(subagents.run(TASK, callOptions()))
      const queued: TaskOutput[] = []
      const second = (async () => {
        for await (const output of subagents.run({ ...TASK, type: 'reviewer' }, callOptions()))
          queued.push(output)
      })()
      await vi.waitFor(() => expect(queued[0]?.status).toBe('queued'))
      expect(queued[0]).toMatchObject({ modelRef: 'testkit:own', type: 'reviewer' })
      h.run.abort(new DOMException('stopped', 'AbortError'))
      await first
      await second
    })
  })
})

// ---------- Phase 10 (W10.3): the detached child of a background task ----------

describe('runDetachedChild (Phase 10, W10.3)', () => {
  const LAUNCHING = 'msg_a000000000000009'

  function detached(h: Harness, signal: AbortSignal, costs: number[] = []): ChildSession {
    return createDetachedSession({
      deps: h.session.ctx.deps,
      chatId: 'chat',
      messageId: LAUNCHING,
      settings: h.session.ctx.prepared.settings,
      chatInstructions: 'Chat rules.',
      reasoningEffort: 'auto',
      signal,
      logger: h.logs.logger,
      onExtraCost: usd => costs.push(usd),
    })
  }

  it('runs a custom child on its own host: the report, the usage row under the launching message, the cost sink', async () => {
    const h = harness({ customizations: reviewerService(['tools: probe']) })
    const costs: number[] = []
    const { model, calls } = scripted((_options, call) => (call === 1 ? callParts('c1', 'probe', { path: '.' }) : textParts('Background report.')))
    const outputs = await collect(runDetachedChild({
      session: detached(h, new AbortController().signal, costs),
      model: resolvedModel(model),
      toolMode: 'ask',
      workspace: null,
      scope: null,
      catalog: customCatalog(),
      task: { ...TASK, type: 'reviewer', background: true },
      toolCallId: 'call_bg',
    }))
    expect(outputs[0]?.status).toBe('running')
    const final = outputs.at(-1)!
    expect(final).toMatchObject({ status: 'completed', type: 'reviewer', report: 'Background report.', agent: { source: 'project', path: REVIEWER_PATH } })
    expect(final.steps).toEqual([expect.objectContaining({ toolCallId: 'c1', toolName: 'probe', state: 'done' })])
    expect(h.toolContexts.map(entry => entry.c.toolCallId)).toEqual(['call_bg/c1'])
    expect(h.toolContexts[0]!.agent).toBeNull()
    const system = systemOf(calls[0])
    expect(system.startsWith(SUBAGENT_INSTRUCTIONS_MARKER)).toBe(true)
    expect(system.indexOf('Chat rules.')).toBeGreaterThan(system.indexOf('PERSONA: strict reviewer'))
    expect(h.usage).toEqual([expect.objectContaining({ chatId: 'chat', messageId: LAUNCHING, purpose: 'subagent', modelId: 'child' })])
    expect(costs).toHaveLength(1)
    expect(final.costUsd).toBeCloseTo(costs[0]!, 12)
    expect(h.extraCosts).toEqual([])
  })

  it('needs no slot: more children than the parallel limit run at once', async () => {
    const h = harness()
    let active = 0
    let peak = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const model = new MockLanguageModelV4({
      provider: 'testkit',
      modelId: 'child',
      doStream: async () => {
        active += 1
        peak = Math.max(peak, active)
        await gate
        return { stream: convertArrayToReadableStream(textParts('Done.')) }
      },
    })
    const count = LIMITS.subagentParallelMax + 2
    const runs = Array.from({ length: count }, (_, index) => collect(runDetachedChild({
      session: detached(h, new AbortController().signal),
      model: resolvedModel(model),
      toolMode: 'ask',
      workspace: null,
      scope: null,
      catalog: testCatalog(),
      task: { ...TASK, background: true },
      toolCallId: `call_${index}`,
    })))
    await vi.waitFor(() => expect(active).toBe(count))
    release()
    const outputs = await Promise.all(runs)
    expect(peak).toBe(count)
    expect(outputs.map(list => list.at(-1)?.status)).toEqual(Array.from({ length: count }).fill('completed'))
  })

  it('the task\'s stop ends it aborted; its deadline ends it limit; an unknown type fails at once', async () => {
    const h = harness()
    const { model } = scripted(options => hangingStream(options, [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Partial.' }]))
    const base = { model: resolvedModel(model), toolMode: 'ask' as const, workspace: null, scope: null, catalog: testCatalog(), task: { ...TASK, background: true }, toolCallId: 'call_bg' }

    const stop = new AbortController()
    const stopped: TaskOutput[] = []
    const stopping = (async () => {
      for await (const output of runDetachedChild({ ...base, session: detached(h, stop.signal) }))
        stopped.push(output)
    })()
    await vi.waitFor(() => expect(stopped.length).toBeGreaterThan(0))
    stop.abort(new DOMException('stopped', 'AbortError'))
    await stopping
    expect(stopped.at(-1)).toMatchObject({ status: 'aborted', error: BACKGROUND_STOPPED_TEXT, report: 'Partial.' })

    // The manager aborts the task signal together with the deadline.
    const task = new AbortController()
    const deadline = new AbortController()
    const limited: TaskOutput[] = []
    const limiting = (async () => {
      for await (const output of runDetachedChild({ ...base, session: detached(h, task.signal), deadline: deadline.signal }))
        limited.push(output)
    })()
    await vi.waitFor(() => expect(limited.length).toBeGreaterThan(0))
    deadline.abort()
    task.abort()
    await limiting
    expect(limited.at(-1)).toMatchObject({ status: 'limit', error: BACKGROUND_DEADLINE_TEXT, report: 'Partial.' })
    expect(BACKGROUND_DEADLINE_TEXT).toBe('The background agent reached its time limit (30 minutes).')

    const unknown = await collect(runDetachedChild({ ...base, session: detached(h, new AbortController().signal), task: { ...base.task, type: 'nope' } }))
    expect(unknown).toEqual([expect.objectContaining({ status: 'failed', error: unknownAgentTypeText('nope', ['explore', 'general']) })])
  })
})

describe('the structural host (Phase 10, subagent/host.ts)', () => {
  it('a chat run satisfies ChildSession and HostSession; a detached session has the task signal, no history and its own cost sink', () => {
    const h = harness()
    const asChild: ChildSession = h.session
    const asHost: HostSession = h.session
    expect(asChild.assistantId).toBe(asHost.assistantId)

    const controller = new AbortController()
    const costs: number[] = []
    const detached = createDetachedSession({
      deps: h.session.ctx.deps,
      chatId: 'chat',
      messageId: 'msg_a000000000000002',
      settings: h.session.ctx.prepared.settings,
      chatInstructions: 'Chat rules.',
      reasoningEffort: 'high',
      signal: controller.signal,
      logger: h.logs.logger,
      now: () => 42,
      onExtraCost: usd => costs.push(usd),
    })
    expect(detached).toMatchObject({ chatId: 'chat', assistantId: 'msg_a000000000000002' })
    expect(detached.ctx.run.signal).toBe(controller.signal)
    expect(detached.ctx.prepared).toMatchObject({ history: [], continued: null, chat: { settings: { instructions: 'Chat rules.' } } })
    expect(detached.ctx.reasoningEffort).toBe('high')
    expect(detached.ctx.now()).toBe(42)
    detached.addExtraCost(0.5)
    detached.addExtraCost(-1)
    detached.addExtraCost(Number.NaN)
    expect(costs).toEqual([0.5])
    expect(Object.isFrozen(detached)).toBe(true)
    expect(Object.isFrozen(detached.ctx)).toBe(true)
    // Without a sink and without chat instructions.
    const quiet = createDetachedSession({ ...{ deps: h.session.ctx.deps, chatId: 'chat', messageId: MESSAGE_ID, settings: h.session.ctx.prepared.settings, reasoningEffort: 'auto' as const, signal: controller.signal, logger: h.logs.logger }, chatInstructions: undefined })
    expect(() => quiet.addExtraCost(1)).not.toThrow()
    expect(quiet.ctx.prepared.chat.settings).toEqual({})
  })
})
