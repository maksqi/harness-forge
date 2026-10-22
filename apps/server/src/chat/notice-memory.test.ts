// The once-per-chat notice memory (Phase 14, C52): remember / has, the bounds, the event-driven clearing, stop.
import type { ServerEvent } from '@harness-forge/shared'
import type { ServerEventListener } from '../services/events/types.ts'
import { describe, expect, it } from 'vitest'
import { createNoticeMemory, NOTICE_MEMORY_CHATS_MAX, NOTICE_MEMORY_KEYS_MAX } from './notice-memory.ts'

/** A bus that keeps its listeners (`emit` calls them; `disposed` counts disposals). */
function fakeBus() {
  const listeners = new Set<ServerEventListener>()
  let disposed = 0
  let subscribed = 0
  return {
    subscribe: (listener: ServerEventListener) => {
      subscribed += 1
      listeners.add(listener)
      return { dispose: () => {
        disposed += 1
        listeners.delete(listener)
      } }
    },
    emit: (event: ServerEvent) => {
      for (const listener of listeners)
        listener(event)
    },
    counts: () => ({ subscribed, disposed, listeners: listeners.size }),
  }
}

describe('createNoticeMemory', () => {
  it('remembers a key per chat once', () => {
    const memory = createNoticeMemory()
    expect(memory.remember('a', 'k1')).toBe(true)
    expect(memory.remember('a', 'k1')).toBe(false)
    expect(memory.has('a', 'k1')).toBe(true)
    expect(memory.remember('a', 'k2')).toBe(true)
    expect(memory.remember('b', 'k1')).toBe(true)
    expect(memory.has('c', 'k1')).toBe(false)
    memory.forget('a')
    expect(memory.has('a', 'k1')).toBe(false)
    expect(memory.size()).toBe(1)
    memory.clear()
    expect(memory.size()).toBe(0)
  })

  it('is bounded: chats used least recently and the oldest keys go first', () => {
    const memory = createNoticeMemory()
    for (let index = 0; index < NOTICE_MEMORY_CHATS_MAX; index++)
      memory.remember(`chat-${index}`, 'k')
    // Touching chat-0 makes chat-1 the least recently used.
    expect(memory.remember('chat-0', 'k')).toBe(false)
    memory.remember('chat-new', 'k')
    expect(memory.size()).toBe(NOTICE_MEMORY_CHATS_MAX)
    expect(memory.has('chat-0', 'k')).toBe(true)
    expect(memory.has('chat-1', 'k')).toBe(false)
    for (let index = 0; index <= NOTICE_MEMORY_KEYS_MAX; index++)
      memory.remember('keys', `k${index}`)
    expect(memory.has('keys', 'k0')).toBe(false)
    expect(memory.has('keys', `k${NOTICE_MEMORY_KEYS_MAX}`)).toBe(true)
  })

  it('subscribes lazily once; chat.deleted forgets the chat, key.rotated everything; stop ends the subscription', () => {
    const bus = fakeBus()
    let reads = 0
    const memory = createNoticeMemory(() => {
      reads += 1
      return bus
    })
    expect(reads).toBe(0)
    memory.remember('a', 'k')
    memory.remember('b', 'k')
    expect(bus.counts()).toEqual({ subscribed: 1, disposed: 0, listeners: 1 })
    bus.emit({ type: 'chat.deleted', data: { id: 'a' }, at: 1 } as ServerEvent)
    expect(memory.has('a', 'k')).toBe(false)
    expect(memory.has('b', 'k')).toBe(true)
    bus.emit({ type: 'key.rotated', data: {}, at: 2 } as unknown as ServerEvent)
    expect(memory.size()).toBe(0)
    memory.remember('c', 'k')
    memory.stop()
    expect(memory.size()).toBe(0)
    expect(bus.counts()).toEqual({ subscribed: 1, disposed: 1, listeners: 0 })
    // After stop nothing subscribes again.
    memory.remember('d', 'k')
    expect(bus.counts().subscribed).toBe(1)
  })

  it('works without a bus (a missing or throwing one)', () => {
    const missing = createNoticeMemory(() => undefined)
    expect(missing.remember('a', 'k')).toBe(true)
    const throwing = createNoticeMemory(() => {
      throw new Error('not built yet')
    })
    expect(throwing.remember('a', 'k')).toBe(true)
    expect(throwing.remember('a', 'k')).toBe(false)
    throwing.stop()
  })
})
