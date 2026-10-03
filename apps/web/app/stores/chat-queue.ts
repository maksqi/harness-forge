// Chat queue store (docs/UI.md 7.26, 11.6; docs/API.md 4.24; ADR-042): the messages a user sent while a run was active,
// per chat, as the server's in-memory queue holds them. Lists live only in memory (the server's queue does not survive
// a restart either). `queue.changed` (SSE) replaces a chat's list in every tab, `chat.deleted` drops it, and after an
// event-stream reconnect every loaded chat is fetched again (useServerEvents).
// Signature frozen from Gate P9-0b (C25); implementation W9.9 (`fetch`, `enqueue`, `cancel` and `refreshLoaded` through
// the `chatQueue.*` routes; an answer of an older fetch never replaces a newer event). P9-0b: the state, the getter,
// `markDelivered` and `applyEvent` work; the request actions are inert (`fetch` / `refreshLoaded` send nothing,
// `enqueue` / `cancel` reject with `not_implemented`).
import type { QueueAddBody, QueueItem, ServerEvent } from '@harness-forge/shared'
import { HarnessError } from '@harness-forge/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

const NO_ITEMS: readonly QueueItem[] = Object.freeze([])

function notImplemented(): HarnessError {
  return new HarnessError({ code: 'not_implemented', message: 'The message queue is not available yet.' })
}

export const useChatQueueStore = defineStore('chat-queue', () => {
  // ---------- state ----------

  /** The queue of each chat, oldest first. */
  const byChat = ref<Record<string, QueueItem[]>>({})
  /** Chats whose queue was fetched (refetched after a reconnect). */
  const loaded = ref<Record<string, true>>({})

  // ---------- getters ----------

  /** `items(chatId)`: the chat's queue, oldest first; [] when unknown. */
  const items = computed(() => (chatId: string): readonly QueueItem[] => byChat.value[chatId] ?? NO_ITEMS)

  // ---------- helpers ----------

  function setItems(chatId: string, next: QueueItem[]): void {
    byChat.value = { ...byChat.value, [chatId]: next }
  }

  function forget(chatId: string): void {
    if (chatId in byChat.value) {
      const { [chatId]: _items, ...rest } = byChat.value
      byChat.value = rest
    }
    if (chatId in loaded.value) {
      const { [chatId]: _loaded, ...rest } = loaded.value
      loaded.value = rest
    }
  }

  // ---------- actions ----------

  /** `GET /chat/:id/queue`: replaces the chat's list. P9-0b stub: sends nothing. */
  async function fetch(_chatId: string): Promise<void> {}

  /**
   * `POST /chat/:id/queue { message, modelRef, reasoningEffort, toolMode }`: the stored item joins the list. Throws
   * `HarnessError` (409 `run-idle` / `queue-full` / `exists`, 400, 404). P9-0b stub: rejects with `not_implemented`.
   */
  async function enqueue(_chatId: string, _body: QueueAddBody): Promise<QueueItem> {
    throw notImplemented()
  }

  /**
   * `DELETE /chat/:id/queue/:itemId`: 204 -> 'cancelled' (the item leaves the list), 404 -> 'gone' (delivered or
   * started meanwhile). P9-0b stub: rejects with `not_implemented`.
   */
  async function cancel(_chatId: string, _itemId: string): Promise<'cancelled' | 'gone'> {
    throw notImplemented()
  }

  /** A `data-steer` chunk of the item arrived in the chat's stream: the row leaves the list now. */
  function markDelivered(chatId: string, itemId: string): void {
    const current = byChat.value[chatId]
    if (current?.some(item => item.id === itemId))
      setItems(chatId, current.filter(item => item.id !== itemId))
  }

  /** `queue.changed`: the event's list replaces the chat's list; `chat.deleted`: the chat's list is dropped. */
  function applyEvent(event: ServerEvent): void {
    if (event.type === 'queue.changed')
      setItems(event.data.chatId, [...event.data.items])
    else if (event.type === 'chat.deleted')
      forget(event.data.id)
  }

  /** After an event-stream reconnect: fetches the queue of every loaded chat again. */
  async function refreshLoaded(): Promise<void> {
    await Promise.allSettled(Object.keys(loaded.value).map(chatId => fetch(chatId)))
  }

  return { byChat, loaded, items, fetch, enqueue, cancel, markDelivered, applyEvent, refreshLoaded }
})
