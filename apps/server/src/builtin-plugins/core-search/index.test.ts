// `core-search` (W14.5-T3): `search_web` is registered only while the selected backend has a key (`setup` and every
// saved settings change), `HF_OFFLINE` does not block it, the tool works through the plugin host with the stored
// (encrypted) key, and the "Test search" route finds the module's own fetch through `coreSearchRuntime`.
import type { Disposable, PluginContext, ToolCallContext, ToolDefinition } from '@harness-forge/plugin-sdk'
import type { BuiltinPluginId } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeSearchFetch } from '../../testing/fake-search.ts'
import { SEARCH_WEB_TOOL_NAME } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeSearchFetch } from '../../testing/fake-search.ts'
import { CORE_SEARCH_PLUGIN_ID, coreSearchRuntime, createCoreSearchPlugin, manifest } from './index.ts'

const KEY = 'brave-key-canary-index-4a'
const QUERY = 'index canary query 9b'

const context: ToolCallContext = {
  chatId: '0199a8f0-0000-7000-8000-000000000001',
  modelRef: 'mock:search-tool',
  toolCallId: 'call_1',
  messages: [],
  signal: new AbortController().signal,
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0))
    await cleanup()
})

async function searchApp(env: Record<string, string> = {}): Promise<{ t: TestApp, fake: FakeSearchFetch }> {
  const fake = createFakeSearchFetch()
  const module = createCoreSearchPlugin({ safeFetch: fake.safeFetch, timeoutMs: 50 })
  const t = await createTestApp({ env, builtins: [{ id: CORE_SEARCH_PLUGIN_ID as BuiltinPluginId, manifest, module }], start: false })
  cleanups.push(() => t.close())
  await t.deps.plugins.start()
  return { t, fake }
}

async function toolNames(t: TestApp): Promise<string[]> {
  const response = await t.request('/api/tools')
  expect(response.status).toBe(200)
  return ((await response.json()) as { items: Array<{ name: string }> }).items.map(tool => tool.name)
}

describe('core-search: key-gated registration', () => {
  it('no key: no search_web; a key: registered (core-search, safe); a backend switch without a key: unregistered', async () => {
    const { t } = await searchApp()
    expect(t.deps.plugins.state(CORE_SEARCH_PLUGIN_ID)).toBe('active')
    expect(t.deps.registry.tools.get(SEARCH_WEB_TOOL_NAME)).toBeUndefined()
    expect(await toolNames(t)).not.toContain(SEARCH_WEB_TOOL_NAME)

    await t.deps.plugins.updateSettings(CORE_SEARCH_PLUGIN_ID, { braveApiKey: KEY })
    expect(t.deps.registry.tools.get(SEARCH_WEB_TOOL_NAME)).toMatchObject({ pluginId: CORE_SEARCH_PLUGIN_ID, mcpServerId: null, definition: { policy: 'safe' } })
    expect(await toolNames(t)).toContain(SEARCH_WEB_TOOL_NAME)

    await t.deps.plugins.updateSettings(CORE_SEARCH_PLUGIN_ID, { backend: 'tavily' })
    expect(t.deps.registry.tools.get(SEARCH_WEB_TOOL_NAME)).toBeUndefined()
    expect(await toolNames(t)).not.toContain(SEARCH_WEB_TOOL_NAME)

    await t.deps.plugins.updateSettings(CORE_SEARCH_PLUGIN_ID, { tavilyApiKey: 'tavily-key' })
    expect(t.deps.registry.tools.get(SEARCH_WEB_TOOL_NAME)).toBeDefined()
    await t.deps.plugins.updateSettings(CORE_SEARCH_PLUGIN_ID, { tavilyApiKey: null })
    expect(t.deps.registry.tools.get(SEARCH_WEB_TOOL_NAME)).toBeUndefined()
    // Back to Brave, whose key is still stored.
    await t.deps.plugins.updateSettings(CORE_SEARCH_PLUGIN_ID, { backend: 'brave' })
    expect(t.deps.registry.tools.get(SEARCH_WEB_TOOL_NAME)).toBeDefined()
  })

  it('searches with the stored key through the host; HF_OFFLINE does not block it; the plugin log holds no key or query', async () => {
    const { t, fake } = await searchApp({ HF_OFFLINE: '1' })
    expect(t.env.offline).toBe(true)
    await t.deps.plugins.updateSettings(CORE_SEARCH_PLUGIN_ID, { braveApiKey: KEY, maxResults: 2 })
    const registered = t.deps.registry.tools.get(SEARCH_WEB_TOOL_NAME)!
    const output = await registered.definition.execute({ query: QUERY }, context)
    expect(output).toMatchObject({ query: QUERY, backend: 'brave', results: [{ title: 'Result one' }, { title: 'Result two' }] })
    expect(fake.requests).toHaveLength(1)
    const logs = JSON.stringify(await t.deps.plugins.logs(CORE_SEARCH_PLUGIN_ID))
    expect(logs).toContain('search_web: searched')
    expect(logs).not.toContain(KEY)
    expect(logs).not.toContain(QUERY)
    expect(t.logs.text()).not.toContain(QUERY)
    // The settings view never shows the key.
    expect(JSON.stringify(await t.deps.plugins.getSettings(CORE_SEARCH_PLUGIN_ID))).not.toContain(KEY)
  })

  it('setup registers at once when a key is stored, re-checks on every change and disposes the registration', async () => {
    const events: string[] = []
    let settings: Record<string, unknown> = { backend: 'exa', exaApiKey: 'exa-key' }
    let onChange: ((values: Record<string, unknown>) => void | Promise<void>) | undefined
    const ctx = {
      settings: {
        get: () => settings,
        onChange: (callback: (values: Record<string, unknown>) => void) => {
          onChange = callback
          return { dispose() {} }
        },
      },
      tools: {
        register: (definition: ToolDefinition): Disposable => {
          events.push(`register:${definition.name}`)
          return { dispose: () => void events.push(`dispose:${definition.name}`) }
        },
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as PluginContext
    await createCoreSearchPlugin({ safeFetch: createFakeSearchFetch().safeFetch }).setup(ctx)
    expect(events).toEqual(['register:search_web'])
    settings = { backend: 'exa', exaApiKey: 'exa-key', maxResults: 3 }
    await onChange!(settings)
    expect(events).toEqual(['register:search_web'])
    await onChange!({ backend: 'brave', exaApiKey: 'exa-key' })
    await onChange!({ backend: 'brave', exaApiKey: 'exa-key' })
    expect(events).toEqual(['register:search_web', 'dispose:search_web'])
    await onChange!({ backend: 'brave', braveApiKey: 'b' })
    expect(events).toEqual(['register:search_web', 'dispose:search_web', 'register:search_web'])
  })

  it('keeps loading when another plugin took the name (a warning, no tool)', async () => {
    const warnings: unknown[] = []
    const ctx = {
      settings: { get: () => ({ braveApiKey: 'b' }), onChange: () => ({ dispose() {} }) },
      tools: {
        register: () => {
          throw new Error('Tool "search_web" is already registered.')
        },
      },
      logger: { debug() {}, info() {}, warn: (message: string) => void warnings.push(message), error() {} },
    } as unknown as PluginContext
    await createCoreSearchPlugin({ safeFetch: createFakeSearchFetch().safeFetch }).setup(ctx)
    expect(warnings).toEqual(['search_web could not be registered'])
  })

  it('coreSearchRuntime: the module\'s own fetch and timeout (null for any other module)', () => {
    const fake = createFakeSearchFetch()
    const module = createCoreSearchPlugin({ safeFetch: fake.safeFetch, timeoutMs: 1234 })
    expect(coreSearchRuntime(module)).toEqual({ safeFetch: fake.safeFetch, timeoutMs: 1234 })
    expect(coreSearchRuntime(createCoreSearchPlugin({ safeFetch: fake.safeFetch }))?.timeoutMs).toBe(10_000)
    expect(coreSearchRuntime({ setup() {} })).toBeNull()
  })
})
