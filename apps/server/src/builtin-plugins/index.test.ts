import type { PluginContext, ToolDefinition } from '@harness-forge/plugin-sdk'
import { PLUGIN_API_VERSION } from '@harness-forge/plugin-sdk'
import { AGENT_TOOL_NAMES, BUILTIN_OUTPUT_STYLE_NAMES, BUILTIN_PLUGIN_IDS, isReservedPluginId, pluginManifestBaseSchema, WORKSPACE_TOOL_NAMES } from '@harness-forge/shared'
import semver from 'semver'
import { describe, expect, it } from 'vitest'
import { BUILTIN_STYLE_DEFINITIONS } from './core-agent/styles.ts'
import { BUILTIN_PLUGINS, getBuiltinPlugins } from './index.ts'
import { MOCK_MODEL_IDS, mockModels } from './mock/index.ts'

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
  it('lists every builtin id in load order (core-workspace, then core-agent, then mock)', () => {
    expect(BUILTIN_PLUGINS.map(plugin => plugin.id)).toEqual([...BUILTIN_PLUGIN_IDS])
    expect(BUILTIN_PLUGIN_IDS).toEqual(['core-providers', 'core-tools', 'core-commands', 'core-mcp', 'core-workspace', 'core-agent', 'mock'])
  })

  it('counts seven builtin plugins with mock, six without it', () => {
    expect(BUILTIN_PLUGINS).toHaveLength(7)
    expect(getBuiltinPlugins({ mockProvider: true })).toHaveLength(7)
    expect(getBuiltinPlugins({ mockProvider: false })).toHaveLength(6)
  })

  it('includes mock only with HF_MOCK_PROVIDER=1', () => {
    expect(getBuiltinPlugins({ mockProvider: false }).map(plugin => plugin.id)).toEqual(['core-providers', 'core-tools', 'core-commands', 'core-mcp', 'core-workspace', 'core-agent'])
    expect(getBuiltinPlugins({ mockProvider: true }).map(plugin => plugin.id)).toEqual([...BUILTIN_PLUGIN_IDS])
  })

  it('registers 15 builtin tools (14 on Windows, without shell): core-tools 3, core-workspace 7, core-agent 4 (with skill), mock 1', async () => {
    const tools = await registeredTools()
    const shell = process.platform !== 'win32'
    expect(tools).toEqual({
      'core-providers': [],
      'core-tools': ['current_time', 'web_fetch', 'generate_image'],
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

  it('phase 12 pins (C45): the 18th mock model, prompt-hook, the last of the language models and of the listing', () => {
    expect(MOCK_MODEL_IDS).toHaveLength(18)
    expect(MOCK_MODEL_IDS.at(-1)).toBe('prompt-hook')
    expect(mockModels().map(model => model.id).slice(-2)).toEqual(['hooks', 'prompt-hook'])
    expect(mockModels()).toHaveLength(21)
    // The list of builtins is unchanged in Phase 12 (the mock model lives in mock/prompt-hook.ts).
    expect(BUILTIN_PLUGINS).toHaveLength(7)
  })

  it.each(BUILTIN_PLUGINS.map(plugin => [plugin.id, plugin] as const))('%s has a valid manifest and module', (id, plugin) => {
    const manifest = pluginManifestBaseSchema.parse(plugin.manifest)
    expect(manifest.id).toBe(id)
    expect(isReservedPluginId(id)).toBe(true)
    expect(semver.satisfies(PLUGIN_API_VERSION, manifest.engines.harness)).toBe(true)
    expect(typeof plugin.module.setup).toBe('function')
  })
})
