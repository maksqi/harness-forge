import type { PluginContext } from '@harness-forge/plugin-sdk'
import { settingsValuesSchema } from '@harness-forge/plugin-sdk'
import { pluginManifestBaseSchema } from '@harness-forge/shared'
import { describe, expect, it, vi } from 'vitest'
import { registerCoreMcpBridge } from '../../mcp/core-bridge.ts'
import coreMcp, { manifest } from './index.ts'

function fakeContext(dataDir: string) {
  const warn = vi.fn()
  const ctx = { plugin: { id: 'core-mcp', version: '1.0.0', dir: '/builtin', dataDir }, logger: { warn } } as unknown as PluginContext
  return { ctx, warn }
}

describe('core-mcp plugin', () => {
  it('exports a valid builtin manifest with connection settings', () => {
    expect(pluginManifestBaseSchema.safeParse(manifest).success).toBe(true)
    expect(manifest.id).toBe('core-mcp')
    expect(manifest.permissions).toEqual(['network', 'process', 'secrets'])
    const values = settingsValuesSchema(manifest.settings)
    expect(values.safeParse({ autoReconnect: false, connectTimeoutSeconds: 30 }).success).toBe(true)
    expect(values.safeParse({ connectTimeoutSeconds: 1 }).success).toBe(false)
  })

  it('attaches its context to the MCP manager of its data directory', async () => {
    const attach = vi.fn(async () => {})
    const bridge = registerCoreMcpBridge('/data/plugins/.data/core-mcp', { attach })
    try {
      const { ctx, warn } = fakeContext('/data/plugins/.data/core-mcp')
      await coreMcp.setup(ctx)
      expect(attach).toHaveBeenCalledWith(ctx)
      expect(warn).not.toHaveBeenCalled()
    }
    finally {
      bridge.dispose()
    }
  })

  it('warns and stays empty without an MCP manager', async () => {
    const { ctx, warn } = fakeContext('/elsewhere/plugins/.data/core-mcp')
    await coreMcp.setup(ctx)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('MCP manager is not available'))
  })
})
