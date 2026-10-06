// Chat queue store (docs/UI.md 7.26, 11.6; docs/API.md 4.26, 5.26; ADR-042): the messages a user sent while a run was
// active, per chat, as the server's in-memory queue holds them. Lists live only in memory (the server's queue does not
// survive a restart either). `queue.changed` (SSE) replaces a chat's list in every tab, `chat.deleted` drops it, and
// after an event-stream reconnect every loaded chat is fetched again (useServerEvents).
// Signature frozen from Gate P9-0b (C25); implementation W9.9:
// - every local change and every event bumps the chat's version: an answer of a fetch that started before it (or of an
//   older fetch) never replaces the newer list;
// - a message that left the queue (delivered, started, cancelled, stopped, failed) never comes back: its id is
//   remembered (bounded), so a late `POST` answer or a late event cannot show it again (ids are never reused);
// - a `failed` removal of a message this tab queued shows "Couldn't send a queued message." with the server's error;
// - + Phase 11 (W11.11): a message refused at enqueue (409 `hook-blocked` / `untrusted`) was never queued: the error is
//   rethrown as it came (ChatView puts the message back into the composer with the refusal) and the list stays as is.
import type { QueueAddBody, QueueItem, QueueRemoval, ServerEvent } from '@harness-forge/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { useApi } from '~/composables/useApi'
import { hasErrorCode, toHarnessError, withHarnessErrors } from '~/utils/errors'

const NO_ITEMS: readonly QueueItem[] = Object.freeze([])

/** The toast when a cancel loses against the step boundary or the next turn (docs/UI.md 7.26). */
export const QUEUE_ITEM_GONE_MESSAGE = 'Already sent to the agent.'
/** The toast of a `failed` removal in the tab that queued the message (docs/UI.md 7.26). */
export const QUEUE_SEND_FAILED_MESSAGE = 'Couldn\'t send a queued message.'

/** How many departed and own message ids are remembered (oldest forgotten first). */
const REMEMBERED_IDS_MAX = 500

/** A set that forgets its oldest entries above `REMEMBERED_IDS_MAX`. */
function rememberId(set: Set<string>, id: string): void {
  set.delete(id)
  set.add(id)
  if (set.size > REMEMBERED_IDS_MAX)
    set.delete(set.values().next().value!)
}

export const useChatQueueStore = defineStore('chat-queue', () => {
  const api = useApi()

  // ---------- state ----------

  /** The queue of each chat, oldest first (a chat whose queue is empty has no entry). */
  const byChat = ref<Record<string, QueueItem[]>>({})
  /** Chats whose queue was fetched (refetched after a reconnect). */
  const loaded = ref<Record<string, true>>({})

  // Not state: bookkeeping of the requests and events.
  /** Per chat: bumped by every event, local change and fetch start (a fetch applies only when nothing came after it). */
  const versions = new Map<string, number>()
  /** Ids of messages that left a queue: never shown again. */
  const departed = new Set<string>()
  /** Ids of messages this tab queued (a `failed` removal is reported here only). */
  const own = new Set<string>()

  // ---------- getters ----------

  /** `items(chatId)`: the chat's queue, oldest first; [] when unknown. */
  const items = computed(() => (chatId: string): readonly QueueItem[] => byChat.value[chatId] ?? NO_ITEMS)

  // ---------- helpers ----------

  function bump(chatId: string): number {
    const next = (versions.get(chatId) ?? 0) + 1
    versions.set(chatId, next)
    return next
  }

  function setItems(chatId: string, next: readonly QueueItem[]): void {
    const kept = next.filter(item => !departed.has(item.id))
    if (kept.length > 0) {
      byChat.value = { ...byChat.value, [chatId]: kept }
    }
    else if (chatId in byChat.value) {
      const { [chatId]: _items, ...rest } = byChat.value
      byChat.value = rest
    }
  }

  /** The message left the chat's queue: drop its row now and never show it again. */
  function drop(chatId: string, itemId: string): void {
    rememberId(departed, itemId)
    bump(chatId)
    const current = byChat.value[chatId]
    if (current?.some(item => item.id === itemId))
      setItems(chatId, current)
  }

  function forget(chatId: string): void {
    versions.delete(chatId)
    setItems(chatId, [])
    if (chatId in loaded.value) {
      const { [chatId]: _loaded, ...rest } = loaded.value
      loaded.value = rest
    }
  }

  function reportFailures(removed: readonly QueueRemoval[] | undefined): void {
    for (const removal of removed ?? []) {
      rememberId(departed, removal.id)
      if (removal.reason === 'failed' && own.has(removal.id))
        toast.error(QUEUE_SEND_FAILED_MESSAGE, removal.error ? { description: removal.error } : undefined)
    }
  }

  // ---------- actions ----------

  /**
   * `GET /chat/:id/queue`: replaces the chat's list and marks it loaded. Dropped when an event, a local change or another
   * fetch of the chat came after it started. Throws `HarnessError` (404 for an unknown chat).
   */
  async function fetch(chatId: string): Promise<void> {
    const version = bump(chatId)
    const list = await withHarnessErrors(api.chatQueue.list({ params: { id: chatId } }))
    if (!loaded.value[chatId])
      loaded.value = { ...loaded.value, [chatId]: true }
    if (versions.get(chatId) === version)
      setItems(chatId, list.items)
  }

  /**
   * `POST /chat/:id/queue { message, modelRef, reasoningEffort, toolMode }`: the stored item joins the list (once: the
   * `queue.changed` of the add may arrive first, and an item delivered meanwhile stays gone). Throws `HarnessError`
   * (409 `run-idle` / `queue-full` / `exists`, 400, 404; + Phase 11: 409 `hook-blocked` with `details.hook` when a
   * UserPromptSubmit hook refused the message at enqueue, 409 `untrusted` for a project command with unapproved shell
   * lines: nothing was queued, the list is unchanged and the caller puts the message back into the composer).
   */
  async function enqueue(chatId: string, body: QueueAddBody): Promise<QueueItem> {
    // Before the request: a `failed` event may beat its answer.
    rememberId(own, body.message.id)
    let item: QueueItem
    try {
      item = await withHarnessErrors(api.chatQueue.add({ params: { id: chatId }, body }))
    }
    catch (error) {
      // A refusal (`409 conflict`, except `exists`: that id is queued or stored already) queued nothing: the id is no
      // longer one of ours.
      if (hasErrorCode(error, 'conflict') && (toHarnessError(error).details as { reason?: unknown } | undefined)?.reason !== 'exists')
        own.delete(body.message.id)
      throw error
    }
    const current = byChat.value[chatId] ?? []
    if (!departed.has(item.id) && !current.some(entry => entry.id === item.id)) {
      bump(chatId)
      setItems(chatId, [...current, item])
    }
    return item
  }

  /**
   * `DELETE /chat/:id/queue/:itemId`: 204 -> 'cancelled', 404 -> 'gone' (delivered or started meanwhile); either way the
   * item leaves the list. Other failures are thrown (`HarnessError`) and keep the list.
   */
  async function cancel(chatId: string, itemId: string): Promise<'cancelled' | 'gone'> {
    try {
      await withHarnessErrors(api.chatQueue.remove({ params: { id: chatId, itemId } }))
    }
    catch (error) {
      if (!hasErrorCode(error, 'not_found'))
        throw error
      drop(chatId, itemId)
      return 'gone'
    }
    drop(chatId, itemId)
    return 'cancelled'
  }

  /**
   * A `data-steer` chunk of the item arrived in the chat's stream: the row leaves the list now (also used for the items
   * a Stop dropped).
   */
  function markDelivered(chatId: string, itemId: string): void {
    drop(chatId, itemId)
  }

  /** `queue.changed`: the event's list replaces the chat's list; `chat.deleted`: the chat's list is dropped. */
  function applyEvent(event: ServerEvent): void {
    if (event.type === 'queue.changed') {
      reportFailures(event.data.removed)
      bump(event.data.chatId)
      setItems(event.data.chatId, event.data.items)
    }
    else if (event.type === 'chat.deleted') {
      forget(event.data.id)
    }
  }

  /** After an event-stream reconnect: fetches the queue of every loaded chat again (failures keep the old list). */
  async function refreshLoaded(): Promise<void> {
    await Promise.allSettled(Object.keys(loaded.value).map(chatId => fetch(chatId)))
  }

  return { byChat, loaded, items, fetch, enqueue, cancel, markDelivered, applyEvent, refreshLoaded }
})
