// The MCP resource cache (Phase 14, ADR-061; ARCHITECTURE.md 6.42): per connected server with the `resources`
// capability, the `resources/list` answer (paged; at most `LIMITS.mcpResourcesMax` resources; resource templates are not
// listed) under the refresh rules of the prompt cache (`prompts.ts`: on connect, on a stdio
// `notifications/resources/list_changed`, and by `list` when older than `MCP_LIST_MAX_AGE_MS`); `read` runs
// `resources/read` once for an attach (the route caps the size, `LIMITS.mcpResourceReadBytes`). One cache per manager,
// keyed like the prompt cache; the cache never holds a client.
//
// Owner in P14-A: W14.2. The signatures are FROZEN after Gate P14-0b. Behavior:
// - Listing: `createMcpListStore` of `prompts.ts` (the same paging, waits, retries and discards); an entry needs a URI
//   an attach accepts (`mcpResourceUriSchema`: a scheme, at most 2048 characters, no whitespace or control characters)
//   and is normalized (plain-text name, title and description, capped; a well-formed MIME type; an integer size); the
//   first entry of a URI wins. No change events (the `@` menu lists on every query).
// - `read`: `resources/read`, waited for at most `READ_TIMEOUT_MS` (then `provider_error`; never cancelled inside the
//   client, see `prompts.ts`); a JSON-RPC "resource not found" (`-32002`)
//   is `not_found`; the server's other errors are thrown as they are (the managers map them); an abort of `signal`
//   rejects with its reason.
// - `mcpResourceUpload(contents, …)`: what `POST /mcp/resources/attach` stores (see its comment).
// A resource URI is never a file path: a resource is read only through its server. Contents are untrusted: never
// logged (not even the URI at `info`).
import type { MCPClient } from '@ai-sdk/mcp'
import type { Logger } from '../logger.ts'
import type { McpCachedList, McpCacheServer } from './prompts.ts'
import type { McpResourceContents, McpResourceInfo } from './types.ts'
import { Buffer } from 'node:buffer'
import { MCPClientError } from '@ai-sdk/mcp'
import { HarnessError, LIMITS, mcpResourceUriSchema } from '@harness-forge/shared'
import { base64ByteLength, mcpContentText } from './content.ts'
import { createMcpListStore, MCP_LIST_MAX_AGE_MS, plainText, readPages, withRequestTimeout } from './prompts.ts'

/** Timeout of one `resources/read`. */
export const READ_TIMEOUT_MS = 60_000

/** The JSON-RPC error code of an unknown resource (MCP specification). */
export const RESOURCE_NOT_FOUND_CODE = -32002

/** Characters of a resource name or title (`mcpResourceEntrySchema`). */
const LABEL_MAX_CHARS = 256
/** Characters of a resource description (`mcpResourceEntrySchema`). */
const DESCRIPTION_MAX_CHARS = 1000
/** A MIME type `type/subtype` (parameters are dropped). */
const MIME_PATTERN = /^[\w.+-]+\/[\w.+-]+$/

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

/** A MIME type without parameters, lower case; null when it is not `type/subtype`. */
export function canonicalMimeType(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  const type = (value.split(';')[0] ?? '').trim().toLowerCase()
  return type.length <= LABEL_MAX_CHARS && MIME_PATTERN.test(type) ? type : null
}

/** A listed resource as `McpResourceInfo`, or null (no URI an attach accepts). */
function resourceInfo(server: McpCacheServer, value: unknown, seen: Set<string>): McpResourceInfo | null {
  if (typeof value !== 'object' || value === null)
    return null
  const resource = value as { uri?: unknown, name?: unknown, title?: unknown, description?: unknown, mimeType?: unknown, size?: unknown }
  const uri = resource.uri
  if (typeof uri !== 'string' || !mcpResourceUriSchema.safeParse(uri).success || seen.has(uri))
    return null
  seen.add(uri)
  const size = resource.size
  return Object.freeze({
    serverId: server.serverId,
    serverName: server.serverName,
    uri,
    name: plainText(resource.name, LABEL_MAX_CHARS) ?? '',
    title: plainText(resource.title, LABEL_MAX_CHARS),
    description: plainText(resource.description, DESCRIPTION_MAX_CHARS),
    mimeType: canonicalMimeType(resource.mimeType),
    size: typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : null,
  })
}

/** The change signature of a resource listing. */
function resourceSignature(list: McpCachedList<McpResourceInfo>): string {
  return JSON.stringify([list.truncated, list.items.map(item => [item.uri, item.name, item.title, item.description, item.mimeType, item.size])])
}

/** True for the JSON-RPC "resource not found" error of a server. */
function isResourceNotFound(error: unknown): boolean {
  return MCPClientError.isInstance(error) && error.code === RESOURCE_NOT_FOUND_CODE
}

/** The resource cache of one manager (the module comment). */
export function createResourceCache(options: McpResourceCacheOptions = {}): McpResourceCache {
  const store = createMcpListStore<McpResourceInfo>({
    kind: 'resources',
    maxAgeMs: options.maxAgeMs ?? MCP_LIST_MAX_AGE_MS,
    now: options.now ?? Date.now,
    logger: options.logger,
    onChange: undefined,
    signature: resourceSignature,
    fetch: (server, client, signal) => {
      const seen = new Set<string>()
      return readPages(
        async (cursor) => {
          const result = await client.listResources(cursor === undefined ? {} : { params: { cursor } })
          return { items: result.resources, nextCursor: result.nextCursor }
        },
        item => resourceInfo(server, item, seen),
        LIMITS.mcpResourcesMax,
        signal,
      )
    },
  })

  return {
    refresh: store.refresh,
    list: store.list,
    read: async (server, client, uri, signal) => {
      try {
        return await withRequestTimeout(server, READ_TIMEOUT_MS, signal, () => client.readResource({ uri }))
      }
      catch (error) {
        if (!signal.aborted && isResourceNotFound(error))
          throw new HarnessError({ code: 'not_found', message: `The MCP server "${server.serverName}" has no such resource.` })
        throw error
      }
    },
    drop: store.drop,
    clear: store.clear,
  }
}

// ---------- attach ----------

/** What `POST /mcp/resources/attach` stores through the upload path (`files.upload(new File([bytes], name, { type }))`). */
export interface McpResourceUpload {
  /** The upload name: the last path segment of the URI, else the listed name, else `resource`. */
  readonly name: string
  /** `text/plain`, the server's `text/*`, an `image/*` type or `application/pdf`; '' = sniffed by the upload path. */
  readonly mime: string
  readonly bytes: Uint8Array<ArrayBuffer>
}

/** Options of `mcpResourceUpload`. */
export interface McpResourceUploadOptions {
  /** The requested URI (the upload name comes from it). */
  readonly uri: string
  /** The listed name of the resource, when it is listed. */
  readonly name?: string | null
  /** Most bytes (default `LIMITS.mcpResourceReadBytes`); more is `payload_too_large`. */
  readonly maxBytes?: number
}

/** `payload_too_large` of a resource above `maxBytes` (`details.limitBytes`). */
export function resourceTooLarge(maxBytes: number): HarnessError {
  return new HarnessError({
    code: 'payload_too_large',
    message: `The resource is larger than ${Math.floor(maxBytes / (1024 * 1024))} MiB and can't be attached.`,
    details: { limitBytes: maxBytes },
  })
}

function unreadable(message: string): HarnessError {
  return new HarnessError({ code: 'validation_error', message, details: { issues: [{ path: ['uri'], message, code: 'custom' }] } })
}

/** The upload name of a resource: the last path segment of its URI (decoded), else `listed`, else `resource`. */
export function resourceFileName(uri: string, listed?: string | null): string {
  let segment = ''
  try {
    const path = new URL(uri).pathname
    const last = path.split('/').filter(part => part !== '').pop() ?? ''
    try {
      segment = decodeURIComponent(last)
    }
    catch {
      segment = last
    }
  }
  catch {
    segment = ''
  }
  const name = plainText(segment, LABEL_MAX_CHARS) ?? plainText(listed, LABEL_MAX_CHARS)
  return name === null || /^\.+$/.test(name) ? 'resource' : name
}

/**
 * The upload of a `resources/read` answer (API.md 5.39): the text contents joined with blank lines (a binary content
 * next to them becomes a one-line placeholder), as the servers' `text/*` type when every text content declares the same
 * one, else `text/plain`; without text, the first binary content: an image or a PDF (as declared, the upload path
 * checks the bytes), or `text/*` decoded as text; any other binary type, or nothing readable, is `validation_error`;
 * more than `maxBytes` is `payload_too_large` (`details.limitBytes`).
 */
export function mcpResourceUpload(contents: McpResourceContents | { contents?: unknown }, options: McpResourceUploadOptions): McpResourceUpload {
  const maxBytes = options.maxBytes ?? LIMITS.mcpResourceReadBytes
  const name = resourceFileName(options.uri, options.name)
  const items = Array.isArray(contents.contents) ? (contents.contents as unknown[]).filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null) : []
  const texts = items.filter(item => typeof item.text === 'string')
  if (texts.length > 0) {
    const parts: string[] = []
    let bytes = 0
    for (const item of items) {
      const part = typeof item.text === 'string' ? item.text : mcpContentText({ type: 'resource', resource: item })
      bytes += Buffer.byteLength(part, 'utf8') + (parts.length > 0 ? 2 : 0)
      if (bytes > maxBytes)
        throw resourceTooLarge(maxBytes)
      parts.push(part)
    }
    const types = new Set(texts.map(item => canonicalMimeType(item.mimeType)))
    const [only] = types
    const mime = types.size === 1 && only !== null && only !== undefined && only.startsWith('text/') ? only : 'text/plain'
    return { name, mime, bytes: new Uint8Array(Buffer.from(parts.join('\n\n'), 'utf8')) }
  }
  const blob = items.find(item => typeof item.blob === 'string')
  if (blob === undefined)
    throw unreadable('The resource has no content that can be attached.')
  const data = blob.blob as string
  if (base64ByteLength(data) > maxBytes)
    throw resourceTooLarge(maxBytes)
  const bytes = new Uint8Array(Buffer.from(data, 'base64'))
  if (bytes.byteLength > maxBytes)
    throw resourceTooLarge(maxBytes)
  // A missing or generic type is taken from the bytes by the upload path (an image, a PDF or UTF-8 text, else refused).
  const declared = canonicalMimeType(blob.mimeType)
  const mime = declared === 'application/octet-stream' ? null : declared
  if (mime !== null && !mime.startsWith('image/') && !mime.startsWith('text/') && mime !== 'application/pdf')
    throw unreadable(`Only text, images and PDF files can be attached from an MCP server (this resource is ${mime}).`)
  return { name, mime: mime ?? '', bytes }
}
