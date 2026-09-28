import type { HookMap, HookName, ToolDefinition } from '@harness-forge/plugin-sdk'
import type { McpServer } from '@harness-forge/shared'
import type { ToolExecutionOptions } from 'ai'
import type { ToolPref } from '../mcp/types.ts'
import type { RegisteredTool } from '../registry/types.ts'
import type { ToolAssemblyInput, ToolWrapContext } from './tools.ts'
import { Buffer } from 'node:buffer'
import { LIMITS } from '@harness-forge/shared'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createSilentLogger } from '../logger.ts'
import { ToolFailure } from './errors.ts'
import { assembleTools, capToolOutput, clampToolTimeout, isTruncatedToolOutput, utf8Prefix, wrapToModelOutput, wrapToolExecute } from './tools.ts'

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

function wrapContext(overrides: { active?: boolean, run?: HookRun } = {}): ToolWrapContext {
  const run: HookRun = overrides.run ?? (async () => {})
  return {
    chatId: 'chat',
    modelRef: 'mock:echo',
    registry: { hooks: { run, on: () => ({ dispose() {} }), list: () => [] } },
    plugins: { guard, isActive: () => overrides.active ?? true },
    signal: new AbortController().signal,
  }
}

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
    ...overrides,
  }
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
