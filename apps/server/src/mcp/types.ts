// Frozen interfaces of the MCP manager and of tool preferences (PLUGINS.md 5 / 10, API.md 5.12 / 5.13).
// Implementations (W3.5): `createMcpManager(deps)` in `mcp/index.ts`, `createToolService(deps)` in `mcp/tools.ts`.
import type { McpServer, McpServerInput, McpServerUpdate, ToolOverride, ToolSummary, ToolUpdate } from '@harness-forge/shared'
import type { SensitiveOperationOptions } from '../types.ts'

/**
 * One `@ai-sdk/mcp` client per enabled server declared in the registry (plugin declarations and `core-mcp` user
 * servers from `mcp_servers`). Connected servers' tools are registered as `mcp__<serverId>__<tool>` in the registry
 * (owner = the declaring plugin, `mcpServerId` set); connection changes emit `plugin.changed` for the owner.
 */
export interface McpManager {
  /** Boot (after the plugin host): connects declared servers in the background and follows registry changes. */
  readonly start: () => Promise<void>
  /** Closes every client (stdio children terminate). */
  readonly stop: () => Promise<void>
  /** User-configured (`editable`) and plugin-declared servers. */
  readonly list: () => Promise<McpServer[]>
  /** `not_found`. */
  readonly get: (id: string) => Promise<McpServer>
  /**
   * A `core-mcp` server: header / env values stored as secrets (`mcp:<id>`); `conflict` (`exists`). The route
   * requires fresh auth for stdio transports (or passes `requireFreshAuth` for the service to call).
   */
  readonly create: (input: McpServerInput, options?: SensitiveOperationOptions) => Promise<McpServer>
  /** `not_found`, `forbidden` (plugin-declared). Transport / `enabled` changes reconnect or close the client. */
  readonly update: (id: string, patch: McpServerUpdate, options?: SensitiveOperationOptions) => Promise<McpServer>
  /** Closes the client, unregisters its tools, deletes its secrets. `not_found`, `forbidden` (plugin-declared). */
  readonly remove: (id: string) => Promise<void>
  /** Close + reconnect, waiting up to 10 s. `not_found`, `conflict` (`disabled`). */
  readonly reconnect: (id: string) => Promise<McpServer>
}

/** A `tool_prefs` row; a tool without a row is `{ enabled: true, override: null }`. */
export interface ToolPref {
  enabled: boolean
  override: ToolOverride | null
}

export interface ToolService {
  /** `GET /tools`: registry tools + tools of disconnected MCP servers (`available: false`), sorted by name. */
  readonly list: () => Promise<ToolSummary[]>
  /** `PATCH /tools/:name`: upserts `tool_prefs`; `not_found` for an unknown tool. */
  readonly update: (name: string, patch: ToolUpdate) => Promise<ToolSummary>
  /** Every stored pref (chat pipeline: disabled tools are not sent, `override` is approval step 1). */
  readonly prefs: () => Promise<ReadonlyMap<string, ToolPref>>
}
