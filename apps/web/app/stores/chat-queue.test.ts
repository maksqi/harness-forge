import type { HarnessError } from '@harness-forge/shared'
import { createServerEvent } from '@harness-forge/shared'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { chatId, messageId, queueItem } from '~/utils/testing/fixtures'
import { useChatQueueStore } from './chat-queue'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('chat-queue store (P9-0b shape)', () => {
  it('starts empty per chat', () => {
    const store = useChatQueueStore()
    expect(store.byChat).toEqual({})
    expect(store.loaded).toEqual({})
    expect(store.items(chatId(1))).toEqual([])
  })

  it('replaces a chat\'s list on queue.changed and drops it on chat.deleted', () => {
    const store = useChatQueueStore()
    const first = queueItem()
    const second = queueItem({ id: messageId('queued2'), text: 'Second' })
    store.applyEvent(createServerEvent('queue.changed', { chatId: chatId(1), items: [first, second] }))
    store.applyEvent(createServerEvent('queue.changed', { chatId: chatId(2), items: [first] }))
    expect(store.items(chatId(1)).map(item => item.id)).toEqual([first.id, second.id])
    store.applyEvent(createServerEvent('queue.changed', { chatId: chatId(1), items: [second], removed: [{ id: first.id, reason: 'delivered' }] }))
    expect(store.items(chatId(1)).map(item => item.id)).toEqual([second.id])
    store.applyEvent(createServerEvent('chat.deleted', { id: chatId(1) }))
    expect(store.items(chatId(1))).toEqual([])
    expect(store.items(chatId(2))).toHaveLength(1)
  })

  it('drops a delivered item at once', () => {
    const store = useChatQueueStore()
    const first = queueItem()
    store.applyEvent(createServerEvent('queue.changed', { chatId: chatId(1), items: [first] }))
    store.markDelivered(chatId(1), messageId('unknown'))
    expect(store.items(chatId(1))).toHaveLength(1)
    store.markDelivered(chatId(1), first.id)
    expect(store.items(chatId(1))).toEqual([])
  })

  it('keeps the request actions inert until W9.9', async () => {
    const store = useChatQueueStore()
    await expect(store.fetch(chatId(1))).resolves.toBeUndefined()
    await expect(store.refreshLoaded()).resolves.toBeUndefined()
    await expect(store.enqueue(chatId(1), { message: queueItem().message, modelRef: 'mock:echo', reasoningEffort: 'auto', toolMode: 'ask' }))
      .rejects
      .toSatisfy((error: HarnessError) => error.code === 'not_implemented')
    await expect(store.cancel(chatId(1), messageId('queued1'))).rejects.toSatisfy((error: HarnessError) => error.code === 'not_implemented')
  })
})
