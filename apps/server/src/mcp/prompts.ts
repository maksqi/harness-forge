// The MCP prompt cache (Phase 14, ADR-061; ARCHITECTURE.md 6.41): per connected server with the `prompts` capability,
// the `prompts/list` answer (paged; at most `LIMITS.mcpPromptsMax` prompts with `LIMITS.mcpPromptArgumentsMax`
// arguments each, names through `mcpPromptCommandName`), filled when the server connects (`refresh`, called by the
// managers after the tool listing), again on a stdio `notifications/prompts/list_changed` and by `list` when the entry
// is older than `MCP_LIST_MAX_AGE_MS` (HTTP and SSE servers cannot notify); `get` runs `prompts/get` once for a command
// invocation (the result is frozen into the expansion by the caller). One cache per manager: the global manager keys
// entries by server id, the project manager by `<projectId>/<serverId>`. The cache never holds a client: the managers
// pass the server's current client to every call, and `drop` forgets a server when its client closes.
//
// Owner in P14-A: W14.2. The signatures are FROZEN after Gate P14-0b. Behavior:
// - Listing (`createMcpListStore`, shared with `resources.ts`): pages of `LIST_PAGE_TIMEOUT_MS` each (at most
//   `LIST_PAGES_MAX`, a repeated cursor ends it); the entries are normalized (plain-text titles and descriptions, capped)
//   and capped (`truncated`); a prompt without a usable name is skipped, and of two prompts whose command names collide
//   the first wins (a `debug` line names them by a hash prefix only). One listing per server runs at a time for `list`
//   (`refresh` always lists anew: a `list_changed` may follow a listing that is still running); the newest started
//   listing wins, and a listing that finishes after `drop` / `clear` is discarded. A failed listing keeps the previous
//   entry; `list` tries such a server again after `LIST_RETRY_MS` at the earliest.
// - Requests are never aborted inside the client (no `signal`, no `timeout` option): a timeout or an abort only stops
//   waiting (`raceRequest`), and the request itself ends with the server's answer or when the client closes. A client
//   that drops the handler of a cancelled request throws on the late answer ("unknown message ID"), which the stdio
//   transport does not catch (reported as a CCR); answers of discarded listings are simply dropped here.
// - `list` answers a fresh entry at once; otherwise it waits at most `LIST_WAIT_MS` for the listing (then it answers the
//   previous entry, or none, and the listing fills the cache for the next call). It never rejects.
// - Changes: `onChange(server)` when a listing answers other prompts than the cached ones (also the first non-empty
//   listing) and when `drop` forgets a server that had prompts (`clear` is silent: the manager stopped).
// - `get`: the prompt must be in the server's (cached) listing (else `not_found`); `prompts/get` with the bound
//   arguments, waited for at most `GET_TIMEOUT_MS` (then `provider_error`; the server's own errors are thrown as they
//   are, the managers map them); an abort of `signal` rejects with its reason.
// Prompt texts and arguments are untrusted: capped, never logged (prompt names only as a hash prefix, at `debug`).
import type { MCPClient } from '@ai-sdk/mcp'
import type { McpPromptArgument } from '@harness-forge/shared'
import type { Logger } from '../logger.ts'
import type { McpPromptInfo, McpPromptResult } from './types.ts'
import { createHash } from 'node:crypto'
import { HarnessError, isMcpPromptCommandName, LIMITS, mcpPromptCommandName } from '@harness-forge/shared'

/** A cached listing older than this is listed again by `list` (prompts and resources; HTTP and SSE cannot notify). */
export const MCP_LIST_MAX_AGE_MS = 60_000

/** Timeout of one `prompts/list` / `resources/list` page. */
export const LIST_PAGE_TIMEOUT_MS = 20_000
/** Most pages of one listing. */
export const LIST_PAGES_MAX = 50
/** Longest wait of `list` for a listing (then the previous entry answers and the listing goes on). */
export const LIST_WAIT_MS = 5000
/** A failed listing is tried again by `list` after this long at the earliest. */
export const LIST_RETRY_MS = 10_000
/** Timeout of one `prompts/get`. */
export const GET_TIMEOUT_MS = 30_000

/** Characters of a prompt or argument name the cache keeps (a longer name is skipped). */
const NAME_MAX_CHARS = 1024
/** Characters of a prompt title. */
const TITLE_MAX_CHARS = 256
/** Characters of a prompt or argument description. */
const DESCRIPTION_MAX_CHARS = 1024

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

// ---------- shared helpers (prompts and resources) ----------

/** The first 12 hex characters of the sha256 of a name (what `debug` lines carry instead of untrusted names). */
export function nameHash(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 12)
}

/** `text` cut to at most `max` UTF-16 code units, never inside a surrogate pair. */
function cutChars(text: string, max: number): string {
  if (text.length <= max)
    return text
  const code = text.charCodeAt(max - 1)
  return text.slice(0, code >= 0xD800 && code <= 0xDBFF ? max - 1 : max)
}

/**
 * Untrusted text as one line of plain text (control, format and line-break characters become spaces, blanks collapse),
 * at most `max` characters (a longer text ends in `…`); null for a non-string or an empty result.
 */
export function plainText(value: unknown, max: number): string | null {
  if (typeof value !== 'string')
    return null
  const text = value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').replace(/\s+/g, ' ').trim()
  if (text === '')
    return null
  return text.length <= max ? text : `${cutChars(text, max - 1)}…`
}

/** The `reason` a `raceRequest` timeout rejects with (callers map it). */
export class McpRequestTimeout extends Error {
  constructor(readonly timeoutMs: number) {
    super(`The MCP request did not finish within ${timeoutMs} ms.`)
    this.name = 'McpRequestTimeout'
  }
}

/**
 * Waits for `request` at most `timeoutMs` (then rejects with `McpRequestTimeout`) and until `signal` aborts (then rejects
 * with its reason). The request is never cancelled: it ends with the server's answer or when the client closes, and a
 * late rejection is swallowed.
 */
export async function raceRequest<T>(request: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined): Promise<T> {
  request.catch(() => {})
  signal?.throwIfAborted()
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new McpRequestTimeout(timeoutMs)), timeoutMs)
        timer.unref?.()
        if (signal !== undefined) {
          onAbort = () => reject(signal.reason)
          signal.addEventListener('abort', onAbort, { once: true })
        }
      }),
    ])
  }
  finally {
    clearTimeout(timer)
    if (onAbort !== undefined)
      signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * `raceRequest` of one request of a command or an attach: a timeout is a `provider_error` naming the server (`retry`);
 * an abort of `signal` rejects with its reason; the server's own errors are thrown as they are.
 */
export async function withRequestTimeout<T>(server: McpCacheServer, timeoutMs: number, signal: AbortSignal, request: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  try {
    return await raceRequest(request(), timeoutMs, signal)
  }
  catch (error) {
    signal.throwIfAborted()
    if (error instanceof McpRequestTimeout) {
      throw new HarnessError({
        code: 'provider_error',
        message: `The MCP server "${server.serverName}" did not answer within ${Math.round(timeoutMs / 1000)} s.`,
        action: 'retry',
      })
    }
    throw error
  }
}

/** One page of a listing: its items and the cursor of the next page. */
export interface McpListPage {
  readonly items: readonly unknown[]
  readonly nextCursor: unknown
}

/**
 * Reads the pages of a listing (`fetchPage(cursor)`, waited for at most `LIST_PAGE_TIMEOUT_MS` each, at most
 * `LIST_PAGES_MAX`; an abort of `signal` stops it) and normalizes every item with `normalize` (null = skipped); at most
 * `max` items (`truncated` when the server listed more). A repeated or empty cursor ends the listing.
 */
export async function readPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<McpListPage>,
  normalize: (item: unknown) => T | null,
  max: number,
  signal: AbortSignal,
): Promise<McpCachedList<T>> {
  const items: T[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < LIST_PAGES_MAX; page++) {
    const result = await raceRequest(fetchPage(cursor), LIST_PAGE_TIMEOUT_MS, signal)
    const listed = Array.isArray(result.items) ? result.items : []
    for (let index = 0; index < listed.length; index++) {
      const item = normalize(listed[index])
      if (item === null)
        continue
      if (items.length >= max)
        return { items, truncated: true }
      items.push(item)
    }
    const next = result.nextCursor
    if (typeof next !== 'string' || next === '' || cursors.has(next))
      return { items, truncated: false }
    cursors.add(next)
    cursor = next
  }
  // More pages than `LIST_PAGES_MAX`: the rest is left out.
  return { items, truncated: true }
}

/** Options of `createMcpListStore`. */
export interface McpListStoreOptions<T> {
  /** For `debug` lines. */
  readonly kind: 'prompts' | 'resources'
  readonly maxAgeMs: number
  readonly now: () => number
  readonly logger: Logger | undefined
  /** One complete listing of a server (rejects on failure). */
  readonly fetch: (server: McpCacheServer, client: MCPClient, signal: AbortSignal) => Promise<McpCachedList<T>>
  /** The change signature of a listing (equal signatures = no change). */
  readonly signature: (list: McpCachedList<T>) => string
  readonly onChange: ((server: McpCacheServer) => void) | undefined
}

/** The listing part of a cache (shared by the prompt and the resource cache). */
export interface McpListStore<T> {
  readonly refresh: (server: McpCacheServer, client: MCPClient, signal?: AbortSignal) => Promise<void>
  readonly list: (server: McpCacheServer, client: MCPClient, signal?: AbortSignal) => Promise<McpCachedList<T>>
  readonly drop: (key: string) => void
  readonly clear: () => void
}

interface StoreEntry<T> {
  readonly server: McpCacheServer
  readonly list: McpCachedList<T>
  readonly listedAt: number
  readonly signature: string
}

interface RunningListing<T> {
  readonly id: number
  readonly epoch: number
  readonly controller: AbortController
  readonly done: Promise<McpCachedList<T> | null>
}

const EMPTY_LIST: McpCachedList<never> = Object.freeze({ items: Object.freeze([]) as readonly never[], truncated: false })

/** Resolves when `promise` settles, `ms` passed or `signal` aborted, whichever comes first. Never rejects. */
async function settleWithin(promise: Promise<unknown>, ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted)
    return
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  await Promise.race([
    promise.then(() => {}, () => {}),
    new Promise<void>((resolve) => {
      if (Number.isFinite(ms)) {
        timer = setTimeout(resolve, ms)
        timer.unref?.()
      }
      onAbort = resolve
      signal?.addEventListener('abort', onAbort, { once: true })
    }),
  ])
  clearTimeout(timer)
  if (onAbort !== undefined)
    signal?.removeEventListener('abort', onAbort)
}

/** The cache of listings of one manager (the module comment). */
export function createMcpListStore<T>(options: McpListStoreOptions<T>): McpListStore<T> {
  const entries = new Map<string, StoreEntry<T>>()
  /** Bumped by `drop` / `clear`: a listing of an older epoch is discarded. */
  const epochs = new Map<string, number>()
  /** The listing `list` waits for (the newest started one). */
  const running = new Map<string, RunningListing<T>>()
  /** Every running listing per key (aborted by `drop` / `clear`). */
  const controllers = new Map<string, Set<AbortController>>()
  /** The id of the newest stored listing per key (an older listing that finishes later is discarded). */
  const storedIds = new Map<string, number>()
  /** When the last listing of a key failed (`list` waits `LIST_RETRY_MS` before it tries again). */
  const failedAt = new Map<string, number>()
  const emptySignature = options.signature(EMPTY_LIST)
  let nextId = 0

  const epochOf = (key: string): number => epochs.get(key) ?? 0

  function changed(server: McpCacheServer): void {
    try {
      options.onChange?.(server)
    }
    catch (error) {
      options.logger?.debug(`MCP ${options.kind} change listener failed`, { err: error })
    }
  }

  function store(server: McpCacheServer, list: McpCachedList<T>, id: number): void {
    const previous = entries.get(server.key)
    const signature = options.signature(list)
    entries.set(server.key, { server, list, listedAt: options.now(), signature })
    storedIds.set(server.key, id)
    failedAt.delete(server.key)
    if (signature !== (previous?.signature ?? emptySignature))
      changed(server)
  }

  function start(server: McpCacheServer, client: MCPClient, signal: AbortSignal | undefined): RunningListing<T> {
    const key = server.key
    const epoch = epochOf(key)
    const id = ++nextId
    const controller = new AbortController()
    const onAbort = (): void => controller.abort(signal?.reason)
    if (signal?.aborted)
      controller.abort(signal.reason)
    else
      signal?.addEventListener('abort', onAbort, { once: true })
    let set = controllers.get(key)
    if (set === undefined) {
      set = new Set()
      controllers.set(key, set)
    }
    set.add(controller)
    const startedAt = options.now()
    const done = (async (): Promise<McpCachedList<T> | null> => {
      try {
        const list = await options.fetch(server, client, controller.signal)
        if (controller.signal.aborted || epochOf(key) !== epoch || (storedIds.get(key) ?? 0) > id)
          return null
        store(server, list, id)
        options.logger?.debug(`MCP ${options.kind} listed`, { serverId: server.serverId, count: list.items.length, truncated: list.truncated, ms: options.now() - startedAt })
        return list
      }
      catch (error) {
        if (epochOf(key) === epoch && !controller.signal.aborted)
          failedAt.set(key, options.now())
        options.logger?.debug(`MCP ${options.kind} listing failed`, { serverId: server.serverId, err: error, ms: options.now() - startedAt })
        return null
      }
      finally {
        signal?.removeEventListener('abort', onAbort)
        controllers.get(key)?.delete(controller)
        if (controllers.get(key)?.size === 0)
          controllers.delete(key)
        if (running.get(key)?.id === id)
          running.delete(key)
      }
    })()
    const listing = { id, epoch, controller, done }
    running.set(key, listing)
    return listing
  }

  return {
    refresh: async (server, client, signal) => {
      // An abort ends the wait at once (the listing is discarded when its answer comes).
      await settleWithin(start(server, client, signal).done, Number.POSITIVE_INFINITY, signal)
    },

    list: async (server, client, signal) => {
      const key = server.key
      const entry = entries.get(key)
      const now = options.now()
      if (entry !== undefined && now - entry.listedAt < options.maxAgeMs)
        return entry.list
      const failed = failedAt.get(key)
      if (failed !== undefined && now - failed < LIST_RETRY_MS)
        return entry?.list ?? EMPTY_LIST
      // A listing `list` starts is shared and outlives the caller's signal (it fills the cache for the next call).
      const listing = running.get(key) ?? start(server, client, undefined)
      await settleWithin(listing.done, LIST_WAIT_MS, signal)
      return entries.get(key)?.list ?? EMPTY_LIST
    },

    drop: (key) => {
      const entry = entries.get(key)
      epochs.set(key, epochOf(key) + 1)
      for (const controller of controllers.get(key) ?? [])
        controller.abort(new Error('The MCP server was dropped from the cache.'))
      controllers.delete(key)
      running.delete(key)
      storedIds.delete(key)
      failedAt.delete(key)
      entries.delete(key)
      if (entry !== undefined && entry.signature !== emptySignature)
        changed(entry.server)
    },

    clear: () => {
      // Every running listing is aborted, so none of them stores anything after this.
      for (const set of controllers.values()) {
        for (const controller of set)
          controller.abort(new Error('The MCP cache was cleared.'))
      }
      controllers.clear()
      running.clear()
      entries.clear()
      epochs.clear()
      storedIds.clear()
      failedAt.clear()
    },
  }
}

// ---------- prompts ----------

/** The declared arguments of a listed prompt: usable names, no duplicates, at most `LIMITS.mcpPromptArgumentsMax`. */
function promptArguments(value: unknown): { args: McpPromptArgument[], dropped: number } {
  const args: McpPromptArgument[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const entry of Array.isArray(value) ? value as unknown[] : []) {
    if (typeof entry !== 'object' || entry === null)
      continue
    const { name, description, required } = entry as { name?: unknown, description?: unknown, required?: unknown }
    if (typeof name !== 'string' || name === '' || name.length > NAME_MAX_CHARS || seen.has(name))
      continue
    if (args.length >= LIMITS.mcpPromptArgumentsMax) {
      dropped++
      continue
    }
    seen.add(name)
    args.push(Object.freeze({ name, description: plainText(description, DESCRIPTION_MAX_CHARS), required: required === true }))
  }
  return { args, dropped }
}

/** The change signature of a prompt listing. */
function promptSignature(list: McpCachedList<McpPromptInfo>): string {
  return JSON.stringify([list.truncated, list.items.map(prompt => [prompt.commandName, prompt.name, prompt.title, prompt.description, prompt.arguments])])
}

/** The prompt cache of one manager (the module comment). */
export function createPromptCache(options: McpPromptCacheOptions = {}): McpPromptCache {
  const logger = options.logger

  /** A listed prompt as `McpPromptInfo`, or null (no usable name, a command name taken by an earlier prompt). */
  function promptInfo(server: McpCacheServer, value: unknown, taken: Set<string>): McpPromptInfo | null {
    if (typeof value !== 'object' || value === null)
      return null
    const prompt = value as { name?: unknown, title?: unknown, description?: unknown, arguments?: unknown }
    const name = prompt.name
    if (typeof name !== 'string' || name === '' || name.length > NAME_MAX_CHARS)
      return null
    const commandName = mcpPromptCommandName(server.serverId, name)
    if (!isMcpPromptCommandName(commandName))
      return null
    if (taken.has(commandName)) {
      logger?.debug('MCP prompt name taken by an earlier prompt', { serverId: server.serverId, prompt: nameHash(name) })
      return null
    }
    taken.add(commandName)
    const { args, dropped } = promptArguments(prompt.arguments)
    if (dropped > 0)
      logger?.debug('MCP prompt arguments over the limit were ignored', { serverId: server.serverId, prompt: nameHash(name), dropped })
    return Object.freeze({
      serverId: server.serverId,
      serverName: server.serverName,
      name,
      commandName,
      title: plainText(prompt.title, TITLE_MAX_CHARS),
      description: plainText(prompt.description, DESCRIPTION_MAX_CHARS),
      arguments: Object.freeze(args),
    })
  }

  const store = createMcpListStore<McpPromptInfo>({
    kind: 'prompts',
    maxAgeMs: options.maxAgeMs ?? MCP_LIST_MAX_AGE_MS,
    now: options.now ?? Date.now,
    logger,
    onChange: options.onChange,
    signature: promptSignature,
    fetch: (server, client, signal) => {
      const taken = new Set<string>()
      return readPages(
        async (cursor) => {
          const result = await client.experimental_listPrompts(cursor === undefined ? {} : { params: { cursor } })
          return { items: result.prompts, nextCursor: result.nextCursor }
        },
        item => promptInfo(server, item, taken),
        LIMITS.mcpPromptsMax,
        signal,
      )
    },
  })

  return {
    refresh: store.refresh,
    list: store.list,
    get: async (server, client, name, args, signal) => {
      signal.throwIfAborted()
      const listed = await store.list(server, client, signal)
      signal.throwIfAborted()
      if (!listed.items.some(prompt => prompt.name === name))
        throw new HarnessError({ code: 'not_found', message: `The MCP server "${server.serverName}" has no such prompt.` })
      const values: Record<string, string> = {}
      for (const [key, value] of Object.entries(args)) {
        if (typeof value === 'string')
          values[key] = value
      }
      return withRequestTimeout(server, GET_TIMEOUT_MS, signal, () => client.experimental_getPrompt({ name, arguments: values }))
    },
    drop: store.drop,
    clear: store.clear,
  }
}
