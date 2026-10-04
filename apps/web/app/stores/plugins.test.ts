import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logEntry, pluginDetail, pluginSummary, toolSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { parsePluginFilter, PLUGIN_LOG_LIMIT, usePluginsStore } from './plugins'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
  vi.useRealTimers()
})

const core = pluginSummary({
  id: 'core-providers',
  name: 'Core providers',
  kind: 'declarative',
  source: 'builtin',
  builtin: true,
  removable: false,
  runsCode: false,
  description: 'Built-in LLM providers',
  contributions: { providers: ['anthropic', 'openai'], models: 20, tools: [], mcpServers: [], commands: [], hooks: [], agents: [], skills: [] },
})
const dice = pluginSummary()
const mcpPlugin = pluginSummary({
  id: 'mcp-everything',
  name: 'MCP everything',
  description: 'Reference MCP server',
  enabled: false,
  state: 'disabled',
  contributions: { providers: [], models: 0, tools: [], mcpServers: ['everything'], commands: ['echo'], hooks: [], agents: [], skills: [] },
})

async function loadPlugins() {
  api.plugins.list.mockResolvedValue({ items: [core, dice, mcpPlugin] })
  const plugins = usePluginsStore()
  await plugins.fetchAll()
  return plugins
}

describe('plugins store: list', () => {
  it('counts plugins per browse filter', async () => {
    const plugins = await loadPlugins()
    expect(plugins.counts).toEqual({ all: 3, providers: 1, tools: 1, mcp: 1, commands: 1, disabled: 1 })
    expect(plugins.byId('dice-roller')?.name).toBe('Dice roller')
  })

  it('filters by the ?filter= value and a search query', async () => {
    const plugins = await loadPlugins()
    expect(plugins.filtered('providers').map(plugin => plugin.id)).toEqual(['core-providers'])
    expect(plugins.filtered('disabled').map(plugin => plugin.id)).toEqual(['mcp-everything'])
    expect(plugins.filtered('all', 'LLM').map(plugin => plugin.id)).toEqual(['core-providers'])
    expect(plugins.filtered('all', 'dice').map(plugin => plugin.id)).toEqual(['dice-roller'])
    expect(plugins.filtered().length).toBe(3)
    expect(parsePluginFilter('tools')).toBe('tools')
    expect(parsePluginFilter(['mcp', 'tools'])).toBe('mcp')
    expect(parsePluginFilter('kind')).toBe('all')
    expect(parsePluginFilter(undefined)).toBe('all')
  })

  it('enables optimistically and rolls back on failure', async () => {
    const plugins = await loadPlugins()
    api.plugins.enable.mockRejectedValue(new HarnessError({ code: 'internal_error', message: 'Boom' }))
    const pending = plugins.enable('mcp-everything')
    expect(plugins.byId('mcp-everything')?.enabled).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'internal_error' })
    expect(plugins.byId('mcp-everything')?.enabled).toBe(false)
  })

  it('keeps details and rows in sync after lifecycle actions', async () => {
    const plugins = await loadPlugins()
    api.plugins.disable.mockResolvedValue(pluginDetail({ enabled: false, state: 'disabled' }))
    const detail = await plugins.disable('dice-roller')
    expect(detail.state).toBe('disabled')
    expect(plugins.details['dice-roller']?.state).toBe('disabled')
    expect(plugins.byId('dice-roller')?.state).toBe('disabled')
    expect(plugins.byId('dice-roller')).not.toHaveProperty('manifest')
  })

  it('uninstalls with keepData and forgets the plugin', async () => {
    const plugins = await loadPlugins()
    api.plugins.remove.mockResolvedValue(undefined)
    await plugins.uninstall('dice-roller', { keepData: true })
    expect(api.plugins.remove).toHaveBeenCalledWith({ params: { id: 'dice-roller' }, query: { keepData: true } })
    expect(plugins.byId('dice-roller')).toBeUndefined()
  })

  it('trusts the current hash of the plugin (fetching the detail when needed)', async () => {
    const plugins = await loadPlugins()
    api.plugins.get.mockResolvedValue(pluginDetail({ state: 'untrusted' }))
    api.pluginInstall.trust.mockResolvedValue(pluginDetail({ state: 'active' }))
    await plugins.trust('dice-roller')
    expect(api.pluginInstall.trust).toHaveBeenCalledWith({ params: { id: 'dice-roller' }, body: { sha256: 'a'.repeat(64) } })
    expect(plugins.details['dice-roller']?.state).toBe('active')
    api.plugins.get.mockResolvedValue(pluginDetail({ id: 'core-providers', trust: { required: false, trusted: true, hash: null, trustedHash: null } }))
    await expect(plugins.trust('core-providers')).rejects.toMatchObject({ code: 'validation_error' })
  })
})

describe('plugins store: tools, MCP, commands, logs', () => {
  it('sets tool preferences optimistically', async () => {
    api.tools.list.mockResolvedValue({ items: [toolSummary()] })
    api.tools.update.mockRejectedValue(new HarnessError({ code: 'not_found', message: 'Unknown tool' }))
    const plugins = usePluginsStore()
    await plugins.fetchTools()
    expect(plugins.toolsLoaded).toBe(true)
    expect(plugins.hasTools).toBe(true)
    const pending = plugins.setToolPref('roll_dice', { override: 'deny' })
    expect(plugins.tools[0]?.override).toBe('deny')
    await expect(pending).rejects.toMatchObject({ code: 'not_found' })
    expect(plugins.tools[0]?.override).toBeNull()
  })

  it('has no tools when every tool is disabled or unavailable', async () => {
    api.tools.list.mockResolvedValue({ items: [toolSummary({ enabled: false }), toolSummary({ name: 'x', available: false })] })
    const plugins = usePluginsStore()
    await plugins.fetchTools()
    expect(plugins.hasTools).toBe(false)
  })

  it('creates or updates MCP servers through saveMcp()', async () => {
    const server = {
      id: 'everything',
      name: 'Everything',
      pluginId: 'core-mcp',
      editable: true,
      transport: { type: 'stdio' as const, command: 'npx', args: [], env: {} },
      policy: 'ask' as const,
      enabled: true,
      status: 'connecting' as const,
      error: null,
      tools: [],
      connectedAt: null,
    }
    api.mcp.create.mockResolvedValue(server)
    api.mcp.update.mockResolvedValue({ ...server, name: 'Renamed' })
    api.mcp.reconnect.mockResolvedValue({ ...server, name: 'Renamed', status: 'connected' })
    api.mcp.remove.mockResolvedValue(undefined)
    const plugins = usePluginsStore()
    await plugins.saveMcp({ id: 'everything', name: 'Everything', transport: { type: 'stdio', command: 'npx' } })
    expect(api.mcp.create).toHaveBeenCalledWith({ body: { id: 'everything', name: 'Everything', transport: { type: 'stdio', command: 'npx' } } })
    await plugins.saveMcp({ id: 'everything', patch: { name: 'Renamed' } })
    expect(api.mcp.update).toHaveBeenCalledWith({ params: { id: 'everything' }, body: { name: 'Renamed' } })
    await plugins.reconnectMcp('everything')
    expect(plugins.mcp).toEqual([{ ...server, name: 'Renamed', status: 'connected' }])
    await plugins.removeMcp('everything')
    expect(plugins.mcp).toEqual([])
  })

  it('loads logs, appends live entries once and keeps the newest 500', async () => {
    const plugins = usePluginsStore()
    plugins.applyEvent({ type: 'plugin.log', data: { pluginId: 'dice-roller', entry: logEntry(1) }, at: 1 })
    expect(plugins.logs['dice-roller']).toBeUndefined()

    api.plugins.logs.mockResolvedValue({ items: [logEntry(1), logEntry(2)] })
    await plugins.fetchLogs('dice-roller')
    expect(api.plugins.logs).toHaveBeenCalledWith({ params: { id: 'dice-roller' }, query: { limit: PLUGIN_LOG_LIMIT } })
    plugins.applyEvent({ type: 'plugin.log', data: { pluginId: 'dice-roller', entry: logEntry(2) }, at: 2 })
    plugins.applyEvent({ type: 'plugin.log', data: { pluginId: 'dice-roller', entry: logEntry(3) }, at: 3 })
    expect(plugins.logs['dice-roller']?.map(entry => entry.seq)).toEqual([1, 2, 3])

    for (let seq = 4; seq <= 600; seq++)
      plugins.applyEvent({ type: 'plugin.log', data: { pluginId: 'dice-roller', entry: logEntry(seq) }, at: seq })
    expect(plugins.logs['dice-roller']).toHaveLength(PLUGIN_LOG_LIMIT)
    expect(plugins.logs['dice-roller']?.at(-1)?.seq).toBe(600)
  })

  it('keeps live entries that arrive while the logs load', async () => {
    let finish: (value: unknown) => void = () => {}
    api.plugins.logs.mockReturnValue(new Promise((resolve) => {
      finish = resolve
    }))
    const plugins = usePluginsStore()
    const pending = plugins.fetchLogs('dice-roller')
    plugins.applyEvent({ type: 'plugin.log', data: { pluginId: 'dice-roller', entry: logEntry(3) }, at: 3 })
    finish({ items: [logEntry(1), logEntry(2)] })
    await pending
    expect(plugins.logs['dice-roller']?.map(entry => entry.seq)).toEqual([1, 2, 3])
  })
})

describe('plugins store: events', () => {
  it('patches rows, drops uninstalled plugins and refetches what is loaded', async () => {
    vi.useFakeTimers()
    const plugins = await loadPlugins()
    api.plugins.get.mockResolvedValue(pluginDetail())
    await plugins.fetchOne('dice-roller')
    api.tools.list.mockResolvedValue({ items: [] })
    api.commands.list.mockResolvedValue({ items: [] })
    await plugins.fetchTools()
    await plugins.fetchCommands()

    plugins.applyEvent({ type: 'plugin.changed', data: { id: 'dice-roller', plugin: { ...dice, state: 'error' } }, at: 1 })
    expect(plugins.byId('dice-roller')?.state).toBe('error')
    expect(plugins.details['dice-roller']?.state).toBe('error')
    plugins.applyEvent({ type: 'plugin.changed', data: { id: 'mcp-everything', plugin: null }, at: 2 })
    expect(plugins.byId('mcp-everything')).toBeUndefined()

    await vi.advanceTimersByTimeAsync(500)
    expect(api.plugins.get).toHaveBeenCalledTimes(2)
    expect(api.tools.list).toHaveBeenCalledTimes(2)
    expect(api.commands.list).toHaveBeenCalledTimes(2)
    expect(api.mcp.list).not.toHaveBeenCalled()
  })

  it('refetches everything loaded after a reconnect', async () => {
    const plugins = await loadPlugins()
    api.mcp.list.mockResolvedValue({ items: [] })
    await plugins.fetchMcp()
    await plugins.refreshLoaded()
    expect(api.plugins.list).toHaveBeenCalledTimes(2)
    expect(api.mcp.list).toHaveBeenCalledTimes(2)
    expect(api.tools.list).not.toHaveBeenCalled()
  })
})
