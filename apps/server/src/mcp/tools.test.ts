import type { ToolDefinition } from '@harness-forge/plugin-sdk'
import type { McpManager } from './types.ts'
import process from 'node:process'
import { HarnessError, toolSummarySchema, WORKSPACE_TOOL_ACCESS } from '@harness-forge/shared'
import { jsonSchema } from 'ai'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { toolPrefs } from '../db/schema.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { createRecordingEventBus } from '../testing/fakes.ts'
import { createMcpTestApp, echoStdio, waitFor } from './__fixtures__/harness.ts'
import { EXECUTE_ALLOW_REFUSED_MESSAGE } from './tools.ts'

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

  it('reports the workspace access of a definition (plugin API 1.2.0), null without one and for MCP tools', async () => {
    const { t } = await app()
    t.deps.registry.tools.register('alpha', tool('read_tool', { workspace: 'read' }))
    t.deps.registry.tools.register('alpha', tool('write_tool', { workspace: 'write' }))
    t.deps.registry.tools.register('alpha', tool('exec_tool', { workspace: 'execute' }))
    t.deps.registry.tools.register('alpha', tool('plain_tool'))
    // An MCP definition never carries workspace access into the list, even if one were set.
    t.deps.registry.tools.register('core-mcp', tool('mcp__docs__read', { workspace: 'read' }), { mcpServerId: 'docs' })
    const items = await t.deps.tools.list()
    for (const item of items)
      toolSummarySchema.parse(item)
    expect(Object.fromEntries(items.map(item => [item.name, item.workspace]))).toEqual({
      exec_tool: 'execute',
      mcp__docs__read: null,
      plain_tool: null,
      read_tool: 'read',
      write_tool: 'write',
    })
    // `PATCH /tools/:name` answers the same summary, workspace included.
    expect(await t.deps.tools.update('write_tool', { override: 'allow' })).toMatchObject({ workspace: 'write', override: 'allow' })
  })

  it('lists the 7 core-workspace tools with their access through GET /tools', async () => {
    const t = await createTestApp()
    closers.push(() => t.close())
    const res = await t.request('/api/tools')
    expect(res.status).toBe(200)
    const body = await res.json() as { items: unknown[] }
    const items = body.items.map(item => toolSummarySchema.parse(item))
    const workspace = items.filter(item => item.pluginId === 'core-workspace')
    const expected = process.platform === 'win32'
      ? Object.entries(WORKSPACE_TOOL_ACCESS).filter(([name]) => name !== 'shell')
      : Object.entries(WORKSPACE_TOOL_ACCESS)
    expect(Object.fromEntries(workspace.map(item => [item.name, item.workspace]))).toEqual(Object.fromEntries(expected))
    if (process.platform !== 'win32')
      expect(workspace).toHaveLength(7)
    // Tools of other builtins use no workspace.
    expect(items.filter(item => item.pluginId === 'core-tools').map(item => item.workspace)).toEqual([null, null, null])
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

  it('refuses override allow on a tool with workspace access execute (ADR-038); other overrides and tools unchanged', async () => {
    const { t, events } = await app()
    t.deps.registry.tools.register('alpha', tool('exec_tool', { workspace: 'execute' }))
    t.deps.registry.tools.register('alpha', tool('write_tool', { workspace: 'write' }))
    t.deps.registry.tools.register('alpha', tool('plain_tool'))
    events.clear()
    for (const patch of [{ override: 'allow' as const }, { enabled: false, override: 'allow' as const }]) {
      const error = await t.deps.tools.update('exec_tool', patch).then(() => null, (reason: unknown) => reason)
      expect(error).toBeInstanceOf(HarnessError)
      expect(error).toMatchObject({
        code: 'validation_error',
        message: EXECUTE_ALLOW_REFUSED_MESSAGE,
        details: { issues: [{ path: ['override'], message: EXECUTE_ALLOW_REFUSED_MESSAGE }] },
      })
    }
    // Nothing was stored or announced by the refused patches.
    expect(await t.deps.tools.prefs()).toEqual(new Map())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(events.ofType('plugin.changed')).toEqual([])

    expect(await t.deps.tools.update('exec_tool', { override: 'deny' })).toMatchObject({ workspace: 'execute', override: 'deny' })
    expect(await t.deps.tools.update('exec_tool', { override: 'ask' })).toMatchObject({ override: 'ask' })
    expect(await t.deps.tools.update('exec_tool', { override: null, enabled: false })).toMatchObject({ override: null, enabled: false })
    expect(await t.deps.tools.update('exec_tool', { enabled: true })).toMatchObject({ override: null, enabled: true })
    expect(await t.deps.tools.update('write_tool', { override: 'allow' })).toMatchObject({ override: 'allow' })
    expect(await t.deps.tools.update('plain_tool', { override: 'allow' })).toMatchObject({ override: 'allow' })
    expect(await t.deps.tools.prefs()).toEqual(new Map([
      ['write_tool', { enabled: true, override: 'allow' }],
      ['plain_tool', { enabled: true, override: 'allow' }],
    ]))
  })

  it('lists an allow override stored before v1.4 on an execute tool as null, and a patch clears it (Phase 9)', async () => {
    const { t } = await app()
    t.deps.registry.tools.register('alpha', tool('exec_tool', { workspace: 'execute' }))
    await t.db.insert(toolPrefs).values({ toolName: 'exec_tool', enabled: true, override: 'allow', updatedAt: 1 })
    // The approval ignores it (W8.5), so the list shows the effective override; the raw prefs keep the row.
    expect((await t.deps.tools.list()).find(item => item.name === 'exec_tool')).toMatchObject({ enabled: true, override: null })
    expect(await t.deps.tools.prefs()).toEqual(new Map([['exec_tool', { enabled: true, override: 'allow' }]]))
    // A patch that leaves the override alone stores the effective one.
    expect(await t.deps.tools.update('exec_tool', { enabled: false })).toMatchObject({ enabled: false, override: null })
    expect(await t.deps.tools.prefs()).toEqual(new Map([['exec_tool', { enabled: false, override: null }]]))
    expect(await t.deps.tools.update('exec_tool', { override: null, enabled: true })).toMatchObject({ enabled: true, override: null })
    expect(await t.deps.tools.prefs()).toEqual(new Map())
  })

  it.skipIf(process.platform === 'win32')('refuses override allow on the core shell tool', async () => {
    const t = await createTestApp()
    closers.push(() => t.close())
    await expect(t.deps.tools.update('shell', { override: 'allow' })).rejects.toMatchObject({ code: 'validation_error' })
    expect(await t.deps.tools.update('shell', { override: 'deny' })).toMatchObject({ name: 'shell', workspace: 'execute', override: 'deny' })
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
