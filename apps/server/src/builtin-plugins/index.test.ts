import type { PluginContext, ToolDefinition } from '@harness-forge/plugin-sdk'
import { PLUGIN_API_VERSION } from '@harness-forge/plugin-sdk'
import {
  AGENT_TOOL_NAMES,
  BUILTIN_OUTPUT_STYLE_NAMES,
  BUILTIN_PLUGIN_IDS,
  isReservedPluginId,
  pluginManifestBaseSchema,
  pluginSettingsViewSchema,
  SEARCH_WEB_TOOL_NAME,
  settingsSchemaSchema,
  WEB_SEARCH_BACKENDS,
  WORKSPACE_TOOL_NAMES,
} from '@harness-forge/shared'
import semver from 'semver'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../testing/create-test-app.ts'
import { BUILTIN_STYLE_DEFINITIONS } from './core-agent/styles.ts'
import { CORE_SEARCH_PLUGIN_ID, manifest as coreSearchManifest, createCoreSearchPlugin, DEFAULT_SEARCH_BACKEND, DEFAULT_SEARCH_MAX_RESULTS, SEARCH_KEY_SETTINGS } from './core-search/index.ts'
import { BUILTIN_PLUGINS, coreSearchBuiltin, getBuiltinPlugins } from './index.ts'
import { MOCK_MODEL_IDS, mockModels } from './mock/index.ts'

/**
 * The builtins in load order (Phase 14: `core-search` right after `core-tools`). CCR C50-1: `BUILTIN_PLUGIN_IDS` of
 * `@harness-forge/shared` (frozen) gains `core-search` at the gate; until then it is this list without it.
 */
const LOAD_ORDER = ['core-providers', 'core-tools', 'core-search', 'core-commands', 'core-mcp', 'core-workspace', 'core-agent', 'mock'] as const

/** True for the id of `core-search` (a plain string compare: `BuiltinPluginId` lacks it until CCR C50-1 lands). */
function isSearch(id: string): boolean {
  return id === CORE_SEARCH_PLUGIN_ID
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0))
    await cleanup()
})

/** Output styles registered through `ctx.outputStyles` by any builtin (there must be none). */
const registeredStyles: string[] = []

/** The tool names every builtin registers in `setup`, through a context that records them (no other side effects). */
async function registeredTools(): Promise<Record<string, string[]>> {
  const byPlugin: Record<string, string[]> = {}
  registeredStyles.length = 0
  for (const plugin of BUILTIN_PLUGINS) {
    const tools: string[] = []
    const ignore = { register: () => ({ dispose() {} }) }
    const ctx = {
      outputStyles: { register: (definition: { name: string }) => {
        registeredStyles.push(definition.name)
        return { dispose() {} }
      } },
      tools: { register: (definition: ToolDefinition) => {
        tools.push(definition.name)
        return { dispose() {} }
      } },
      providers: ignore,
      commands: ignore,
      settings: { get: () => ({}) },
      images: { generate: async () => ({ images: [] }) },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as PluginContext
    await plugin.module.setup(ctx)
    byPlugin[plugin.id] = tools
  }
  return byPlugin
}

describe('builtin plugins', () => {
  it('lists every builtin id in load order (core-search after core-tools; core-workspace, then core-agent, then mock)', () => {
    expect(BUILTIN_PLUGINS.map(plugin => plugin.id)).toEqual([...LOAD_ORDER])
    // CCR C50-1: the shared list is the load order without core-search until the coordinator adds it (after core-tools).
    const shared: readonly string[] = BUILTIN_PLUGIN_IDS
    expect(shared).toEqual(shared.includes(CORE_SEARCH_PLUGIN_ID) ? [...LOAD_ORDER] : LOAD_ORDER.filter(id => !isSearch(id)))
  })

  it('counts eight builtin plugins with mock, seven without it', () => {
    expect(BUILTIN_PLUGINS).toHaveLength(8)
    expect(getBuiltinPlugins({ mockProvider: true })).toHaveLength(8)
    expect(getBuiltinPlugins({ mockProvider: false })).toHaveLength(7)
  })

  it('includes mock only with HF_MOCK_PROVIDER=1', () => {
    expect(getBuiltinPlugins({ mockProvider: false }).map(plugin => plugin.id)).toEqual(LOAD_ORDER.filter(id => id !== 'mock'))
    expect(getBuiltinPlugins({ mockProvider: true }).map(plugin => plugin.id)).toEqual([...LOAD_ORDER])
  })

  it('registers 15 builtin tools (14 on Windows, without shell): core-tools 3, core-workspace 7, core-agent 4 (with skill), mock 1; core-search none yet', async () => {
    const tools = await registeredTools()
    const shell = process.platform !== 'win32'
    expect(tools).toEqual({
      'core-providers': [],
      'core-tools': ['current_time', 'web_fetch', 'generate_image'],
      // Phase 14 (C50): the stub registers no tool; W14.5 registers search_web while the selected backend has a key.
      'core-search': [],
      'core-commands': [],
      'core-mcp': [],
      'core-workspace': WORKSPACE_TOOL_NAMES.filter(name => shell || name !== 'shell'),
      'core-agent': ['todo_write', 'exit_plan_mode', 'task', 'skill'],
      'mock': ['mock_approval_tool'],
    })
    expect(tools['core-agent']).toEqual([...AGENT_TOOL_NAMES])
    expect(Object.values(tools).flat()).toHaveLength(shell ? 15 : 14)
    // Phase 11: the builtin output styles are catalog builtins read from core-agent/styles.ts, never registered.
    expect(registeredStyles).toEqual([])
  })

  it('phase 11 pins (C38): the three builtin output styles of core-agent and the 17th mock model, hooks', () => {
    expect(BUILTIN_STYLE_DEFINITIONS.map(style => style.name)).toEqual([...BUILTIN_OUTPUT_STYLE_NAMES])
    expect(MOCK_MODEL_IDS.at(16)).toBe('hooks')
  })

  it('phase 12 pins (C45): the 18th mock model, prompt-hook, then (Phase 14, C53) the 19th search and 20th search-tool', () => {
    expect(MOCK_MODEL_IDS.at(17)).toBe('prompt-hook')
    expect(mockModels().map(model => model.id).slice(-4, -2)).toEqual(['hooks', 'prompt-hook'])
    // The list of builtins is unchanged in Phase 12 (the mock model lives in mock/prompt-hook.ts).
    expect(BUILTIN_PLUGINS.filter(plugin => !isSearch(plugin.id))).toHaveLength(7)
  })

  it('phase 14 pins (C53 counts, applied by C50): 20 mock language models (search, search-tool last), 23 listed models', () => {
    expect(MOCK_MODEL_IDS).toHaveLength(20)
    expect(MOCK_MODEL_IDS.slice(-2)).toEqual(['search', 'search-tool'])
    expect(mockModels().map(model => model.id).slice(-2)).toEqual(['search', 'search-tool'])
    expect(mockModels()).toHaveLength(23)
  })

  it.each(BUILTIN_PLUGINS.map(plugin => [plugin.id, plugin] as const))('%s has a valid manifest and module', (id, plugin) => {
    const manifest = pluginManifestBaseSchema.parse(plugin.manifest)
    expect(manifest.id).toBe(id)
    expect(isReservedPluginId(id)).toBe(true)
    expect(semver.satisfies(PLUGIN_API_VERSION, manifest.engines.harness)).toBe(true)
    expect(typeof plugin.module.setup).toBe('function')
  })
})

describe('core-search (Phase 14, C50 skeleton)', () => {
  it('has the final manifest and settings schema: Web search, network, backend / three secret keys / maxResults', () => {
    const manifest = pluginManifestBaseSchema.parse(coreSearchManifest)
    expect(manifest).toMatchObject({ id: 'core-search', name: 'Web search', version: '1.0.0', engines: { harness: '^1.0.0' }, permissions: ['network'] })
    const schema = settingsSchemaSchema.parse(coreSearchManifest.settings)
    expect(Object.keys(schema.properties)).toEqual(['backend', 'braveApiKey', 'tavilyApiKey', 'exaApiKey', 'maxResults'])
    expect(schema.properties.backend).toMatchObject({ type: 'string', enum: [...WEB_SEARCH_BACKENDS], default: DEFAULT_SEARCH_BACKEND })
    expect(DEFAULT_SEARCH_BACKEND).toBe('brave')
    for (const backend of WEB_SEARCH_BACKENDS) {
      expect(schema.properties[SEARCH_KEY_SETTINGS[backend]], backend).toMatchObject({ type: 'string', format: 'secret' })
      expect(schema.properties[SEARCH_KEY_SETTINGS[backend]], backend).not.toHaveProperty('default')
    }
    expect(schema.properties.maxResults).toEqual(expect.objectContaining({ type: 'integer', minimum: 1, maximum: 10, default: DEFAULT_SEARCH_MAX_RESULTS }))
    expect(DEFAULT_SEARCH_MAX_RESULTS).toBe(5)
    expect(schema.required).toBeUndefined()
  })

  it('is built per options: the plugin-source fetch with the test remote only when testRemoteUrl is set', () => {
    const plain = BUILTIN_PLUGINS.find(plugin => isSearch(plugin.id))!
    expect(getBuiltinPlugins({ mockProvider: true, testRemoteUrl: null })).toBe(BUILTIN_PLUGINS)
    const rerouted = getBuiltinPlugins({ mockProvider: true, testRemoteUrl: 'http://127.0.0.1:9' })
    expect(rerouted.map(plugin => plugin.id)).toEqual([...LOAD_ORDER])
    const search = rerouted.find(plugin => isSearch(plugin.id))!
    expect(search).not.toBe(plain)
    expect(search.manifest).toBe(coreSearchManifest)
    expect(rerouted.filter(plugin => !isSearch(plugin.id))).toEqual(BUILTIN_PLUGINS.filter(plugin => !isSearch(plugin.id)))
    // The reroute accepts only the loopback test remote (createPluginSourceFetch throws for anything else).
    expect(() => coreSearchBuiltin({ testRemoteUrl: 'http://localhost:9' })).toThrow(TypeError)
    expect(typeof createCoreSearchPlugin({ safeFetch: async () => {
      throw new Error('never called')
    } }).setup).toBe('function')
  })

  it('loads without a key and registers no tool; GET /plugins/core-search/settings answers the schema; GET /tools has no search_web', async () => {
    const t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
    cleanups.push(() => t.close())
    const plugin = await t.request('/api/plugins/core-search')
    expect(plugin.status).toBe(200)
    expect(await plugin.json()).toMatchObject({ id: 'core-search', name: 'Web search', state: 'active' })
    const settings = await t.request('/api/plugins/core-search/settings')
    expect(settings.status).toBe(200)
    const view = pluginSettingsViewSchema.parse(await settings.json())
    expect(view.schema).toEqual(settingsSchemaSchema.parse(coreSearchManifest.settings))
    expect(view.values).toMatchObject({ backend: 'brave', maxResults: 5 })
    expect(Object.keys(view.secrets).sort()).toEqual(['braveApiKey', 'exaApiKey', 'tavilyApiKey'])
    expect(Object.values(view.secrets).every(secret => secret.set === false)).toBe(true)
    const tools = await t.request('/api/tools')
    expect(tools.status).toBe(200)
    const names = ((await tools.json()) as { items: Array<{ name: string }> }).items.map(tool => tool.name)
    expect(names).not.toContain(SEARCH_WEB_TOOL_NAME)
    expect(t.deps.registry.tools.get(SEARCH_WEB_TOOL_NAME)).toBeUndefined()
  })
})
