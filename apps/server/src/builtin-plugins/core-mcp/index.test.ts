import type { PluginContext } from '@harness-forge/plugin-sdk'
import { settingsValuesSchema } from '@harness-forge/plugin-sdk'
import { pluginManifestBaseSchema } from '@harness-forge/shared'
import { describe, expect, it, vi } from 'vitest'
import coreMcp, { manifest } from './index.ts'

describe('core-mcp plugin', () => {
  it('exports a valid builtin manifest with connection settings', () => {
    expect(pluginManifestBaseSchema.safeParse(manifest).success).toBe(true)
    expect(manifest.id).toBe('core-mcp')
    expect(manifest.permissions).toEqual(['network', 'process', 'secrets'])
    const values = settingsValuesSchema(manifest.settings)
    expect(values.safeParse({ autoReconnect: false, connectTimeoutSeconds: 30 }).success).toBe(true)
    expect(values.safeParse({ connectTimeoutSeconds: 1 }).success).toBe(false)
  })

  it('registers nothing itself: the MCP manager declares the panel servers while it is active', async () => {
    const register = vi.fn()
    const warn = vi.fn()
    const ctx = { plugin: { id: 'core-mcp', version: '1.0.0', dir: '/builtin', dataDir: '/data' }, logger: { warn }, mcp: { register } } as unknown as PluginContext
    await coreMcp.setup(ctx)
    expect(register).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })
})
