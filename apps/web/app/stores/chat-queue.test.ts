// Chat queue store (docs/UI.md 7.26, 11.6; docs/API.md 4.26, 5.26; W9.9-T1): the per-chat lists, the three routes
// (`chatQueue.list` / `add` / `remove`) through a mocked `$api`, the events (`queue.changed`, `chat.deleted`), the
// reconnect refetch, and the races: an older fetch never replaces a newer event, a message that left the queue never
// comes back, and a failed removal is reported only in the tab that queued the message.
import type { QueueAddBody, QueueItem } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatId, messageId, queueItem } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { QUEUE_SEND_FAILED_MESSAGE, useChatQueueStore } from './chat-queue'

const mock = vi.hoisted(() => ({ api: null as unknown, toastError: vi.fn() }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), { error: (...args: unknown[]) => mock.toastError(...args) }) }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  mock.toastError.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function addBody(item: QueueItem): QueueAddBody {
  return { message: item.message, modelRef: item.modelRef, reasoningEffort: item.reasoningEffort, toolMode: item.toolMode }
}

function conflict(reason: string): HarnessError {
  return new HarnessError({ code: 'conflict', message: 'Conflict.', details: { reason } })
}

const first = queueItem()
const second = queueItem({ id: messageId('queued2'), text: 'Check the lexer too' })

describe('chat-queue store: shape and events', () => {
  it('starts empty per chat', () => {
    const store = useChatQueueStore()
    expect(store.byChat).toEqual({})
    expect(store.loaded).toEqual({})
    expect(store.items(chatId(1))).toEqual([])
  })

  it('replaces a chat\'s list on queue.changed and drops it on chat.deleted', () => {
    const store = useChatQueueStore()
    store.applyEvent(createServerEvent('queue.changed', { chatId: chatId(1), items: [first, second] }))
    store.applyEvent(createServerEvent('queue.changed', { chatId: chatId(2), items: [first] }))
    expect(store.items(chatId(1)).map(item => item.id)).toEqual([first.id, second.id])
    store.applyEvent(createServerEvent('queue.changed', { chatId: chatId(1), items: [second], removed: [{ id: first.id, reason: 'delivered' }] }))
    expect(store.items(chatId(1)).map(item => item.id)).toEqual([second.id])
    store.applyEvent(createServerEvent('chat.deleted', { id: chatId(1) }))
    expect(store.items(chatId(1))).toEqual([])
    expect(store.byChat).not.toHaveProperty(chatId(1))
    expect(store.items(chatId(2))).toHaveLength(1)
  })

  it('keeps no entry for an emptied queue', () => {
    const store = useChatQueueStore()
    store.applyEvent(createServerEvent('queue.changed', { chatId: chatId(1), items: [first] }))
    store.applyEvent(createServerEvent('queue.changed', { chatId: chatId(1), items: [], removed: [{ id: first.id, reason: 'started' }] }))
    expect(store.byChat).toEqual({})
  })

  it('drops a delivered item at once, and a late event never shows it again', () => {
    const store = useChatQueueStore()
    store.applyEvent(createServerEvent('queue.changed', { chatId: chatId(1), items: [first, second] }))
    store.markDelivered(chatId(1), messageId('unknown'))
    expect(store.items(chatId(1))).toHaveLength(2)
    store.markDelivered(chatId(1), first.id)
    expect(store.items(chatId(1)).map(item => item.id)).toEqual([second.id])
    // The event of the add, delayed behind the steer chunk.
    store.applyEvent(createServerEvent('queue.changed', { chatId: chatId(1), items: [first, second] }))
    expect(store.items(chatId(1)).map(item => item.id)).toEqual([second.id])
  })

  it('reports a failed removal only for a message this tab queued, with the server\'s error', async () => {
    const store = useChatQueueStore()
    api.chatQueue.add.mockResolvedValue(first)
    await store.enqueue(chatId(1), addBody(first))
    store.applyEvent(createServerEvent('queue.changed', {
      chatId: chatId(1),
      items: [],
      removed: [{ id: first.id, reason: 'failed', error: 'The model is not available.' }, { id: second.id, reason: 'failed' }],
    }))
    expect(mock.toastError.mock.calls).toEqual([[QUEUE_SEND_FAILED_MESSAGE, { description: 'The model is not available.' }]])
    expect(store.items(chatId(1))).toEqual([])
    // Other reasons are silent.
    mock.toastError.mockReset()
    store.applyEvent(createServerEvent('queue.changed', { chatId: chatId(1), items: [], removed: [{ id: first.id, reason: 'stopped' }] }))
    expect(mock.toastError).not.toHaveBeenCalled()
  })
})

describe('chat-queue store: fetch', () => {
  it('loads a chat\'s queue and marks it loaded', async () => {
    const store = useChatQueueStore()
    api.chatQueue.list.mockResolvedValue({ items: [first, second] })
    await store.fetch(chatId(1))
    expect(api.chatQueue.list).toHaveBeenCalledWith({ params: { id: chatId(1) } })
    expect(store.items(chatId(1)).map(item => item.id)).toEqual([first.id, second.id])
    expect(store.loaded).toEqual({ [chatId(1)]: true })
  })

  it('never lets an older answer replace a newer event', async () => {
    const store = useChatQueueStore()
    const answer = deferred<{ items: QueueItem[] }>()
    api.chatQueue.list.mockReturnValueOnce(answer.promise)
    const loading = store.fetch(chatId(1))
    store.applyEvent(createServerEvent('queue.changed', { chatId: chatId(1), items: [second] }))
    answer.resolve({ items: [first] })
    await loading
    expect(store.items(chatId(1)).map(item => item.id)).toEqual([second.id])
    expect(store.loaded[chatId(1)]).toBe(true)
  })

  it('applies only the latest of two overlapping fetches', async () => {
    const store = useChatQueueStore()
    const older = deferred<{ items: QueueItem[] }>()
    const newer = deferred<{ items: QueueItem[] }>()
    api.chatQueue.list.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const a = store.fetch(chatId(1))
    const b = store.fetch(chatId(1))
    newer.resolve({ items: [second] })
    await b
    older.resolve({ items: [first, second] })
    await a
    expect(store.items(chatId(1)).map(item => item.id)).toEqual([second.id])
  })

  it('throws a HarnessError for an unknown chat and keeps the list', async () => {
    const store = useChatQueueStore()
    store.applyEvent(createServerEvent('queue.changed', { chatId: chatId(1), items: [first] }))
    api.chatQueue.list.mockRejectedValue(new HarnessError({ code: 'not_found', message: 'Chat not found.' }))
    await expect(store.fetch(chatId(1))).rejects.toSatisfy((error: HarnessError) => error.code === 'not_found')
    expect(store.items(chatId(1))).toHaveLength(1)
    expect(store.loaded).toEqual({})
  })

  it('refetches only the loaded chats after a reconnect; a failure keeps the others going', async () => {
    const store = useChatQueueStore()
    api.chatQueue.list.mockResolvedValue({ items: [] })
    await store.fetch(chatId(1))
    await store.fetch(chatId(2))
    // Seen through an event only: not loaded.
    store.applyEvent(createServerEvent('queue.changed', { chatId: chatId(3), items: [first] }))
    api.chatQueue.list.mockReset()
    api.chatQueue.list
      .mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Oops.' }))
      .mockResolvedValueOnce({ items: [second] })
    await expect(store.refreshLoaded()).resolves.toBeUndefined()
    expect(api.chatQueue.list.mock.calls.map(([input]) => input.params.id)).toEqual([chatId(1), chatId(2)])
    expect(store.items(chatId(2)).map(item => item.id)).toEqual([second.id])
    expect(store.items(chatId(3))).toHaveLength(1)
  })

  it('a deleted chat is no longer refetched', async () => {
    const store = useChatQueueStore()
    api.chatQueue.list.mockResolvedValue({ items: [first] })
    await store.fetch(chatId(1))
    store.applyEvent(createServerEvent('chat.deleted', { id: chatId(1) }))
    expect(store.loaded).toEqual({})
    await store.refreshLoaded()
    expect(api.chatQueue.list).toHaveBeenCalledTimes(1)
  })
})

describe('chat-queue store: enqueue', () => {
  it('posts the message with the composer state and adds the stored item', async () => {
    const store = useChatQueueStore()
    api.chatQueue.add.mockResolvedValue(first)
    await expect(store.enqueue(chatId(1), addBody(first))).resolves.toEqual(first)
    expect(api.chatQueue.add).toHaveBeenCalledWith({ params: { id: chatId(1) }, body: addBody(first) })
    expect(store.items(chatId(1))).toEqual([first])
  })

  it('adds the item once when its event arrived first', async () => {
    const store = useChatQueueStore()
    api.chatQueue.add.mockImplementation(async () => {
      store.applyEvent(createServerEvent('queue.changed', { chatId: chatId(1), items: [second, first] }))
      return first
    })
    await store.enqueue(chatId(1), addBody(first))
    expect(store.items(chatId(1)).map(item => item.id)).toEqual([second.id, first.id])
  })

  it('does not bring back an item delivered before the answer arrived', async () => {
    const store = useChatQueueStore()
    api.chatQueue.add.mockImplementation(async () => {
      // The step boundary took it at once: the steer chunk (and the event) beat the answer.
      store.markDelivered(chatId(1), first.id)
      return first
    })
    await store.enqueue(chatId(1), addBody(first))
    expect(store.items(chatId(1))).toEqual([])
  })

  it('a fetch that started before the add does not drop the new item', async () => {
    const store = useChatQueueStore()
    const answer = deferred<{ items: QueueItem[] }>()
    api.chatQueue.list.mockReturnValueOnce(answer.promise)
    api.chatQueue.add.mockResolvedValue(first)
    const loading = store.fetch(chatId(1))
    await store.enqueue(chatId(1), addBody(first))
    answer.resolve({ items: [] })
    await loading
    expect(store.items(chatId(1))).toEqual([first])
  })

  it('throws the conflicts as HarnessError and adds nothing', async () => {
    const store = useChatQueueStore()
    for (const reason of ['run-idle', 'queue-full', 'exists']) {
      api.chatQueue.add.mockRejectedValueOnce(conflict(reason))
      await expect(store.enqueue(chatId(1), addBody(first)))
        .rejects
        .toSatisfy((error: HarnessError) => error instanceof HarnessError && (error.details as { reason: string }).reason === reason)
    }
    expect(store.items(chatId(1))).toEqual([])
  })
})

describe('chat-queue store: cancel', () => {
  it('204: cancelled, and the row leaves the list', async () => {
    const store = useChatQueueStore()
    store.applyEvent(createServerEvent('queue.changed', { chatId: chatId(1), items: [first, second] }))
    api.chatQueue.remove.mockResolvedValue(undefined)
    await expect(store.cancel(chatId(1), first.id)).resolves.toBe('cancelled')
    expect(api.chatQueue.remove).toHaveBeenCalledWith({ params: { id: chatId(1), itemId: first.id } })
    expect(store.items(chatId(1)).map(item => item.id)).toEqual([second.id])
  })

  it('404: gone (delivered or started meanwhile), and the row leaves the list', async () => {
    const store = useChatQueueStore()
    store.applyEvent(createServerEvent('queue.changed', { chatId: chatId(1), items: [first] }))
    api.chatQueue.remove.mockRejectedValue(new HarnessError({ code: 'not_found', message: 'Not queued.' }))
    await expect(store.cancel(chatId(1), first.id)).resolves.toBe('gone')
    expect(store.items(chatId(1))).toEqual([])
  })

  it('other failures are thrown and keep the row', async () => {
    const store = useChatQueueStore()
    store.applyEvent(createServerEvent('queue.changed', { chatId: chatId(1), items: [first] }))
    api.chatQueue.remove.mockRejectedValue(new HarnessError({ code: 'internal_error', message: 'Oops.' }))
    await expect(store.cancel(chatId(1), first.id)).rejects.toSatisfy((error: HarnessError) => error.code === 'internal_error')
    expect(store.items(chatId(1))).toEqual([first])
  })
})
