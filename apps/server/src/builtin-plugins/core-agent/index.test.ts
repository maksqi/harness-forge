import type { PluginContext, ToolCallContext, ToolDefinition } from '@harness-forge/plugin-sdk'
import type { TaskInput, TaskOutput } from '@harness-forge/shared'
import type { AgentRunScope, RunSubagentOptions } from '../../chat/agent-scope.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import { PLUGIN_API_VERSION } from '@harness-forge/plugin-sdk'
import { AGENT_TOOL_NAMES, AGENT_TOOL_SCHEMAS, listResponseSchema, pluginManifestBaseSchema, taskOutputSchema, toolSummarySchema } from '@harness-forge/shared'
import semver from 'semver'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bindAgentScope } from '../../chat/agent-scope.ts'
import { validateToolDefinition } from '../../registry/validate.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import coreAgent, {
  CORE_AGENT_PLUGIN_ID,
  createAgentTools,
  createTaskTool,
  exitPlanModeModelText,
  manifest,
  TASK_UNAVAILABLE_ERROR,
  taskModelText,
  todoWriteModelText,
  TOOL_MODE_LABELS,
} from './index.ts'

const POLICIES: Record<string, string> = { todo_write: 'safe', exit_plan_mode: 'always', task: 'safe' }
const TIMEOUTS: Record<string, number> = { todo_write: 60_000, exit_plan_mode: 60_000, task: 600_000 }

const VALID_INPUTS: Record<string, unknown> = {
  todo_write: { todos: [{ id: '1', content: 'Read the code', status: 'in_progress', activeForm: 'Reading the code' }] },
  exit_plan_mode: { plan: '# Plan\n1. Do it.' },
  task: { description: 'List the files', prompt: 'List the project files.', type: 'explore' },
}

function context(signal = new AbortController().signal): ToolCallContext {
  return { chatId: '0199a8f0-0000-7000-8000-000000000001', modelRef: 'mock:subagent', toolCallId: 'mock_call_1_1', messages: [], signal }
}

function output(extra: Partial<TaskOutput> = {}): TaskOutput {
  return {
    status: 'completed',
    type: 'explore',
    description: 'List the files',
    modelRef: 'mock:subagent',
    steps: [],
    stepsOmitted: 0,
    report: 'Found 3 files.',
    startedAt: 1,
    finishedAt: 2,
    ...extra,
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of iterable)
    values.push(value)
  return values
}

async function modelText(tool: ToolDefinition, value: unknown): Promise<unknown> {
  const result = await tool.toModelOutput!(JSON.parse(JSON.stringify(value)), { toolCallId: 'call_1', input: {} })
  return result.type === 'text' ? result.value : result
}

describe('core-agent manifest', () => {
  it('is a valid builtin manifest: 1.0.0, engines ^1.3.0, no permissions, no settings', () => {
    const parsed = pluginManifestBaseSchema.parse(manifest)
    expect(parsed).toMatchObject({ id: 'core-agent', name: 'Agent tools', version: '1.0.0', engines: { harness: '^1.3.0' }, main: 'index.ts' })
    expect(parsed.permissions ?? []).toEqual([])
    expect(parsed.settings).toBeUndefined()
    expect(CORE_AGENT_PLUGIN_ID).toBe('core-agent')
    expect(semver.satisfies(PLUGIN_API_VERSION, manifest.engines.harness)).toBe(true)
    // A 1.2 host would treat the async-generator execute of `task` as a plain function: the range must exclude it.
    expect(semver.satisfies('1.2.0', manifest.engines.harness)).toBe(false)
  })
})

describe('the three agent tools', () => {
  const tools = createAgentTools()
  const byName = new Map(tools.map(tool => [tool.name, tool]))

  it('come in the shared registration order (AGENT_TOOL_NAMES)', () => {
    expect(tools.map(tool => tool.name)).toEqual([...AGENT_TOOL_NAMES])
  })

  it.each(AGENT_TOOL_NAMES.map(name => [name] as const))('%s: shared input schema, policy, timeout, no workspace access, a description', (name) => {
    const tool = byName.get(name)!
    expect(tool.inputSchema).toBe(AGENT_TOOL_SCHEMAS[name].input)
    expect(tool.policy).toBe(POLICIES[name])
    expect(tool.timeoutMs).toBe(TIMEOUTS[name])
    expect(tool.workspace).toBeUndefined()
    expect(tool.description.length).toBeGreaterThan(100)
    expect(tool.description.length).toBeLessThanOrEqual(1024)
    expect(typeof tool.toModelOutput).toBe('function')
    expect(() => validateToolDefinition(tool)).not.toThrow()
    expect(AGENT_TOOL_SCHEMAS[name].input.safeParse(VALID_INPUTS[name]).success).toBe(true)
  })

  it('task is an async generator; the other two are plain async functions', () => {
    expect(Object.prototype.toString.call(byName.get('task')!.execute)).toBe('[object AsyncGeneratorFunction]')
    expect(Object.prototype.toString.call(byName.get('todo_write')!.execute)).toBe('[object AsyncFunction]')
    expect(Object.prototype.toString.call(byName.get('exit_plan_mode')!.execute)).toBe('[object AsyncFunction]')
  })

  it('todo_write refuses duplicate ids and more than 50 items in its input schema', () => {
    const schema = AGENT_TOOL_SCHEMAS.todo_write.input
    expect(schema.safeParse({ todos: [{ id: '1', content: 'a', status: 'pending' }, { id: '1', content: 'b', status: 'pending' }] }).success).toBe(false)
    expect(schema.safeParse({ todos: Array.from({ length: 51 }, (_, index) => ({ id: `${index}`, content: 'x', status: 'pending' })) }).success).toBe(false)
  })

  it('setup registers every tool through ctx.tools.register', async () => {
    const registered: ToolDefinition[] = []
    const ctx = {
      tools: {
        register: (definition: ToolDefinition) => {
          registered.push(definition)
          return { dispose() {} }
        },
      },
    } as unknown as PluginContext
    await coreAgent.setup(ctx)
    expect(registered.map(tool => tool.name)).toEqual([...AGENT_TOOL_NAMES])
  })
})

describe('model texts', () => {
  const tools = new Map(createAgentTools().map(tool => [tool.name, tool]))

  it('todo_write: one line with the counts ("Todo list cleared." for an empty list)', async () => {
    const counts = { pending: 2, inProgress: 1, completed: 0, total: 3 }
    expect(todoWriteModelText({ todos: [], counts })).toBe('Todo list updated: 1 in progress, 2 pending, 0 completed.')
    expect(todoWriteModelText({ todos: [], counts: { pending: 0, inProgress: 0, completed: 0, total: 0 } })).toBe('Todo list cleared.')
    const todos = [{ id: '1', content: 'Read the code', status: 'completed' as const }]
    expect(await modelText(tools.get('todo_write')!, { todos, counts: { pending: 0, inProgress: 0, completed: 1, total: 1 } })).toBe('Todo list updated: 0 in progress, 0 pending, 1 completed.')
    // An output of another shape reaches the model as JSON.
    expect(await modelText(tools.get('todo_write')!, { other: true })).toEqual({ type: 'json', value: { other: true } })
  })

  it('exit_plan_mode: names the mode the user chose by its label', async () => {
    expect(exitPlanModeModelText({ approved: true, mode: 'edits' })).toBe('The user approved the plan. Mode is now Accept edits. Implement it now; track progress with todo_write.')
    expect(await modelText(tools.get('exit_plan_mode')!, { approved: true, mode: 'ask' })).toBe('The user approved the plan. Mode is now Ask. Implement it now; track progress with todo_write.')
    expect(TOOL_MODE_LABELS).toEqual({ off: 'Off', ask: 'Ask', edits: 'Accept edits', plan: 'Plan', auto: 'Auto' })
  })

  it('task: the report only, or "Sub-agent failed: <error>; partial report: <report>"', async () => {
    expect(taskModelText(output())).toBe('Found 3 files.')
    expect(taskModelText(output({ report: '  ' }))).toBe('The sub-agent finished without a report.')
    expect(taskModelText(output({ status: 'limit', report: 'Partial findings.' }))).toBe('Partial findings.')
    expect(taskModelText(output({ status: 'limit', report: '', error: 'The step limit was reached.' }))).toBe('Sub-agent failed: The step limit was reached; partial report: (none)')
    expect(taskModelText(output({ status: 'failed', report: 'Half done.', error: 'Provider error.' }))).toBe('Sub-agent failed: Provider error; partial report: Half done.')
    expect(taskModelText(output({ status: 'aborted', report: '' }))).toBe('Sub-agent failed: it was stopped; partial report: (none)')
    expect(taskModelText(output({ status: 'running', report: 'x' }))).toBe('Sub-agent failed: it did not finish; partial report: x')
    const task = tools.get('task')!
    expect(await modelText(task, output({ report: 'All good.' }))).toBe('All good.')
    // A stored output that later runs reduce to { status, report } still reads as text.
    expect(await modelText(task, { status: 'completed', report: 'Reduced report.' })).toBe('Reduced report.')
    expect(await modelText(task, { status: 'failed', report: '', error: 'Boom.' })).toBe('Sub-agent failed: Boom; partial report: (none)')
  })
})

describe('task execute', () => {
  const input: TaskInput = { description: 'List the files', prompt: 'List the project files.', type: 'explore' }

  it('without an agent scope (inside a sub-agent, outside a run) yields one failed output', async () => {
    const values = await collect(createTaskTool().execute(input, context()) as AsyncIterable<TaskOutput>)
    expect(values).toHaveLength(1)
    const [value] = values
    expect(taskOutputSchema.parse(value)).toMatchObject({ status: 'failed', type: 'explore', description: 'List the files', modelRef: 'mock:subagent', steps: [], stepsOmitted: 0, report: '', error: TASK_UNAVAILABLE_ERROR })
    expect(taskModelText(value!)).toMatch(/^Sub-agent failed: Sub-agents can only be started from a chat/)
  })

  it('delegates to the bound scope: yields every snapshot of runSubagent with the call id and signal', async () => {
    const calls: Array<{ input: TaskInput, options: RunSubagentOptions }> = []
    const scope: AgentRunScope = {
      chatId: '0199a8f0-0000-7000-8000-000000000001',
      messageId: 'msg_AAAAAAAAAAAAAAAA',
      toolMode: 'ask',
      async* runSubagent(taskInput, options) {
        calls.push({ input: taskInput, options })
        yield output({ status: 'queued', report: '', finishedAt: undefined })
        yield output({ status: 'running', report: '', finishedAt: undefined })
        yield output()
      },
      todos: () => null,
    }
    const controller = new AbortController()
    const c = context(controller.signal)
    bindAgentScope(c, scope)
    const values = await collect(createTaskTool().execute(input, c) as AsyncIterable<TaskOutput>)
    expect(values.map(value => value.status)).toEqual(['queued', 'running', 'completed'])
    expect(calls).toEqual([{ input, options: { toolCallId: 'mock_call_1_1', signal: controller.signal } }])
  })
})

describe('core-agent in the plugin host', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp({ builtins: [{ id: 'core-agent', manifest, module: coreAgent }], start: false })
    await t.deps.plugins.start()
  })

  afterAll(async () => {
    await t.close()
  })

  it('loads active and contributes the three tools without workspace access', () => {
    expect(t.deps.plugins.state('core-agent')).toBe('active')
    expect([...t.deps.registry.contributions('core-agent').tools].sort()).toEqual([...AGENT_TOOL_NAMES].sort())
    for (const name of AGENT_TOOL_NAMES)
      expect(t.deps.registry.tools.get(name), name).toMatchObject({ pluginId: 'core-agent', mcpServerId: null, definition: { timeoutMs: TIMEOUTS[name] } })
  })

  it('gET /api/tools lists them under core-agent', async () => {
    const response = await t.request('/api/tools')
    expect(response.status).toBe(200)
    const items = listResponseSchema(toolSummarySchema).parse(await response.json()).items.filter(item => item.pluginId === 'core-agent')
    expect(items.map(item => item.name).sort()).toEqual([...AGENT_TOOL_NAMES].sort())
    for (const item of items)
      expect(item.workspace ?? null).toBeNull()
  })
})
