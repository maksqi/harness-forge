// Workspace store (docs/UI.md 7.21, 7.22, 11.5; docs/API.md changes; ADR-036, ADR-037): the changes panel's data per
// chat: "This chat" (`GET /chats/:id/changes`, the net changes from the change journal) and "Git" (`GET /chats/:id/git`;
// the route is chat-scoped, so both are keyed by chat id), the lazy file diffs, revert and undo. The rewind preview and
// apply are one-shot calls of RewindDialog (useApi()); its Undo uses `undo()`.
// Signature frozen from Gate P8-0b (C20). Stub bodies: the fetches, `applyEvent` and `refreshLoaded` do nothing yet and
// `fileDiff` / `revert` / `undo` call the API directly; W8.8 implements the entries (loading, error, loadedAt), the
// joined and forced fetches, the diff cache, the debounced `workspace.changed` refetch and the reconnect refresh.
import type { ChatChanges, FileDiff, GitStatus, HarnessError, RestoreResult, ServerEvent } from '@harness-forge/shared'
import type { ChangesView } from '~/components/workspace/changes/changes-rows'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useApi } from '~/composables/useApi'
import { withHarnessErrors } from '~/utils/errors'

/** One loaded view of one chat. */
export interface ChangesEntry<T> {
  /** The last answer; null before the first one. */
  data: T | null
  loading: boolean
  /** The last failure (kept until the next success); fetches never reject. */
  error: HarnessError | null
  /** When `data` arrived (epoch ms); null before the first answer. */
  loadedAt: number | null
}

export const useWorkspaceStore = defineStore('workspace', () => {
  const api = useApi()

  // ---------- state ----------

  /** By chat id: the This chat view. */
  const chat = ref<Record<string, ChangesEntry<ChatChanges>>>({})
  /** By chat id: the Git view (the route is chat-scoped). */
  const git = ref<Record<string, ChangesEntry<GitStatus>>>({})

  // ---------- getters ----------

  /** `chatChanges(chatId)`: the loaded This chat view, or null. */
  const chatChanges = computed(() => (chatId: string): ChatChanges | null => chat.value[chatId]?.data ?? null)
  /** `gitStatus(chatId)`: the loaded Git view, or null. */
  const gitStatus = computed(() => (chatId: string): GitStatus | null => git.value[chatId]?.data ?? null)
  /** `changeCount(chatId)`: This chat files whose status is not `unchanged` (the toggle's pill); 0 before a load. */
  const changeCount = computed(() => (chatId: string): number =>
    chat.value[chatId]?.data?.files.filter(file => file.status !== 'unchanged').length ?? 0)

  // ---------- actions ----------

  /**
   * `GET /chats/:id/changes` into the chat's entry; a failure stays in the entry (never rejects); a second call while
   * one runs joins it unless `force`. Stub (C20): does nothing until W8.8.
   */
  async function fetchChatChanges(_chatId: string, _opts: { force?: boolean } = {}): Promise<void> {}

  /** `GET /chats/:id/git` into the chat's Git entry; same rules as `fetchChatChanges`. Stub (C20): does nothing. */
  async function fetchGit(_chatId: string, _opts: { force?: boolean } = {}): Promise<void> {}

  /**
   * `GET /chats/:id/changes/diff?source=&path=`: one file's diff (cached until the next refresh in W8.8). Throws
   * `HarnessError`; an abort passes through.
   */
  function fileDiff(chatId: string, source: ChangesView, path: string, opts: { signal?: AbortSignal } = {}): Promise<FileDiff> {
    return withHarnessErrors(api.changes.diff({ params: { id: chatId }, query: { source, path }, signal: opts.signal }))
  }

  /**
   * `POST /chats/:id/changes/revert { source, path, expectedSha? }` (`expectedSha` = the `currentSha` of the diff the
   * user saw, null when it showed the file missing; left out when no diff was loaded). Throws `HarnessError` (409
   * run-active / stale, 400, 404).
   */
  function revert(chatId: string, input: { source: ChangesView, path: string, expectedSha?: string | null }): Promise<RestoreResult> {
    return withHarnessErrors(api.changes.revert({ params: { id: chatId }, body: input }))
  }

  /** `POST /chats/:id/changes/undo { batchId, conflicts: 'skip' }`: the Undo of a revert or rewind toast. */
  function undo(chatId: string, batchId: string): Promise<RestoreResult> {
    return withHarnessErrors(api.changes.undo({ params: { id: chatId }, body: { batchId, conflicts: 'skip' } }))
  }

  /**
   * `workspace.changed` -> refetch (debounced 300 ms per chat) the This chat entry of `data.chatId` and the Git entries
   * of the loaded chats of `data.projectId`; `run.finished` -> refetch that chat's loaded entries; `chat.deleted` ->
   * drop its entries; `project.changed` with `project: null` -> drop the entries of that project's chats.
   * Stub (C20): does nothing until W8.8.
   */
  function applyEvent(_event: ServerEvent): void {}

  /** After an event-stream reconnect: refetch every loaded entry. Stub (C20): does nothing until W8.8. */
  async function refreshLoaded(): Promise<void> {}

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
