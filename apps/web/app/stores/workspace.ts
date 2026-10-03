// Workspace store (docs/UI.md 7.21, 7.22, 11.5; docs/API.md changes; ADR-036, ADR-037): the changes panel's data per
// chat: "This chat" (`GET /chats/:id/changes`, the net changes from the change journal) and "Git" (`GET /chats/:id/git`;
// the route is chat-scoped, so both are keyed by chat id), the lazy file diffs, revert and undo. The rewind preview and
// apply are one-shot calls of RewindDialog (useApi()); its Undo uses `undo()`.
// Signature frozen from Gate P8-0b (C20); bodies W8.8. Fetches keep their failure in the entry and never reject; a second
// call while one runs joins it unless `force` (which aborts the older request, so an older answer never overwrites a
// newer one). Diffs are cached per chat and view until that view's next successful fetch (the entry's `loadedAt`
// changes, so open rows reload their diff). Refreshes (no polling): `workspace.changed` and `run.finished` refetch the
// loaded entries, debounced 300 ms per chat; an event-stream reconnect refetches every loaded entry (`refreshLoaded`).
import type { ChatChanges, FileDiff, GitStatus, HarnessError, RestoreResult, ServerEvent } from '@harness-forge/shared'
import type { Ref } from 'vue'
import type { ChangesView } from '~/components/workspace/changes/changes-rows'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useApi } from '~/composables/useApi'
import { useChatsStore } from '~/stores/chats'
import { useUiStore } from '~/stores/ui'
import { isAbortError, toHarnessError } from '~/utils/errors'

/** One loaded view of one chat. */
export interface ChangesEntry<T> {
  /** The last answer; null before the first one. */
  data: T | null
  loading: boolean
  /** The last failure (kept until the next success); fetches never reject. */
  error: HarnessError | null
  /** When `data` arrived (epoch ms, strictly increasing per entry); null before the first answer. */
  loadedAt: number | null
}

/** The refetch delay after `workspace.changed` / `run.finished` (per chat; later events restart it). */
export const WORKSPACE_REFRESH_DEBOUNCE_MS = 300

interface Inflight {
  promise: Promise<void>
  controller: AbortController
}

/** Runs an API call and rethrows every failure as a `HarnessError` (aborts pass through), sync throws included. */
async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  }
  catch (error) {
    throw isAbortError(error) ? error : toHarnessError(error)
  }
}

export const useWorkspaceStore = defineStore('workspace', () => {
  const api = useApi()

  // ---------- state ----------

  /** By chat id: the This chat view. */
  const chat = ref<Record<string, ChangesEntry<ChatChanges>>>({})
  /** By chat id: the Git view (the route is chat-scoped). */
  const git = ref<Record<string, ChangesEntry<GitStatus>>>({})

  // Internal (not part of the store's contract): running fetches, the diff cache and the debounced refreshes.
  const inflight: Record<ChangesView, Map<string, Inflight>> = { chat: new Map(), git: new Map() }
  const diffs = new Map<string, FileDiff>()
  /** Bumped per `${chatId}\n${view}` whenever that view's diffs are dropped, so a diff loaded meanwhile is not cached. */
  const diffGenerations = new Map<string, number>()
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>, views: Set<ChangesView> }>()

  // ---------- getters ----------

  /** `chatChanges(chatId)`: the loaded This chat view, or null. */
  const chatChanges = computed(() => (chatId: string): ChatChanges | null => chat.value[chatId]?.data ?? null)
  /** `gitStatus(chatId)`: the loaded Git view, or null. */
  const gitStatus = computed(() => (chatId: string): GitStatus | null => git.value[chatId]?.data ?? null)
  /** `changeCount(chatId)`: This chat files whose status is not `unchanged` (the toggle's pill); 0 before a load. */
  const changeCount = computed(() => (chatId: string): number =>
    chat.value[chatId]?.data?.files.filter(file => file.status !== 'unchanged').length ?? 0)

  // ---------- internals ----------

  function entriesOf(view: ChangesView): Ref<Record<string, ChangesEntry<ChatChanges | GitStatus>>> {
    return (view === 'chat' ? chat : git) as Ref<Record<string, ChangesEntry<ChatChanges | GitStatus>>>
  }

  function viewKey(chatId: string, view: ChangesView): string {
    return `${chatId}\n${view}`
  }

  function diffKey(chatId: string, view: ChangesView, path: string): string {
    return `${viewKey(chatId, view)}\n${path}`
  }

  /** Drops the cached diffs of one view of a chat. */
  function dropDiffs(chatId: string, view: ChangesView): void {
    const prefix = `${viewKey(chatId, view)}\n`
    for (const key of [...diffs.keys()]) {
      if (key.startsWith(prefix))
        diffs.delete(key)
    }
    const key = viewKey(chatId, view)
    diffGenerations.set(key, (diffGenerations.get(key) ?? 0) + 1)
  }

  function request(view: ChangesView, chatId: string, signal: AbortSignal): Promise<ChatChanges | GitStatus> {
    return view === 'chat'
      ? api.changes.list({ params: { id: chatId }, signal })
      : api.changes.git({ params: { id: chatId }, signal })
  }

  function fetchView(view: ChangesView, chatId: string, opts: { force?: boolean }): Promise<void> {
    const running = inflight[view].get(chatId)
    if (running && !opts.force)
      return running.promise
    running?.controller.abort()

    const entries = entriesOf(view)
    entries.value[chatId] ??= { data: null, loading: false, error: null, loadedAt: null }
    entries.value[chatId]!.loading = true
    const controller = new AbortController()
    const current = () => inflight[view].get(chatId)?.controller === controller

    const promise = (async () => {
      try {
        const data = await call(() => request(view, chatId, controller.signal))
        const entry = entries.value[chatId]
        if (!current() || !entry)
          return
        entry.data = data
        entry.error = null
        entry.loadedAt = Math.max(Date.now(), (entry.loadedAt ?? 0) + 1)
        dropDiffs(chatId, view)
      }
      catch (error) {
        const entry = entries.value[chatId]
        if (!current() || !entry || isAbortError(error))
          return
        entry.error = toHarnessError(error)
      }
      finally {
        if (current()) {
          inflight[view].delete(chatId)
          const entry = entries.value[chatId]
          if (entry)
            entry.loading = false
        }
      }
    })()
    inflight[view].set(chatId, { promise, controller })
    return promise
  }

  /** The chats with a loaded entry in either view. */
  function loadedChatIds(): string[] {
    return [...new Set([...Object.keys(chat.value), ...Object.keys(git.value)])]
  }

  /** A chat's project: its loaded This chat answer, else the chats store; undefined when unknown. */
  function projectOf(chatId: string): string | null | undefined {
    const loaded = chat.value[chatId]?.data
    if (loaded)
      return loaded.projectId
    return useChatsStore().byId(chatId)?.projectId
  }

  /** Refetches the given loaded views of a chat after the debounce; later calls restart it and add their views. */
  function schedule(chatId: string, views: readonly ChangesView[]): void {
    const loaded = views.filter(view => entriesOf(view).value[chatId])
    if (loaded.length === 0)
      return
    const earlier = pending.get(chatId)
    if (earlier)
      clearTimeout(earlier.timer)
    const all = new Set([...(earlier?.views ?? []), ...loaded])
    const timer = setTimeout(() => {
      pending.delete(chatId)
      for (const view of all) {
        if (entriesOf(view).value[chatId])
          void fetchView(view, chatId, { force: true })
      }
    }, WORKSPACE_REFRESH_DEBOUNCE_MS)
    pending.set(chatId, { timer, views: all })
  }

  /** Forgets everything about a chat: its entries, running fetches, scheduled refreshes and cached diffs. */
  function drop(chatId: string): void {
    for (const view of ['chat', 'git'] as const) {
      inflight[view].get(chatId)?.controller.abort()
      inflight[view].delete(chatId)
      dropDiffs(chatId, view)
      delete entriesOf(view).value[chatId]
    }
    const scheduled = pending.get(chatId)
    if (scheduled) {
      clearTimeout(scheduled.timer)
      pending.delete(chatId)
    }
  }

  // ---------- actions ----------

  /**
   * `GET /chats/:id/changes` into the chat's entry; a failure stays in the entry (never rejects); a second call while
   * one runs joins it unless `force`.
   */
  function fetchChatChanges(chatId: string, opts: { force?: boolean } = {}): Promise<void> {
    return fetchView('chat', chatId, opts)
  }

  /** `GET /chats/:id/git` into the chat's Git entry; same rules as `fetchChatChanges`. */
  function fetchGit(chatId: string, opts: { force?: boolean } = {}): Promise<void> {
    return fetchView('git', chatId, opts)
  }

  /**
   * `GET /chats/:id/changes/diff?source=&path=`: one file's diff, cached until the view's next successful fetch.
   * Throws `HarnessError`; an abort passes through.
   */
  async function fileDiff(chatId: string, source: ChangesView, path: string, opts: { signal?: AbortSignal } = {}): Promise<FileDiff> {
    const key = diffKey(chatId, source, path)
    const cached = diffs.get(key)
    if (cached)
      return cached
    const generation = diffGenerations.get(viewKey(chatId, source)) ?? 0
    const result = await call(() => api.changes.diff({ params: { id: chatId }, query: { source, path }, signal: opts.signal }))
    if ((diffGenerations.get(viewKey(chatId, source)) ?? 0) === generation)
      diffs.set(key, result)
    return result
  }

  /**
   * `POST /chats/:id/changes/revert { source, path, expectedSha? }` (`expectedSha` = the `currentSha` of the diff the
   * user saw, null when it showed the file missing; left out when no diff was loaded). Throws `HarnessError` (409
   * run-active / stale, 400, 404).
   */
  function revert(chatId: string, input: { source: ChangesView, path: string, expectedSha?: string | null }): Promise<RestoreResult> {
    return call(() => api.changes.revert({ params: { id: chatId }, body: input }))
  }

  /** `POST /chats/:id/changes/undo { batchId, conflicts: 'skip' }`: the Undo of a revert or rewind toast. */
  function undo(chatId: string, batchId: string): Promise<RestoreResult> {
    return call(() => api.changes.undo({ params: { id: chatId }, body: { batchId, conflicts: 'skip' } }))
  }

  /**
   * `workspace.changed` -> refetch (debounced 300 ms per chat) the This chat entry of `data.chatId`, the Git entries of
   * the loaded chats of `data.projectId` and the This chat entry of the open chat when it belongs to that project (its
   * "changed outside this chat" marks); `run.finished` -> refetch that chat's loaded entries; `chat.deleted` -> drop its
   * entries; `project.changed` with `project: null` -> drop the entries of that project's chats.
   */
  function applyEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'workspace.changed': {
        const { chatId, projectId } = event.data
        if (chatId)
          schedule(chatId, ['chat'])
        const active = useUiStore().activeChatId
        for (const id of loadedChatIds()) {
          if (id !== chatId && projectOf(id) !== projectId)
            continue
          schedule(id, id === active || id === chatId ? ['chat', 'git'] : ['git'])
        }
        return
      }
      case 'run.finished':
        schedule(event.data.chatId, ['chat', 'git'])
        return
      case 'chat.deleted':
        drop(event.data.id)
        return
      case 'project.changed':
        if (event.data.project !== null)
          return
        for (const id of loadedChatIds()) {
          if (projectOf(id) === event.data.id)
            drop(id)
        }
    }
  }

  /** After an event-stream reconnect: refetch every loaded entry. */
  async function refreshLoaded(): Promise<void> {
    const tasks: Array<Promise<void>> = []
    for (const view of ['chat', 'git'] as const) {
      for (const chatId of Object.keys(entriesOf(view).value))
        tasks.push(fetchView(view, chatId, { force: true }))
    }
    await Promise.all(tasks)
  }

  return {
    chat,
    git,
    chatChanges,
    gitStatus,
    changeCount,
    fetchChatChanges,
    fetchGit,
    fileDiff,
    revert,
    undo,
    applyEvent,
    refreshLoaded,
  }
})
