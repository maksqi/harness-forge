// The MCP resource cache (Phase 14, ADR-061; ARCHITECTURE.md 6.42): per connected server with the `resources`
// capability, the `resources/list` answer (paged; at most `LIMITS.mcpResourcesMax` resources; resource templates are not
// listed) under the refresh rules of the prompt cache (`prompts.ts`: on connect, on a stdio
// `notifications/resources/list_changed`, and by `list` when older than `MCP_LIST_MAX_AGE_MS`); `read` runs
// `resources/read` once for an attach (the route caps the size, `LIMITS.mcpResourceReadBytes`). One cache per manager,
// keyed like the prompt cache; the cache never holds a client.
//
// Owner in P14-A: W14.2. C51 stub (P14-0b): the signatures are final (frozen after Gate P14-0b) and the managers call
// them; the bodies list nothing and `read` answers `not_implemented`. A resource URI is never a file path: a resource is
// read only through its server. Contents are untrusted: never logged (the URI only at `debug`).
import type { MCPClient } from '@ai-sdk/mcp'
import type { Logger } from '../logger.ts'
import type { McpCachedList, McpCacheServer } from './prompts.ts'
import type { McpResourceContents, McpResourceInfo } from './types.ts'
import { HarnessError } from '@harness-forge/shared'

/** Options of `createResourceCache`. */
export interface McpResourceCacheOptions {
  /** Age after which `list` lists a server again (default `MCP_LIST_MAX_AGE_MS`). */
  readonly maxAgeMs?: number
  /** Debug lines only (server id, count, `truncated`, `ms`). */
  readonly logger?: Logger
  /** Clock (tests). */
  readonly now?: () => number
}

/** One manager's resource cache. */
export interface McpResourceCache {
  /**
   * Lists the resources of `server` through `client` and replaces its entry (after connecting when the server advertises
   * `capabilities.resources`, and on a stdio `notifications/resources/list_changed`). Never rejects (a failure keeps the
   * previous entry, logged at `debug`); an abort of `signal` ends it.
   */
  readonly refresh: (server: McpCacheServer, client: MCPClient, signal?: AbortSignal) => Promise<void>
  /**
   * The cached resources of a connected server; lists it first when it has no entry or the entry is older than
   * `maxAgeMs`. Never rejects.
   */
  readonly list: (server: McpCacheServer, client: MCPClient, signal?: AbortSignal) => Promise<McpCachedList<McpResourceInfo>>
  /**
   * `resources/read` of `uri` (any URI the server accepts, listed or not). The server's own errors are thrown as they
   * are (the managers map them); an abort of `signal` rejects.
   */
  readonly read: (server: McpCacheServer, client: MCPClient, uri: string, signal: AbortSignal) => Promise<McpResourceContents>
  /** Forgets a server (its client closed, it was removed). */
  readonly drop: (key: string) => void
  /** Forgets every server (the manager stopped). */
  readonly clear: () => void
}

/** The resource cache of one manager (C51 stub: lists nothing; W14.2 implements it). */
export function createResourceCache(_options: McpResourceCacheOptions = {}): McpResourceCache {
  return {
    refresh: async () => {},
    list: async () => ({ items: [], truncated: false }),
    read: async () => {
      throw new HarnessError({ code: 'not_implemented', message: 'Reading MCP resources is not available yet.' })
    },
    drop: () => {},
    clear: () => {},
  }
}
