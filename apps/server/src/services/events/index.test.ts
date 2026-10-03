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

describe('disconnectAll (Phase 7)', () => {
  it('closes every stream subscription (onDisconnect, else onClose), keeps in-process listeners and the bus running', async () => {
    const { bus } = setup()
    const calls: string[] = []
    const seen: string[] = []
    bus.subscribe(() => {}, { onDisconnect: () => void calls.push('stream-a') })
    bus.subscribe(() => {}, { onClose: () => calls.push('stream-b') })
    bus.subscribe(event => seen.push(event.type))
    expect(bus.subscriberCount()).toBe(3)
    await bus.disconnectAll()
    expect(calls).toEqual(['stream-a', 'stream-b'])
    expect(bus.subscriberCount()).toBe(1)
    // The bus keeps working: new streams (reconnecting browsers) and emits.
    const after: string[] = []
    bus.subscribe(event => after.push(event.type), { onClose: () => {} })
    bus.emit('chat.deleted', { id: CHAT_ID })
    expect(seen).toEqual(['chat.deleted'])
    expect(after).toEqual(['chat.deleted'])
  })

  it('delivers an event emitted right before it to every stream first', async () => {
    const { bus } = setup()
    const order: string[] = []
    bus.subscribe(event => order.push(`event:${event.type}`), { onDisconnect: () => void order.push('disconnect') })
    bus.emit('catalog.changed', { providerId: null })
    await bus.disconnectAll()
    expect(order).toEqual(['event:catalog.changed', 'disconnect'])
  })

  it('called by a listener during a delivery, waits until the queued events were delivered', async () => {
    const { bus } = setup()
    const order: string[] = []
    let disconnected: Promise<void> | undefined
    bus.subscribe((event) => {
      order.push(`a:${event.type}`)
      if (event.type === 'chat.deleted') {
        bus.emit('catalog.changed', { providerId: null })
        disconnected = bus.disconnectAll()
      }
    })
    bus.subscribe(event => order.push(`stream:${event.type}`), { onDisconnect: () => void order.push('stream:disconnect') })
    bus.emit('chat.deleted', { id: CHAT_ID })
    await disconnected
    expect(order).toEqual(['a:chat.deleted', 'stream:chat.deleted', 'a:catalog.changed', 'stream:catalog.changed', 'stream:disconnect'])
  })

  it('waits for asynchronous onDisconnect handlers and logs a failing one', async () => {
    const { bus, logs } = setup()
    let finished = false
    bus.subscribe(() => {}, {
      onDisconnect: async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
        finished = true
      },
    })
    bus.subscribe(() => {}, {
      onDisconnect: async () => {
        throw new Error('socket gone')
      },
    })
    await bus.disconnectAll()
    expect(finished).toBe(true)
    expect(logs.records.some(record => record.msg === 'event subscriber disconnect failed')).toBe(true)
  })

  it('does nothing once the bus is stopped', async () => {
    const { bus } = setup()
    const onClose = vi.fn()
    bus.subscribe(() => {}, { onClose })
    await bus.stop()
    expect(onClose).toHaveBeenCalledTimes(1)
    await bus.disconnectAll()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
