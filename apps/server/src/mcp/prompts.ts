// The MCP prompt cache (Phase 14, ADR-061; ARCHITECTURE.md 6.41): per connected server with the `prompts` capability,
// the `prompts/list` answer (paged; at most `LIMITS.mcpPromptsMax` prompts with `LIMITS.mcpPromptArgumentsMax`
// arguments each, names through `mcpPromptCommandName`), filled when the server connects (`refresh`, called by the
// managers after the tool listing), again on a stdio `notifications/prompts/list_changed` and by `list` when the entry
// is older than `MCP_LIST_MAX_AGE_MS` (HTTP and SSE servers cannot notify); `get` runs `prompts/get` once for a command
// invocation (the result is frozen into the expansion by the caller). One cache per manager: the global manager keys
// entries by server id, the project manager by `<projectId>/<serverId>`. The cache never holds a client: the managers
// pass the server's current client to every call, and `drop` forgets a server when its client closes.
//
// Owner in P14-A: W14.2 (the listing, the caps, the change detection, `get`). C51 stub (P14-0b): the signatures are
// final (frozen after Gate P14-0b) and the managers call them; the bodies list nothing and `get` answers
// `not_implemented`. Prompt texts are untrusted: capped, never logged at `info` (names only as a hash prefix).
import type { MCPClient } from '@ai-sdk/mcp'
import type { Logger } from '../logger.ts'
import type { McpPromptInfo, McpPromptResult } from './types.ts'
import { HarnessError } from '@harness-forge/shared'

/** A cached listing older than this is listed again by `list` (prompts and resources; HTTP and SSE cannot notify). */
export const MCP_LIST_MAX_AGE_MS = 60_000

/** The server of a cache entry (a global server, or a server of a project's `.mcp.json`). */
export interface McpCacheServer {
  /** The cache key: the server id of a global server, `<projectId>/<serverId>` of a project server. */
  readonly key: string
  readonly serverId: string
  /** The server's display name (`McpPromptInfo.serverName`, `McpResourceInfo.serverName`). */
  readonly serverName: string
  /** The project of a project server; null for a global one. */
  readonly projectId: string | null
}

/** The cached entries of one server. */
export interface McpCachedList<T> {
  /** At most the cap of the kind (`LIMITS.mcpPromptsMax`, `LIMITS.mcpResourcesMax`), in the server's order. */
  readonly items: readonly T[]
  /** The server listed more entries than the cap. */
  readonly truncated: boolean
}

/** Options of `createPromptCache`. */
export interface McpPromptCacheOptions {
  /** Age after which `list` lists a server again (default `MCP_LIST_MAX_AGE_MS`). */
  readonly maxAgeMs?: number
  /**
   * Called when the prompts of a server changed (a refresh with another answer, a dropped server that had prompts): the
   * managers emit `customization.changed { kind: 'command' }` (with `projectId` for a project server).
   */
  readonly onChange?: (server: McpCacheServer) => void
  /** Debug lines only (server id, count, `truncated`, `ms`). */
  readonly logger?: Logger
  /** Clock (tests). */
  readonly now?: () => number
}

/** One manager's prompt cache. */
export interface McpPromptCache {
  /**
   * Lists the prompts of `server` through `client` and replaces its entry (the managers call it after connecting when
   * the server advertises `capabilities.prompts`, and on a stdio `notifications/prompts/list_changed`). Never rejects: a
   * failed listing keeps the previous entry (logged at `debug`); an abort of `signal` ends it.
   */
  readonly refresh: (server: McpCacheServer, client: MCPClient, signal?: AbortSignal) => Promise<void>
  /**
   * The cached prompts of a connected server; lists it first when it has no entry or the entry is older than
   * `maxAgeMs`. Never rejects (a failure answers the previous entry, or none).
   */
  readonly list: (server: McpCacheServer, client: MCPClient, signal?: AbortSignal) => Promise<McpCachedList<McpPromptInfo>>
  /**
   * `prompts/get` of the prompt `name` (as the server lists it) with the bound argument values. Throws `not_found` for a
   * prompt the server does not list; the server's own errors are thrown as they are (the managers map them); an abort of
   * `signal` rejects.
   */
  readonly get: (server: McpCacheServer, client: MCPClient, name: string, args: Readonly<Record<string, string>>, signal: AbortSignal) => Promise<McpPromptResult>
  /** Forgets a server (its client closed, it was removed); `onChange` when it had prompts. */
  readonly drop: (key: string) => void
  /** Forgets every server (the manager stopped). */
  readonly clear: () => void
}

function notImplemented(what: string): HarnessError {
  return new HarnessError({ code: 'not_implemented', message: `${what} is not available yet.` })
}

/** The prompt cache of one manager (C51 stub: lists nothing; W14.2 implements it). */
export function createPromptCache(_options: McpPromptCacheOptions = {}): McpPromptCache {
  return {
    refresh: async () => {},
    list: async () => ({ items: [], truncated: false }),
    get: async () => {
      throw notImplemented('Running MCP prompts')
    },
    drop: () => {},
    clear: () => {},
  }
}
