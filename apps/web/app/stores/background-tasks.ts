// Background tasks store (docs/UI.md 7.29, 11.7; docs/API.md 4.29, 5.30; ADR-046): the background agents of each chat,
// as `GET /chat/:id/tasks` lists them (newest first), kept current by `task.changed` (an upsert in every tab) and
// dropped by `chat.deleted`; after an event-stream reconnect every loaded chat is fetched again (useServerEvents).
// Signature frozen from Gate P10-0b (C33); implementation W10.10:
// - per-chat versions like chat-queue: every event, local change and fetch start bumps the chat's version. A fetch that
//   nothing came after replaces the list; otherwise its rows are merged, so an answer of an older fetch never replaces a
//   newer row and a task that only an event reported stays listed;
// - a snapshot never loses to an older one (`isOlderSnapshot`): a delivered task is newer than an ended one, an ended
//   one newer than a running one, and a running one with fewer tool calls is older (the server keeps no `updatedAt`);
// - a deleted chat never comes back (its id is remembered, bounded): late events, fetch and stop answers are dropped;
// - one stop per task at a time (a second `stop` of the same task joins the first).
import type { BackgroundTask, ServerEvent } from '@harness-forge/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { isRunningTask, visibleTasks } from '~/components/chat/background/background-agents'
import { useApi } from '~/composables/useApi'
import { hasErrorCode, withHarnessErrors } from '~/utils/errors'

const NO_TASKS: readonly BackgroundTask[] = Object.freeze([])

/** How many deleted chat ids are remembered (oldest forgotten first). */
const DELETED_CHATS_MAX = 500

/** Newest first, like the route. */
function byNewest(a: BackgroundTask, b: BackgroundTask): number {
  return b.createdAt - a.createdAt
}

/** 0 running, 1 ended and not delivered, 2 delivered: a task only ever moves forward. */
function stageOf(task: BackgroundTask): number {
  if (task.deliveredAt !== null)
    return 2
  return isRunningTask(task) ? 0 : 1
}

/** Every tool call of the snapshot (kept steps and the earlier ones the server dropped): it only grows while it runs. */
function progressOf(task: BackgroundTask): number {
  return task.output.steps.length + task.output.stepsOmitted
}

/**
 * Whether `next` is an older snapshot of the task than `current` (it must not replace it): an earlier stage, or, while
 * both run, fewer tool calls. Equal snapshots are not older.
 */
function isOlderSnapshot(next: BackgroundTask, current: BackgroundTask): boolean {
  const stage = stageOf(next) - stageOf(current)
  if (stage !== 0)
    return stage < 0
  return stageOf(next) === 0 && progressOf(next) < progressOf(current)
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

  // Not state: bookkeeping of the requests and events.
  /** Per chat, bumped by every event, local change and fetch start. */
  const versions = new Map<string, number>()
  /** Deleted chats: nothing is listed for them again. */
  const deleted = new Set<string>()
  /** The stop in flight per task (a second Stop joins it). */
  const stops = new Map<string, Promise<'stopped' | 'gone'>>()

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
    if (next.length === 0 && !(chatId in byChat.value))
      return
    byChat.value = { ...byChat.value, [chatId]: [...next].sort(byNewest) }
  }

  /** Puts the task into its chat's list (replacing the row with its id), unless it is older than the listed row. */
  function upsert(task: BackgroundTask): void {
    if (deleted.has(task.chatId))
      return
    bump(task.chatId)
    const current = byChat.value[task.chatId] ?? []
    const known = current.find(item => item.id === task.id)
    if (known && isOlderSnapshot(task, known))
      return
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
    deleted.delete(chatId)
    deleted.add(chatId)
    if (deleted.size > DELETED_CHATS_MAX)
      deleted.delete(deleted.values().next().value!)
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
   * `GET /chat/:id/tasks`: replaces the chat's list and marks it loaded. When an event, a stop or another fetch of the
   * chat came after it started, its rows are merged instead (a newer row wins, a row only an event reported stays).
   * Throws `HarnessError` (404 for an unknown chat).
   */
  async function fetch(chatId: string): Promise<void> {
    const version = bump(chatId)
    const list = await withHarnessErrors(api.chatTasks.list({ params: { id: chatId } }))
    if (deleted.has(chatId))
      return
    if (!loaded.value[chatId])
      loaded.value = { ...loaded.value, [chatId]: true }
    if (versions.get(chatId) === version) {
      setTasks(chatId, list.items)
      return
    }
    const merged = new Map((byChat.value[chatId] ?? []).map(task => [task.id, task]))
    for (const task of list.items) {
      const known = merged.get(task.id)
      if (!known || isOlderSnapshot(known, task))
        merged.set(task.id, task)
    }
    setTasks(chatId, [...merged.values()])
  }

  async function sendStop(chatId: string, taskId: string): Promise<'stopped' | 'gone'> {
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
      stops.delete(taskId)
    }
  }

  /**
   * `POST /chat/:id/tasks/:taskId/stop`: the returned task is upserted; 'stopped' when it answers `aborted`, 'gone' when
   * it had already ended with another status (the route answers an ended task as it is) or on a 404. Throws
   * `HarnessError` for other failures. A stop of a task whose stop is in flight joins it.
   */
  function stop(chatId: string, taskId: string): Promise<'stopped' | 'gone'> {
    const pending = stops.get(taskId)
    if (pending)
      return pending
    const next = sendStop(chatId, taskId)
    stops.set(taskId, next)
    return next
  }

  /**
   * `stop()` for every running task of the chat in turn (there is no batch route); resolves with the number stopped. A
   * failure does not keep the others running: the first one is thrown once every task was tried.
   */
  async function stopAll(chatId: string): Promise<number> {
    let stopped = 0
    let failure: unknown = null
    for (const task of (byChat.value[chatId] ?? []).filter(isRunningTask)) {
      try {
        if (await stop(chatId, task.id) === 'stopped')
          stopped += 1
      }
      catch (error) {
        failure ??= error
      }
    }
    if (failure !== null)
      throw failure
    return stopped
  }

  /** `task.changed`: upsert (an event never loses to an older fetch); `chat.deleted`: drop the chat. */
  function applyEvent(event: ServerEvent): void {
    if (event.type === 'task.changed') {
      // The event's chat id is the authority (the task names the same chat).
      upsert(event.data.task.chatId === event.data.chatId ? event.data.task : { ...event.data.task, chatId: event.data.chatId })
    }
    else if (event.type === 'chat.deleted') {
      forget(event.data.id)
    }
  }

  /**
   * Refetches every loaded chat after the event stream reconnects (missed events are not replayed), and every chat that
   * lists a running task only events reported (a new chat's first reply launched it): its end may have been missed.
   */
  async function refreshLoaded(): Promise<void> {
    const chats = new Set(Object.keys(loaded.value))
    for (const [chatId, list] of Object.entries(byChat.value)) {
      if (list.some(isRunningTask))
        chats.add(chatId)
    }
    await Promise.allSettled([...chats].map(chatId => fetch(chatId)))
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
