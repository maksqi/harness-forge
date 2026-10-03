// The `@` menu state of one composer (docs/UI.md 7.26, 11.6; ADR-042). The token under the caret comes from
// `mentionTokenAt` of `@harness-forge/shared` (`util/mentions.ts`, the only implementation of the mention grammar); the
// matches from `useProjectFiles().search`. Signature frozen from Gate P9-0b (C25); implemented by W9.8:
// - the menu is open while the caret is in a token of a project chat and Esc did not dismiss that token (the dismissal
//   is remembered until the token's text changes, like the slash menu);
// - a search runs 80 ms after the last change of the query, aborting the one before; the answers of the last 20
//   queries per project are kept (for `LIMITS.mentionIndexTtlMs`, the server's index lifetime), so a cached query
//   shows at once;
// - `state` is `loading` from the change until the answer (the menu shows "Searching files…" only after 150 ms and
//   keeps the previous rows meanwhile), `error` with `error` set when the search failed;
// - `apply(entry)` replaces the token (a file: its mention and a blank; a folder: `@dir/`, keeping the menu open).
import type { HarnessError, ProjectFileEntry, ProjectFileSearch } from '@harness-forge/shared'
import type { ComputedRef, Ref } from 'vue'
import type { ProjectFilesApi } from '~/composables/useProjectFiles'
import { LIMITS, mentionTokenAt } from '@harness-forge/shared'
import { computed, getCurrentScope, onScopeDispose, readonly, ref, shallowRef, watch } from 'vue'
import { replaceMentionToken } from '~/components/chat/composer/mention-menu'
import { useProjectFiles } from '~/composables/useProjectFiles'
import { isAbortError, toHarnessError } from '~/utils/errors'

export interface FileMentionsOptions {
  /** The chat's project; null = never opens. */
  projectId: Ref<string | null>
  text: Ref<string>
  caret: Ref<number>
}

/** What `apply` produces: the new text and caret, and whether the menu stays open (a folder was picked). */
export interface FileMentionApplied {
  text: string
  caret: number
  keepOpen: boolean
}

export interface FileMentions {
  /** The `@` token under the caret (`mentionTokenAt(text, caret)`), or null. */
  token: ComputedRef<{ start: number, end: number, query: string } | null>
  /** A token, a project, and not dismissed. */
  open: ComputedRef<boolean>
  items: Readonly<Ref<readonly ProjectFileEntry[]>>
  state: Readonly<Ref<'loading' | 'ready' | 'error'>>
  error: Readonly<Ref<HarnessError | null>>
  truncated: Readonly<Ref<boolean>>
  /** Esc: the menu stays closed for this token until it changes. */
  dismiss: () => void
  /** The text after picking `entry`. */
  apply: (entry: ProjectFileEntry) => FileMentionApplied
}

/** Wait after the last change of the query before searching. */
export const MENTION_SEARCH_DEBOUNCE_MS = 80
/** Queries whose answers are kept per project. */
export const MENTION_CACHE_SIZE = 20

interface CacheEntry {
  result: ProjectFileSearch
  at: number
}

/** The mention menu state of one composer. */
export function useFileMentions(opts: FileMentionsOptions): FileMentions {
  // Created on the first search (`useApi()` needs the Nuxt app).
  let files: ProjectFilesApi | null = null
  const api = () => (files ??= useProjectFiles())

  const token = computed(() => {
    const found = mentionTokenAt(opts.text.value, opts.caret.value)
    return found ? { start: found.start, end: found.end, query: found.query } : null
  })
  /** Identifies the token for Esc: its position and text (typing changes it, so the menu comes back). */
  const tokenKey = computed(() => {
    const current = token.value
    return current ? `${current.start}:${opts.text.value.slice(current.start, current.end)}` : null
  })
  const dismissedKey = ref<string | null>(null)
  const open = computed(() => opts.projectId.value !== null && tokenKey.value !== null && tokenKey.value !== dismissedKey.value)

  const items = shallowRef<readonly ProjectFileEntry[]>([])
  const state = ref<'loading' | 'ready' | 'error'>('ready')
  const error = shallowRef<HarnessError | null>(null)
  const truncated = ref(false)

  /** Per project: query -> the answer, least recently used first. */
  const cache = new Map<string, Map<string, CacheEntry>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | null = null

  function cached(projectId: string, query: string): ProjectFileSearch | null {
    const entries = cache.get(projectId)
    const entry = entries?.get(query)
    if (!entries || !entry)
      return null
    if (Date.now() - entry.at > LIMITS.mentionIndexTtlMs) {
      entries.delete(query)
      return null
    }
    // Most recently used last.
    entries.delete(query)
    entries.set(query, entry)
    return entry.result
  }

  function remember(projectId: string, query: string, result: ProjectFileSearch) {
    let entries = cache.get(projectId)
    if (!entries) {
      entries = new Map()
      cache.set(projectId, entries)
    }
    entries.delete(query)
    entries.set(query, { result, at: Date.now() })
    while (entries.size > MENTION_CACHE_SIZE) {
      const oldest = entries.keys().next().value
      if (oldest === undefined)
        break
      entries.delete(oldest)
    }
  }

  function cancelPending() {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    controller?.abort()
    controller = null
  }

  function show(result: ProjectFileSearch) {
    items.value = result.items
    truncated.value = result.truncated
    error.value = null
    state.value = 'ready'
  }

  function reset() {
    cancelPending()
    items.value = []
    truncated.value = false
    error.value = null
    state.value = 'ready'
  }

  async function search(projectId: string, query: string) {
    timer = undefined
    const current = new AbortController()
    controller = current
    try {
      const result = await api().search(projectId, query, { limit: LIMITS.mentionResultsMax, signal: current.signal })
      if (current.signal.aborted)
        return
      remember(projectId, query, result)
      show(result)
    }
    catch (failure) {
      if (current.signal.aborted || isAbortError(failure))
        return
      items.value = []
      truncated.value = false
      error.value = toHarnessError(failure)
      state.value = 'error'
    }
    finally {
      if (controller === current)
        controller = null
    }
  }

  watch(
    () => (open.value ? { projectId: opts.projectId.value!, query: token.value!.query } : null),
    (next, previous) => {
      if (!next) {
        reset()
        return
      }
      if (previous && previous.projectId === next.projectId && previous.query === next.query)
        return
      cancelPending()
      if (previous && previous.projectId !== next.projectId) {
        items.value = []
        truncated.value = false
      }
      const hit = cached(next.projectId, next.query)
      if (hit) {
        show(hit)
        return
      }
      state.value = 'loading'
      error.value = null
      timer = setTimeout(() => void search(next.projectId, next.query), MENTION_SEARCH_DEBOUNCE_MS)
    },
    { immediate: true },
  )

  // A new token (or none) forgets the dismissal of the previous one.
  watch(tokenKey, (key) => {
    if (dismissedKey.value !== null && key !== dismissedKey.value)
      dismissedKey.value = null
  })

  function dismiss() {
    dismissedKey.value = tokenKey.value
  }

  function apply(entry: ProjectFileEntry): FileMentionApplied {
    const current = token.value
    if (!current)
      return { text: opts.text.value, caret: opts.caret.value, keepOpen: false }
    dismissedKey.value = null
    return replaceMentionToken(opts.text.value, current, entry)
  }

  if (getCurrentScope())
    onScopeDispose(cancelPending)

  return {
    token,
    open,
    items: readonly(items) as Readonly<Ref<readonly ProjectFileEntry[]>>,
    state: readonly(state),
    error: readonly(error) as Readonly<Ref<HarnessError | null>>,
    truncated: readonly(truncated),
    dismiss,
    apply,
  }
}
