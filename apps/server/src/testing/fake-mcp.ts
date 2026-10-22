// Helpers for MCP manager test doubles (Phase 14, C50-T6): the prompt / resource listings and the five Phase 14 members
// of `McpManager` (`prompts`, `getPrompt`, `resources`, `readResource`, `authTarget`) for hand-written managers that
// know no prompt, resource or server. A light module (types and `HarnessError` only), so test utilities can import it
// without the MCP runtime:
//
//   const mcp: McpManager = { start, stop, list, get, create, update, remove, reconnect, ...inertMcpManagerMembers() }
import type { McpAuthStorage } from '../mcp/oauth/types.ts'
import type { McpListing, McpManager, McpPromptInfo, McpResourceInfo, ProjectMcpListing } from '../mcp/types.ts'
import { HarnessError } from '@harness-forge/shared'

/** A listing in which no server listed anything (Phase 14). */
export function emptyMcpListing<T>(): McpListing<T> {
  return { items: [], truncated: false, unavailable: [] }
}

/** A project listing in which no server listed anything and nothing is shadowed (Phase 14). */
export function emptyProjectMcpListing<T>(): ProjectMcpListing<T> {
  return { ...emptyMcpListing<T>(), shadowed: new Set<string>() }
}

/** Where the OAuth secrets of a project server are stored (ADR-059): `project:<projectId>`, `mcp-oauth.<serverId>`. */
export function projectMcpAuthStorage(projectId: string, serverId: string): McpAuthStorage {
  return { kind: 'project', scope: `project:${projectId}`, name: `mcp-oauth.${serverId}` }
}

/** The Phase 14 members of the global `McpManager` (C50). */
export type McpManagerPhase14Members = Pick<McpManager, 'prompts' | 'getPrompt' | 'resources' | 'readResource' | 'authTarget'>

/**
 * The Phase 14 members for a hand-written `McpManager` double that knows no prompt, resource or server: `prompts` /
 * `resources` answer an empty listing, `getPrompt` / `readResource` reject with `not_found` (or the signal's reason
 * when it aborted), `authTarget` answers null. Spread it: `{ start, stop, list, …, ...inertMcpManagerMembers() }`.
 */
export function inertMcpManagerMembers(): McpManagerPhase14Members {
  return {
    prompts: async () => emptyMcpListing<McpPromptInfo>(),
    getPrompt: async (serverId, name, _args, signal) => {
      signal.throwIfAborted()
      throw new HarnessError({ code: 'not_found', message: `The MCP prompt "${name}" of "${serverId}" was not found.` })
    },
    resources: async () => emptyMcpListing<McpResourceInfo>(),
    readResource: async (serverId, _uri, signal) => {
      signal.throwIfAborted()
      throw new HarnessError({ code: 'not_found', message: `The MCP resource was not found on "${serverId}".` })
    },
    authTarget: () => null,
  }
}
