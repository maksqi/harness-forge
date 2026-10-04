import type { PluginContext, ToolDefinition } from '@harness-forge/plugin-sdk'
import { PLUGIN_API_VERSION } from '@harness-forge/plugin-sdk'
import { AGENT_TOOL_NAMES, BUILTIN_PLUGIN_IDS, isReservedPluginId, pluginManifestBaseSchema, WORKSPACE_TOOL_NAMES } from '@harness-forge/shared'
import semver from 'semver'
import { describe, expect, it } from 'vitest'
import { BUILTIN_PLUGINS, getBuiltinPlugins } from './index.ts'

/** The tool names every builtin registers in `setup`, through a context that records them (no other side effects). */
async function registeredTools(): Promise<Record<string, string[]>> {
  const byPlugin: Record<string, string[]> = {}
  for (const plugin of BUILTIN_PLUGINS) {
    const tools: string[] = []
    const ignore = { register: () => ({ dispose() {} }) }
    const ctx = {
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
  })

  it.each(BUILTIN_PLUGINS.map(plugin => [plugin.id, plugin] as const))('%s has a valid manifest and module', (id, plugin) => {
    const manifest = pluginManifestBaseSchema.parse(plugin.manifest)
    expect(manifest.id).toBe(id)
    expect(isReservedPluginId(id)).toBe(true)
    expect(semver.satisfies(PLUGIN_API_VERSION, manifest.engines.harness)).toBe(true)
    expect(typeof plugin.module.setup).toBe('function')
  })
})
