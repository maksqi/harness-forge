import type { HookMap, ModelInfo, ProviderDefinition, ToolDefinition } from '@harness-forge/plugin-sdk'
import type { GuardOptions } from '../plugins/types.ts'
import type { RegistryServices } from './index.ts'
import type { RegistryChange } from './types.ts'
import { jsonSchema } from 'ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PROVIDER_DEFINITIONS } from '../builtin-plugins/core-providers/index.ts'
import { createMemoryLogger } from '../logger.ts'
import { guardCall, isGuardTimeout } from '../plugins/guard.ts'
import { createRegistryCore } from './index.ts'

interface Harness {
  registry: ReturnType<typeof createRegistryCore>
  logs: Array<{ pluginId: string, level: string, message: string }>
  inactive: Set<string>
}

function harness(options: { guardTimeoutMs?: number } = {}): Harness {
  const logs: Harness['logs'] = []
  const inactive = new Set<string>()
  const services: RegistryServices = {
    logger: createMemoryLogger().logger,
    log: (pluginId, level, message) => logs.push({ pluginId, level, message }),
    isRunnable: pluginId => !inactive.has(pluginId),
    guard: <T>(pluginId: string, fn: (signal: AbortSignal) => T | Promise<T>, guardOptions: GuardOptions) => guardCall({
      log: (id, level, message) => logs.push({ pluginId: id, level, message }),
      redactText: text => text,
      lifecycleSignal: () => undefined,
      isInactive: () => false,
    }, pluginId, fn, { ...guardOptions, timeoutMs: options.guardTimeoutMs ?? guardOptions.timeoutMs }),
  }
  return { registry: createRegistryCore(() => services), logs, inactive }
}

function unusedModel(): never {
  throw new Error('unused')
}

function provider(id: string, extra: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return { id, name: `Provider ${id}`, credentials: [], createLanguageModel: unusedModel, ...extra }
}

function tool(name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return { name, description: `Tool ${name}`, inputSchema: z.object({ value: z.string() }), execute: async () => 'ok', ...extra }
}

const MODELS: ModelInfo[] = [{ id: 'a' }, { id: 'b', name: 'B' }]

describe('providers', () => {
  it('registers every builtin provider definition', () => {
    const { registry } = harness()
    for (const definition of PROVIDER_DEFINITIONS)
      registry.providers.register('core-providers', definition)
    expect(registry.providers.list().map(entry => entry.definition.id)).toEqual(PROVIDER_DEFINITIONS.map(definition => definition.id))
  })

  it('enforces the plugin namespace, validates the definition and rejects duplicates with conflict', () => {
    const { registry } = harness()
    registry.providers.register('acme', provider('acme'))
    registry.providers.register('acme', provider('acme-eu'))
    expect(() => registry.providers.register('acme', provider('other'))).toThrow(/must be "acme" or start with "acme-"/)
    expect(() => registry.providers.register('acme', provider('acme'))).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(() => registry.providers.register('acme', provider('acme-x', { name: '' }))).toThrow(expect.objectContaining({ code: 'validation_error' }))
    expect(() => registry.providers.register('acme', { ...provider('acme-y'), createLanguageModel: undefined } as unknown as ProviderDefinition)).toThrow(/createLanguageModel/)
    expect(() => registry.providers.register('acme', provider('acme-z', { credentials: [{ key: 'k', label: 'K', type: 'text' }, { key: 'k', label: 'K', type: 'text' }] }))).toThrow(/Duplicate credential key/)
    expect(() => registry.providers.register('acme', provider('acme-w', { listModels: 'nope' as never }))).toThrow(/listModels/)
  })

  it('lists in registry order and disposes idempotently', () => {
    const { registry } = harness()
    const changes: RegistryChange[] = []
    registry.onChange(change => changes.push(change))
    const zeta = registry.providers.register('zeta', provider('zeta'))
    registry.providers.register('alpha', provider('alpha'))
    registry.providers.register('core-providers', provider('openai'))
    expect(registry.providers.list().map(entry => entry.definition.id)).toEqual(['openai', 'alpha', 'zeta'])
    zeta.dispose()
    zeta.dispose()
    expect(registry.providers.get('zeta')).toBeUndefined()
    expect(changes.filter(change => change.key === 'zeta').map(change => change.action)).toEqual(['added', 'removed'])
    // A new registration under the same id is not removed by the stale disposable.
    const again = registry.providers.register('zeta', provider('zeta'))
    zeta.dispose()
    expect(registry.providers.get('zeta')).toBeDefined()
    again.dispose()
  })
})

describe('models', () => {
  it('holds models until their provider is registered', () => {
    const { registry } = harness()
    const held = registry.models.register('acme', 'openrouter', MODELS)
    expect(registry.models.list('openrouter')).toEqual([])
    registry.providers.register('core-providers', provider('openrouter'))
    expect(registry.models.list('openrouter')).toEqual([{ pluginId: 'acme', providerId: 'openrouter', models: MODELS }])
    expect(registry.contributions('acme').models).toBe(2)
    held.dispose()
    expect(registry.models.list('openrouter')).toEqual([])
  })

  it('copies models and validates them', () => {
    const { registry } = harness()
    registry.providers.register('acme', provider('acme'))
    const models = [{ id: 'x' }]
    registry.models.register('acme', 'acme', models)
    models[0]!.id = 'mutated'
    expect(registry.models.list('acme')[0]?.models[0]?.id).toBe('x')
    expect(() => registry.models.register('acme', 'acme', [{ id: 'dup' }, { id: 'dup' }])).toThrow(/Duplicate model id/)
    expect(() => registry.models.register('acme', 'Not Valid', [])).toThrow(expect.objectContaining({ code: 'validation_error' }))
  })

  it('orders registrations of several plugins in registry order', () => {
    const { registry } = harness()
    registry.providers.register('core-providers', provider('openai'))
    registry.models.register('zeta', 'openai', [{ id: 'z' }])
    registry.models.register('alpha', 'openai', [{ id: 'a' }])
    registry.models.register('core-tools', 'openai', [{ id: 'c' }])
    expect(registry.models.list('openai').map(entry => entry.pluginId)).toEqual(['core-tools', 'alpha', 'zeta'])
  })
})

describe('tools', () => {
  it('validates name, description, schema, policy and timeout', () => {
    const { registry } = harness()
    expect(() => registry.tools.register('p', tool('bad name'))).toThrow(/Invalid tool name/)
    expect(() => registry.tools.register('p', tool('mcp__x__y'))).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(() => registry.tools.register('p', tool('t1', { description: '' }))).toThrow(/description/)
    expect(() => registry.tools.register('p', tool('t2', { description: 'x'.repeat(1025) }))).toThrow(/description/)
    expect(() => registry.tools.register('p', tool('t3', { inputSchema: z.string() }))).toThrow(/JSON object/)
    expect(() => registry.tools.register('p', tool('t4', { inputSchema: { type: 'object' } as never }))).toThrow(/ctx\.ai\.jsonSchema/)
    expect(() => registry.tools.register('p', tool('t5', { policy: 'never' as never }))).toThrow(/policy/)
    expect(() => registry.tools.register('p', tool('t6', { timeoutMs: 600_001 }))).toThrow(/timeoutMs/)
    expect(() => registry.tools.register('p', tool('t7', { execute: undefined as never }))).toThrow(/execute/)
    registry.tools.register('p', tool('json_tool', { inputSchema: jsonSchema({ type: 'object', properties: {} }), policy: () => 'safe', timeoutMs: 5000 }))
    expect(registry.tools.get('json_tool')).toMatchObject({ pluginId: 'p', mcpServerId: null, title: null })
  })

  it('reserves mcp__ names for MCP tools and accepts them with a server id', () => {
    const { registry } = harness()
    registry.tools.register('acme', tool('mcp__acme__search', { description: '' }), { mcpServerId: 'acme', title: 'Search' })
    expect(registry.tools.get('mcp__acme__search')).toMatchObject({ mcpServerId: 'acme', title: 'Search' })
    expect(() => registry.tools.register('acme', tool('plain'), { mcpServerId: 'acme' })).toThrow(/start with "mcp__"/)
  })

  it('rejects duplicates across plugins and sorts by name', () => {
    const { registry } = harness()
    registry.tools.register('b', tool('zeta'))
    registry.tools.register('a', tool('alpha'))
    expect(() => registry.tools.register('c', tool('alpha'))).toThrow(expect.objectContaining({ code: 'conflict', message: expect.stringContaining('"a"') }))
    expect(registry.tools.list().map(entry => entry.definition.name)).toEqual(['alpha', 'zeta'])
  })
})

describe('commands', () => {
  it('needs exactly one of template and run, rejects client commands and duplicates', () => {
    const { registry } = harness()
    registry.commands.register('p', { name: 'tldr', description: 'Summary', template: 'Summarize {{input}}' })
    registry.commands.register('p', { name: 'roll', description: 'Roll', run: async () => ({ type: 'reply', markdown: '4' }) })
    expect(() => registry.commands.register('p', { name: 'both', description: 'x', template: 'x', run: async () => ({ type: 'prompt', text: 'x' }) })).toThrow(/exactly one/)
    expect(() => registry.commands.register('p', { name: 'none', description: 'x' })).toThrow(/exactly one/)
    expect(() => registry.commands.register('p', { name: 'model', description: 'x', template: 'x' })).toThrow(/reserved/)
    expect(() => registry.commands.register('p', { name: 'Bad', description: 'x', template: 'x' })).toThrow(/Invalid command name/)
    expect(() => registry.commands.register('q', { name: 'tldr', description: 'x', template: 'x' })).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(() => registry.commands.register('p', { name: 'long', description: 'x'.repeat(121), template: 'x' })).toThrow(/description/)
    expect(registry.commands.list().map(entry => entry.definition.name)).toEqual(['roll', 'tldr'])
  })
})

describe('mcp servers', () => {
  it('validates declarations, the namespace and duplicates', () => {
    const { registry } = harness()
    registry.mcpServers.register('acme', { id: 'acme-docs', name: 'Docs', transport: { type: 'http', url: 'https://mcp.example.com' } })
    registry.mcpServers.register('core-mcp', { id: 'everything', name: 'Everything', transport: { type: 'stdio', command: 'npx' } })
    expect(() => registry.mcpServers.register('acme', { id: 'other', name: 'x', transport: { type: 'http', url: 'https://x.example.com' } })).toThrow(/must be "acme"/)
    expect(() => registry.mcpServers.register('acme', { id: 'acme', name: 'x', transport: { type: 'http', url: 'not a url' } })).toThrow(expect.objectContaining({ code: 'validation_error' }))
    expect(() => registry.mcpServers.register('everything', { id: 'everything', name: 'x', transport: { type: 'http', url: 'https://x.example.com' } })).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(registry.mcpServers.list().map(entry => entry.decl.id)).toEqual(['everything', 'acme-docs'])
  })
})

describe('hooks', () => {
  const context = { chatId: 'c1', modelRef: 'mock:echo' }

  it('calls handlers by priority, then plugin load order, then registration order', async () => {
    const { registry } = harness()
    const calls: string[] = []
    const on = (pluginId: string, label: string, priority?: number): void => {
      registry.hooks.on(pluginId, 'chat.headers', () => void calls.push(label), priority === undefined ? undefined : { priority })
    }
    on('zeta', 'zeta-1')
    on('alpha', 'alpha-1')
    on('alpha', 'alpha-2')
    on('core-tools', 'core')
    on('zeta', 'zeta-high', 10)
    on('alpha', 'alpha-low', -1)
    expect(registry.hooks.list('chat.headers').map(entry => entry.priority)).toEqual([10, 0, 0, 0, 0, -1])
    await registry.hooks.run('chat.headers', context, { headers: {} })
    expect(calls).toEqual(['zeta-high', 'core', 'alpha-1', 'alpha-2', 'zeta-1', 'alpha-low'])
  })

  it('freezes the input and commits the output copy only on success', async () => {
    const { registry, logs } = harness()
    registry.hooks.on('a', 'chat.headers', (input, output) => {
      expect(Object.isFrozen(input)).toBe(true)
      output.headers['x-a'] = '1'
    })
    registry.hooks.on('b', 'chat.headers', (_input, output) => {
      output.headers['x-b'] = '2'
      throw new Error('b failed')
    })
    registry.hooks.on('c', 'chat.headers', (_input, output) => {
      output.headers['x-c'] = output.headers['x-b'] ?? 'no b'
    })
    const output: HookMap['chat.headers'][1] = { headers: { base: '0' } }
    await registry.hooks.run('chat.headers', context, output)
    expect(output.headers).toEqual({ 'base': '0', 'x-a': '1', 'x-c': 'no b' })
    expect(logs.some(entry => entry.pluginId === 'b' && entry.message.includes('b failed'))).toBe(true)
  })

  it('deep-freezes a copy of the input so handlers cannot change shared objects', async () => {
    const { registry } = harness()
    const model = { id: 'm', capabilities: { tools: true } }
    const failures: unknown[] = []
    registry.hooks.on('p', 'chat.params', (input) => {
      try {
        (input.model.capabilities as { tools?: boolean }).tools = false
      }
      catch (error) {
        failures.push(error)
      }
    })
    await registry.hooks.run('chat.params', { ...context, model, reasoningEffort: 'auto', toolMode: 'ask' }, { instructions: '', maxSteps: 1, providerOptions: {} })
    expect(model.capabilities.tools).toBe(true)
    expect(failures).toHaveLength(1)
  })

  it('disables a handler after 5 consecutive failures until it is registered again', async () => {
    const { registry, logs } = harness()
    let calls = 0
    registry.hooks.on('flaky', 'chat.messages', () => {
      calls += 1
      throw new Error('nope')
    })
    for (let i = 0; i < 7; i++)
      await registry.hooks.run('chat.messages', context, { messages: [] })
    expect(calls).toBe(5)
    expect(logs.filter(entry => entry.level === 'warn').map(entry => entry.message)).toEqual([expect.stringContaining('disabled after 5 consecutive failures')])
  })

  it('resets the failure count after a success', async () => {
    const { registry } = harness()
    let calls = 0
    registry.hooks.on('flaky', 'tool.approve', () => {
      calls += 1
      if (calls % 4 !== 0)
        throw new Error('nope')
    })
    for (let i = 0; i < 12; i++)
      await registry.hooks.run('tool.approve', { ...context, tool: 't', toolCallId: '1', input: {} }, {})
    expect(calls).toBe(12)
  })

  it('tool.before: a throw blocks the call without counting, a timeout blocks and counts', async () => {
    const { registry } = harness({ guardTimeoutMs: 20 })
    const input = { ...context, tool: 'roll_dice', toolCallId: 'call-1' }
    const blocker = registry.hooks.on('guard-plugin', 'tool.before', () => {
      throw new Error('not allowed')
    })
    for (let i = 0; i < 6; i++)
      await expect(registry.hooks.run('tool.before', input, { input: {} })).rejects.toMatchObject({ code: 'plugin_error', message: 'Blocked by guard-plugin: not allowed' })
    blocker.dispose()

    registry.hooks.on('slow-plugin', 'tool.before', () => new Promise(() => {}))
    let blocked = 0
    for (let i = 0; i < 6; i++) {
      try {
        await registry.hooks.run('tool.before', input, { input: {} })
      }
      catch (error) {
        expect(error).toMatchObject({ message: expect.stringMatching(/^Blocked by slow-plugin: Timed out/) })
        blocked += 1
      }
    }
    // 5 timeouts disable the handler; the 6th call passes.
    expect(blocked).toBe(5)
  })

  it('lets tool.before change the input and skips handlers of inactive plugins', async () => {
    const { registry, inactive } = harness()
    registry.hooks.on('rewriter', 'tool.before', (_input, output) => {
      output.input = { notation: '1d6' }
    })
    registry.hooks.on('sleeper', 'tool.before', () => {
      throw new Error('should not run')
    })
    inactive.add('sleeper')
    const output = { input: { notation: 'bad' } as unknown }
    await registry.hooks.run('tool.before', { ...context, tool: 'roll_dice', toolCallId: 'c' }, output)
    expect(output.input).toEqual({ notation: '1d6' })
  })

  it('runs message.completed without an output and validates registrations', async () => {
    const { registry } = harness()
    const seen: unknown[] = []
    registry.hooks.on('p', 'message.completed', (input, output) => void seen.push(input.aborted, output))
    await registry.hooks.run('message.completed', { ...context, message: { id: 'm', role: 'assistant', parts: [] }, usage: {} as never, aborted: false }, undefined)
    expect(seen).toEqual([false, undefined])
    expect(() => registry.hooks.on('p', 'chat.unknown' as never, () => {})).toThrow(/Unknown hook/)
    expect(() => registry.hooks.on('p', 'chat.params', 'x' as never)).toThrow(/function/)
    expect(() => registry.hooks.on('p', 'chat.params', () => {}, { priority: Number.NaN })).toThrow(/priority/)
  })

  it('treats guard timeouts as timeouts', async () => {
    const error = await guardCall({ log: () => {}, redactText: text => text, lifecycleSignal: () => undefined, isInactive: () => false }, 'p', () => new Promise(() => {}), { timeoutMs: 5, phase: 'hook' }).catch(caught => caught)
    expect(isGuardTimeout(error)).toBe(true)
  })
})

describe('contributions, change notifications and owner removal', () => {
  it('reports the contributions of a plugin and removes every registration of an owner', () => {
    const { registry } = harness()
    const changes: string[] = []
    registry.onChange(change => changes.push(`${change.kind}:${change.action}:${change.key}`))
    registry.providers.register('acme', provider('acme'))
    registry.models.register('acme', 'acme', MODELS)
    registry.tools.register('acme', tool('acme_search'))
    registry.commands.register('acme', { name: 'acme', description: 'Acme', template: '{{input}}' })
    registry.hooks.on('acme', 'chat.params', () => {})
    registry.hooks.on('acme', 'tool.after', () => {})
    registry.mcpServers.register('acme', { id: 'acme', name: 'Acme', transport: { type: 'sse', url: 'https://acme.example.com/sse' } })
    registry.tools.register('other', tool('other_tool'))
    expect(registry.contributions('acme')).toEqual({
      providers: ['acme'],
      models: 2,
      tools: ['acme_search'],
      mcpServers: ['acme'],
      commands: ['acme'],
      hooks: ['chat.params', 'tool.after'],
      agents: [],
      skills: [],
    })
    expect(registry.removeOwner('acme')).toBe(7)
    expect(registry.contributions('acme')).toEqual({ providers: [], models: 0, tools: [], mcpServers: [], commands: [], hooks: [], agents: [], skills: [] })
    expect(registry.tools.get('other_tool')).toBeDefined()
    expect(changes.filter(change => change.includes(':removed:'))).toHaveLength(7)
  })

  it('keeps notifying when a listener throws and stops after dispose', () => {
    const { registry } = harness()
    const seen: string[] = []
    registry.onChange(() => {
      throw new Error('listener failed')
    })
    const subscription = registry.onChange(change => seen.push(change.key))
    registry.tools.register('p', tool('first'))
    subscription.dispose()
    registry.tools.register('p', tool('second'))
    expect(seen).toEqual(['first'])
  })
})
