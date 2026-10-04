// The `task` tool behind the host wrapper (W9.5-T2, ADR-043): an async generator over the agent scope's
// `runSubagent`, streamed as throttled preliminary outputs with the final snapshot last; the model reads the report only;
// no agent scope (a sub-agent's own call, a call outside a run) is one `failed` output.
import type { ToolCallContext, ToolDefinition } from '@harness-forge/plugin-sdk'
import type { TaskInput, TaskOutput } from '@harness-forge/shared'
import type { ToolExecutionOptions } from 'ai'
import type { AgentRunScope, RunSubagentOptions } from '../../chat/agent-scope.ts'
import type { ToolWrapContext } from '../../chat/tools.ts'
import { taskOutputSchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { agentScopeOf } from '../../chat/agent-scope.ts'
import { isAsyncIterable, wrapToModelOutput, wrapToolExecute } from '../../chat/tools.ts'
import { guardCall } from '../../plugins/guard.ts'
import { createTaskTool, TASK_TOOL_NAME, TASK_UNAVAILABLE_ERROR, taskModelText } from './task.ts'

const INPUT: TaskInput = { description: 'List the files', prompt: 'List the project files.', type: 'explore' }
const MESSAGE_ID = 'msg_a000000000000001'

function snapshot(extra: Partial<TaskOutput> = {}): TaskOutput {
  return {
    status: 'running',
    type: 'explore',
    description: 'List the files',
    modelRef: 'mock:subagent',
    steps: [],
    stepsOmitted: 0,
    report: '',
    startedAt: 1,
    ...extra,
  }
}

/** The real guard (timeout, abort) with silent services. */
const guard: ToolWrapContext['plugins']['guard'] = (pluginId, fn, guardOptions) => guardCall(
  { log: () => {}, redactText: text => text, lifecycleSignal: () => undefined, isInactive: () => false },
  pluginId,
  fn,
  guardOptions,
)

function wrapContext(agent: AgentRunScope | null, hooks: string[] = []): ToolWrapContext {
  return {
    chatId: 'chat',
    messageId: MESSAGE_ID,
    modelRef: 'mock:subagent',
    registry: { hooks: { run: async (name, ..._args) => {
      hooks.push(name)
    }, on: () => ({ dispose() {} }), list: () => [] } },
    plugins: { guard, isActive: () => true },
    signal: new AbortController().signal,
    agent,
  }
}

function scope(run: AgentRunScope['runSubagent']): AgentRunScope {
  return {
    chatId: 'chat',
    messageId: MESSAGE_ID,
    toolMode: 'ask',
    runSubagent: run,
    todos: () => null,
    loadSkill: async () => {
      throw new Error('not used')
    },
    savePlan: async () => ({}),
  }
}

const options: ToolExecutionOptions<unknown> = { toolCallId: 'mock_call_1_1', messages: [], context: undefined }

async function collect(result: unknown): Promise<unknown[]> {
  expect(isAsyncIterable(result)).toBe(true)
  const values: unknown[] = []
  for await (const value of result as AsyncIterable<unknown>)
    values.push(value)
  return values
}

describe('task through the host wrapper', () => {
  const task = createTaskTool() as unknown as ToolDefinition
  const registered = { pluginId: 'core-agent', definition: task }

  it('streams the snapshots of runSubagent (throttled) and ends with the final one; tool.after runs once', async () => {
    const calls: Array<{ input: TaskInput, options: RunSubagentOptions, bound: AgentRunScope | null }> = []
    const hooks: string[] = []
    const agent = scope(async function* (input, runOptions) {
      calls.push({ input, options: runOptions, bound: null })
      yield snapshot({ status: 'queued' })
      for (let i = 0; i < 5; i++)
        yield snapshot({ steps: [{ toolCallId: `c${i}`, toolName: 'read_file', summary: `f${i}`, state: 'done' }] })
      yield snapshot({ status: 'completed', report: 'Found 3 files.', finishedAt: 2 })
    })
    const values = await collect(wrapToolExecute(registered, wrapContext(agent, hooks))(INPUT, options))
    expect(values.length).toBeGreaterThanOrEqual(2)
    expect(values.length).toBeLessThan(7)
    expect(values[0]).toMatchObject({ status: 'queued' })
    const final = taskOutputSchema.parse(values.at(-1))
    expect(final).toMatchObject({ status: 'completed', report: 'Found 3 files.' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.input).toEqual(INPUT)
    expect(calls[0]!.options.toolCallId).toBe('mock_call_1_1')
    expect(hooks).toEqual(['tool.before', 'tool.after'])
  })

  it('hands the call signal to the runner: a stopped run reaches the child', async () => {
    const run = new AbortController()
    let seen: AbortSignal | undefined
    const agent = scope(async function* (_input, runOptions) {
      seen = runOptions.signal
      yield snapshot()
      await new Promise(resolve => runOptions.signal.addEventListener('abort', resolve, { once: true }))
      yield snapshot({ status: 'aborted', error: 'The sub-agent was stopped.', finishedAt: 2 })
    })
    const result = wrapToolExecute(registered, wrapContext(agent))(INPUT, { ...options, abortSignal: run.signal })
    const iterator = (result as AsyncGenerator<unknown>)[Symbol.asyncIterator]()
    expect(await iterator.next()).toMatchObject({ value: { status: 'running' } })
    run.abort(new DOMException('stopped', 'AbortError'))
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' })
    expect(seen?.aborted).toBe(true)
  })

  it('the model reads only the report (or the failure with the partial report)', async () => {
    const convert = wrapToModelOutput(registered, { guard })
    const completed = snapshot({ status: 'completed', report: 'Found 3 files.', steps: [{ toolCallId: 'c1', toolName: 'read_file', summary: 'secret.txt', state: 'done', resultPreview: 'preview' }], finishedAt: 2 })
    expect(await convert({ toolCallId: 'c', input: INPUT, output: completed })).toEqual({ type: 'text', value: 'Found 3 files.' })
    const failed = snapshot({ status: 'failed', report: 'Half.', error: 'Upstream: boom.', finishedAt: 2 })
    expect(await convert({ toolCallId: 'c', input: INPUT, output: failed })).toEqual({ type: 'text', value: 'Sub-agent failed: Upstream: boom; partial report: Half.' })
    const limit = snapshot({ status: 'limit', report: 'Partial findings.', error: 'The sub-agent reached its step limit (2 steps).', finishedAt: 2 })
    expect(await convert({ toolCallId: 'c', input: INPUT, output: limit })).toEqual({ type: 'text', value: 'Partial findings.' })
  })

  it('a background call (Phase 10) reaches the runner unchanged; its one output reads as the launch text', async () => {
    const inputs: TaskInput[] = []
    const launched = snapshot({ status: 'background', taskId: 'bgt_0123456789abcdef', finishedAt: 1 })
    const agent = scope(async function* (input) {
      inputs.push(input)
      yield launched
    })
    const background: TaskInput = { ...INPUT, type: 'reviewer', background: true }
    const values = await collect(wrapToolExecute(registered, wrapContext(agent))(background, options))
    expect(inputs).toEqual([background])
    expect(values.at(-1)).toEqual(launched)
    const convert = wrapToModelOutput(registered, { guard })
    expect(await convert({ toolCallId: 'c', input: background, output: launched })).toEqual({
      type: 'text',
      value: 'Started background agent bgt_0123456789abcdef. Its report will arrive as a message; keep working.',
    })
  })

  it('without an agent scope (a sub-agent calling task, depth 1) the call is one failed output', async () => {
    const values = await collect(wrapToolExecute(registered, wrapContext(null))(INPUT, options))
    expect(values.at(-1)).toMatchObject({ status: 'failed', error: TASK_UNAVAILABLE_ERROR, report: '' })
    expect(taskModelText(values.at(-1) as TaskOutput)).toMatch(/^Sub-agent failed: Sub-agents can only be started from a chat/)
    expect(TASK_TOOL_NAME).toBe('task')
  })

  it('the agent scope is bound only through the wrapper (a plain context has none)', () => {
    const c: ToolCallContext = { chatId: 'chat', modelRef: 'mock:subagent', toolCallId: 'x', messages: [], signal: new AbortController().signal }
    expect(agentScopeOf(c)).toBeNull()
  })
})
