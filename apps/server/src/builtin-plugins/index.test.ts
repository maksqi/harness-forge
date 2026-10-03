import { PLUGIN_API_VERSION } from '@harness-forge/plugin-sdk'
import { BUILTIN_PLUGIN_IDS, isReservedPluginId, pluginManifestBaseSchema } from '@harness-forge/shared'
import semver from 'semver'
import { describe, expect, it } from 'vitest'
import { BUILTIN_PLUGINS, getBuiltinPlugins } from './index.ts'

/** `core-workspace` (Phase 7) joins the frozen builtin list in P7-0b (C14); until then the list lacks it. */
const REGISTERED_IDS = BUILTIN_PLUGIN_IDS.filter(id => id !== 'core-workspace')

describe('builtin plugins', () => {
  it('lists every builtin id in load order', () => {
    expect(BUILTIN_PLUGINS.map(plugin => plugin.id)).toEqual(REGISTERED_IDS)
  })

  it('includes mock only with HF_MOCK_PROVIDER=1', () => {
    expect(getBuiltinPlugins({ mockProvider: false }).map(plugin => plugin.id)).toEqual(['core-providers', 'core-tools', 'core-commands', 'core-mcp'])
    expect(getBuiltinPlugins({ mockProvider: true }).map(plugin => plugin.id)).toEqual(REGISTERED_IDS)
  })

  it.each(BUILTIN_PLUGINS.map(plugin => [plugin.id, plugin] as const))('%s has a valid manifest and module', (id, plugin) => {
    const manifest = pluginManifestBaseSchema.parse(plugin.manifest)
    expect(manifest.id).toBe(id)
    expect(isReservedPluginId(id)).toBe(true)
    expect(semver.satisfies(PLUGIN_API_VERSION, manifest.engines.harness)).toBe(true)
    expect(typeof plugin.module.setup).toBe('function')
  })
})
