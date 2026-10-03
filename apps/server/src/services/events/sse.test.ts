import type { ServerEvent } from '@harness-forge/shared'
import type { EventStreamCloseReason, EventStreamSink } from './sse.ts'
import { createServerEvent, LIMITS } from '@harness-forge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryLogger } from '../../logger.ts'
import { createEventBusWithLogger } from './index.ts'
import { formatEventFrame, openEventStream, serverEventFrame, SSE_MAX_QUEUE, SSE_PING_FRAME, SSE_RETRY_FRAME } from './sse.ts'

const CHAT_ID = '0199a8f0-0000-7000-8000-000000000001'

afterEach(() => {
  vi.useRealTimers()
})

function setup() {
  const logs = createMemoryLogger()
  const bus = createEventBusWithLogger(logs.logger)
  return { bus, logs, logger: logs.logger }
}

interface TestSink {
  sink: EventStreamSink
  frames: string[]
  closes: EventStreamCloseReason[]
  /** Releases the write in progress when the sink blocks. */
  release: () => void
}

/** A sink that records frames; `blocking` makes every write wait for `release()` (a consumer that does not read). */
function createSink(options: { blocking?: boolean, failing?: boolean } = {}): TestSink {
  const frames: string[] = []
  const closes: EventStreamCloseReason[] = []
  let pendingRelease: (() => void) | undefined
  return {
    frames,
    closes,
    release: () => pendingRelease?.(),
    sink: {
      write: async (frame) => {
        if (options.failing)
          throw new Error('socket closed')
        frames.push(frame)
        if (options.blocking) {
          await new Promise<void>((resolve) => {
            pendingRelease = resolve
          })
        }
      },
      close: reason => closes.push(reason),
    },
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index++)
    await Promise.resolve()
}

function dataOf(frame: string): unknown {
  const line = frame.split('\n').find(entry => entry.startsWith('data: '))
  return line === undefined ? undefined : JSON.parse(line.slice('data: '.length))
}

function idOf(frame: string): number {
  const line = frame.split('\n').find(entry => entry.startsWith('id: '))
  return Number(line?.slice('id: '.length))
}

describe('formatEventFrame', () => {
  it('writes id, event and the JSON on one data line', () => {
    const event = createServerEvent('chat.deleted', { id: CHAT_ID }, 1_759_000_000_000)
    expect(formatEventFrame(42, event)).toBe(
      `id: 42\nevent: chat.deleted\ndata: {"type":"chat.deleted","data":{"id":"${CHAT_ID}"},"at":1759000000000}\n\n`,
    )
  })

  it('keeps multi-line strings on a single data line', () => {
    const event = { type: 'plugin.log', data: { pluginId: 'x', entry: { at: 1, level: 'info', message: 'a\nb\r\nc' } }, at: 1 } as ServerEvent
    const frame = formatEventFrame(1, event)
    expect(frame.split('\n').filter(line => line.startsWith('data: '))).toHaveLength(1)
    expect(frame.endsWith('\n\n')).toBe(true)
  })
})

describe('serverEventFrame', () => {
  it('validates, numbers and caches a frame per event object', () => {
    const { logger } = setup()
    const first = createServerEvent('chat.deleted', { id: CHAT_ID })
    const second = createServerEvent('catalog.changed', { providerId: null })
    const frameA = serverEventFrame(first, logger)
    const frameB = serverEventFrame(second, logger)
    expect(frameA).not.toBeNull()
    expect(serverEventFrame(first, logger)).toBe(frameA)
    expect(idOf(frameB!)).toBeGreaterThan(idOf(frameA!))
    expect(dataOf(frameA!)).toEqual(first)
  })

  it('drops invalid events and logs them without their payload (rate limited per type)', () => {
    const { logger, logs } = setup()
    const invalid = { type: 'chat.deleted', data: { id: 'not-a-chat-id', secret: 'sk-live-123456' }, at: 1 } as unknown as ServerEvent
    expect(serverEventFrame(invalid, logger)).toBeNull()
    expect(serverEventFrame({ ...invalid }, logger)).toBeNull()
    const warnings = logs.records.filter(record => record.msg === 'dropped an invalid server event')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ event: 'chat.deleted', issues: [{ path: 'data.id' }] })
    expect(logs.text()).not.toContain('not-a-chat-id')
    expect(logs.text()).not.toContain('sk-live')
  })

  it('sends the parsed event: keys outside the schema never reach the client', () => {
    const event = { type: 'chat.deleted', data: { id: CHAT_ID, apiKey: 'sk-live-123456' }, at: 5 } as unknown as ServerEvent
    const frame = serverEventFrame(event)
    expect(frame).not.toContain('apiKey')
    expect(dataOf(frame!)).toEqual({ type: 'chat.deleted', data: { id: CHAT_ID }, at: 5 })
  })
})

describe('openEventStream', () => {
  it('starts with the retry frame, then writes events in order', async () => {
    const { bus, logger } = setup()
    const { sink, frames } = createSink()
    const stream = openEventStream(bus, sink, { logger })
    bus.emit('chat.deleted', { id: CHAT_ID })
    bus.emit('catalog.changed', { providerId: 'openai' })
    await flush()
    expect(frames[0]).toBe(SSE_RETRY_FRAME)
    expect(frames.slice(1).map(frame => (dataOf(frame) as ServerEvent).type)).toEqual(['chat.deleted', 'catalog.changed'])
    expect(frames[1]).toMatch(/^id: \d+\nevent: chat\.deleted\ndata: /)
    stream.close('client')
  })

  it('gives two connections the same frame (same id) for an event', async () => {
    const { bus, logger } = setup()
    const a = createSink()
    const b = createSink()
    openEventStream(bus, a.sink, { logger })
    openEventStream(bus, b.sink, { logger })
    bus.emit('chat.deleted', { id: CHAT_ID })
    await flush()
    expect(a.frames[1]).toBeDefined()
    expect(a.frames[1]).toBe(b.frames[1])
  })

  it('skips invalid events and keeps the stream open', async () => {
    const { bus, logger } = setup()
    const { sink, frames } = createSink()
    const stream = openEventStream(bus, sink, { logger })
    bus.publish({ type: 'chat.deleted', data: { id: 'nope' }, at: 1 } as unknown as ServerEvent)
    bus.emit('catalog.changed', { providerId: null })
    await flush()
    expect(frames).toHaveLength(2)
    expect(stream.isClosed()).toBe(false)
  })

  it('sends a ping every heartbeat interval, without piling up pings', async () => {
    vi.useFakeTimers()
    const { bus, logger } = setup()
    const blocked = createSink({ blocking: true })
    const idle = createSink()
    openEventStream(bus, idle.sink, { logger })
    const stream = openEventStream(bus, blocked.sink, { logger })
    await vi.advanceTimersByTimeAsync(LIMITS.sseHeartbeatMs - 1)
    expect(idle.frames).toEqual([SSE_RETRY_FRAME])
    await vi.advanceTimersByTimeAsync(1)
    expect(idle.frames).toEqual([SSE_RETRY_FRAME, SSE_PING_FRAME])
    await vi.advanceTimersByTimeAsync(LIMITS.sseHeartbeatMs)
    expect(idle.frames).toEqual([SSE_RETRY_FRAME, SSE_PING_FRAME, SSE_PING_FRAME])
    // A consumer that does not read gets at most one queued ping.
    await vi.advanceTimersByTimeAsync(LIMITS.sseHeartbeatMs * 5)
    expect(stream.queued()).toBe(1)
  })

  it('closes a connection whose queue exceeds the limit, without blocking the producer', async () => {
    const { bus, logger, logs } = setup()
    const { sink, closes } = createSink({ blocking: true })
    const stream = openEventStream(bus, sink, { logger })
    await flush()
    expect(bus.subscriberCount()).toBe(1)
    for (let index = 0; index < SSE_MAX_QUEUE; index++)
      bus.emit('catalog.changed', { providerId: null })
    expect(stream.isClosed()).toBe(false)
    expect(stream.queued()).toBe(SSE_MAX_QUEUE)
    bus.emit('catalog.changed', { providerId: null })
    expect(stream.isClosed()).toBe(true)
    await expect(stream.closed).resolves.toBe('overflow')
    expect(closes).toEqual(['overflow'])
    expect(bus.subscriberCount()).toBe(0)
    expect(logs.records.some(record => record.level === 'warn' && record.msg.includes('does not keep up'))).toBe(true)
  })

  it('resumes writing when the consumer catches up', async () => {
    const { bus, logger } = setup()
    const { sink, frames, release } = createSink({ blocking: true })
    openEventStream(bus, sink, { logger })
    bus.emit('chat.deleted', { id: CHAT_ID })
    bus.emit('catalog.changed', { providerId: null })
    await flush()
    expect(frames).toEqual([SSE_RETRY_FRAME])
    release()
    await flush()
    expect(frames).toHaveLength(2)
    release()
    await flush()
    expect(frames).toHaveLength(3)
  })

  it('closes on shutdown (bus stop) and on a client disconnect', async () => {
    const { bus, logger } = setup()
    const a = createSink()
    const b = createSink()
    const byShutdown = openEventStream(bus, a.sink, { logger })
    const byClient = openEventStream(bus, b.sink, { logger })
    byClient.close('client')
    byClient.close('error')
    await expect(byClient.closed).resolves.toBe('client')
    expect(b.closes).toEqual(['client'])
    expect(bus.subscriberCount()).toBe(1)
    await bus.stop()
    await expect(byShutdown.closed).resolves.toBe('shutdown')
    expect(a.closes).toEqual(['shutdown'])
  })

  it('closes right away when the bus is already stopped', async () => {
    const { bus, logger } = setup()
    await bus.stop()
    const { sink, closes } = createSink()
    const stream = openEventStream(bus, sink, { logger })
    await expect(stream.closed).resolves.toBe('shutdown')
    expect(closes).toEqual(['shutdown'])
  })

  it('closes when the session re-check fails, ignores re-check errors', async () => {
    vi.useFakeTimers()
    const { bus, logger } = setup()
    const results: Array<boolean | Error> = [true, new Error('settings unavailable'), false]
    const revalidate = vi.fn(async () => {
      const next = results.shift()
      if (next instanceof Error)
        throw next
      return next ?? false
    })
    const { sink, closes } = createSink()
    const stream = openEventStream(bus, sink, { logger, revalidate })
    await vi.advanceTimersByTimeAsync(LIMITS.sseHeartbeatMs)
    await vi.advanceTimersByTimeAsync(LIMITS.sseHeartbeatMs)
    expect(stream.isClosed()).toBe(false)
    await vi.advanceTimersByTimeAsync(LIMITS.sseHeartbeatMs)
    await expect(stream.closed).resolves.toBe('session')
    expect(closes).toEqual(['session'])
    expect(revalidate).toHaveBeenCalledTimes(3)
    expect(bus.subscriberCount()).toBe(0)
  })

  it('closes with `error` when a write fails', async () => {
    const { bus, logger } = setup()
    const { sink } = createSink({ failing: true })
    const stream = openEventStream(bus, sink, { logger })
    await expect(stream.closed).resolves.toBe('error')
    expect(bus.subscriberCount()).toBe(0)
  })

  it('stops the heartbeat once closed', async () => {
    vi.useFakeTimers()
    const { bus, logger } = setup()
    const { sink, frames } = createSink()
    const stream = openEventStream(bus, sink, { logger })
    stream.close('client')
    await vi.advanceTimersByTimeAsync(LIMITS.sseHeartbeatMs * 3)
    expect(frames).toEqual([SSE_RETRY_FRAME])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('openEventStream and disconnectAll (Phase 7)', () => {
  it('writes an event emitted right before disconnectAll, then closes with `disconnect`', async () => {
    const { bus, logger } = setup()
    const { sink, frames, closes } = createSink()
    const stream = openEventStream(bus, sink, { logger })
    bus.emit('chat.deleted', { id: CHAT_ID })
    await bus.disconnectAll()
    expect(await stream.closed).toBe('disconnect')
    expect(closes).toEqual(['disconnect'])
    expect(frames[0]).toBe(SSE_RETRY_FRAME)
    expect(frames.map(dataOf)).toContainEqual(expect.objectContaining({ type: 'chat.deleted', data: { id: CHAT_ID } }))
    expect(bus.subscriberCount()).toBe(0)
  })

  it('flushes every queued frame of a slow consumer before closing', async () => {
    const { bus, logger } = setup()
    const { sink, frames, closes, release } = createSink({ blocking: true })
    const stream = openEventStream(bus, sink, { logger })
    bus.emit('chat.deleted', { id: CHAT_ID })
    bus.emit('catalog.changed', { providerId: null })
    const disconnected = bus.disconnectAll()
    await flush()
    expect(stream.isClosed()).toBe(false)
    for (let index = 0; index < 5 && !stream.isClosed(); index++) {
      release()
      await flush()
    }
    await disconnected
    expect(closes).toEqual(['disconnect'])
    expect(frames.slice(1).map(frame => (dataOf(frame) as ServerEvent).type)).toEqual(['chat.deleted', 'catalog.changed'])
  })

  it('closes a consumer that does not read within the flush limit, and takes no new frames meanwhile', async () => {
    vi.useFakeTimers()
    const { bus, logger } = setup()
    const { sink, frames, closes } = createSink({ blocking: true })
    const stream = openEventStream(bus, sink, { logger, disconnectFlushMs: 1000 })
    bus.emit('chat.deleted', { id: CHAT_ID })
    const disconnected = bus.disconnectAll()
    bus.emit('catalog.changed', { providerId: null })
    await vi.advanceTimersByTimeAsync(999)
    expect(stream.isClosed()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await disconnected
    expect(closes).toEqual(['disconnect'])
    expect(frames.some(frame => frame.includes('catalog.changed'))).toBe(false)
  })
})
