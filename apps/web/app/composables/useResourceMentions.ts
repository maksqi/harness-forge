// MCP resources in `@` mentions (Phase 14, ADR-061; docs/UI.md 7.35, 11.10): the resources of the connected MCP servers
// for the composer's mention menu, in every chat with tools on (also without a project; a project chat adds the
// project's servers). The token is the file mentions' one (`mentionTokenAt` of `@harness-forge/shared`).
// - `GET /mcp/resources?projectId=&q=&limit=50`, 80 ms after the last keystroke, the previous request aborted; answers
//   younger than 15 s are reused (the last 20 queries per scope); `refresh()` when the menu opens.
// - `attach(entry)`: `POST /mcp/resources/attach { serverId, uri, projectId? }` → the upload's `FileRef` (the composer adds
//   it with `useComposerAttachments()`); 413 and 409 `needs-auth` are thrown for the composer's messages. A project chat
//   always sends its `projectId` (the server reads from the project's approved server of that id, else the global one).
// The only caller of the resource routes. Signature from C54 (P14-0b, frozen from Gate P14-0b); implemented by W14.8:
// - `state`: `idle` while disabled or without a token; `loading` from a change of the query until its answer (the
//   previous rows stay meanwhile); `ready`; `error` when the listing failed.
// - W14.8 adds `available` (additive): whether the scope has anything to mention (`true` once an answer listed a
//   resource, was cut, or named a server that is not connected; `false` once an answer had none of these; `null` before
//   the scope's first answer). The composer shows the "MCP resources" section only for a scope that has something, so a
//   chat whose MCP servers offer no resources never shows an empty section.
import type { ApiClient, FileRef, McpResourceEntry, McpResourceList, MentionToken } from '@harness-forge/shared'
import type { ComputedRef, MaybeRefOrGetter, Ref } from 'vue'
import { LIMITS, mentionTokenAt } from '@harness-forge/shared'
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef, toValue, watch } from 'vue'
import { useApi } from '~/composables/useApi'
import { isAbortError, toHarnessError } from '~/utils/errors'

export type ResourceMentionsState = 'idle' | 'loading' | 'ready' | 'error'

export interface ResourceMentionsOptions {
  /** The chat's project (its servers join the list); null = global servers only. */
  projectId: MaybeRefOrGetter<string | null>
  text: Ref<string>
  caret: Ref<number>
  /** Tools are available and the tool mode is not `off`. */
  enabled: MaybeRefOrGetter<boolean>
}

export interface ResourceMentions {
  /** `mentionTokenAt(text, caret)`; null while disabled. */
  token: ComputedRef<MentionToken | null>
  items: ComputedRef<readonly McpResourceEntry[]>
  state: ComputedRef<ResourceMentionsState>
  /** More resources matched than were listed. */
  truncated: ComputedRef<boolean>
  /** Servers whose resources are missing (not connected, sign-in needed). */
  unavailable: ComputedRef<McpResourceList['unavailable']>
  /**
   * + W14.8 (additive): the scope has something to mention (resources, or servers that are not connected); null before
   * the scope's first answer.
   */
  available: ComputedRef<boolean | null>
  /** Attaches a resource as an upload. */
  attach: (entry: McpResourceEntry) => Promise<FileRef>
  /** Lists again (the menu opened); an answer younger than 15 s is reused. */
  refresh: () => Promise<void>
}

/** Wait after the last change of the query before listing. */
export const RESOURCE_SEARCH_DEBOUNCE_MS = 80
/** Answers younger than this are reused. */
export const RESOURCE_CACHE_MAX_AGE_MS = 15_000
/** Queries whose answers are kept per scope. */
export const RESOURCE_CACHE_SIZE = 20
/** Resources one listing asks for (`limit`). */
export const RESOURCE_LIST_LIMIT = LIMITS.mentionResultsMax

const NO_ITEMS: readonly McpResourceEntry[] = Object.freeze([])
const NO_UNAVAILABLE: McpResourceList['unavailable'] = []

interface CacheEntry {
  list: McpResourceList
  at: number
}

interface Request {
  /** The scope key: the project id, '' for global servers only. */
  scope: string
  projectId: string | null
  query: string
}

/** Whether an answer shows that its scope has something to mention. */
function hasSomething(list: McpResourceList): boolean {
  return list.items.length > 0 || list.truncated || list.unavailable.some(server => server.status !== 'disabled')
}

export function useResourceMentions(opts: ResourceMentionsOptions): ResourceMentions {
  // Created on the first request (`useApi()` needs the Nuxt app).
  let client: ApiClient | null = null
  const api = (): ApiClient => (client ??= useApi())

  const token = computed<MentionToken | null>(() => (toValue(opts.enabled) ? mentionTokenAt(opts.text.value, opts.caret.value) : null))
  const projectId = (): string | null => toValue(opts.projectId) ?? null

  /** The answer the menu shows (kept while the next one loads). */
  const shown = shallowRef<McpResourceList | null>(null)
  const status = ref<Exclude<ResourceMentionsState, 'idle'>>('ready')
  /** Per scope: whether it has something to mention (absent = not known yet). */
  const known = ref<Record<string, boolean>>({})

  /** Per scope: query → the answer, least recently used first. */
  const cache = new Map<string, Map<string, CacheEntry>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | null = null
  /** The listing running now (a refresh and the debounced listing of one token share it). */
  let inFlight: { key: string, promise: Promise<void> } | null = null

  const current = computed<Request | null>(() => {
    const found = token.value
    if (!found)
      return null
    const project = projectId()
    return { scope: project ?? '', projectId: project, query: found.query }
  })

  function cached(scope: string, query: string): McpResourceList | null {
    const entries = cache.get(scope)
    const entry = entries?.get(query)
    if (!entries || !entry)
      return null
    if (Date.now() - entry.at >= RESOURCE_CACHE_MAX_AGE_MS) {
      entries.delete(query)
      return null
    }
    // Most recently used last.
    entries.delete(query)
    entries.set(query, entry)
    return entry.list
  }

  function remember(scope: string, query: string, list: McpResourceList): void {
    let entries = cache.get(scope)
    if (!entries) {
      entries = new Map()
      cache.set(scope, entries)
    }
    entries.delete(query)
    entries.set(query, { list, at: Date.now() })
    while (entries.size > RESOURCE_CACHE_SIZE) {
      const oldest = entries.keys().next().value
      if (oldest === undefined)
        break
      entries.delete(oldest)
    }
  }

  function cancelPending(): void {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    controller?.abort()
    controller = null
    inFlight = null
  }

  function requestKey(request: Request): string {
    return `${request.scope}\n${request.query}`
  }

  function show(scope: string, list: McpResourceList): void {
    shown.value = list
    status.value = 'ready'
    // Once a scope had something it keeps it (an empty answer is then "no match").
    const next = known.value[scope] === true || hasSomething(list)
    if (known.value[scope] !== next)
      known.value = { ...known.value, [scope]: next }
  }

  /** Lists `request` now, unless the same listing already runs (then it is shared). */
  function startList(request: Request): Promise<void> {
    const key = requestKey(request)
    if (inFlight?.key === key)
      return inFlight.promise
    cancelPending()
    status.value = 'loading'
    const promise = list(request).finally(() => {
      if (inFlight?.promise === promise)
        inFlight = null
    })
    inFlight = { key, promise }
    return promise
  }

  async function list(request: Request): Promise<void> {
    const pending = new AbortController()
    controller = pending
    try {
      const query = {
        q: request.query,
        limit: RESOURCE_LIST_LIMIT,
        ...(request.projectId === null ? {} : { projectId: request.projectId }),
      }
      const answer = await api().mcpResources.list({ query, signal: pending.signal })
      if (pending.signal.aborted)
        return
      remember(request.scope, request.query, answer)
      show(request.scope, answer)
    }
    catch (failure) {
      if (pending.signal.aborted || isAbortError(failure))
        return
      // A listing that failed keeps nothing on screen; the error state says so (the scope stays as known before).
      shown.value = null
      status.value = 'error'
    }
    finally {
      if (controller === pending)
        controller = null
    }
  }

  watch(
    current,
    (next, previous) => {
      if (!next) {
        cancelPending()
        status.value = 'ready'
        return
      }
      if (previous && previous.scope === next.scope && previous.query === next.query)
        return
      if (previous && previous.scope !== next.scope)
        shown.value = null
      // A refresh lists this token already.
      if (inFlight?.key === requestKey(next))
        return
      cancelPending()
      const hit = cached(next.scope, next.query)
      if (hit) {
        show(next.scope, hit)
        return
      }
      status.value = 'loading'
      timer = setTimeout(() => {
        timer = undefined
        void startList(next)
      }, RESOURCE_SEARCH_DEBOUNCE_MS)
    },
    { immediate: true },
  )

  // A project change forgets what was shown for the previous scope.
  watch(projectId, () => {
    shown.value = null
  })

  async function refresh(): Promise<void> {
    const request = current.value
    if (!request)
      return
    if (inFlight?.key === requestKey(request))
      return inFlight.promise
    const hit = cached(request.scope, request.query)
    if (hit) {
      cancelPending()
      show(request.scope, hit)
      return
    }
    return startList(request)
  }

  async function attach(entry: McpResourceEntry): Promise<FileRef> {
    const project = projectId()
    const body = { serverId: entry.serverId, uri: entry.uri, ...(project === null ? {} : { projectId: project }) }
    try {
      return await api().mcpResources.attach({ body })
    }
    catch (failure) {
      throw toHarnessError(failure)
    }
  }

  const state = computed<ResourceMentionsState>(() => (token.value ? status.value : 'idle'))
  const items = computed(() => (token.value ? shown.value?.items ?? NO_ITEMS : NO_ITEMS))
  const truncated = computed(() => token.value !== null && shown.value?.truncated === true)
  const unavailable = computed(() => (token.value ? shown.value?.unavailable ?? NO_UNAVAILABLE : NO_UNAVAILABLE))
  const available = computed<boolean | null>(() => known.value[projectId() ?? ''] ?? null)

  if (getCurrentScope())
    onScopeDispose(cancelPending)

  return { token, items, state, truncated, unavailable, available, attach, refresh }
}
