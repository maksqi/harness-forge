// Background tasks store (docs/UI.md 7.29, 11.7; docs/API.md 4.29, 5.30; ADR-046): the background agents of each chat,
// as `GET /chat/:id/tasks` lists them (newest first), kept current by `task.changed` (an upsert in every tab) and
// dropped by `chat.deleted`; after an event-stream reconnect every loaded chat is fetched again (useServerEvents).
// Signature frozen from Gate P10-0b (C33); implementation W10.10. Per-chat versions like chat-queue: every event, local
// change and fetch start bumps the chat's version, so an answer of an older fetch never replaces a newer list.
// P10-0b: `fetch` sends no request yet (the route answers 501 until W10.4); events, stops and the getters work.
import type { BackgroundTask, ServerEvent } from '@harness-forge/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { visibleTasks } from '~/components/chat/background/background-agents'
import { useApi } from '~/composables/useApi'
import { hasErrorCode, withHarnessErrors } from '~/utils/errors'

const NO_TASKS: readonly BackgroundTask[] = Object.freeze([])

/** Newest first, like the route. */
function byNewest(a: BackgroundTask, b: BackgroundTask): number {
  return b.createdAt - a.createdAt
}

export const useBackgroundTasksStore = defineStore('background-tasks', () => {
  const api = useApi()

  // ---------- state ----------

  /** The background tasks of each chat, newest first (a chat without tasks may have no entry). */
  const byChat = ref<Record<string, BackgroundTask[]>>({})
  /** Chats whose list was fetched (refetched after a reconnect). */
  const loaded = ref<Record<string, true>>({})
  /** Task ids with a stop in flight. */
  const stopping = ref<Record<string, true>>({})

  // Not state: per chat, bumped by every event, local change and fetch start.
  const versions = new Map<string, number>()

  // ---------- getters ----------

  /** `tasks(chatId)`: the chat's background tasks, newest first; [] when unknown. */
  const tasks = computed(() => (chatId: string): readonly BackgroundTask[] => byChat.value[chatId] ?? NO_TASKS)
  /** `visible(chatId)`: what the dock shows (running, or finished and not delivered yet). */
  const visible = computed(() => (chatId: string): readonly BackgroundTask[] => visibleTasks(byChat.value[chatId] ?? NO_TASKS))
  /** `byId(chatId, taskId)`: one task, or null. */
  const byId = computed(() => (chatId: string, taskId: string): BackgroundTask | null =>
    byChat.value[chatId]?.find(task => task.id === taskId) ?? null)

  // ---------- helpers ----------

  function bump(chatId: string): number {
    const next = (versions.get(chatId) ?? 0) + 1
    versions.set(chatId, next)
    return next
  }

  function setTasks(chatId: string, next: readonly BackgroundTask[]): void {
    byChat.value = { ...byChat.value, [chatId]: [...next].sort(byNewest) }
  }

  /** Puts the task into its chat's list (replacing the row with its id). */
  function upsert(task: BackgroundTask): void {
    bump(task.chatId)
    const current = byChat.value[task.chatId] ?? []
    setTasks(task.chatId, [...current.filter(item => item.id !== task.id), task])
  }

  function setStopping(taskId: string, on: boolean): void {
    if (on) {
      stopping.value = { ...stopping.value, [taskId]: true }
    }
    else if (stopping.value[taskId]) {
      const { [taskId]: _stopping, ...rest } = stopping.value
      stopping.value = rest
    }
  }

  function forget(chatId: string): void {
    versions.delete(chatId)
    if (chatId in byChat.value) {
      const { [chatId]: _tasks, ...rest } = byChat.value
      byChat.value = rest
    }
    if (chatId in loaded.value) {
      const { [chatId]: _loaded, ...rest } = loaded.value
      loaded.value = rest
    }
  }

  // ---------- actions ----------

  /**
   * `GET /chat/:id/tasks`: replaces the chat's list and marks it loaded (W10.10). P10-0b: resolves without a request
   * (the route is a 501 stub until W10.4), so chat loads stay quiet. Throws `HarnessError` once implemented.
   */
  async function fetch(chatId: string): Promise<void> {
    bump(chatId)
  }

  /**
   * `POST /chat/:id/tasks/:taskId/stop`: the returned task is upserted; 'stopped' when it answers `aborted`, 'gone' when
   * it had already ended with another status (the route answers an ended task as it is) or on a 404. Throws
   * `HarnessError` for other failures.
   */
  async function stop(chatId: string, taskId: string): Promise<'stopped' | 'gone'> {
    setStopping(taskId, true)
    try {
      const task = await withHarnessErrors(api.chatTasks.stop({ params: { id: chatId, taskId } }))
      upsert(task)
      return task.status === 'aborted' ? 'stopped' : 'gone'
    }
    catch (error) {
      if (hasErrorCode(error, 'not_found'))
        return 'gone'
      throw error
    }
    finally {
      setStopping(taskId, false)
    }
  }

  /** `stop()` for every running task of the chat in turn (there is no batch route); resolves with the number stopped. */
  async function stopAll(chatId: string): Promise<number> {
    let stopped = 0
    for (const task of (byChat.value[chatId] ?? []).filter(item => item.status === 'running')) {
      if (await stop(chatId, task.id) === 'stopped')
        stopped += 1
    }
    return stopped
  }

  /** `task.changed`: upsert (an event never loses to an older fetch); `chat.deleted`: drop the chat. */
  function applyEvent(event: ServerEvent): void {
    if (event.type === 'task.changed')
      upsert(event.data.task)
    else if (event.type === 'chat.deleted')
      forget(event.data.id)
  }

  /** Refetches every loaded chat (after the event stream reconnects: missed events are not replayed). */
  async function refreshLoaded(): Promise<void> {
    await Promise.allSettled(Object.keys(loaded.value).map(chatId => fetch(chatId)))
  }

  return {
    byChat,
    loaded,
    stopping,
    tasks,
    visible,
    byId,
    fetch,
    stop,
    stopAll,
    applyEvent,
    refreshLoaded,
  }
})
