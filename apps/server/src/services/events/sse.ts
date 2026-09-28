// Server-sent events for `GET /api/events` (API.md section 7, ARCHITECTURE.md 6.7): wire framing and one bounded,
// backpressure-aware delivery queue per connection. Owner: W1.5 (W1.5-T1).
//
// Wire format: `retry: 3000` first, then per event `id: <n>`, `event: <type>`, `data: <ServerEvent JSON>` and a blank
// line; a `: ping` comment every 25 s. Every event is validated with `serverEventSchema` once (the frame and its
// per-process id are cached by event identity and shared by every connection); invalid events are dropped and logged
// (rate limited). Producers never block: a connection whose queue exceeds 256 frames is closed and the browser
// `EventSource` reconnects (the web then refetches its stores).
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { ServerEvent } from '@harness-forge/shared'
import type { Logger } from '../../logger.ts'
import type { EventBus } from './types.ts'
import { LIMITS, serverEventSchema } from '@harness-forge/shared'

/** Reconnect delay announced to `EventSource` (first frame of every stream). */
export const SSE_RETRY_MS = 3000
/** Frames a connection may have queued; one more closes it. */
export const SSE_MAX_QUEUE = 256
export const SSE_RETRY_FRAME = `retry: ${SSE_RETRY_MS}\n\n`
/** Heartbeat comment (keeps proxies from closing an idle stream). */
export const SSE_PING_FRAME = ': ping\n\n'
/** Response headers of the stream (API.md section 7). */
export const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
})

/** Why a stream ended: the client left, shutdown, too slow, the session is no longer valid, a write failed. */
export type EventStreamCloseReason = 'client' | 'shutdown' | 'overflow' | 'session' | 'error'

const INVALID_EVENT_LOG_INTERVAL_MS = 60_000

let lastEventId = 0
const frameCache = new WeakMap<object, string | null>()
const invalidEventLoggedAt = new Map<string, number>()

/** One SSE frame: `id`, `event` (= `type`) and the event JSON on a single `data` line. */
export function formatEventFrame(id: number, event: ServerEvent): string {
  // JSON.stringify escapes CR and LF, so the payload always fits on one `data:` line.
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

function logInvalidEvent(event: unknown, issues: readonly { path: readonly PropertyKey[], code: string }[], logger: Logger | undefined): void {
  const rawType = typeof event === 'object' && event !== null ? (event as { type?: unknown }).type : undefined
  const type = typeof rawType === 'string' ? rawType.slice(0, 64) : 'unknown'
  const now = Date.now()
  if (now - (invalidEventLoggedAt.get(type) ?? 0) < INVALID_EVENT_LOG_INTERVAL_MS)
    return
  invalidEventLoggedAt.set(type, now)
  logger?.warn('dropped an invalid server event', {
    event: type,
    issues: issues.slice(0, 5).map(issue => ({ path: issue.path.map(String).join('.'), code: issue.code })),
  })
}

/**
 * The frame of an event, or null when the event fails `serverEventSchema` (dropped). Validation and numbering happen
 * once per event object: every connection receiving the same event sends the same `id` and bytes. The data sent is the
 * parsed event, so keys outside the schema never reach the browser.
 */
export function serverEventFrame(event: ServerEvent, logger?: Logger): string | null {
  const cacheable = typeof event === 'object' && event !== null
  if (cacheable) {
    const cached = frameCache.get(event)
    if (cached !== undefined)
      return cached
  }
  const parsed = serverEventSchema.safeParse(event)
  let frame: string | null = null
  if (parsed.success) {
    lastEventId += 1
    frame = formatEventFrame(lastEventId, parsed.data)
  }
  else {
    logInvalidEvent(event, parsed.error.issues, logger)
  }
  if (cacheable)
    frameCache.set(event, frame)
  return frame
}

/** Where a connection writes its frames (the HTTP response). */
export interface EventStreamSink {
  /** Writes one frame and resolves once the consumer accepted it (backpressure). Should not reject. */
  write: (frame: string) => Promise<void>
  /** Ends the response; called once, for every reason (for `client` the response is usually gone already). */
  close: (reason: EventStreamCloseReason) => void
}

export interface EventStreamOptions {
  logger: Logger
  /** Default `LIMITS.sseHeartbeatMs` (25 s). */
  heartbeatMs?: number
  /** Default `SSE_MAX_QUEUE` (256). */
  maxQueue?: number
  /** Runs with every heartbeat; resolving false closes the stream (`session`). A rejection is logged and ignored. */
  revalidate?: () => Promise<boolean>
}

export interface EventStream {
  /** Resolves with the reason once the stream is closed. */
  readonly closed: Promise<EventStreamCloseReason>
  readonly isClosed: () => boolean
  /** Closes the stream: unsubscribes, stops the heartbeat, drops the queue and closes the sink. Idempotent. */
  readonly close: (reason: EventStreamCloseReason) => void
  /** Frames waiting to be written (tests). */
  readonly queued: () => number
}

/**
 * Subscribes one SSE connection to `bus`. Bus delivery only appends to the connection's queue (never blocks the
 * producer); a single pump writes the queue to `sink` one frame at a time, waiting for the consumer each time.
 */
export function openEventStream(bus: EventBus, sink: EventStreamSink, options: EventStreamOptions): EventStream {
  const { logger, revalidate } = options
  const heartbeatMs = options.heartbeatMs ?? LIMITS.sseHeartbeatMs
  const maxQueue = options.maxQueue ?? SSE_MAX_QUEUE
  const queue: string[] = [SSE_RETRY_FRAME]
  let closed = false
  let revalidating = false
  let wake: (() => void) | undefined
  let subscription: Disposable | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let resolveClosed: (reason: EventStreamCloseReason) => void = () => {}
  const closedPromise = new Promise<EventStreamCloseReason>((resolve) => {
    resolveClosed = resolve
  })

  function wakePump(): void {
    const resume = wake
    wake = undefined
    resume?.()
  }

  function close(reason: EventStreamCloseReason): void {
    if (closed)
      return
    closed = true
    subscription?.dispose()
    if (heartbeat !== undefined)
      clearInterval(heartbeat)
    queue.length = 0
    wakePump()
    try {
      sink.close(reason)
    }
    catch (error) {
      logger.debug('events stream: closing the response failed', { err: error })
    }
    logger.debug('events stream closed', { reason })
    resolveClosed(reason)
  }

  function enqueue(frame: string): void {
    if (closed)
      return
    if (queue.length >= maxQueue) {
      logger.warn('events stream closed: the client does not keep up', { queued: queue.length })
      close('overflow')
      return
    }
    queue.push(frame)
    wakePump()
  }

  function checkSession(check: () => Promise<boolean>): void {
    if (revalidating)
      return
    revalidating = true
    check().then(
      (valid) => {
        if (!valid)
          close('session')
      },
      error => logger.debug('events stream: session re-check failed', { err: error }),
    ).finally(() => {
      revalidating = false
    })
  }

  function tick(): void {
    if (closed)
      return
    if (queue.at(-1) !== SSE_PING_FRAME)
      enqueue(SSE_PING_FRAME)
    if (revalidate !== undefined)
      checkSession(revalidate)
  }

  async function pump(): Promise<void> {
    try {
      for (;;) {
        // `closed` is set by `close()` from bus callbacks, timers and the sink while this loop awaits.
        if (closed)
          return
        const frame = queue.shift()
        if (frame === undefined) {
          await new Promise<void>((resolve) => {
            wake = resolve
          })
          continue
        }
        await sink.write(frame)
      }
    }
    catch (error) {
      logger.debug('events stream: write failed', { err: error })
      close('error')
    }
  }

  subscription = bus.subscribe((event) => {
    if (closed)
      return
    const frame = serverEventFrame(event, logger)
    if (frame !== null)
      enqueue(frame)
  }, { onClose: () => close('shutdown') })
  if (closed) {
    // The bus closed the subscription synchronously (stopped bus).
    subscription.dispose()
  }
  else {
    heartbeat = setInterval(tick, heartbeatMs)
    heartbeat.unref?.()
    logger.debug('events stream opened')
  }
  void pump()

  return {
    closed: closedPromise,
    isClosed: () => closed,
    close,
    queued: () => queue.length,
  }
}
