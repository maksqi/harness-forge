import { PLUGIN_API_VERSION } from '@harness-forge/plugin-sdk'
import { BUILTIN_PLUGIN_IDS, isReservedPluginId, pluginManifestBaseSchema } from '@harness-forge/shared'
import semver from 'semver'
import { describe, expect, it } from 'vitest'
import { BUILTIN_PLUGINS, getBuiltinPlugins } from './index.ts'

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

  it.each(BUILTIN_PLUGINS.map(plugin => [plugin.id, plugin] as const))('%s has a valid manifest and module', (id, plugin) => {
    const manifest = pluginManifestBaseSchema.parse(plugin.manifest)
    expect(manifest.id).toBe(id)
    expect(isReservedPluginId(id)).toBe(true)
    expect(semver.satisfies(PLUGIN_API_VERSION, manifest.engines.harness)).toBe(true)
    expect(typeof plugin.module.setup).toBe('function')
  })
})
