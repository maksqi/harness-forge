import type { EventSourceLike } from './event-stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEventStream } from './event-stream'

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = []
  listeners = new Map<string, Array<(event: MessageEvent) => void>>()
  closed = false

  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close() {
    this.closed = true
  }

  emit(type: string, data?: string) {
    const event = new MessageEvent(type, { data })
    for (const listener of this.listeners.get(type) ?? [])
      listener(event)
  }

  static last(): FakeEventSource {
    return FakeEventSource.instances.at(-1)!
  }
}

function createStream(overrides: Partial<Parameters<typeof createEventStream>[0]> = {}) {
  const messages: Array<[string, string]> = []
  const opens: boolean[] = []
  const statuses: string[] = []
  const stream = createEventStream({
    url: '/api/events',
    eventTypes: ['chat.updated'],
    onMessage: (data, type) => messages.push([type, data]),
    onOpen: ({ reconnected }) => opens.push(reconnected),
    onStatus: status => statuses.push(status),
    createEventSource: url => new FakeEventSource(url),
    random: () => 0.5,
    ...overrides,
  })
  return { stream, messages, opens, statuses }
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeEventSource.instances = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createEventStream', () => {
  it('connects once and delivers named and unnamed events', () => {
    const { stream, messages, opens } = createStream()
    stream.start()
    stream.start()
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.last().url).toBe('/api/events')
    FakeEventSource.last().emit('open')
    FakeEventSource.last().emit('chat.updated', '{"a":1}')
    FakeEventSource.last().emit('message', '{"b":2}')
    FakeEventSource.last().emit('other.event', '{"c":3}')
    expect(messages).toEqual([['chat.updated', '{"a":1}'], ['message', '{"b":2}']])
    expect(opens).toEqual([false])
    expect(stream.status).toBe('open')
  })

  it('backs off exponentially while the endpoint fails (e.g. 501 in Phase 0) and stays quiet', async () => {
    const { stream, statuses } = createStream()
    stream.start()
    const delays: number[] = []
    for (let attempt = 0; attempt < 7; attempt++) {
      const before = Date.now()
      FakeEventSource.last().emit('error')
      expect(FakeEventSource.last().closed).toBe(true)
      const count = FakeEventSource.instances.length
      while (FakeEventSource.instances.length === count)
        await vi.advanceTimersByTimeAsync(100)
      delays.push(Date.now() - before)
    }
    expect(delays).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000])
    expect(statuses).toContain('waiting')
    stream.stop()
  })

  it('resets the backoff after a successful open and reports the reconnect', async () => {
    const { stream, opens } = createStream()
    stream.start()
    FakeEventSource.last().emit('error')
    await vi.advanceTimersByTimeAsync(2000)
    FakeEventSource.last().emit('error')
    await vi.advanceTimersByTimeAsync(4000)
    FakeEventSource.last().emit('open')
    expect(opens).toEqual([true])
    FakeEventSource.last().emit('error')
    await vi.advanceTimersByTimeAsync(2000)
    expect(FakeEventSource.instances).toHaveLength(4)
    stream.stop()
  })

  it('stops cleanly: closes the source and cancels the reconnect', async () => {
    const { stream, messages } = createStream()
    stream.start()
    const source = FakeEventSource.last()
    source.emit('error')
    stream.stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(stream.status).toBe('idle')
    source.emit('chat.updated', '{}')
    expect(messages).toEqual([])
  })

  it('waits while the page is hidden and reconnects when it is shown', async () => {
    const { stream } = createStream()
    stream.start()
    FakeEventSource.last().emit('error')
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await vi.advanceTimersByTimeAsync(5000)
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(stream.status).toBe('waiting')
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(FakeEventSource.instances).toHaveLength(2)
    visibility.mockRestore()
    stream.stop()
  })

  it('reconnects at once when the browser comes back online', () => {
    const { stream } = createStream()
    stream.start()
    FakeEventSource.last().emit('error')
    window.dispatchEvent(new Event('online'))
    expect(FakeEventSource.instances).toHaveLength(2)
    stream.stop()
  })
})
