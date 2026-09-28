// Internal extension of the MCP manager used by the tool service (`tools.ts`): not part of the frozen `McpManager`
// interface, read through `mcpInternals(deps.mcp)` so a fake manager without it still works.
import type { McpStatus, ToolPolicy } from '@harness-forge/shared'
import type { McpManager } from './types.ts'

/** Owner plugin of the MCP servers configured in the MCP panel. */
export const CORE_MCP_PLUGIN_ID = 'core-mcp'

/** A tool of the last successful listing of an MCP server that is declared but not connected now. */
export interface OfflineMcpTool {
  /** Registered name `mcp__<serverId>__<tool>`. */
  name: string
  title: string | null
  description: string
  pluginId: string
  mcpServerId: string
  policy: ToolPolicy
  inputSchema: Record<string, unknown>
}

export interface McpManagerInternals {
  /** Tools of declared servers that are not connected (`GET /tools`, `available: false`). */
  readonly offlineTools: () => OfflineMcpTool[]
  /** Status of a declared server, or null when the manager does not know it. */
  readonly serverStatus: (id: string) => McpStatus | null
}

export function mcpInternals(manager: McpManager): Partial<McpManagerInternals> {
  return manager as Partial<McpManagerInternals>
}
