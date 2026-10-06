import type { HookMap, HookName, ProviderOptions, ReasoningParams } from '@harness-forge/plugin-sdk'
import type { ReasoningEffort, ToolMode } from '@harness-forge/shared'
import type { ResolvedModel } from '../providers/types.ts'
import type { OfferedTool, RunParamsInput } from './params.ts'
import type { AssembledTools } from './tools.ts'
import { AGENT_TOOL_NAMES, LIMITS, toolModeSchema } from '@harness-forge/shared'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { mockAgentTypeNames, mockSkillNames } from '../builtin-plugins/mock/agents.ts'
import { mockHooksStyleText } from '../builtin-plugins/mock/hooks.ts'
import { createSilentLogger } from '../logger.ts'
import { builtinRunOutputStyle, DEFAULT_RUN_OUTPUT_STYLE } from './output-style.ts'
import {
  AGENT_TYPES_HEADER,
  agentBlocks,
  agentTypesBlock,
  buildRunParams,
  joinInstructions,
  listedDescription,
  mergeProviderOptions,
  offeredAgentTools,
  orderAgentTypes,
  osName,
  planModeBlock,
  projectFileInstructions,
  providerImageOptions,
  providerReasoning,
  runInstructions,
  runMaxSteps,
  SKILLS_HEADER,
  skillsBlock,
  styleBlock,
  TASK_HINT,
  TODO_HINT,
  workspaceBlock,
} from './params.ts'

function resolved(options: { reasoning?: boolean, efforts?: ReasoningEffort[], fn?: (effort: ReasoningEffort) => ReasoningParams | undefined } = {}): ResolvedModel {
  return {
    modelRef: 'prov:model',
    providerId: 'prov',
    modelId: 'model',
    info: { id: 'model' },
    entry: { capabilities: { reasoning: options.reasoning ?? true }, reasoningEfforts: options.efforts ?? ['auto', 'off', 'low', 'high'] },
    provider: { pluginId: 'demo', definition: { id: 'prov', name: 'Prov', credentials: [], createLanguageModel: () => null as never, ...(options.fn === undefined ? {} : { reasoning: options.fn }) } },
  } as unknown as ResolvedModel
}

type HookRun = <K extends HookName>(name: K, ...args: HookMap[K]) => Promise<void>

function input(overrides: Partial<RunParamsInput> & { run?: HookRun } = {}): RunParamsInput {
  const run: HookRun = overrides.run ?? (async () => {})
  return {
    chatId: 'chat',
    modelRef: 'prov:model',
    resolved: resolved({ fn: effort => ({ reasoning: effort === 'off' ? 'none' : 'high', providerOptions: { prov: { budget: 1024 } } }) }),
    reasoningEffort: 'high',
    toolMode: 'ask',
    globalInstructions: ' Global. ',
    chatInstructions: 'Chat.',
    maxSteps: 20,
    registry: { hooks: { run, on: () => ({ dispose() {} }), list: () => [] } },
    logger: createSilentLogger(),
    ...overrides,
  }
}

describe('instructions', () => {
  it('joins global and chat instructions with a blank line, skipping empty ones', () => {
    expect(joinInstructions(' Global. ', 'Chat.')).toBe('Global.\n\nChat.')
    expect(joinInstructions('', undefined)).toBe('')
    expect(joinInstructions(undefined, 'Only chat')).toBe('Only chat')
  })
})

describe('providerReasoning', () => {
  it('calls provider.reasoning only for an offered effort of a reasoning model', () => {
    const fn = (effort: ReasoningEffort): ReasoningParams => ({ reasoning: effort === 'off' ? 'none' : 'high' })
    const logger = createSilentLogger()
    expect(providerReasoning(resolved({ fn }), 'high', logger)).toEqual({ reasoning: 'high' })
    expect(providerReasoning(resolved({ fn }), 'off', logger)).toEqual({ reasoning: 'none' })
    expect(providerReasoning(resolved({ fn }), 'auto', logger)).toBeUndefined()
    expect(providerReasoning(resolved({ fn }), 'medium', logger)).toBeUndefined()
    expect(providerReasoning(resolved({ fn, reasoning: false }), 'high', logger)).toBeUndefined()
    expect(providerReasoning(resolved(), 'high', logger)).toBeUndefined()
  })

  it('ignores a throwing provider and invalid values', () => {
    const logger = createSilentLogger()
    expect(providerReasoning(resolved({ fn: () => {
      throw new Error('bad')
    } }), 'high', logger)).toBeUndefined()
    expect(providerReasoning(resolved({ fn: () => ({ reasoning: 'extreme', providerOptions: { prov: 'x' }, maxOutputTokens: -1 }) as never }), 'high', logger)).toEqual({})
    expect(providerReasoning(resolved({ fn: () => ({ maxOutputTokens: 8000, providerOptions: { prov: { a: 1 } } }) }), 'high', logger)).toEqual({ maxOutputTokens: 8000, providerOptions: { prov: { a: 1 } } })
  })
})

describe('buildRunParams', () => {
  it('builds instructions, reasoning and provider options without hooks', async () => {
    expect(await buildRunParams(input())).toEqual({
      instructions: 'Global.\n\nChat.',
      maxSteps: 20,
      providerOptions: { prov: { budget: 1024 } },
      reasoning: 'high',
      headers: {},
    })
    expect((await buildRunParams(input({ globalInstructions: '', chatInstructions: undefined, reasoningEffort: 'auto' })))).toEqual({ instructions: undefined, maxSteps: 20, providerOptions: {}, headers: {} })
  })

  it('applies chat.params and chat.headers hooks and checks their values', async () => {
    const run: HookRun = async (name, ...args) => {
      const [hookInput, output] = args as unknown as [Record<string, unknown>, Record<string, unknown>]
      if (name === 'chat.params') {
        expect(hookInput).toMatchObject({ chatId: 'chat', modelRef: 'prov:model', reasoningEffort: 'high', toolMode: 'ask', model: { id: 'model' } })
        output.instructions = `${String(output.instructions)} Hooked.`
        output.temperature = 0.2
        output.maxOutputTokens = 512
        output.maxSteps = 500
        output.reasoning = 'low';
        (output.providerOptions as Record<string, unknown>).extra = { on: true }
      }
      if (name === 'chat.headers') {
        output.headers = { 'x-ok': 'yes', 'bad name': 'no', 'x-newline': 'a\nb', 'x-number': 5 }
      }
    }
    expect(await buildRunParams(input({ run }))).toEqual({
      instructions: 'Global.\n\nChat. Hooked.',
      temperature: 0.2,
      maxOutputTokens: 512,
      maxSteps: 200,
      reasoning: 'low',
      providerOptions: { prov: { budget: 1024 }, extra: { on: true } },
      headers: { 'x-ok': 'yes' },
    })
  })

  it('falls back to the pre-hook values for invalid hook output', async () => {
    const run: HookRun = async (name, ...args) => {
      const output = args[1] as unknown as Record<string, unknown>
      if (name === 'chat.params') {
        output.instructions = 42
        output.maxSteps = 'many'
        output.reasoning = 'extreme'
        output.providerOptions = 'nope'
        output.temperature = Number.NaN
      }
    }
    expect(await buildRunParams(input({ run }))).toEqual({
      instructions: 'Global.\n\nChat.',
      maxSteps: 20,
      reasoning: 'high',
      providerOptions: { prov: { budget: 1024 } },
      headers: {},
    })
  })
})

describe('steps (Phase 7)', () => {
  it('uses projectMaxSteps in a chat with a project, maxSteps otherwise', () => {
    expect(runMaxSteps({ maxSteps: 20, projectMaxSteps: 100 }, null)).toBe(20)
    expect(runMaxSteps({ maxSteps: 20, projectMaxSteps: 100 }, 'prj_0123456789abcdef')).toBe(100)
  })

  it('clamps the chat.params maxSteps to 1..200', async () => {
    const withHook = (value: number) => input({
      maxSteps: 100,
      run: async (name, ...args) => {
        if (name === 'chat.params')
          (args[1] as { maxSteps: number }).maxSteps = value
      },
    })
    expect((await buildRunParams(withHook(1000))).maxSteps).toBe(200)
    expect((await buildRunParams(withHook(200))).maxSteps).toBe(200)
    expect((await buildRunParams(withHook(150))).maxSteps).toBe(150)
    expect((await buildRunParams(withHook(0))).maxSteps).toBe(1)
    expect((await buildRunParams(withHook(-4))).maxSteps).toBe(1)
    expect((await buildRunParams(input({ maxSteps: 100 }))).maxSteps).toBe(100)
  })
})

describe('workspace instructions (Phase 7)', () => {
  const ALL_TOOLS = ['read_file', 'list_directory', 'find_files', 'search_files', 'write_file', 'edit_file', 'shell']
  const workspace = {
    name: 'Demo app',
    root: '/srv/projects/demo',
    instructions: ' Project rules. ',
    projectFile: { name: 'AGENTS.md' as const, content: 'Run the tests.\n', truncated: false },
  }

  it('names the OS of the server host', () => {
    expect(osName('darwin')).toBe('macOS')
    expect(osName('linux')).toBe('Linux')
    expect(osName('win32')).toBe('Windows')
    expect(osName('haiku' as NodeJS.Platform)).toBe('haiku')
    expect(osName()).toBeTypeOf('string')
  })

  it('without workspace tools has only the project name, folder and OS', () => {
    expect(workspaceBlock(workspace, [], 'linux')).toBe('Project "Demo app", folder /srv/projects/demo (Linux).')
    // The name is quoted as JSON: a quote or a line break cannot end the line.
    expect(workspaceBlock({ name: 'My "x"\napp', root: '/r' }, [], 'darwin')).toBe('Project "My \\"x\\"\\napp", folder /r (macOS).')
  })

  it('builds the rules only from the offered tools', () => {
    expect(workspaceBlock(workspace, ALL_TOOLS, 'linux')).toBe([
      'Project "Demo app", folder /srv/projects/demo (Linux).',
      '- Use paths relative to the project folder.',
      '- Read a file with read_file before you change it.',
      '- edit_file: old_string must match the file exactly, including whitespace and indentation, and must be unique in it; add surrounding lines to make it unique, or set replace_all.',
      '- Prefer edit_file for changes to an existing file; use write_file to create a file or to replace all of its content.',
      '- Each shell call runs in a new process: the working folder carries over (cd persists inside the project folder), environment variables do not; there is no stdin (interactive commands cannot work), and background processes are stopped when the command ends.',
    ].join('\n'))
    const readOnly = workspaceBlock(workspace, ['read_file', 'list_directory'], 'linux')
    expect(readOnly.split('\n')).toEqual(['Project "Demo app", folder /srv/projects/demo (Linux).', '- Use paths relative to the project folder.'])
    const noShell = workspaceBlock(workspace, ALL_TOOLS.filter(name => name !== 'shell'), 'linux')
    expect(noShell).not.toContain('shell')
    expect(noShell).toContain('Prefer edit_file')
    const editOnly = workspaceBlock(workspace, ['edit_file'], 'linux')
    expect(editOnly).toContain('old_string must match')
    expect(editOnly).not.toContain('read_file')
    expect(editOnly).not.toContain('Prefer edit_file')
    expect(workspaceBlock(workspace, ['shell'], 'linux').split('\n')).toHaveLength(3)
    // A tool of another plugin with workspace access gets the generic rule only.
    expect(workspaceBlock(workspace, ['lint_project'], 'linux').split('\n')).toEqual(['Project "Demo app", folder /srv/projects/demo (Linux).', '- Use paths relative to the project folder.'])
  })

  it('introduces the project file and skips an empty one', () => {
    expect(projectFileInstructions(workspace.projectFile)).toBe('Instructions from AGENTS.md in the project folder:\n\nRun the tests.')
    expect(projectFileInstructions({ name: 'CLAUDE.md', content: ' \n ', truncated: false })).toBe('')
    expect(projectFileInstructions(null)).toBe('')
  })

  it('orders global, workspace block, project file, project instructions, chat instructions', () => {
    const text = runInstructions({ globalInstructions: 'Global.', chatInstructions: 'Chat.', workspace, workspaceTools: ['read_file'], platform: 'linux' })
    expect(text).toBe([
      'Global.',
      'Project "Demo app", folder /srv/projects/demo (Linux).\n- Use paths relative to the project folder.',
      'Instructions from AGENTS.md in the project folder:\n\nRun the tests.',
      'Project rules.',
      'Chat.',
    ].join('\n\n'))
    // Without a workspace: global and chat instructions only.
    expect(runInstructions({ globalInstructions: 'Global.', chatInstructions: 'Chat.', workspace: null })).toBe('Global.\n\nChat.')
    // The block is there without tools, empty parts are skipped.
    expect(runInstructions({ globalInstructions: '', chatInstructions: undefined, workspace: { ...workspace, instructions: null, projectFile: null }, platform: 'darwin' }))
      .toBe('Project "Demo app", folder /srv/projects/demo (macOS).')
  })

  it('gives chat.params hooks the full instructions', async () => {
    const seen: unknown[] = []
    const params = await buildRunParams(input({
      workspace,
      workspaceTools: ['read_file'],
      platform: 'linux',
      run: async (name, ...args) => {
        if (name === 'chat.params')
          seen.push((args[1] as { instructions: string }).instructions)
      },
    }))
    expect(params.instructions).toBe(seen[0])
    expect(params.instructions).toBe('Global.\n\nProject "Demo app", folder /srv/projects/demo (Linux).\n- Use paths relative to the project folder.\n\nInstructions from AGENTS.md in the project folder:\n\nRun the tests.\n\nProject rules.\n\nChat.')
  })
})

describe('image output provider options (ADR-028)', () => {
  function imageModel(imageParams?: (request: unknown) => unknown): ResolvedModel {
    const base = resolved()
    return { ...base, provider: { ...base.provider, definition: { ...base.provider.definition, ...(imageParams === undefined ? {} : { imageParams }) } } } as unknown as ResolvedModel
  }

  it('asks imageParams for one image with the aspect ratio and keeps only valid provider options', () => {
    const requests: unknown[] = []
    const model = imageModel((request) => {
      requests.push(request)
      return { providerOptions: { google: { responseModalities: ['TEXT', 'IMAGE'] } }, size: '1024x1024' }
    })
    expect(providerImageOptions(model, '16:9', createSilentLogger())).toEqual({ google: { responseModalities: ['TEXT', 'IMAGE'] } })
    expect(providerImageOptions(model, undefined, createSilentLogger())).toEqual({ google: { responseModalities: ['TEXT', 'IMAGE'] } })
    expect(requests).toEqual([{ n: 1, inputs: 0, aspectRatio: '16:9' }, { n: 1, inputs: 0 }])
    expect(providerImageOptions(imageModel(), '1:1', createSilentLogger())).toBeUndefined()
    expect(providerImageOptions(imageModel(() => undefined), '1:1', createSilentLogger())).toBeUndefined()
    expect(providerImageOptions(imageModel(() => ({ providerOptions: { google: 'x' } })), '1:1', createSilentLogger())).toBeUndefined()
    expect(providerImageOptions(imageModel(() => {
      throw new Error('broken plugin')
    }), '1:1', createSilentLogger())).toBeUndefined()
  })

  it('deep-merges the reasoning options over the image options, before the hooks see them', async () => {
    expect(mergeProviderOptions({ google: { a: 1, nested: { x: 1 } }, other: { keep: true } }, { google: { b: 2, nested: { y: 2 } } })).toEqual({
      google: { a: 1, b: 2, nested: { x: 1, y: 2 } },
      other: { keep: true },
    })
    const polluted = JSON.parse('{"prov":{"__proto__":{"polluted":true},"ok":1}}') as ProviderOptions
    const merged = mergeProviderOptions({}, polluted)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(merged.prov).toMatchObject({ ok: 1 })
    const seen: unknown[] = []
    const params = await buildRunParams(input({
      imageProviderOptions: { prov: { responseModalities: ['TEXT', 'IMAGE'] }, img: { aspectRatio: '16:9' } },
      run: async (name, ...args) => {
        if (name === 'chat.params')
          seen.push(structuredClone((args[1] as { providerOptions: unknown }).providerOptions))
      },
    }))
    const expected = { prov: { responseModalities: ['TEXT', 'IMAGE'], budget: 1024 }, img: { aspectRatio: '16:9' } }
    expect(seen).toEqual([expected])
    expect(params.providerOptions).toEqual(expected)
  })
})

describe('agent instructions (Phase 9, ADR-041 / ADR-043)', () => {
  const workspace = {
    name: 'Demo app',
    root: '/srv/projects/demo',
    instructions: 'Project rules.',
    projectFile: { name: 'AGENTS.md' as const, content: 'Run the tests.', truncated: false },
  }
  const BLOCK = 'Project "Demo app", folder /srv/projects/demo (Linux).\n- Use paths relative to the project folder.'
  const ALL = [...AGENT_TOOL_NAMES]

  function tool(pluginId: string, name: string): OfferedTool {
    return { pluginId, definition: { name } }
  }

  it('the plan block: read-only investigation, exit_plan_mode with a complete Markdown plan, plain questions answered directly', () => {
    const block = planModeBlock(true)
    expect(block.split('\n')[0]).toBe('Plan mode is on: the user wants a plan before anything changes.')
    expect(block).toContain('read-only')
    expect(block).toContain('call exit_plan_mode with the whole plan as Markdown')
    expect(block).toContain('Answer plain questions')
    expect(block).toContain('directly in your reply')
    // Without the tool (disabled in the Tools tab, or a model without tools) the plan goes into the reply.
    const noTool = planModeBlock(false)
    expect(noTool).not.toContain('exit_plan_mode')
    expect(noTool).toContain('present the whole plan as Markdown')
    expect(noTool).toContain('Answer plain questions')
  })

  it('the hints name their tool and its rules', () => {
    expect(TODO_HINT).toContain('todo_write')
    expect(TODO_HINT).toContain('in_progress')
    expect(TASK_HINT).toContain('"explore"')
    expect(TASK_HINT).toContain('"general"')
    expect(TASK_HINT).toContain('cannot ask the user for approval')
    expect(TASK_HINT).toContain('complete prompt')
    for (const text of [planModeBlock(true), planModeBlock(false), TODO_HINT, TASK_HINT])
      expect(text).toMatch(/^[\x20-\x7E\n]+$/)
  })

  it.each(toolModeSchema.options.map(mode => [mode] as const))('mode %s: the plan block only in plan, the hints only for offered tools', (mode: ToolMode) => {
    const plan = mode === 'plan' ? [planModeBlock(true)] : []
    expect(agentBlocks(mode, ALL)).toEqual([...plan, TODO_HINT, TASK_HINT])
    expect(agentBlocks(mode, ['todo_write'])).toEqual([...(mode === 'plan' ? [planModeBlock(false)] : []), TODO_HINT])
    expect(agentBlocks(mode, ['task'])).toEqual([...(mode === 'plan' ? [planModeBlock(false)] : []), TASK_HINT])
    expect(agentBlocks(mode, [])).toEqual(mode === 'plan' ? [planModeBlock(false)] : [])
    expect(agentBlocks(mode)).toEqual(agentBlocks(mode, []))
  })

  it('order: global, workspace block, plan block, todo hint, task hint, project file, project and chat instructions', () => {
    const text = runInstructions({ globalInstructions: 'Global.', chatInstructions: 'Chat.', workspace, workspaceTools: ['read_file'], platform: 'linux', toolMode: 'plan', agentTools: ['task', 'exit_plan_mode', 'todo_write'] })
    expect(text).toBe([
      'Global.',
      BLOCK,
      planModeBlock(true),
      TODO_HINT,
      TASK_HINT,
      'Instructions from AGENTS.md in the project folder:\n\nRun the tests.',
      'Project rules.',
      'Chat.',
    ].join('\n\n'))
    // Without a workspace the agent blocks follow the global instructions.
    expect(runInstructions({ globalInstructions: 'Global.', chatInstructions: 'Chat.', workspace: null, toolMode: 'edits', agentTools: ['todo_write', 'task'] }))
      .toBe(['Global.', TODO_HINT, TASK_HINT, 'Chat.'].join('\n\n'))
    // No mode and no agent tools (a caller of Phase 8): unchanged.
    expect(runInstructions({ globalInstructions: 'Global.', chatInstructions: 'Chat.', workspace, workspaceTools: ['read_file'], platform: 'linux' }))
      .toBe(['Global.', BLOCK, 'Instructions from AGENTS.md in the project folder:\n\nRun the tests.', 'Project rules.', 'Chat.'].join('\n\n'))
    // Only the agent blocks.
    expect(runInstructions({ globalInstructions: '', chatInstructions: undefined, toolMode: 'plan', agentTools: ['exit_plan_mode'] })).toBe(planModeBlock(true))
  })

  it('buildRunParams passes the agent blocks to the chat.params hooks; ask without agent tools adds nothing', async () => {
    const seen: string[] = []
    const run: RunParamsInput['registry']['hooks']['run'] = async (name, ...args) => {
      if (name === 'chat.params')
        seen.push((args[1] as { instructions: string }).instructions)
    }
    const params = await buildRunParams(input({ toolMode: 'plan', agentTools: ['todo_write', 'exit_plan_mode'], run }))
    expect(params.instructions).toBe(['Global.', planModeBlock(true), TODO_HINT, 'Chat.'].join('\n\n'))
    expect(seen).toEqual([params.instructions])
    expect((await buildRunParams(input({ toolMode: 'ask' }))).instructions).toBe('Global.\n\nChat.')
    expect((await buildRunParams(input({ toolMode: 'auto', agentTools: ['task'], globalInstructions: '', chatInstructions: undefined }))).instructions).toBe(TASK_HINT)
  })

  it('offeredAgentTools: core-agent tools only (by owner), in AGENT_TOOL_NAMES order, narrowed by activeTools', () => {
    const byName = new Map<string, OfferedTool>([
      ['task', tool('core-agent', 'task')],
      ['read_file', tool('core-workspace', 'read_file')],
      ['exit_plan_mode', tool('core-agent', 'exit_plan_mode')],
      ['todo_write', tool('core-agent', 'todo_write')],
    ])
    expect(offeredAgentTools({ byName })).toEqual(['todo_write', 'exit_plan_mode', 'task'])
    // The approved plan continuation: exit_plan_mode stays executable but is not offered to the model.
    expect(offeredAgentTools({ byName, activeTools: ['read_file', 'todo_write', 'task'] })).toEqual(['todo_write', 'task'])
    expect(offeredAgentTools({ byName, activeTools: [] })).toEqual([])
    // A tool of another plugin with an agent tool's name is not an agent tool.
    expect(offeredAgentTools({ byName: new Map([['todo_write', tool('evil', 'todo_write')]]) })).toEqual([])
    expect(offeredAgentTools({ byName: new Map() })).toEqual([])
    // The pipeline passes its `AssembledTools` as is: `agentTools: offeredAgentTools(assembled)`.
    expectTypeOf<AssembledTools>().toExtend<Parameters<typeof offeredAgentTools>[0]>()
  })
})

describe('the agent-types and skills blocks (Phase 10, W10.3-T6)', () => {
  const PROJECT = {
    name: 'Demo app',
    root: '/srv/projects/demo',
    instructions: 'Project rules.',
    projectFile: { name: 'AGENTS.md' as const, content: 'Run the tests.', truncated: false },
  }
  const TYPES = [
    { name: 'reviewer', description: 'Reviews diffs.' },
    { name: 'general', description: 'General agent.' },
    { name: 'debugger', description: 'Finds bugs.' },
    { name: 'explore', description: 'Read-only search.' },
  ]
  const SKILLS = [{ name: 'release-notes', description: 'Writes release notes.' }, { name: 'pdf', description: 'Reads PDF files.' }]

  it('lists the agent types after the task hint (builtins first, then by name) in the format the mocks read', () => {
    const block = agentTypesBlock(TYPES)
    expect(block).toBe([
      AGENT_TYPES_HEADER,
      '- explore: Read-only search.',
      '- general: General agent.',
      '- debugger: Finds bugs.',
      '- reviewer: Reviews diffs.',
    ].join('\n'))
    expect(AGENT_TYPES_HEADER.startsWith('Agent types')).toBe(true)
    expect(mockAgentTypeNames(block)).toEqual(['explore', 'general', 'debugger', 'reviewer'])
    expect(agentTypesBlock([])).toBe('')
  })

  it('lists the skills by name in the format the mocks read', () => {
    const block = skillsBlock(SKILLS)
    expect(block).toBe([SKILLS_HEADER, '- pdf: Reads PDF files.', '- release-notes: Writes release notes.'].join('\n'))
    expect(SKILLS_HEADER.startsWith('Skills')).toBe(true)
    expect(mockSkillNames(block)).toEqual(['pdf', 'release-notes'])
    // The two blocks never read as each other.
    expect(mockSkillNames(agentTypesBlock(TYPES))).toEqual([])
    expect(mockAgentTypeNames(block)).toEqual([])
    expect(skillsBlock([])).toBe('')
  })

  it('present only when the tool is offered; order: task hint, agent types, skills, then the project file', () => {
    const text = runInstructions({
      globalInstructions: 'Global.',
      chatInstructions: 'Chat.',
      workspace: PROJECT,
      workspaceTools: [],
      platform: 'linux',
      toolMode: 'edits',
      agentTools: ['todo_write', 'task', 'skill'],
      agentTypes: TYPES,
      skills: SKILLS,
    })
    expect(text).toBe([
      'Global.',
      'Project "Demo app", folder /srv/projects/demo (Linux).',
      TODO_HINT,
      TASK_HINT,
      agentTypesBlock(TYPES),
      skillsBlock(SKILLS),
      'Instructions from AGENTS.md in the project folder:\n\nRun the tests.',
      'Project rules.',
      'Chat.',
    ].join('\n\n'))
    expect(mockAgentTypeNames(text)).toEqual(['explore', 'general', 'debugger', 'reviewer'])
    expect(mockSkillNames(text)).toEqual(['pdf', 'release-notes'])

    // `task` not offered: no agent types (skills only with `skill`); `skill` not offered: no skills block.
    expect(agentBlocks('ask', ['skill'], { agentTypes: TYPES, skills: SKILLS })).toEqual([skillsBlock(SKILLS)])
    expect(agentBlocks('ask', ['task'], { agentTypes: TYPES, skills: SKILLS })).toEqual([TASK_HINT, agentTypesBlock(TYPES)])
    expect(agentBlocks('ask', [], { agentTypes: TYPES, skills: SKILLS })).toEqual([])
    // An offered `skill` with an empty list adds nothing (the pipeline never offers it then).
    expect(agentBlocks('ask', ['task', 'skill'], { agentTypes: [], skills: [] })).toEqual([TASK_HINT])
    // Plan mode keeps the plan block first.
    expect(agentBlocks('plan', ['task', 'exit_plan_mode'], { agentTypes: TYPES })).toEqual([planModeBlock(true), TASK_HINT, agentTypesBlock(TYPES)])
  })

  it(`caps: ${LIMITS.agentTypesListedMax} agent types, ${LIMITS.skillsListedMax} skills, descriptions of ${LIMITS.listedDescriptionMaxChars} characters on one line`, () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ name: `agent-${String(index).padStart(2, '0')}`, description: `Agent ${index}.` }))
    const typeNames = mockAgentTypeNames(agentTypesBlock([...many, { name: 'general', description: 'G.' }, { name: 'explore', description: 'E.' }]))
    expect(typeNames).toHaveLength(LIMITS.agentTypesListedMax)
    expect(typeNames.slice(0, 3)).toEqual(['explore', 'general', 'agent-00'])
    expect(typeNames.at(-1)).toBe(`agent-${String(LIMITS.agentTypesListedMax - 3).padStart(2, '0')}`)

    const skills = Array.from({ length: 60 }, (_, index) => ({ name: `skill-${String(index).padStart(2, '0')}`, description: 'S.' }))
    expect(mockSkillNames(skillsBlock(skills))).toHaveLength(LIMITS.skillsListedMax)

    const long = `First line\n\n  second   line ${'x'.repeat(400)}`
    const line = agentTypesBlock([{ name: 'wordy', description: long }]).split('\n')[1]!
    const description = line.slice('- wordy: '.length)
    expect(description.startsWith('First line second line xxx')).toBe(true)
    expect(description).toHaveLength(LIMITS.listedDescriptionMaxChars)
    expect(description.endsWith('…')).toBe(true)
    expect(listedDescription('Short.')).toBe('Short.')
    expect(listedDescription(` ${'y'.repeat(LIMITS.listedDescriptionMaxChars)} `)).toHaveLength(LIMITS.listedDescriptionMaxChars)
    // A surrogate pair is never split.
    expect(listedDescription(`${'a'.repeat(248)}\u{1F600}tail`)).toBe(`${'a'.repeat(248)}…`)
  })

  it('skips invalid and duplicate names; an entry without a description is listed by name', () => {
    const block = agentTypesBlock([
      { name: 'Bad Name', description: 'x' },
      { name: 'evil\n- injected', description: 'x' },
      { name: 'quiet', description: '   ' },
      { name: 'quiet', description: 'Second.' },
    ])
    expect(block).toBe(`${AGENT_TYPES_HEADER}\n- quiet`)
    expect(orderAgentTypes([{ name: 'b', description: '' }, { name: 'explore', description: '' }, { name: 'a', description: '' }], 2).map(entry => entry.name)).toEqual(['explore', 'a'])
  })

  it('buildRunParams lists the catalog\'s agents and skills when task and skill are offered', async () => {
    const plain = await buildRunParams(input({ agentTools: ['task', 'skill'] }))
    expect(plain.instructions).toBe(['Global.', TASK_HINT, 'Chat.'].join('\n\n'))
    const listed = await buildRunParams(input({ agentTools: ['task', 'skill'], agentTypes: TYPES, skills: SKILLS }))
    expect(listed.instructions).toBe(['Global.', TASK_HINT, agentTypesBlock(TYPES), skillsBlock(SKILLS), 'Chat.'].join('\n\n'))
    const none = await buildRunParams(input({ agentTypes: TYPES, skills: SKILLS }))
    expect(none.instructions).toBe('Global.\n\nChat.')
  })
})

describe('output styles and model-invocable skills (Phase 11, W11.6-T5 / T6)', () => {
  const PROJECT = {
    name: 'Demo app',
    root: '/srv/projects/demo',
    instructions: 'Project rules.',
    projectFile: { name: 'AGENTS.md' as const, content: 'Run the tests.', truncated: false },
  }
  const TOOLS = ['read_file', 'edit_file', 'write_file', 'shell']
  const TYPES = [{ name: 'explore', description: 'Read-only search.' }]
  const SKILLS = [
    { name: 'pdf', description: 'Reads PDF files.' },
    { name: 'internal', description: 'Internal notes.', modelInvocable: false },
    { name: 'deploy', description: 'Deploys.', modelInvocable: true },
  ]
  const TERSE = { name: 'terse', label: 'Terse Replies', content: 'Answer in three lines at most.\n', keepCodingInstructions: false }
  const base = {
    globalInstructions: 'Global.',
    chatInstructions: 'Chat.',
    workspace: PROJECT,
    workspaceTools: TOOLS,
    platform: 'linux' as const,
    toolMode: 'edits' as const,
    agentTools: ['todo_write', 'task', 'skill'],
    agentTypes: TYPES,
    skills: SKILLS,
  }

  it('puts the style block first; keep-coding-instructions false drops the tool rules and the todo / task hints only', () => {
    const plain = runInstructions(base)
    const styled = runInstructions({ ...base, outputStyle: TERSE })
    expect(styled).toBe([
      'Output style: Terse Replies\n\nAnswer in three lines at most.',
      'Global.',
      'Project "Demo app", folder /srv/projects/demo (Linux).',
      agentTypesBlock(TYPES),
      skillsBlock(SKILLS),
      'Instructions from AGENTS.md in the project folder:\n\nRun the tests.',
      'Project rules.',
      'Chat.',
    ].join('\n\n'))
    expect(styled).not.toContain(TODO_HINT)
    expect(styled).not.toContain(TASK_HINT)
    expect(styled).not.toContain('- Use paths relative to the project folder.')
    // What `mock:hooks` reports for `style?`.
    expect(mockHooksStyleText(styled)).toBe('Style: Terse Replies | workspace-rules: no | todo-hint: no')
    expect(mockHooksStyleText(plain)).toBe('Style: none | workspace-rules: yes | todo-hint: yes')
    // Keeping the coding instructions: the same text as without a style, the block first.
    const kept = runInstructions({ ...base, outputStyle: { ...TERSE, keepCodingInstructions: true } })
    expect(kept).toBe(`Output style: Terse Replies\n\nAnswer in three lines at most.\n\n${plain}`)
    expect(mockHooksStyleText(kept)).toBe('Style: Terse Replies | workspace-rules: yes | todo-hint: yes')
    // Plan mode keeps its block (and the listings) with keep = false.
    const plan = runInstructions({ ...base, toolMode: 'plan', agentTools: ['task', 'exit_plan_mode'], outputStyle: TERSE })
    expect(plan).toContain(planModeBlock(true))
    expect(plan).toContain(agentTypesBlock(TYPES))
    expect(plan).not.toContain(TASK_HINT)
    // Without a workspace there is no head line to keep.
    expect(runInstructions({ ...base, workspace: null, outputStyle: TERSE }).split('\n\n').slice(0, 3)).toEqual(['Output style: Terse Replies', 'Answer in three lines at most.', 'Global.'])
  })

  it('default, null and absent add nothing; builtin styles keep the coding instructions', () => {
    const plain = runInstructions(base)
    expect(runInstructions({ ...base, outputStyle: DEFAULT_RUN_OUTPUT_STYLE })).toBe(plain)
    expect(runInstructions({ ...base, outputStyle: null })).toBe(plain)
    // An empty body adds no block (and its keep flag still applies).
    expect(runInstructions({ ...base, outputStyle: { ...TERSE, content: '  ' } }).startsWith('Global.')).toBe(true)
    const explanatory = runInstructions({ ...base, outputStyle: builtinRunOutputStyle('explanatory') })
    expect(explanatory.startsWith('Output style: Explanatory\n\nBesides doing the task')).toBe(true)
    expect(explanatory).toContain(TODO_HINT)
    expect(mockHooksStyleText(explanatory)).toBe('Style: Explanatory | workspace-rules: yes | todo-hint: yes')
    expect(styleBlock(null)).toBeNull()
    expect(styleBlock(DEFAULT_RUN_OUTPUT_STYLE)).toBeNull()
    expect(styleBlock({ label: '', content: 'Body.' })).toBe('Output style: Custom\n\nBody.')
  })

  it('buildRunParams: the block first for the main agent, before the chat.params hooks; a child without a style has none', async () => {
    let seen = ''
    const run: HookRun = async (name, ...args) => {
      if (name === 'chat.params')
        seen = (args[1] as { instructions: string }).instructions
    }
    const main = await buildRunParams(input({ run, agentTools: ['todo_write'], outputStyle: TERSE }))
    expect(main.instructions).toBe(['Output style: Terse Replies\n\nAnswer in three lines at most.', 'Global.', 'Chat.'].join('\n\n'))
    expect(seen).toBe(main.instructions)
    // Sub-agents never pass `outputStyle`: their instructions have no block and keep the hints.
    const child = await buildRunParams(input({ agentTools: ['todo_write'] }))
    expect(child.instructions).toBe(['Global.', TODO_HINT, 'Chat.'].join('\n\n'))
    expect(mockHooksStyleText(child.instructions!)).toBe('Style: none | workspace-rules: no | todo-hint: yes')
  })

  it('the skills block lists only model-invocable skills (disable-model-invocation leaves a skill out)', () => {
    const block = skillsBlock(SKILLS)
    expect(block).toBe([SKILLS_HEADER, '- deploy: Deploys.', '- pdf: Reads PDF files.'].join('\n'))
    expect(mockSkillNames(block)).toEqual(['deploy', 'pdf'])
    expect(skillsBlock([{ name: 'internal', description: 'Internal.', modelInvocable: false }])).toBe('')
    expect(agentBlocks('ask', ['skill'], { skills: [{ name: 'internal', description: 'Internal.', modelInvocable: false }] })).toEqual([])
  })
})
