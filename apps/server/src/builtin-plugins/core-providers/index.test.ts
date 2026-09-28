import type { PluginContext, ProviderDefinition } from '@harness-forge/plugin-sdk'
import { BUILTIN_PROVIDER_IDS, pluginManifestBaseSchema, pluginManifestSchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import corePlugin, { manifest, PROVIDER_DEFINITIONS } from './index.ts'

describe('core-providers plugin', () => {
  it('exports a builtin manifest (reserved id, valid otherwise)', () => {
    expect(pluginManifestBaseSchema.safeParse(manifest).success).toBe(true)
    expect(pluginManifestSchema.safeParse(manifest).success).toBe(false)
    expect(manifest.id).toBe('core-providers')
  })

  it('registers the 13 builtin providers through ctx.providers.register', async () => {
    const registered: ProviderDefinition[] = []
    const ctx = {
      providers: {
        register(definition: ProviderDefinition) {
          registered.push(definition)
          return { dispose() {} }
        },
      },
    } as unknown as PluginContext
    await corePlugin.setup(ctx)
    expect(registered.map(definition => definition.id)).toEqual([...BUILTIN_PROVIDER_IDS])
    expect(registered).toEqual([...PROVIDER_DEFINITIONS])
  })
})
