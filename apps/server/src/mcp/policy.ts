// Approval policy of an MCP tool (PLUGINS.md 10, ARCHITECTURE.md 6.2): the server's annotations are hints, the
// server-level policy is the fallback. Annotations are advisory; users override untrusted servers per tool.
import type { ToolPolicy } from '@harness-forge/shared'

/** The behavioral hints of an MCP tool that drive its policy (`annotations` of `tools/list`). */
export interface McpToolHints {
  readOnlyHint?: unknown
  destructiveHint?: unknown
}

/** Default policy of MCP servers (and of tools without annotations). */
export const DEFAULT_MCP_POLICY: ToolPolicy = 'ask'

/** `readOnlyHint: true` -> `safe`; else `destructiveHint: true` -> `always`; else the server policy (default `ask`). */
export function mcpToolPolicy(hints: McpToolHints | null | undefined, serverPolicy: ToolPolicy = DEFAULT_MCP_POLICY): ToolPolicy {
  if (hints?.readOnlyHint === true)
    return 'safe'
  if (hints?.destructiveHint === true)
    return 'always'
  return serverPolicy
}
