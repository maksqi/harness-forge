import type { SessionPayload, SessionService } from '../../security/types.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { AppEnv, RequestAuth } from '../types.ts'
import { harnessErrorEnvelopeSchema, LIMITS, serverEventSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SSE_MAX_QUEUE, SSE_PING_FRAME, SSE_RETRY_FRAME } from '../../services/events/sse.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createErrorHandler } from '../middleware/error-handler.ts'
import { createEventsRoutes } from './events.ts'

const CHAT_ID = '0199a8f0-0000-7000-8000-000000000001'

let t: TestApp

beforeAll(async () => {
  t = await createTestApp()
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(async () => {
  await t.close()
})

/** Reads a `text/event-stream` body frame by frame (frames end with a blank line). */
function frameReader(response: Response) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return {
    async next(): Promise<string | null> {
      for (;;) {
        const end = buffer.indexOf('\n\n')
        if (end !== -1) {
          const frame = buffer.slice(0, end + 2)
          buffer = buffer.slice(end + 2)
          return frame
        }
        const { done, value } = await reader.read()
        if (done)
          return null
        buffer += decoder.decode(value, { stream: true })
      }
    },
    cancel: () => reader.cancel(),
  }
}

function dataOf(frame: string): unknown {
  const line = frame.split('\n').find(entry => entry.startsWith('data: '))
  return JSON.parse(line!.slice('data: '.length))
}

async function waitForSubscribers(count: number): Promise<void> {
  await vi.waitFor(() => expect(t.deps.events.subscriberCount()).toBe(count))
}

describe('gET /api/events', () => {
  it('answers an event stream with the documented headers and a retry frame first', async () => {
    const response = await t.request('/api/events')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    expect(response.headers.get('content-encoding')).toBeNull()
    const frames = frameReader(response)
    expect(await frames.next()).toBe(SSE_RETRY_FRAME)
    await frames.cancel()
    await waitForSubscribers(0)
  })

  it('delivers an event to two subscribers with the same id and a valid ServerEvent payload', async () => {
    const a = frameReader(await t.request('/api/events'))
    const b = frameReader(await t.request('/api/events'))
    await a.next()
    await b.next()
    await waitForSubscribers(2)
    t.deps.events.emit('chat.deleted', { id: CHAT_ID })
    const frameA = await a.next()
    const frameB = await b.next()
    expect(frameA).toMatch(/^id: \d+\nevent: chat\.deleted\ndata: \{.*\}\n\n$/)
    expect(frameB).toBe(frameA)
    expect(serverEventSchema.parse(dataOf(frameA!))).toMatchObject({ type: 'chat.deleted', data: { id: CHAT_ID } })
    await a.cancel()
    await b.cancel()
    await waitForSubscribers(0)
  })

  it('leaves no listener behind when the client disconnects (body cancel or request abort)', async () => {
    const controller = new AbortController()
    const aborted = frameReader(await t.request('/api/events', { signal: controller.signal }))
    const cancelled = frameReader(await t.request('/api/events'))
    await aborted.next()
    await cancelled.next()
    await waitForSubscribers(2)
    await cancelled.cancel()
    await waitForSubscribers(1)
    controller.abort()
    await waitForSubscribers(0)
  })

  it('sends a `: ping` heartbeat every 25 s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const frames = frameReader(await t.request('/api/events'))
    expect(await frames.next()).toBe(SSE_RETRY_FRAME)
    await vi.advanceTimersByTimeAsync(LIMITS.sseHeartbeatMs)
    expect(await frames.next()).toBe(SSE_PING_FRAME)
    await frames.cancel()
    await waitForSubscribers(0)
  })

  it('closes a stream whose client stops reading once the queue overflows', async () => {
    const response = await t.request('/api/events')
    await waitForSubscribers(1)
    for (let index = 0; index < SSE_MAX_QUEUE + 10; index++)
      t.deps.events.emit('catalog.changed', { providerId: null })
    await waitForSubscribers(0)
    await response.body!.cancel()
  })

  it('ends every stream on shutdown', async () => {
    const own = await createTestApp()
    try {
      const frames = frameReader(await own.request('/api/events'))
      expect(await frames.next()).toBe(SSE_RETRY_FRAME)
      await own.deps.events.stop()
      expect(await frames.next()).toBeNull()
      expect(own.deps.events.subscriberCount()).toBe(0)
    }
    finally {
      await own.close()
    }
  })

  it('answers HEAD without subscribing', async () => {
    const response = await t.request('/api/events', { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(t.deps.events.subscriberCount()).toBe(0)
  })
})

describe('events route auth', () => {
  const session: SessionPayload = { iat: 1, exp: Number.MAX_SAFE_INTEGER, authAt: 1, epoch: 1 }

  function appWithAuth(auth: RequestAuth, sessions?: SessionService): Hono<AppEnv> {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('auth', auth)
      await next()
    })
    app.route('/', createEventsRoutes({ ...t.deps, ...(sessions === undefined ? {} : { sessions }) }))
    app.onError(createErrorHandler(t.deps))
    return app
  }

  it('refuses an unauthenticated request with 401 unauthorized', async () => {
    const app = appWithAuth({ enabled: true, authenticated: false, source: 'env', session: null, freshUntil: null })
    const response = await app.request('/events')
    expect(response.status).toBe(401)
    const envelope = harnessErrorEnvelopeSchema.parse(await response.json())
    expect(envelope.error).toMatchObject({ code: 'unauthorized', action: 'login' })
    expect(t.deps.events.subscriberCount()).toBe(0)
  })

  it('closes the stream when a heartbeat finds the session revoked', async () => {
    let valid = true
    const verify = vi.fn(async () => (valid ? session : null))
    const sessions: SessionService = { issue: async () => 'token', verify, revokeAll: async () => 2 }
    const app = appWithAuth({ enabled: true, authenticated: true, source: 'env', session, freshUntil: null }, sessions)
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const frames = frameReader(await app.request('/events', { headers: { cookie: 'hf_session=v1.token.sig' } }))
    expect(await frames.next()).toBe(SSE_RETRY_FRAME)
    await vi.advanceTimersByTimeAsync(LIMITS.sseHeartbeatMs)
    expect(await frames.next()).toBe(SSE_PING_FRAME)
    expect(verify).toHaveBeenCalledWith('v1.token.sig')
    valid = false
    await vi.advanceTimersByTimeAsync(LIMITS.sseHeartbeatMs)
    // The stream ends (the last ping may or may not make it out before the close).
    const rest: string[] = []
    for (let frame = await frames.next(); frame !== null; frame = await frames.next())
      rest.push(frame)
    expect(rest.every(frame => frame === SSE_PING_FRAME)).toBe(true)
    expect(verify).toHaveBeenCalledTimes(2)
    await waitForSubscribers(0)
  })
})
