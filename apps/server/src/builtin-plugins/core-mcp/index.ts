// Builtin plugin `core-mcp` (PLUGINS.md 1): owns the MCP servers configured in the MCP panel (`mcp_servers` table)
// and declares them to the registry. Phase 0 stub; implemented by W3.5 (W3.5-T5).
import type { PluginManifest } from '@harness-forge/plugin-sdk'
import { definePlugin } from '@harness-forge/plugin-sdk'

export const manifest = {
  manifestVersion: 1,
  id: 'core-mcp',
  name: 'MCP servers',
  version: '1.0.0',
  description: 'MCP servers configured in the MCP panel; their tools become tools of the chat.',
  engines: { harness: '^1.0.0' },
  main: 'index.ts',
  permissions: ['network', 'process', 'secrets'],
} satisfies PluginManifest

export default definePlugin({
  setup() {},
})
