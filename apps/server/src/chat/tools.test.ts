import type { HookMap, HookName, ToolCallContext, ToolDefinition, ToolWorkspace, ToolWorkspaceAccess } from '@harness-forge/plugin-sdk'
import type { McpServer } from '@harness-forge/shared'
import type { ToolExecutionOptions } from 'ai'
import type { Logger } from '../logger.ts'
import type { ToolPref } from '../mcp/types.ts'
import type { RegisteredTool } from '../registry/types.ts'
import type { CheckpointJournal } from '../services/checkpoints/types.ts'
import type { FakeJournalRecord } from '../testing/fake-checkpoints.ts'
import type { WorkspaceRunScope, WorkspaceRunScopeInit } from '../workspace/run-scope.ts'
import type { ToolAssemblyInput, ToolWrapContext } from './tools.ts'
import { Buffer } from 'node:buffer'
import { LIMITS } from '@harness-forge/shared'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createMemoryLogger, createSilentLogger } from '../logger.ts'
import { createFakeCheckpointService } from '../testing/fake-checkpoints.ts'
import { runScopeOf } from '../workspace/run-scope.ts'
import { ToolFailure } from './errors.ts'
import {
  assembleTools,
  capToolOutput,
  clampToolTimeout,
  CORE_WORKSPACE_PLUGIN_ID,
  isTruncatedToolOutput,
  offersWorkspaceTool,
  settledCallRecord,
  toolWorkspace,
  utf8Prefix,
  wrapToModelOutput,
  wrapToolExecute,
} from './tools.ts'

function definition(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'demo_tool',
    description: 'Demo.',
    inputSchema: z.object({ text: z.string() }),
    policy: 'safe',
    execute: async input => ({ echoed: (input as { text: string }).text }),
    ...overrides,
  }
}

const guard: ToolWrapContext['plugins']['guard'] = async (_pluginId, fn, options) => {
  const controller = new AbortController()
  try {
    return await fn(controller.signal)
  }
  catch (error) {
    if (options.signal?.aborted)
      throw options.signal.reason
    throw new Error(error instanceof Error ? error.message : String(error))
  }
}

type HookRun = <K extends HookName>(name: K, ...args: HookMap[K]) => Promise<void>

const MESSAGE_ID = 'msg_a000000000000001'

function wrapContext(overrides: { active?: boolean, run?: HookRun, workspace?: ToolWorkspace | null, scope?: WorkspaceRunScopeInit | null, logger?: Logger } = {}): ToolWrapContext {
  const run: HookRun = overrides.run ?? (async () => {})
  return {
    chatId: 'chat',
    messageId: MESSAGE_ID,
    modelRef: 'mock:echo',
    registry: { hooks: { run, on: () => ({ dispose() {} }), list: () => [] } },
    plugins: { guard, isActive: () => overrides.active ?? true },
    signal: new AbortController().signal,
    ...(overrides.workspace === undefined ? {} : { workspace: overrides.workspace }),
    ...(overrides.scope === undefined ? {} : { scope: overrides.scope }),
    ...(overrides.logger === undefined ? {} : { logger: overrides.logger }),
  }
}

/** An `OpenWorkspace`-like value with fields that must not reach the tools. */
const OPEN_WORKSPACE = { projectId: 'prj_0123456789abcdef', name: 'Demo', root: '/srv/projects/demo', instructions: 'Secret project rules.', projectFile: null }

const options: ToolExecutionOptions<unknown> = { toolCallId: 'call_1', messages: [], context: undefined }

describe('tool output cap', () => {
  it('keeps small outputs (JSON round trip) and truncates large ones with a marker', () => {
    expect(capToolOutput({ a: 1, b: undefined, when: new Date(0) })).toEqual({ a: 1, when: '1970-01-01T00:00:00.000Z' })
    expect(capToolOutput(undefined)).toBeNull()
    const big = { text: 'é'.repeat(40_000) }
    const json = JSON.stringify(big)
    const capped = capToolOutput(big)
    expect(isTruncatedToolOutput(capped)).toBe(true)
    const marker = capped as { truncated: true, originalBytes: number, preview: string }
    expect(marker.originalBytes).toBe(Buffer.byteLength(json))
    expect(Buffer.byteLength(marker.preview)).toBeLessThanOrEqual(LIMITS.toolOutputBytes)
    expect(json.startsWith(marker.preview)).toBe(true)
    // An output of exactly the limit is kept.
    const exact = 'x'.repeat(LIMITS.toolOutputBytes - 2)
    expect(capToolOutput(exact)).toBe(exact)
  })

  it('rejects outputs that cannot be serialized', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => capToolOutput(cyclic)).toThrow(ToolFailure)
    expect(() => capToolOutput({ big: 1n })).toThrow('not JSON-serializable')
  })

  it('cuts UTF-8 on a code point boundary', () => {
    expect(utf8Prefix('abc', 10)).toBe('abc')
    expect(utf8Prefix('aé', 2)).toBe('a')
    expect(utf8Prefix('a😀b', 4)).toBe('a')
    expect(utf8Prefix('a😀b', 5)).toBe('a😀')
  })

  it('clamps tool timeouts to the guard limits', () => {
    expect(clampToolTimeout(undefined)).toBe(60_000)
    expect(clampToolTimeout(-5)).toBe(60_000)
    expect(clampToolTimeout(1500.7)).toBe(1500)
    expect(clampToolTimeout(10_000_000)).toBe(600_000)
  })
})

describe('wrapToolExecute', () => {
  it('runs the tool with a ToolCallContext and caps the output', async () => {
    const execute = vi.fn(async (_input: unknown, context: unknown) => {
      expect(context).toMatchObject({ chatId: 'chat', modelRef: 'mock:echo', toolCallId: 'call_1', messages: [] })
      return 'y'.repeat(LIMITS.toolOutputBytes + 10)
    })
    const wrapped = wrapToolExecute({ pluginId: 'demo', definition: definition({ execute }) }, wrapContext())
    const output = await wrapped({ text: 'hi' }, options)
    expect(isTruncatedToolOutput(output)).toBe(true)
    expect(execute).toHaveBeenCalledWith({ text: 'hi' }, expect.anything())
  })

  it('adds the frozen workspace of the run to the call context; none without a workspace', async () => {
    const seen: ToolCallContext[] = []
    const execute = async (_input: unknown, context: ToolCallContext) => {
      seen.push(context)
      return 'ok'
    }
    const workspace = toolWorkspace(OPEN_WORKSPACE)
    expect(workspace).toEqual({ projectId: 'prj_0123456789abcdef', name: 'Demo', root: '/srv/projects/demo' })
    expect(Object.isFrozen(workspace)).toBe(true)
    await wrapToolExecute({ pluginId: 'demo', definition: definition({ execute }) }, wrapContext({ workspace }))({ text: 'a' }, options)
    await wrapToolExecute({ pluginId: 'demo', definition: definition({ execute }) }, wrapContext({ workspace: null }))({ text: 'b' }, options)
    await wrapToolExecute({ pluginId: 'demo', definition: definition({ execute }) }, wrapContext())({ text: 'c' }, options)
    expect(seen[0]?.workspace).toBe(workspace)
    expect('workspace' in seen[1]!).toBe(false)
    expect('workspace' in seen[2]!).toBe(false)
  })

  it('fails with "Tool unavailable" when the owner plugin is not active', async () => {
    const wrapped = wrapToolExecute({ pluginId: 'demo', definition: definition() }, wrapContext({ active: false }))
    await expect(wrapped({ text: 'hi' }, options)).rejects.toThrow('Tool unavailable: the plugin "demo" is not active.')
  })

  it('lets tool.before change the input (re-validated) or block the call; tool.after changes the output', async () => {
    const run: HookRun = async (name, ...args) => {
      const [, output] = args as unknown as [unknown, Record<string, unknown>]
      if (name === 'tool.before')
        output.input = { text: 'changed' }
      if (name === 'tool.after')
        output.output = { replaced: true, was: output.output }
    }
    const wrapped = wrapToolExecute({ pluginId: 'demo', definition: definition() }, wrapContext({ run }))
    expect(await wrapped({ text: 'original' }, options)).toEqual({ replaced: true, was: { echoed: 'changed' } })

    const invalid = wrapToolExecute({ pluginId: 'demo', definition: definition() }, wrapContext({
      run: async (name, ...args) => {
        if (name === 'tool.before')
          (args[1] as { input: unknown }).input = { text: 42 }
      },
    }))
    await expect(invalid({ text: 'x' }, options)).rejects.toThrow('The tool input is invalid')

    const blocked = wrapToolExecute({ pluginId: 'demo', definition: definition() }, wrapContext({
      run: async (name, ..._args) => {
        if (name === 'tool.before')
          throw new Error('Blocked by guardian: nope')
      },
    }))
    await expect(blocked({ text: 'x' }, options)).rejects.toThrow(new ToolFailure('Blocked by guardian: nope'))
  })

  it('turns a throwing tool into a ToolFailure and passes aborts through', async () => {
    const wrapped = wrapToolExecute({ pluginId: 'demo', definition: definition({ execute: async () => {
      throw new Error('disk full')
    } }) }, wrapContext())
    await expect(wrapped({ text: 'x' }, options)).rejects.toThrow(new ToolFailure('disk full'))

    const controller = new AbortController()
    controller.abort(new DOMException('stopped', 'AbortError'))
    const aborted = wrapToolExecute({ pluginId: 'demo', definition: definition({ execute: async () => {
      throw new Error('never mind')
    } }) }, wrapContext())
    await expect(aborted({ text: 'x' }, { ...options, abortSignal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('wrapToModelOutput', () => {
  it('uses the guarded toModelOutput, JSON on failure or for a truncated output', async () => {
    const convert = wrapToModelOutput({ pluginId: 'demo', definition: definition({ toModelOutput: output => ({ type: 'text', value: `got ${JSON.stringify(output)}` }) }) }, { guard })
    expect(await convert({ toolCallId: 'c', input: {}, output: { a: 1 } })).toEqual({ type: 'text', value: 'got {"a":1}' })
    const marker = { truncated: true, originalBytes: 99_999, preview: '{' }
    expect(await convert({ toolCallId: 'c', input: {}, output: marker })).toEqual({ type: 'json', value: marker })
    const failing = wrapToModelOutput({ pluginId: 'demo', definition: definition({ toModelOutput: () => {
      throw new Error('bad')
    } }) }, { guard })
    expect(await failing({ toolCallId: 'c', input: {}, output: { a: 1 } })).toEqual({ type: 'json', value: { a: 1 } })
    const none = wrapToModelOutput({ pluginId: 'demo', definition: definition() }, { guard })
    expect(await none({ toolCallId: 'c', input: {}, output: undefined })).toEqual({ type: 'json', value: null })
  })
})

function registered(name: string, overrides: Partial<RegisteredTool> = {}): RegisteredTool {
  return { pluginId: 'demo', definition: definition({ name }), mcpServerId: null, title: null, ...overrides }
}

function assemblyInput(overrides: Partial<ToolAssemblyInput> & { tools?: RegisteredTool[], prefs?: Map<string, ToolPref>, servers?: McpServer[] | Error } = {}): ToolAssemblyInput {
  const tools = overrides.tools ?? [registered('alpha'), registered('beta')]
  const servers = overrides.servers ?? []
  return {
    chatId: 'chat',
    messageId: MESSAGE_ID,
    modelRef: 'mock:echo',
    toolMode: 'ask',
    modelSupportsTools: true,
    registry: {
      tools: { list: () => tools, get: name => tools.find(tool => tool.definition.name === name), register: () => ({ dispose() {} }) },
      hooks: { run: async () => {}, on: () => ({ dispose() {} }), list: () => [] },
    },
    plugins: { guard, isActive: pluginId => pluginId !== 'inactive' },
    toolService: { prefs: async () => overrides.prefs ?? new Map() },
    mcp: { list: async () => {
      if (servers instanceof Error)
        throw servers
      return servers
    } },
    signal: new AbortController().signal,
    logger: createSilentLogger(),
    allowExecute: true,
    ...overrides,
  }
}

function workspaceTool(name: string, workspace: ToolWorkspaceAccess, execute?: ToolDefinition['execute']): RegisteredTool {
  return registered(name, { pluginId: 'core-workspace', definition: definition({ name, workspace, ...(execute === undefined ? {} : { execute }) }) })
}

/** The core-workspace tools (by access) plus a plain tool and an MCP tool. */
function workspaceTools(execute?: ToolDefinition['execute']): RegisteredTool[] {
  return [
    registered('current_time'),
    workspaceTool('read_file', 'read', execute),
    workspaceTool('write_file', 'write', execute),
    workspaceTool('edit_file', 'write', execute),
    workspaceTool('shell', 'execute', execute),
    registered('mcp__up__a', { mcpServerId: 'up' }),
  ]
}

describe('assembleTools', () => {
  it('sends every usable registry tool; none in mode off', async () => {
    const all = await assembleTools(assemblyInput())
    expect(Object.keys(all.tools).sort()).toEqual(['alpha', 'beta'])
    expect([...all.byName.keys()].sort()).toEqual(['alpha', 'beta'])
    expect(all.unsupported).toBe(false)
    const off = await assembleTools(assemblyInput({ toolMode: 'off' }))
    expect(off.tools).toEqual({})
    expect(off.unsupported).toBe(false)
  })

  it('leaves out disabled tools, override deny and tools of inactive plugins', async () => {
    const prefs = new Map<string, ToolPref>([
      ['alpha', { enabled: false, override: null }],
      ['beta', { enabled: true, override: 'deny' }],
      ['gamma', { enabled: true, override: 'allow' }],
    ])
    const tools = [registered('alpha'), registered('beta'), registered('gamma'), registered('delta', { pluginId: 'inactive' })]
    const result = await assembleTools(assemblyInput({ tools, prefs }))
    expect(Object.keys(result.tools)).toEqual(['gamma'])
    expect(result.prefs.get('gamma')?.override).toBe('allow')
  })

  it('reports tools-unsupported for a model without tool support', async () => {
    const result = await assembleTools(assemblyInput({ modelSupportsTools: false }))
    expect(result.tools).toEqual({})
    expect(result.unsupported).toBe(true)
    const none = await assembleTools(assemblyInput({ modelSupportsTools: false, tools: [] }))
    expect(none.unsupported).toBe(false)
  })

  it('sends MCP tools only for connected servers (no filter when the manager cannot tell) as dynamic tools', async () => {
    const tools = [registered('mcp__up__a', { mcpServerId: 'up' }), registered('mcp__down__b', { mcpServerId: 'down' }), registered('local')]
    const servers = [{ id: 'up', status: 'connected' }, { id: 'down', status: 'error' }] as McpServer[]
    const result = await assembleTools(assemblyInput({ tools, servers }))
    expect(Object.keys(result.tools).sort()).toEqual(['local', 'mcp__up__a'])
    expect(result.tools.mcp__up__a).toMatchObject({ type: 'dynamic', metadata: { mcpServerId: 'up' } })
    const unknown = await assembleTools(assemblyInput({ tools, servers: new Error('not ready') }))
    expect(Object.keys(unknown.tools).sort()).toEqual(['local', 'mcp__down__b', 'mcp__up__a'])
  })

  it('survives failing preference and registry reads', async () => {
    const result = await assembleTools(assemblyInput({ toolService: { prefs: async () => {
      throw new Error('db')
    } } }))
    expect(Object.keys(result.tools).sort()).toEqual(['alpha', 'beta'])
    const broken = await assembleTools(assemblyInput({
      registry: {
        tools: { list: () => {
          throw new Error('registry')
        }, get: () => undefined, register: () => ({ dispose() {} }) },
        hooks: { run: async () => {}, on: () => ({ dispose() {} }), list: () => [] },
      },
    }))
    expect(broken.tools).toEqual({})
  })
})

describe('assembleTools with a workspace (Phase 7)', () => {
  const servers = [{ id: 'up', status: 'connected' }] as McpServer[]

  it('sends no workspace tool without a workspace (a chat without a project, or the folder unavailable)', async () => {
    for (const workspace of [undefined, null]) {
      const result = await assembleTools(assemblyInput({ tools: workspaceTools(), servers, ...(workspace === undefined ? {} : { workspace }) }))
      expect(Object.keys(result.tools).sort()).toEqual(['current_time', 'mcp__up__a'])
      expect([...result.byName.keys()].sort()).toEqual(['current_time', 'mcp__up__a'])
      expect(result.workspace).toBeNull()
    }
  })

  it('sends every tool with a workspace, and gives every tool the frozen { projectId, name, root }', async () => {
    const seen = new Map<string, ToolCallContext>()
    const execute = async (_input: unknown, context: ToolCallContext) => {
      seen.set(context.toolCallId, context)
      return 'ok'
    }
    const tools = [...workspaceTools(execute), registered('plain_tool', { definition: definition({ name: 'plain_tool', execute }) })]
    const result = await assembleTools(assemblyInput({ tools, servers, workspace: OPEN_WORKSPACE }))
    expect(Object.keys(result.tools).sort()).toEqual(['current_time', 'edit_file', 'mcp__up__a', 'plain_tool', 'read_file', 'shell', 'write_file'])
    expect(result.workspace).toEqual({ projectId: 'prj_0123456789abcdef', name: 'Demo', root: '/srv/projects/demo' })
    expect(Object.isFrozen(result.workspace)).toBe(true)
    await result.tools.write_file!.execute!({ text: 'x' }, { ...options, toolCallId: 'call_write' })
    await result.tools.plain_tool!.execute!({ text: 'x' }, { ...options, toolCallId: 'call_plain' })
    expect(seen.get('call_write')?.workspace).toBe(result.workspace)
    expect(seen.get('call_plain')?.workspace).toBe(result.workspace)
  })

  it('leaves out execute tools while the shell is switched off (HF_WORKSPACE_SHELL=0)', async () => {
    const result = await assembleTools(assemblyInput({ tools: workspaceTools(), servers, workspace: OPEN_WORKSPACE, allowExecute: false }))
    expect(Object.keys(result.tools).sort()).toEqual(['current_time', 'edit_file', 'mcp__up__a', 'read_file', 'write_file'])
  })

  it('applies the workspace filter before the tools-unsupported check and in mode off', async () => {
    const onlyWorkspace = [workspaceTool('read_file', 'read')]
    expect((await assembleTools(assemblyInput({ tools: onlyWorkspace, modelSupportsTools: false }))).unsupported).toBe(false)
    expect((await assembleTools(assemblyInput({ tools: onlyWorkspace, modelSupportsTools: false, workspace: OPEN_WORKSPACE }))).unsupported).toBe(true)
    const off = await assembleTools(assemblyInput({ tools: onlyWorkspace, toolMode: 'off', workspace: OPEN_WORKSPACE }))
    expect(off.tools).toEqual({})
    expect(off.workspace).toEqual({ projectId: 'prj_0123456789abcdef', name: 'Demo', root: '/srv/projects/demo' })
  })

  it('treats an unknown workspace access as execute', () => {
    const odd = { workspace: 'admin' as ToolWorkspaceAccess }
    expect(offersWorkspaceTool(odd, true, true)).toBe(true)
    expect(offersWorkspaceTool(odd, true, false)).toBe(false)
    expect(offersWorkspaceTool(odd, false, true)).toBe(false)
    expect(offersWorkspaceTool({}, false, false)).toBe(true)
    expect(offersWorkspaceTool({ workspace: 'read' }, true, false)).toBe(true)
    expect(offersWorkspaceTool({ workspace: 'write' }, false, true)).toBe(false)
  })
})

// ---------- Phase 8: the run scope and the journal of settled calls ----------

const PROJECT_ID = 'prj_0123456789abcdef'

/** A run scope over the recording fake journal (`fake.records`). */
function runScope(overrides: Partial<WorkspaceRunScopeInit> = {}) {
  const fake = createFakeCheckpointService()
  const scope: WorkspaceRunScopeInit = {
    chatId: 'chat',
    messageId: MESSAGE_ID,
    projectId: PROJECT_ID,
    journal: fake.journal({ chatId: 'chat', messageId: MESSAGE_ID, projectId: PROJECT_ID }),
    shellRules: Object.freeze({ projectId: PROJECT_ID, prefixes: Object.freeze(['ls']) }),
    shellCwd: { current: '.' },
    ...overrides,
  }
  return { fake, scope }
}

/** A registered tool of `pluginId` named `name` with workspace access `access` (none when undefined). */
function scopedTool(pluginId: string, name: string, access?: ToolWorkspaceAccess, execute?: ToolDefinition['execute']): Pick<RegisteredTool, 'pluginId' | 'definition'> {
  return {
    pluginId,
    definition: definition({
      name,
      inputSchema: z.object({ command: z.string().optional(), text: z.string().optional() }),
      ...(access === undefined ? {} : { workspace: access }),
      ...(execute === undefined ? {} : { execute }),
    }),
  }
}

/** The fields of the records, without the scope (checked separately). */
function recorded(records: readonly FakeJournalRecord[]): unknown[] {
  return records.map(({ scope: _scope, ...rest }) => rest)
}

describe('wrapToolExecute: the run scope (Phase 8)', () => {
  const workspace = toolWorkspace(OPEN_WORKSPACE)

  it('binds the scope with the call id right before execute; the call context exposes no property for it', async () => {
    const { scope } = runScope()
    const seen: Array<{ c: ToolCallContext, bound: WorkspaceRunScope | null }> = []
    const execute = async (_input: unknown, c: ToolCallContext) => {
      seen.push({ c, bound: runScopeOf(c) })
      return 'ok'
    }
    const wrapped = wrapToolExecute(scopedTool('demo', 'demo_tool', undefined, execute), wrapContext({ workspace, scope }))
    await wrapped({ text: 'a' }, options)
    await wrapped({ text: 'b' }, { ...options, toolCallId: 'call_2' })

    const [first, second] = seen
    expect(first?.bound).toEqual({ ...scope, toolCallId: 'call_1' })
    expect(second?.bound?.toolCallId).toBe('call_2')
    expect(first?.bound?.chatId).toBe('chat')
    expect(first?.bound?.messageId).toBe(MESSAGE_ID)
    expect(first?.bound?.projectId).toBe(PROJECT_ID)
    expect(first?.bound?.journal).toBe(scope.journal)
    expect(first?.bound?.shellRules.prefixes).toEqual(['ls'])
    // One working folder object for every call of the run.
    expect(first?.bound?.shellCwd).toBe(scope.shellCwd)
    expect(second?.bound?.shellCwd).toBe(scope.shellCwd)
    // Not reachable through the plugin-facing context: the public fields only, no symbol, a copy carries nothing.
    const c = first!.c
    expect(Reflect.ownKeys(c).sort()).toEqual(['chatId', 'messages', 'modelRef', 'signal', 'toolCallId', 'workspace'])
    expect(Object.getOwnPropertySymbols(c)).toEqual([])
    expect(runScopeOf({ ...c })).toBeNull()
    expect(JSON.stringify({ ...c, signal: undefined })).not.toContain(MESSAGE_ID)
  })

  it('shares the working folder between the calls of a run (a change made by one call is seen by the next)', async () => {
    const { scope } = runScope()
    const folders: string[] = []
    const execute = async (_input: unknown, c: ToolCallContext) => {
      const bound = runScopeOf(c)!
      folders.push(bound.shellCwd.current)
      bound.shellCwd.current = 'packages/web'
      return 'ok'
    }
    const wrapped = wrapToolExecute(scopedTool('demo', 'demo_tool', undefined, execute), wrapContext({ workspace, scope }))
    await wrapped({}, options)
    await wrapped({}, { ...options, toolCallId: 'call_2' })
    expect(folders).toEqual(['.', 'packages/web'])
    expect(scope.shellCwd.current).toBe('packages/web')
  })

  it('binds nothing without a scope (a chat without a project); hook inputs never carry it', async () => {
    const bound: Array<WorkspaceRunScope | null> = []
    const execute = async (_input: unknown, c: ToolCallContext) => {
      bound.push(runScopeOf(c))
      return 'ok'
    }
    const hookInputs: unknown[] = []
    const run: HookRun = async (_name, ...args) => {
      hookInputs.push(args[0])
    }
    await wrapToolExecute(scopedTool('demo', 'demo_tool', undefined, execute), wrapContext())({}, options)
    await wrapToolExecute(scopedTool('demo', 'demo_tool', undefined, execute), wrapContext({ workspace, scope: null }))({}, options)
    const { scope } = runScope()
    await wrapToolExecute(scopedTool('demo', 'demo_tool', undefined, execute), wrapContext({ workspace, scope, run }))({}, options)
    expect(bound.slice(0, 2)).toEqual([null, null])
    expect(bound[2]).not.toBeNull()
    for (const input of hookInputs)
      expect(Object.keys(input as object).sort()).toEqual(expect.not.arrayContaining(['scope', 'messageId', 'journal', 'shellRules', 'shellCwd']))
  })
})

describe('wrapToolExecute: journal rows of settled calls (Phase 8)', () => {
  const workspace = toolWorkspace(OPEN_WORKSPACE)

  it('names the row of each kind of tool', () => {
    expect(settledCallRecord(scopedTool(CORE_WORKSPACE_PLUGIN_ID, 'shell', 'execute'), { command: 'ls -la' })).toEqual({ kind: 'shell', command: 'ls -la' })
    expect(settledCallRecord(scopedTool(CORE_WORKSPACE_PLUGIN_ID, 'shell', 'execute'), {})).toEqual({ kind: 'shell', command: '' })
    expect(settledCallRecord(scopedTool(CORE_WORKSPACE_PLUGIN_ID, 'write_file', 'write'), {})).toBeNull()
    expect(settledCallRecord(scopedTool(CORE_WORKSPACE_PLUGIN_ID, 'edit_file', 'write'), {})).toBeNull()
    expect(settledCallRecord(scopedTool(CORE_WORKSPACE_PLUGIN_ID, 'read_file', 'read'), {})).toBeNull()
    expect(settledCallRecord(scopedTool('linter', 'lint_fix', 'write'), {})).toEqual({ kind: 'untracked' })
    expect(settledCallRecord(scopedTool('runner', 'run_task', 'execute'), {})).toEqual({ kind: 'untracked' })
    expect(settledCallRecord(scopedTool('odd', 'odd_tool', 'admin' as ToolWorkspaceAccess), {})).toEqual({ kind: 'untracked' })
    // A third-party tool that happens to share a core name is journaled by its access, not as the core tool.
    expect(settledCallRecord(scopedTool('other', 'write_file', 'write'), {})).toEqual({ kind: 'untracked' })
    expect(settledCallRecord(scopedTool('other', 'reader', 'read'), {})).toBeNull()
    expect(settledCallRecord(scopedTool('demo', 'current_time'), {})).toBeNull()
    expect(settledCallRecord(scopedTool('core-mcp', 'mcp__srv__write'), {})).toBeNull()
  })

  it('records the core shell with the command as run, after success and after failure', async () => {
    const { fake, scope } = runScope()
    const run: HookRun = async (name, ...args) => {
      if (name === 'tool.before')
        (args[1] as { input: { command: string } }).input = { command: 'ls src' }
    }
    const ok = wrapToolExecute(scopedTool(CORE_WORKSPACE_PLUGIN_ID, 'shell', 'execute'), wrapContext({ workspace, scope, run }))
    await ok({ command: 'ls' }, options)
    const failing = wrapToolExecute(scopedTool(CORE_WORKSPACE_PLUGIN_ID, 'shell', 'execute', async () => {
      throw new Error('spawn failed')
    }), wrapContext({ workspace, scope }))
    await expect(failing({ command: 'make' }, { ...options, toolCallId: 'call_2' })).rejects.toThrow(new ToolFailure('spawn failed'))
    expect(recorded(fake.records)).toEqual([
      { kind: 'shell', toolCallId: 'call_1', command: 'ls src' },
      { kind: 'shell', toolCallId: 'call_2', command: 'make' },
    ])
    expect(fake.records[0]?.scope).toEqual({ chatId: 'chat', messageId: MESSAGE_ID, projectId: PROJECT_ID })
  })

  it('records untracked rows for other write / execute tools; nothing for the self-journaled, read, plain and MCP tools', async () => {
    const { fake, scope } = runScope()
    const context = wrapContext({ workspace, scope })
    const calls: Array<[Pick<RegisteredTool, 'pluginId' | 'definition'>, string]> = [
      [scopedTool(CORE_WORKSPACE_PLUGIN_ID, 'write_file', 'write'), 'call_write'],
      [scopedTool(CORE_WORKSPACE_PLUGIN_ID, 'edit_file', 'write'), 'call_edit'],
      [scopedTool(CORE_WORKSPACE_PLUGIN_ID, 'read_file', 'read'), 'call_read'],
      [scopedTool('linter', 'lint_fix', 'write'), 'call_lint'],
      [scopedTool('runner', 'run_task', 'execute', async () => {
        throw new Error('task failed')
      }), 'call_task'],
      [scopedTool('demo', 'current_time'), 'call_time'],
      [scopedTool('core-mcp', 'mcp__srv__write'), 'call_mcp'],
    ]
    for (const [tool, toolCallId] of calls)
      await wrapToolExecute(tool, context)({}, { ...options, toolCallId }).catch(() => {})
    expect(recorded(fake.records)).toEqual([
      { kind: 'untracked', toolCallId: 'call_lint', tool: 'lint_fix' },
      { kind: 'untracked', toolCallId: 'call_task', tool: 'run_task' },
    ])
  })

  it('records an aborted call that started, and nothing for a call that never started', async () => {
    const { fake, scope } = runScope()
    const controller = new AbortController()
    const aborted = wrapToolExecute(scopedTool(CORE_WORKSPACE_PLUGIN_ID, 'shell', 'execute', async () => {
      controller.abort(new DOMException('stopped', 'AbortError'))
      throw new DOMException('stopped', 'AbortError')
    }), wrapContext({ workspace, scope }))
    await expect(aborted({ command: 'sleep 9' }, { ...options, abortSignal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })

    const blocked = wrapToolExecute(scopedTool(CORE_WORKSPACE_PLUGIN_ID, 'shell', 'execute'), wrapContext({
      workspace,
      scope,
      run: async (name, ..._args) => {
        if (name === 'tool.before')
          throw new Error('Blocked by guardian')
      },
    }))
    await expect(blocked({ command: 'rm -rf x' }, { ...options, toolCallId: 'call_blocked' })).rejects.toThrow('Blocked by guardian')
    const invalid = wrapToolExecute(scopedTool('runner', 'run_task', 'execute'), wrapContext({ workspace, scope }))
    await expect(invalid({ command: 42 }, { ...options, toolCallId: 'call_invalid' })).rejects.toThrow('The tool input is invalid')
    const inactive = wrapToolExecute(scopedTool('runner', 'run_task', 'execute'), wrapContext({ workspace, scope, active: false }))
    await expect(inactive({}, { ...options, toolCallId: 'call_inactive' })).rejects.toThrow('Tool unavailable')
    expect(recorded(fake.records)).toEqual([{ kind: 'shell', toolCallId: 'call_1', command: 'sleep 9' }])
  })

  it('records nothing without a journal, and keeps the result when recording throws (logged)', async () => {
    const { scope } = runScope({ journal: null })
    expect(await wrapToolExecute(scopedTool(CORE_WORKSPACE_PLUGIN_ID, 'shell', 'execute', async () => 'ran'), wrapContext({ workspace, scope }))({ command: 'ls' }, options)).toBe('ran')
    const broken: CheckpointJournal = {
      scope: { chatId: 'chat', messageId: MESSAGE_ID, projectId: PROJECT_ID },
      write: async () => {
        throw new Error('unused')
      },
      recordShell: async () => {
        throw new Error('database is locked')
      },
      recordUntracked: async () => {
        throw new Error('database is locked')
      },
    }
    const memory = createMemoryLogger()
    const wrapped = wrapToolExecute(scopedTool('runner', 'run_task', 'execute', async () => ({ ok: true })), wrapContext({ workspace, scope: { ...scope, journal: broken }, logger: memory.logger }))
    expect(await wrapped({}, options)).toEqual({ ok: true })
    expect(memory.records.map(record => record.msg)).toEqual(['the tool call was not journaled'])
  })
})

describe('assembleTools: the run scope (Phase 8)', () => {
  const servers = [{ id: 'up', status: 'connected' }] as McpServer[]

  it('passes the scope only with a workspace and binds it in every tool of the run', async () => {
    const { fake, scope } = runScope()
    const bound = new Map<string, WorkspaceRunScope | null>()
    const execute = async (_input: unknown, c: ToolCallContext) => {
      bound.set(c.toolCallId, runScopeOf(c))
      return 'ok'
    }
    const tools = [...workspaceTools(execute), registered('plain_tool', { definition: definition({ name: 'plain_tool', execute }) })]
    const result = await assembleTools(assemblyInput({ tools, servers, workspace: OPEN_WORKSPACE, scope }))
    expect(result.scope).toBe(scope)
    await result.tools.shell!.execute!({ text: 'x' }, { ...options, toolCallId: 'call_shell' })
    await result.tools.read_file!.execute!({ text: 'x' }, { ...options, toolCallId: 'call_read' })
    expect(bound.get('call_shell')).toEqual({ ...scope, toolCallId: 'call_shell' })
    expect(bound.get('call_read')?.toolCallId).toBe('call_read')
    // The stand-in shell input has no command: the row keeps an empty one.
    expect(recorded(fake.records)).toEqual([{ kind: 'shell', toolCallId: 'call_shell', command: '' }])

    const without = await assembleTools(assemblyInput({ tools, servers, scope }))
    expect(without.scope).toBeNull()
    await without.tools.plain_tool!.execute!({ text: 'x' }, { ...options, toolCallId: 'call_plain' })
    expect(bound.has('call_plain')).toBe(true)
    expect(bound.get('call_plain')).toBeNull()
    expect(fake.records).toHaveLength(1)
    expect((await assembleTools(assemblyInput({ toolMode: 'off', workspace: OPEN_WORKSPACE, scope }))).scope).toBe(scope)
  })
})
