import type { HookMap, HookName, ProviderOptions, ReasoningParams } from '@harness-forge/plugin-sdk'
import type { ReasoningEffort, ToolMode } from '@harness-forge/shared'
import type { ResolvedModel } from '../providers/types.ts'
import type { OfferedTool, RunParamsInput } from './params.ts'
import type { AssembledTools } from './tools.ts'
import { AGENT_TOOL_NAMES, toolModeSchema } from '@harness-forge/shared'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createSilentLogger } from '../logger.ts'
import {
  agentBlocks,
  buildRunParams,
  joinInstructions,
  mergeProviderOptions,
  offeredAgentTools,
  osName,
  planModeBlock,
  projectFileInstructions,
  providerImageOptions,
  providerReasoning,
  runInstructions,
  runMaxSteps,
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

describe('runParamsInput.agentTypes / skills (Phase 10 seam, C31-T6)', () => {
  it('accepts the catalog\'s agents and skills; P10-0b adds no block yet (W10.3)', async () => {
    const plain = await buildRunParams(input({ agentTools: ['task', 'skill'] }))
    const listed = await buildRunParams(input({
      agentTools: ['task', 'skill'],
      agentTypes: [{ name: 'explore', description: 'Read-only search.' }, { name: 'reviewer', description: 'Reviews diffs.' }],
      skills: [{ name: 'release-notes', description: 'Writes release notes.' }],
    }))
    expect(listed).toEqual(plain)
  })
})
