import type { ServerEvent } from '@harness-forge/shared'
import { createServerEvent } from '@harness-forge/shared'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryLogger } from '../../logger.ts'
import { createEventBusWithLogger } from './index.ts'

const CHAT_ID = '0199a8f0-0000-7000-8000-000000000001'

function setup() {
  const logs = createMemoryLogger()
  const bus = createEventBusWithLogger(logs.logger)
  return { bus, logs }
}

describe('event bus', () => {
  it('delivers every event to every subscriber, in subscription order', () => {
    const { bus } = setup()
    const seen: string[] = []
    bus.subscribe(event => seen.push(`a:${event.type}`))
    bus.subscribe(event => seen.push(`b:${event.type}`))
    bus.emit('chat.deleted', { id: CHAT_ID })
    bus.emit('catalog.changed', { providerId: null })
    expect(seen).toEqual(['a:chat.deleted', 'b:chat.deleted', 'a:catalog.changed', 'b:catalog.changed'])
  })

  it('stamps `at` on emit and keeps it on publish', () => {
    const { bus } = setup()
    const received: ServerEvent[] = []
    bus.subscribe(event => received.push(event))
    const before = Date.now()
    bus.emit('chat.deleted', { id: CHAT_ID })
    bus.publish(createServerEvent('catalog.changed', { providerId: 'openai' }, 42))
    expect(received[0]).toEqual({ type: 'chat.deleted', data: { id: CHAT_ID }, at: expect.any(Number) })
    expect(received[0]!.at).toBeGreaterThanOrEqual(before)
    expect(received[1]).toEqual({ type: 'catalog.changed', data: { providerId: 'openai' }, at: 42 })
  })

  it('publishes a distinct object for every publish of the same event', () => {
    const { bus } = setup()
    const received: ServerEvent[] = []
    bus.subscribe(event => received.push(event))
    const event = createServerEvent('catalog.changed', { providerId: null }, 1)
    bus.publish(event)
    bus.publish(event)
    expect(received).toHaveLength(2)
    expect(received[0]).not.toBe(received[1])
  })

  it('stops delivering after dispose; dispose is idempotent', () => {
    const { bus } = setup()
    const listener = vi.fn()
    const subscription = bus.subscribe(listener)
    expect(bus.subscriberCount()).toBe(1)
    subscription.dispose()
    subscription.dispose()
    expect(bus.subscriberCount()).toBe(0)
    bus.emit('catalog.changed', { providerId: null })
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps separate subscriptions for the same listener function', () => {
    const { bus } = setup()
    const listener = vi.fn()
    const first = bus.subscribe(listener)
    bus.subscribe(listener)
    first.dispose()
    expect(bus.subscriberCount()).toBe(1)
    bus.emit('catalog.changed', { providerId: null })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('logs a throwing listener and keeps delivering to the others', () => {
    const { bus, logs } = setup()
    const after = vi.fn()
    bus.subscribe(() => {
      throw new Error('listener broke')
    })
    bus.subscribe(after)
    expect(() => bus.emit('catalog.changed', { providerId: null })).not.toThrow()
    expect(after).toHaveBeenCalledTimes(1)
    expect(logs.records.some(record => record.msg === 'event listener failed' && record.event === 'catalog.changed')).toBe(true)
  })

  it('delivers events emitted by a listener after the current event, in one global order', () => {
    const { bus } = setup()
    const seen: string[] = []
    bus.subscribe((event) => {
      seen.push(`a:${event.type}`)
      if (event.type === 'chat.deleted')
        bus.emit('catalog.changed', { providerId: null })
    })
    bus.subscribe(event => seen.push(`b:${event.type}`))
    bus.emit('chat.deleted', { id: CHAT_ID })
    expect(seen).toEqual(['a:chat.deleted', 'b:chat.deleted', 'a:catalog.changed', 'b:catalog.changed'])
  })

  it('skips a subscriber disposed by an earlier listener of the same delivery', () => {
    const { bus } = setup()
    const late = vi.fn()
    let lateSubscription = { dispose: () => {} }
    bus.subscribe(() => lateSubscription.dispose())
    lateSubscription = bus.subscribe(late)
    bus.emit('catalog.changed', { providerId: null })
    expect(late).not.toHaveBeenCalled()
  })

  it('stop() calls every onClose, drops the subscribers and ignores later events', async () => {
    const { bus } = setup()
    const listener = vi.fn()
    const onClose = vi.fn()
    bus.subscribe(listener, { onClose })
    bus.subscribe(listener, { onClose })
    await bus.stop()
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(bus.subscriberCount()).toBe(0)
    bus.emit('catalog.changed', { providerId: null })
    expect(listener).not.toHaveBeenCalled()
    await bus.stop()
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('a subscriber that disposes itself in onClose does not break stop()', async () => {
    const { bus } = setup()
    const holder: { subscription?: { dispose: () => void } } = {}
    const onClose = vi.fn(() => holder.subscription?.dispose())
    holder.subscription = bus.subscribe(() => {}, { onClose })
    bus.subscribe(() => {}, {
      onClose: () => {
        throw new Error('close failed')
      },
    })
    await expect(bus.stop()).resolves.toBeUndefined()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('subscribing to a stopped bus closes the subscriber asynchronously', async () => {
    const { bus } = setup()
    await bus.stop()
    const onClose = vi.fn()
    const subscription = bus.subscribe(() => {}, { onClose })
    expect(onClose).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(bus.subscriberCount()).toBe(0)
    expect(() => subscription.dispose()).not.toThrow()
  })
})
