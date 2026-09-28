import type { ToolDefinition } from '@harness-forge/plugin-sdk'
import type { McpManager } from './types.ts'
import { toolSummarySchema } from '@harness-forge/shared'
import { jsonSchema } from 'ai'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createTestApp } from '../testing/create-test-app.ts'
import { createRecordingEventBus } from '../testing/fakes.ts'
import { createMcpTestApp, echoStdio, waitFor } from './__fixtures__/harness.ts'

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of closers.splice(0))
    await close()
})

function tool(name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    description: `The ${name} tool.`,
    inputSchema: z.object({ text: z.string().describe('Text') }),
    execute: async () => ({ ok: true }),
    ...extra,
  } as ToolDefinition
}

async function app(options: { mcp?: McpManager } = {}) {
  const events = createRecordingEventBus()
  const t = await createTestApp({
    builtins: [],
    start: false,
    overrides: { events, ...(options.mcp ? { mcp: options.mcp } : {}) },
  })
  closers.push(() => t.close())
  return { t, events }
}

describe('tool service', () => {
  it('lists registry tools sorted by name with policies, prefs defaults and JSON schemas', async () => {
    const { t } = await app()
    t.deps.registry.tools.register('zeta', tool('zeta_tool', { policy: 'safe' }))
    t.deps.registry.tools.register('alpha', tool('alpha_tool'))
    t.deps.registry.tools.register('alpha', tool('beta_tool', { policy: () => 'always', inputSchema: jsonSchema({ type: 'object', properties: { n: { type: 'number' } } }) }))
    const items = await t.deps.tools.list()
    expect(items.map(item => item.name)).toEqual(['alpha_tool', 'beta_tool', 'zeta_tool'])
    for (const item of items)
      toolSummarySchema.parse(item)
    expect(items[0]).toMatchObject({ pluginId: 'alpha', policy: 'ask', enabled: true, override: null, available: true, mcpServerId: null, title: null })
    expect(items[0]?.inputSchema).toMatchObject({ type: 'object', properties: { text: { type: 'string', description: 'Text' } } })
    expect(items[1]).toMatchObject({ policy: null, inputSchema: { type: 'object', properties: { n: { type: 'number' } } } })
    expect(items[2]?.policy).toBe('safe')
  })

  it('stores enabled / override prefs, deletes default rows and exposes them to the chat pipeline', async () => {
    const { t } = await app()
    t.deps.registry.tools.register('alpha', tool('alpha_tool'))
    expect(await t.deps.tools.prefs()).toEqual(new Map())

    expect(await t.deps.tools.update('alpha_tool', { enabled: false })).toMatchObject({ enabled: false, override: null })
    expect(await t.deps.tools.update('alpha_tool', { override: 'deny' })).toMatchObject({ enabled: false, override: 'deny' })
    expect(await t.deps.tools.prefs()).toEqual(new Map([['alpha_tool', { enabled: false, override: 'deny' }]]))
    expect((await t.deps.tools.list())[0]).toMatchObject({ enabled: false, override: 'deny' })

    await t.deps.tools.update('alpha_tool', { enabled: true, override: 'allow' })
    expect(await t.deps.tools.prefs()).toEqual(new Map([['alpha_tool', { enabled: true, override: 'allow' }]]))
    await t.deps.tools.update('alpha_tool', { override: null })
    expect(await t.deps.tools.prefs()).toEqual(new Map())
  })

  it('answers not_found for an unknown tool', async () => {
    const { t } = await app()
    await expect(t.deps.tools.update('missing_tool', { enabled: false })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('lists the tools of a disconnected MCP server as unavailable and lets their prefs change', async () => {
    const unused = async (): Promise<never> => {
      throw new Error('unused')
    }
    const fake = {
      start: async () => {},
      stop: async () => {},
      list: async () => [],
      get: unused,
      create: unused,
      update: unused,
      remove: unused,
      reconnect: unused,
      offlineTools: () => [{
        name: 'mcp__docs__search',
        title: 'Search',
        description: 'Search the docs.',
        pluginId: 'core-mcp',
        mcpServerId: 'docs',
        policy: 'safe' as const,
        inputSchema: { type: 'object', properties: {} },
      }],
      serverStatus: () => 'error' as const,
    } as unknown as McpManager
    const { t } = await app({ mcp: fake })
    const items = await t.deps.tools.list()
    expect(items).toEqual([expect.objectContaining({ name: 'mcp__docs__search', available: false, mcpServerId: 'docs', policy: 'safe', title: 'Search' })])
    expect(await t.deps.tools.update('mcp__docs__search', { override: 'ask' })).toMatchObject({ override: 'ask', available: false })
  })

  it('marks MCP tools available only while their server is connected and announces pref changes', async () => {
    const h = await createMcpTestApp()
    closers.push(h.close)
    await h.t.deps.mcp.create({ id: 'echo', name: 'Echo', transport: echoStdio() })
    const connected = await waitFor(async () => (await h.t.deps.tools.list()).find(item => item.name === 'mcp__echo__echo'))
    expect(connected).toMatchObject({ available: true, pluginId: 'core-mcp', mcpServerId: 'echo', policy: 'safe', title: 'Echo' })
    h.events.clear()
    await h.t.deps.tools.update('mcp__echo__echo', { enabled: false })
    await waitFor(() => h.events.ofType('plugin.changed').some(event => event.data.id === 'core-mcp'))
  })
})
