import type { PluginContext, ToolCallContext, ToolDefinition } from '@harness-forge/plugin-sdk'
import type { SkillOutput, TaskInput, TaskOutput } from '@harness-forge/shared'
import type { AgentRunScope, RunSubagentOptions } from '../../chat/agent-scope.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import { PLUGIN_API_VERSION } from '@harness-forge/plugin-sdk'
import { AGENT_TOOL_NAMES, AGENT_TOOL_SCHEMAS, BUILTIN_AGENT_TYPES, BUILTIN_OUTPUT_STYLE_NAMES, BUILTIN_OUTPUT_STYLES, declarativeOutputStyleSchema, isReservedAgentName, LIMITS, listResponseSchema, outputStyleBlock, parseDefinition, pluginManifestBaseSchema, taskOutputSchema, toolSummarySchema } from '@harness-forge/shared'
import semver from 'semver'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bindAgentScope } from '../../chat/agent-scope.ts'
import { validateToolDefinition } from '../../registry/validate.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import coreAgent, {
  BUILTIN_AGENT_DEFINITIONS,
  BUILTIN_STYLE_DEFINITIONS,
  builtinAgentDefinition,
  builtinStyleDefinition,
  CORE_AGENT_PLUGIN_ID,
  createAgentTools,
  createSkillTool,
  createTaskTool,
  exitPlanModeModelText,
  manifest,
  SKILL_DESCRIPTION,
  skillModelText,
  SKILLS_NOT_AVAILABLE_ERROR,
  TASK_DESCRIPTION,
  TASK_UNAVAILABLE_ERROR,
  taskBackgroundModelText,
  taskModelText,
  todoWriteModelText,
  TOOL_MODE_LABELS,
} from './index.ts'

const POLICIES: Record<string, string> = { todo_write: 'safe', exit_plan_mode: 'always', task: 'safe', skill: 'safe' }
const TIMEOUTS: Record<string, number> = { todo_write: 60_000, exit_plan_mode: 60_000, task: 600_000, skill: 60_000 }

const VALID_INPUTS: Record<string, unknown> = {
  todo_write: { todos: [{ id: '1', content: 'Read the code', status: 'in_progress', activeForm: 'Reading the code' }] },
  exit_plan_mode: { plan: '# Plan\n1. Do it.' },
  task: { description: 'List the files', prompt: 'List the project files.', type: 'explore' },
  skill: { name: 'pdf' },
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
  it('is a valid builtin manifest: 1.0.0, engines ^1.4.0, no permissions, no settings', () => {
    const parsed = pluginManifestBaseSchema.parse(manifest)
    expect(parsed).toMatchObject({ id: 'core-agent', name: 'Agent tools', version: '1.0.0', engines: { harness: '^1.4.0' }, main: 'index.ts' })
    expect(parsed.permissions ?? []).toEqual([])
    expect(parsed.settings).toBeUndefined()
    expect(CORE_AGENT_PLUGIN_ID).toBe('core-agent')
    expect(semver.satisfies(PLUGIN_API_VERSION, manifest.engines.harness)).toBe(true)
    // A 1.3 host knows neither `skill` nor `task.background` and custom agent types: the range must exclude it (and 1.2,
    // which would treat the async-generator execute of `task` as a plain function).
    expect(semver.satisfies('1.3.0', manifest.engines.harness)).toBe(false)
    expect(semver.satisfies('1.2.0', manifest.engines.harness)).toBe(false)
  })

  it('phase 11 / 12: keeps ^1.4.0 under plugin API 1.6.0 (it uses no 1.5.0 or 1.6.0 member; the builtin styles are server-read)', () => {
    expect(PLUGIN_API_VERSION).toBe('1.6.0')
    expect(manifest.engines.harness).toBe('^1.4.0')
    expect(semver.satisfies('1.4.0', manifest.engines.harness)).toBe(true)
    expect(semver.satisfies('1.5.0', manifest.engines.harness)).toBe(true)
    expect(semver.satisfies('1.6.0', manifest.engines.harness)).toBe(true)
  })
})

describe('the four agent tools', () => {
  const tools = createAgentTools()
  const byName = new Map(tools.map(tool => [tool.name, tool]))

  it('come in the shared registration order (AGENT_TOOL_NAMES)', () => {
    expect(tools.map(tool => tool.name)).toEqual([...AGENT_TOOL_NAMES])
    expect(AGENT_TOOL_NAMES).toEqual(['todo_write', 'exit_plan_mode', 'task', 'skill'])
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

  it('task is an async generator; the other three are plain async functions', () => {
    expect(Object.prototype.toString.call(byName.get('task')!.execute)).toBe('[object AsyncGeneratorFunction]')
    for (const name of ['todo_write', 'exit_plan_mode', 'skill'])
      expect(Object.prototype.toString.call(byName.get(name)!.execute), name).toBe('[object AsyncFunction]')
  })

  it('task: type is a catalog name (trimmed, lowercased; general-purpose stays for the runner), background is optional', () => {
    const schema = AGENT_TOOL_SCHEMAS.task.input
    const base = { description: 'Review it', prompt: 'Review the diff.' }
    expect(schema.parse({ ...base, type: '  General-Purpose ' }).type).toBe('general-purpose')
    expect(schema.parse({ ...base, type: 'reviewer', background: true })).toEqual({ ...base, type: 'reviewer', background: true })
    expect(schema.parse({ ...base, type: 'explore' }).background).toBeUndefined()
    for (const type of ['', '1st', 'has space', 'x'.repeat(65), 'under_score'])
      expect(schema.safeParse({ ...base, type }).success, type).toBe(false)
    expect(schema.safeParse({ ...base, type: 'explore', background: 'yes' }).success).toBe(false)
  })

  it('skill: the input is one catalog name (trimmed, lowercased)', () => {
    const schema = AGENT_TOOL_SCHEMAS.skill.input
    expect(schema.parse({ name: ' PDF ' })).toEqual({ name: 'pdf' })
    for (const name of ['', '-pdf', 'pdf files', 'p'.repeat(65)])
      expect(schema.safeParse({ name }).success, name).toBe(false)
    expect(schema.safeParse({}).success).toBe(false)
  })

  it('the descriptions point at the instruction blocks: "Agent types" and background for task, "Skills" for skill', () => {
    expect(TASK_DESCRIPTION).toContain('"Agent types"')
    expect(TASK_DESCRIPTION).toContain('background: true')
    expect(TASK_DESCRIPTION).toContain('arrives later as a message')
    expect(SKILL_DESCRIPTION).toContain('"Skills" block')
    expect(SKILL_DESCRIPTION).toContain('read_file')
  })

  it('skill (Phase 11): the description says only the listed (model-invocable) skills can be loaded', () => {
    expect(SKILL_DESCRIPTION).toContain('Only the listed skills can be loaded')
    expect(SKILL_DESCRIPTION).toContain('slash commands are not listed')
    expect(SKILL_DESCRIPTION).toContain('never guess names that are not listed')
    expect(SKILL_DESCRIPTION.length).toBeLessThanOrEqual(1024)
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

  it('exit_plan_mode (Phase 10): a second line with the saved plan file, or one naming the failed write', async () => {
    const approved = 'The user approved the plan. Mode is now Accept edits. Implement it now; track progress with todo_write.'
    const planPath = '.harness/plans/2026-10-04-add-notes.md'
    expect(exitPlanModeModelText({ approved: true, mode: 'edits', planPath })).toBe(`${approved}\nThe plan was saved to ${planPath}.`)
    expect(await modelText(tools.get('exit_plan_mode')!, { approved: true, mode: 'edits', planPath })).toBe(`${approved}\nThe plan was saved to ${planPath}.`)
    expect(exitPlanModeModelText({ approved: true, mode: 'edits', planError: 'The plan folder is a link.' })).toBe(`${approved}\nThe plan file could not be saved: The plan folder is a link.`)
    expect(exitPlanModeModelText({ approved: true, mode: 'edits', planError: '  ' })).toBe(approved)
    // A v1.5 output (no plan file keys) reads as before.
    expect(await modelText(tools.get('exit_plan_mode')!, { approved: true, mode: 'edits' })).toBe(approved)
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

  it('task (Phase 10): a background launch names its task id; a failed launch reads like any failure', async () => {
    const started = 'Started background agent bgt_AAAAAAAAAAAAAAAA. Its report will arrive as a message; keep working.'
    expect(taskModelText(output({ status: 'background', report: '', taskId: 'bgt_AAAAAAAAAAAAAAAA' }))).toBe(started)
    expect(taskBackgroundModelText('bgt_AAAAAAAAAAAAAAAA')).toBe(started)
    expect(taskBackgroundModelText(undefined)).toBe('Started background agent (unknown id). Its report will arrive as a message; keep working.')
    const task = tools.get('task')!
    expect(await modelText(task, output({ status: 'background', report: '', steps: [], taskId: 'bgt_AAAAAAAAAAAAAAAA' }))).toBe(started)
    // A reduced background output keeps `taskId` (`reduceAgentOutputs`).
    expect(await modelText(task, { status: 'background', report: '', taskId: 'bgt_AAAAAAAAAAAAAAAA' })).toBe(started)
    expect(await modelText(task, output({ status: 'failed', report: '', error: 'Background agents are not available yet.' }))).toBe('Sub-agent failed: Background agents are not available yet; partial report: (none)')
  })

  it('skill: the content, then the base folder line and the supporting files of a project skill', async () => {
    const skill = tools.get('skill')!
    const plain: SkillOutput = { name: 'notes', description: 'Notes.', source: 'user', content: '# Notes\nWrite short notes.\n', truncated: false }
    expect(skillModelText(plain)).toBe('# Notes\nWrite short notes.')
    expect(await modelText(skill, plain)).toBe('# Notes\nWrite short notes.')
    const project: SkillOutput = {
      name: 'pdf',
      description: 'Work with PDF files.',
      source: 'project',
      content: '# PDF\nUse ref.md.',
      truncated: false,
      baseDir: '.harness/skills/pdf',
      files: ['ref.md', 'scripts/extract.py'],
    }
    expect(await modelText(skill, project)).toBe([
      '# PDF\nUse ref.md.',
      '',
      'Base folder: .harness/skills/pdf — read supporting files with read_file',
      'Supporting files: .harness/skills/pdf/ref.md, .harness/skills/pdf/scripts/extract.py',
    ].join('\n'))
    expect(skillModelText({ ...project, files: [] })).toBe('# PDF\nUse ref.md.\n\nBase folder: .harness/skills/pdf — read supporting files with read_file')
    expect(skillModelText({ ...plain, truncated: true })).toBe('# Notes\nWrite short notes.\n\n(The skill was cut here: it is longer than 64 KB.)')
    // The model text starts with the content (`mock:agents` reads "Skill loaded: <first 80 characters>" from it).
    expect(skillModelText(project).startsWith(project.content)).toBe(true)
    expect(await modelText(skill, { other: true })).toEqual({ type: 'json', value: { other: true } })
  })
})

describe('skill execute (P10-0b stub)', () => {
  it('fails with a tool error until skills are loaded through the agent scope (W10.5)', async () => {
    await expect(Promise.resolve(createSkillTool().execute({ name: 'pdf' }, context()))).rejects.toThrow(SKILLS_NOT_AVAILABLE_ERROR)
    expect(SKILLS_NOT_AVAILABLE_ERROR).toBe('Skills are not available yet.')
  })
})

describe('builtin agent definitions', () => {
  it('are explore (read-only) and general, in BUILTIN_AGENT_TYPES order, with reserved names', () => {
    expect(BUILTIN_AGENT_DEFINITIONS.map(agent => agent.name)).toEqual([...BUILTIN_AGENT_TYPES])
    expect(BUILTIN_AGENT_DEFINITIONS.map(agent => [agent.name, agent.readOnly])).toEqual([['explore', true], ['general', false]])
    for (const agent of BUILTIN_AGENT_DEFINITIONS) {
      expect(isReservedAgentName(agent.name)).toBe(true)
      expect(agent.description.length, agent.name).toBeGreaterThan(40)
      // The "Agent types" block cuts descriptions at this length: the builtins are never cut.
      expect(agent.description.length, agent.name).toBeLessThanOrEqual(LIMITS.listedDescriptionMaxChars)
      expect(Object.isFrozen(agent)).toBe(true)
    }
    expect(Object.isFrozen(BUILTIN_AGENT_DEFINITIONS)).toBe(true)
  })

  it('builtinAgentDefinition resolves a name or the general-purpose alias, else null', () => {
    expect(builtinAgentDefinition('explore')?.readOnly).toBe(true)
    expect(builtinAgentDefinition('general')?.name).toBe('general')
    expect(builtinAgentDefinition('general-purpose')?.name).toBe('general')
    for (const name of ['reviewer', 'Explore', '', 'constructor', '__proto__'])
      expect(builtinAgentDefinition(name), name).toBeNull()
  })
})

describe('builtin output styles (Phase 11, ADR-051, C38-T4)', () => {
  it('are default, explanatory and learning in menu order, adapted from the shared texts and frozen', () => {
    expect(BUILTIN_STYLE_DEFINITIONS.map(style => style.name)).toEqual([...BUILTIN_OUTPUT_STYLE_NAMES])
    expect(BUILTIN_STYLE_DEFINITIONS.map(style => style.name)).toEqual(['default', 'explanatory', 'learning'])
    BUILTIN_OUTPUT_STYLES.forEach((shared, index) => {
      const style = BUILTIN_STYLE_DEFINITIONS[index]!
      expect(style).toEqual({ name: shared.name, label: shared.label, description: shared.description, keepCodingInstructions: shared.keepCodingInstructions, content: shared.content })
      expect(Object.isFrozen(style)).toBe(true)
    })
    expect(Object.isFrozen(BUILTIN_STYLE_DEFINITIONS)).toBe(true)
    expect(BUILTIN_STYLE_DEFINITIONS.map(style => [style.name, style.label])).toEqual([['default', 'Default'], ['explanatory', 'Explanatory'], ['learning', 'Learning']])
  })

  it('default adds no instruction block; the other two start with "Output style: <label>"', () => {
    expect(builtinStyleDefinition('default')!.content).toBe('')
    expect(outputStyleBlock(builtinStyleDefinition('default')!)).toBeNull()
    for (const name of ['explanatory', 'learning']) {
      const style = builtinStyleDefinition(name)!
      expect(style.content.length, name).toBeGreaterThan(200)
      expect(style.keepCodingInstructions, name).toBe(true)
      expect(outputStyleBlock(style)!.split('\n')[0]).toBe(`Output style: ${style.label}`)
      expect(style.description.length, name).toBeLessThanOrEqual(LIMITS.listedDescriptionMaxChars)
    }
  })

  it('builtinStyleDefinition is exact (case-sensitive, no prototype keys), else null', () => {
    expect(builtinStyleDefinition('learning')?.label).toBe('Learning')
    for (const name of ['Learning', 'terse', '', 'constructor', '__proto__'])
      expect(builtinStyleDefinition(name), name).toBeNull()
  })

  it('the builtin names are reserved: a plugin style or a style file with one is refused', () => {
    for (const style of BUILTIN_STYLE_DEFINITIONS) {
      expect(declarativeOutputStyleSchema.safeParse({ name: style.name, description: 'Mine.', content: 'Be brief.' }).success, style.name).toBe(false)
      const parsed = parseDefinition('style', `---\nname: ${style.name}\ndescription: Mine.\n---\nBe brief.\n`, { fileName: `${style.name}.md` })
      expect(parsed.diagnostics.map(diagnostic => diagnostic.code), style.name).toContain('reserved-name')
    }
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
      loadSkill: async () => {
        throw new Error('not used')
      },
      savePlan: async () => ({}),
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

  it('loads active and contributes the four tools without workspace access', () => {
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
