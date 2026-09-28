// Builtin plugin `core-mcp` (PLUGINS.md 1, W3.5-T5): owns the MCP servers configured in the MCP panel (`mcp_servers`
// table, header / env values in secrets `mcp:<id>`). The MCP manager follows the state of this plugin
// (`PluginHost.onStateChange`) and, while it is active, declares every stored server as a contribution of `core-mcp`:
// the servers are connected by the manager when enabled and disappear (clients closed) when `core-mcp` is disabled or
// reloaded, like any contribution. Its settings tune the connections of every MCP server. Builtins cannot be
// uninstalled.
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
  // Nothing to register here: the MCP manager declares the servers of the panel while this plugin is active.
  setup() {},
})
