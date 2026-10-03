// Chats store (docs/UI.md 5.3, 5.10, 11; docs/API.md 5.9): the sidebar chat list (cursor pages, date groups), chat
// CRUD with undoable delete, exports, and the per-chat status dot: run state from `ChatSummary.running` /
// `pendingApproval`, `run.*` events and the chat session (`setRunState`), plus client-side unread marks
// (localStorage['hf-unread']). Rows hold summary fields only: the active leaf of `chat.updated` (ADR-030) is the open
// chat session's business. Signatures are frozen after Phase 0.
// Phase 7 (W7.9, docs/UI.md 7.20, 11; ADR-031): the project filter of the list (`projectFilter`, stored in
// localStorage['hf-project-filter'] as the raw value: `all`, `none` or a project id). Pages are loaded with `projectId`,
// rows that stop matching the filter leave the list (a move, `chat.updated`), rows that start matching join it, and a
// stored project id that is unknown once the projects loaded falls back to `all`. Summaries seen outside the list (an
// open chat of another project, or one older than the loaded pages) are kept aside, so `byId` still answers for them.
import type {
  ChatCreate,
  ChatDetail,
  ChatExportFormat,
  ChatSummary,
  ChatUpdate,
  ChatUpdatedData,
  HarnessError,
  ServerEvent,
} from '@harness-forge/shared'
import type { ChatDateGroup } from '~/utils/chat-groups'
import { apiUrl, PROJECT_ID_PATTERN } from '@harness-forge/shared'
import { useEventListener } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { useApi } from '~/composables/useApi'
import { groupChatsByDate, msUntilNextLocalDay, startOfLocalDay } from '~/utils/chat-groups'
import { downloadResponse } from '~/utils/download'
import { toHarnessError, withHarnessErrors } from '~/utils/errors'
import { omitKey } from '~/utils/records'
import { readStoredJson, writeStoredJson } from '~/utils/storage'
import { useProjectsStore } from './projects'
import { useUiStore } from './ui'

/**
 * The project filter of the chat list (docs/UI.md 7.20, 11; ADR-031): `'all'` = every chat, `'none'` = chats without a
 * project, else a project id.
 */
export type ChatProjectFilter = 'all' | 'none' | (string & {})

/** Live run state of a chat: streaming, or waiting for a tool approval. */
export type ChatRunState = 'running' | 'approval'
/** The sidebar dot of a chat (priority approval > running > unread). */
export type ChatListStatus = ChatRunState | 'unread'

export type ChatRemoveOutcome
  = | { status: 'deleted' }
    | { status: 'undone' }
    | { status: 'failed', error: HarnessError }

/** Returned by `remove()`: `undo()` restores the row while the undo window is open. */
export interface ChatRemoveHandle {
  undo: () => void
  /** Settles when the delete is sent and answered, undone, or failed (the row is then restored). Never rejects. */
  done: Promise<ChatRemoveOutcome>
}

export const UNREAD_CHATS_KEY = 'hf-unread'
export const CHAT_PAGE_SIZE = 50
/** localStorage key of the project filter (the raw value: `all`, `none` or a project id). */
export const PROJECT_FILTER_KEY = 'hf-project-filter'
/** Toast when the project the list is filtered by was deleted (docs/UI.md 7.20). */
export const PROJECT_DELETED_MESSAGE = 'The project was deleted. Showing all chats.'
const UNREAD_MAX = 500
/** Summaries kept aside for `byId` (chats outside the filter or the loaded pages). */
const OUTSIDE_MAX = 200

interface PendingDelete {
  summary: ChatSummary | undefined
  timer: ReturnType<typeof setTimeout>
  committing: boolean
  done: Promise<ChatRemoveOutcome>
  settle: (outcome: ChatRemoveOutcome) => void
}

function readUnread(): Record<string, true> {
  const stored = readStoredJson(UNREAD_CHATS_KEY)
  const ids = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []
  return Object.fromEntries(ids.slice(-UNREAD_MAX).map(id => [id, true as const]))
}

/** `all`, `none` or a well-formed project id; anything else is not a filter. */
function isProjectFilter(value: unknown): value is ChatProjectFilter {
  return typeof value === 'string' && (value === 'all' || value === 'none' || PROJECT_ID_PATTERN.test(value))
}

function readProjectFilter(): ChatProjectFilter {
  try {
    const stored = globalThis.localStorage?.getItem(PROJECT_FILTER_KEY)
    return isProjectFilter(stored) ? stored : 'all'
  }
  catch {
    return 'all'
  }
}

function writeProjectFilter(filter: ChatProjectFilter): void {
  try {
    globalThis.localStorage?.setItem(PROJECT_FILTER_KEY, filter)
  }
  catch {
    // Storage blocked or full: the filter lasts for this page only.
  }
}

/** The chat belongs in a list filtered by `filter`. */
function matchesFilter(chat: ChatSummary, filter: ChatProjectFilter): boolean {
  if (filter === 'all')
    return true
  if (filter === 'none')
    return chat.projectId === null
  return chat.projectId === filter
}

/** The summary fields of a chat detail or of `chat.updated` data (without its `activeLeafId`). */
function summaryOf(chat: ChatSummary | ChatDetail | ChatUpdatedData): ChatSummary {
  const summary: ChatSummary = {
    id: chat.id,
    title: chat.title,
    titleSource: chat.titleSource,
    modelRef: chat.modelRef,
    pinned: chat.pinned,
    archived: chat.archived,
    running: chat.running,
    pendingApproval: chat.pendingApproval,
    projectId: chat.projectId,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  }
  if (chat.snippet !== undefined)
    summary.snippet = chat.snippet
  return summary
}

/** The server order: `updatedAt` desc, then `id` desc. */
function compareChats(a: ChatSummary, b: ChatSummary): number {
  return b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
}

function runStateOf(chat: ChatSummary): ChatRunState | null {
  if (chat.pendingApproval)
    return 'approval'
  return chat.running ? 'running' : null
}

export const useChatsStore = defineStore('chats', () => {
  const api = useApi()

  // ---------- state ----------

  /** Loaded chats (non-archived), newest first; rows being deleted are left out. */
  const items = ref<ChatSummary[]>([])
  /** Cursor of the next page; null before the first page and after the last one. */
  const cursor = ref<string | null>(null)
  const hasMore = ref(true)
  const loading = ref(false)
  /** The first page arrived. */
  const loaded = ref(false)
  const runState = ref<Record<string, ChatRunState>>({})
  const unread = ref<Record<string, true>>(readUnread())
  /** + Phase 7: the project filter of the list (`localStorage['hf-project-filter']`), sent with `fetchPage`. */
  const projectFilter = ref<ChatProjectFilter>(readProjectFilter())
  /** Summaries known but not listed: outside the filter, archived, or older than the loaded pages (newest last). */
  const outside = shallowRef<ReadonlyMap<string, ChatSummary>>(new Map())

  watch(unread, value => writeStoredJson(UNREAD_CHATS_KEY, Object.keys(value)))

  // ---------- getters ----------

  const index = computed(() => new Map(items.value.map(chat => [chat.id, chat])))
  /** `byId(id)`: the loaded summary (a listed row, else one seen outside the list), or undefined. */
  const byId = computed(() => (id: string): ChatSummary | undefined => index.value.get(id) ?? outside.value.get(id))

  // Date groups change at midnight even when no chat changes.
  const today = ref(startOfLocalDay(Date.now()))
  let dayTimer: ReturnType<typeof setTimeout> | undefined
  function scheduleDayTick() {
    dayTimer = setTimeout(() => {
      today.value = startOfLocalDay(Date.now())
      scheduleDayTick()
    }, msUntilNextLocalDay())
  }
  scheduleDayTick()
  onScopeDispose(() => clearTimeout(dayTimer))

  /** Sidebar date groups: Today, Yesterday, Previous 7 days, Previous 30 days, then months. */
  const groups = computed<Array<ChatDateGroup<ChatSummary>>>(() =>
    groupChatsByDate(items.value, Math.max(Date.now(), today.value)))

  /** `statusOf(id)`: the dot of a chat row: `approval` > `running` > `unread`, else null. */
  const statusOf = computed(() => (id: string): ChatListStatus | null =>
    runState.value[id] ?? (unread.value[id] ? 'unread' : null))

  // ---------- helpers ----------

  const pendingDeletes = new Map<string, PendingDelete>()
  let pageSeq = 0
  let pendingPage: Promise<void> | null = null

  function dropPending(id: string, entry: PendingDelete) {
    if (pendingDeletes.get(id) === entry)
      pendingDeletes.delete(id)
  }

  function seedRunState(chats: readonly ChatSummary[]) {
    let next: Record<string, ChatRunState> | null = null
    for (const chat of chats) {
      const state = runStateOf(chat)
      if ((runState.value[chat.id] ?? null) === state)
        continue
      next ??= { ...runState.value }
      if (state)
        next[chat.id] = state
      else
        delete next[chat.id]
    }
    if (next)
      runState.value = next
  }

  /** Inside the loaded window: newer than the oldest loaded chat, or every page is loaded. */
  function inLoadedWindow(chat: ChatSummary): boolean {
    const oldest = items.value.at(-1)
    return !hasMore.value || !oldest || compareChats(chat, oldest) <= 0
  }

  function keepOutside(...chats: ChatSummary[]) {
    if (chats.length === 0)
      return
    const next = new Map(outside.value)
    for (const chat of chats) {
      next.delete(chat.id)
      next.set(chat.id, chat)
    }
    for (const key of next.keys()) {
      if (next.size <= OUTSIDE_MAX)
        break
      next.delete(key)
    }
    outside.value = next
  }

  function dropOutside(id: string) {
    if (!outside.value.has(id))
      return
    const next = new Map(outside.value)
    next.delete(id)
    outside.value = next
  }

  /**
   * Replaces a loaded chat; inserts a new one when the list is loaded and it falls inside the loaded window. A chat
   * that is archived or does not match the project filter leaves the list (and is kept aside for `byId`).
   */
  function upsertSummary(chat: ChatSummary) {
    if (pendingDeletes.has(chat.id))
      return
    if (chat.archived || !matchesFilter(chat, projectFilter.value)) {
      removeItem(chat.id)
      keepOutside(chat)
      return
    }
    const known = index.value.has(chat.id)
    if (!known && !(loaded.value && inLoadedWindow(chat))) {
      keepOutside(chat)
      return
    }
    dropOutside(chat.id)
    const rest = known ? items.value.filter(item => item.id !== chat.id) : items.value
    items.value = [...rest, chat].sort(compareChats)
  }

  function removeItem(id: string) {
    if (index.value.has(id))
      items.value = items.value.filter(item => item.id !== id)
  }

  function forget(id: string) {
    dropOutside(id)
    if (id in runState.value)
      runState.value = omitKey(runState.value, id)
    markRead(id)
  }

  function mergePage(page: readonly ChatSummary[], reset: boolean): ChatSummary[] {
    const fresh = page.filter(chat => !pendingDeletes.has(chat.id) && !chat.archived && matchesFilter(chat, projectFilter.value))
    if (fresh.some(chat => outside.value.has(chat.id))) {
      const next = new Map(outside.value)
      for (const chat of fresh)
        next.delete(chat.id)
      outside.value = next
    }
    if (reset)
      return [...fresh].sort(compareChats)
    const seen = new Set(fresh.map(chat => chat.id))
    return [...items.value.filter(chat => !seen.has(chat.id)), ...fresh].sort(compareChats)
  }

  async function commitDelete(id: string, entry: PendingDelete) {
    if (pendingDeletes.get(id) !== entry || entry.committing)
      return
    entry.committing = true
    clearTimeout(entry.timer)
    try {
      await withHarnessErrors(api.chats.remove({ params: { id } }))
      dropPending(id, entry)
      forget(id)
      entry.settle({ status: 'deleted' })
    }
    catch (error) {
      dropPending(id, entry)
      const failure = toHarnessError(error)
      if (failure.code === 'not_found') {
        forget(id)
        entry.settle({ status: 'deleted' })
        return
      }
      if (entry.summary)
        upsertSummary(entry.summary)
      entry.settle({ status: 'failed', error: failure })
    }
  }

  // Deletes still inside their undo window are sent when the page goes away (keepalive survives unload). They
  // count as done: a page restored from the back/forward cache must not keep them pending.
  function flushPendingDeletes() {
    for (const [id, entry] of [...pendingDeletes]) {
      if (entry.committing)
        continue
      entry.committing = true
      clearTimeout(entry.timer)
      try {
        void globalThis.fetch(apiUrl('chats.remove', { params: { id } }), {
          method: 'DELETE',
          keepalive: true,
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        }).catch(() => {})
      }
      catch {
        // The page is going away: nothing else to do.
      }
      dropPending(id, entry)
      forget(id)
      entry.settle({ status: 'deleted' })
    }
  }

  if (typeof window !== 'undefined')
    useEventListener(window, 'pagehide', flushPendingDeletes)

  // ---------- actions ----------

  /**
   * + Phase 7: sets the project filter, stores it, empties the list (its rows are kept aside for `byId`) and loads the
   * first page with `projectId`. The same filter again does nothing. Throws `HarnessError` when the page fails (the list
   * then stays empty and unloaded, so the sidebar offers Retry).
   */
  async function setProjectFilter(filter: ChatProjectFilter): Promise<void> {
    if (filter === projectFilter.value)
      return
    projectFilter.value = filter
    writeProjectFilter(filter)
    keepOutside(...items.value)
    items.value = []
    cursor.value = null
    hasMore.value = true
    loaded.value = false
    await fetchPage({ reset: true })
  }

  // A stored project id that the loaded projects do not know (deleted while this browser was away) falls back to
  // every chat.
  const projects = useProjectsStore()
  watch(
    () => projects.loaded && projectFilter.value !== 'all' && projectFilter.value !== 'none'
      && !projects.byId(projectFilter.value),
    (unknown) => {
      if (unknown)
        setProjectFilter('all').catch(() => {})
    },
    { immediate: true },
  )

  /**
   * `GET /chats` (cursor pages of 50). Appends the next page, or reloads the first page with `{ reset: true }`.
   * Concurrent calls share the request in flight; a reset supersedes it. Throws `HarnessError`.
   */
  function fetchPage({ reset = false }: { reset?: boolean } = {}): Promise<void> {
    if (pendingPage && !reset)
      return pendingPage
    if (!reset && loaded.value && !hasMore.value)
      return Promise.resolve()
    const seq = ++pageSeq
    loading.value = true
    const filter = projectFilter.value
    const request = withHarnessErrors(api.chats.list({
      query: {
        limit: CHAT_PAGE_SIZE,
        ...(!reset && cursor.value ? { cursor: cursor.value } : {}),
        ...(filter !== 'all' ? { projectId: filter } : {}),
      },
    }))
      .then((page) => {
        if (seq !== pageSeq)
          return
        items.value = mergePage(page.items, reset)
        cursor.value = page.nextCursor
        hasMore.value = page.nextCursor !== null
        loaded.value = true
        seedRunState(page.items)
      })
      .finally(() => {
        if (seq === pageSeq) {
          loading.value = false
          pendingPage = null
        }
      })
    pendingPage = request
    return request
  }

  /**
   * `GET /chats?q=`: matching chats with `snippet` (first page); the loaded list is left untouched and the project
   * filter does not apply.
   */
  async function search(q: string, options: { limit?: number, signal?: AbortSignal } = {}): Promise<ChatSummary[]> {
    const query = q.trim()
    if (query === '')
      return []
    const page = await withHarnessErrors(api.chats.list({
      query: { q: query.slice(0, 200), limit: options.limit ?? 20 },
      signal: options.signal,
    }))
    return page.items
  }

  /**
   * `GET /chats/:id`: the active path (ready for `useChat({ messages })`) and its versions (`branches`, ADR-023);
   * refreshes the row and its run state.
   */
  async function get(id: string): Promise<ChatDetail> {
    const chat = await withHarnessErrors(api.chats.get({ params: { id } }))
    const summary = summaryOf(chat)
    seedRunState([summary])
    upsertSummary(summary)
    return chat
  }

  /** `POST /chats` (an empty chat or an import). The normal new-chat flow creates chats through `POST /chat`. */
  async function create(input: ChatCreate): Promise<ChatDetail> {
    const chat = await withHarnessErrors(api.chats.create({ body: input }))
    upsertSummary(summaryOf(chat))
    return chat
  }

  /**
   * `PATCH /chats/:id`. Title, pin, archive, model and project apply at once and roll back when the request fails; a
   * chat moved out of the filtered project leaves the list, one moved into it joins the list.
   */
  async function update(id: string, patch: ChatUpdate): Promise<ChatSummary> {
    const listed = index.value.get(id)
    const previous = listed ?? outside.value.get(id)
    if (previous) {
      const optimistic: ChatSummary = { ...previous }
      if (patch.title !== undefined)
        optimistic.title = patch.title.trim()
      if (patch.pinned !== undefined)
        optimistic.pinned = patch.pinned
      if (patch.archived !== undefined)
        optimistic.archived = patch.archived
      if (patch.modelRef !== undefined)
        optimistic.modelRef = patch.modelRef
      if (patch.projectId !== undefined)
        optimistic.projectId = patch.projectId
      upsertSummary(optimistic)
    }
    try {
      const chat = await withHarnessErrors(api.chats.update({ params: { id }, body: patch }))
      upsertSummary(chat)
      return chat
    }
    catch (error) {
      if (previous && !pendingDeletes.has(id)) {
        if (listed) {
          dropOutside(id)
          const rest = items.value.filter(item => item.id !== id)
          items.value = [...rest, previous].sort(compareChats)
        }
        else {
          removeItem(id)
          keepOutside(previous)
        }
      }
      throw error
    }
  }

  /** Renames a chat (`titleSource` becomes `user`). */
  function rename(id: string, title: string): Promise<ChatSummary> {
    return update(id, { title })
  }

  /**
   * Hides the row now and sends `DELETE /chats/:id` when the undo window ends (default 5 s); `undo()` restores the
   * row. Pending deletes are flushed on `pagehide`. Navigating away from an open chat is the caller's job.
   */
  function remove(id: string, { undoMs = 5000 }: { undoMs?: number } = {}): ChatRemoveHandle {
    const existing = pendingDeletes.get(id)
    if (existing?.committing)
      return { undo: () => {}, done: existing.done }
    if (existing) {
      clearTimeout(existing.timer)
      existing.settle({ status: 'undone' })
    }
    const summary = index.value.get(id) ?? outside.value.get(id) ?? existing?.summary
    removeItem(id)
    dropOutside(id)
    let settle: (outcome: ChatRemoveOutcome) => void = () => {}
    const done = new Promise<ChatRemoveOutcome>((resolve) => {
      settle = resolve
    })
    const entry: PendingDelete = {
      summary,
      timer: setTimeout(() => void commitDelete(id, entry), Math.max(0, undoMs)),
      committing: false,
      done,
      settle,
    }
    pendingDeletes.set(id, entry)
    return {
      undo: () => {
        if (pendingDeletes.get(id) !== entry || entry.committing)
          return
        clearTimeout(entry.timer)
        pendingDeletes.delete(id)
        if (entry.summary)
          upsertSummary(entry.summary)
        entry.settle({ status: 'undone' })
      },
      done,
    }
  }

  /** `GET /chats/:id/export?format=` saved as a file (the server names it). */
  async function exportChat(id: string, format: ChatExportFormat): Promise<void> {
    const response = await withHarnessErrors(api.chats.export({ params: { id }, query: { format } }))
    await downloadResponse(response, `chat-${id}.${format}`)
  }

  /** Run state pushed by the chat session (and by `run.*` events); null clears it. */
  function setRunState(id: string, state: ChatRunState | null): void {
    if ((runState.value[id] ?? null) === state)
      return
    runState.value = state ? { ...runState.value, [id]: state } : omitKey(runState.value, id)
  }

  function markUnread(id: string) {
    if (unread.value[id])
      return
    const ids = [...Object.keys(unread.value), id].slice(-UNREAD_MAX)
    unread.value = Object.fromEntries(ids.map(key => [key, true as const]))
  }

  /** Clears the unread dot (opening a chat does it through `ui.setActiveChat`). */
  function markRead(id: string): void {
    if (unread.value[id])
      unread.value = omitKey(unread.value, id)
  }

  /**
   * A deleted project (`project.changed` with `project: null`): its chats lose their `projectId` (the server detaches
   * them without a `chat.updated` each), and a list filtered by it falls back to every chat with a toast.
   */
  function detachProject(projectId: string) {
    const detach = (chat: ChatSummary): ChatSummary => (chat.projectId === projectId ? { ...chat, projectId: null } : chat)
    for (const entry of pendingDeletes.values()) {
      if (entry.summary)
        entry.summary = detach(entry.summary)
    }
    const listed = items.value.filter(chat => chat.projectId === projectId)
    const aside = [...outside.value.values()].filter(chat => chat.projectId === projectId)
    if (projectFilter.value === projectId) {
      toast(PROJECT_DELETED_MESSAGE)
      keepOutside(...aside.map(detach))
      items.value = items.value.map(detach)
      setProjectFilter('all').catch(() => {})
      return
    }
    for (const chat of [...listed, ...aside])
      upsertSummary(detach(chat))
  }

  /**
   * `chat.created` / `chat.updated` refresh the row (and its run state; the `activeLeafId` of `chat.updated` is not
   * kept), `chat.deleted` drops it, `run.started` sets `running`, `run.finished` clears it (or sets `approval` when
   * `awaitingApproval`) and marks the chat unread unless it is the open one (`ui.activeChatId`). Phase 7:
   * `project.changed` for a deleted project detaches its chats (`detachProject`).
   */
  function applyEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'chat.created':
      case 'chat.updated': {
        if (pendingDeletes.has(event.data.id))
          return
        const summary = summaryOf(event.data)
        seedRunState([summary])
        upsertSummary(summary)
        return
      }
      case 'chat.deleted': {
        const { id } = event.data
        const pending = pendingDeletes.get(id)
        if (pending) {
          clearTimeout(pending.timer)
          pendingDeletes.delete(id)
          pending.settle({ status: 'deleted' })
        }
        removeItem(id)
        forget(id)
        return
      }
      case 'run.started': {
        if (!pendingDeletes.has(event.data.chatId))
          setRunState(event.data.chatId, 'running')
        return
      }
      case 'run.finished': {
        const { chatId, awaitingApproval } = event.data
        if (pendingDeletes.has(chatId))
          return
        setRunState(chatId, awaitingApproval ? 'approval' : null)
        if (useUiStore().activeChatId !== chatId)
          markUnread(chatId)
        return
      }
      case 'project.changed': {
        if (event.data.project === null)
          detachProject(event.data.id)
      }
    }
  }

  return {
    items,
    cursor,
    hasMore,
    loading,
    loaded,
    runState,
    unread,
    projectFilter,
    byId,
    groups,
    statusOf,
    fetchPage,
    search,
    get,
    create,
    rename,
    update,
    remove,
    exportChat,
    setRunState,
    markRead,
    applyEvent,
    setProjectFilter,
  }
})
