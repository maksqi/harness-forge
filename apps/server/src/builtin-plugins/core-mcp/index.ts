// Builtin plugin `core-mcp` (PLUGINS.md 1, W3.5-T5): owns the MCP servers configured in the MCP panel (`mcp_servers`
// table, header / env values in secrets `mcp:<id>`). Its `setup` attaches its context to the MCP manager of the app
// (`mcp/core-bridge.ts`), which declares every stored server through `ctx.mcp.register`: the servers are contributions
// of `core-mcp`, are connected by the manager when enabled, and disappear (clients closed) when `core-mcp` is
// disabled. Its settings tune the connections of every MCP server. Builtins cannot be uninstalled.
import type { PluginManifest } from '@harness-forge/plugin-sdk'
import { definePlugin } from '@harness-forge/plugin-sdk'
import { coreMcpBridgeFor } from '../../mcp/core-bridge.ts'

export const manifest = {
  manifestVersion: 1,
  id: 'core-mcp',
  name: 'MCP servers',
  version: '1.0.0',
  description: 'MCP servers configured in the MCP panel; their tools become tools of the chat.',
  engines: { harness: '^1.0.0' },
  main: 'index.ts',
  permissions: ['network', 'process', 'secrets'],
  settings: {
    type: 'object',
    properties: {
      autoReconnect: {
        type: 'boolean',
        title: 'Reconnect automatically',
        description: 'Retry a failed or dropped MCP connection with increasing delays (up to about 9 minutes).',
        default: true,
      },
      connectTimeoutSeconds: {
        type: 'integer',
        title: 'Connect timeout (seconds)',
        description: 'How long to wait for an MCP server to start and answer the handshake.',
        minimum: 5,
        maximum: 120,
        default: 20,
      },
    },
  },
} satisfies PluginManifest

export default definePlugin({
  async setup(ctx) {
    const bridge = coreMcpBridgeFor(ctx.plugin.dataDir)
    if (!bridge) {
      ctx.logger.warn('The MCP manager is not available: the MCP servers of the panel are not started.')
      return
    }
    await bridge.attach(ctx)
  },
})
