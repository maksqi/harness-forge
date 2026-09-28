// One EventSource with exponential backoff (docs/API.md 7, docs/UI.md 11). Any error closes the source and
// reconnects after 2s, 4s, 8s ... 60s (+-20% jitter), reset by a successful open. The browser's own retry is not
// used: it gives up on HTTP errors (a Phase 0 stub answers 501 JSON), and a fixed 3s retry would hammer a server
// that is down. Reconnects wait while the page is hidden and happen at once when the browser comes back online.
// Auto-imported (utils/).

/** The part of `EventSource` this module uses (tests pass a fake). */
export interface EventSourceLike {
  addEventListener: (type: string, listener: (event: MessageEvent) => void) => void
  close: () => void
}

export type EventStreamStatus = 'idle' | 'connecting' | 'open' | 'waiting'

export interface EventStreamOptions {
  url: string
  /** Named events (`event:` field) to listen for; unnamed `message` events are always delivered. */
  eventTypes: readonly string[]
  /** Raw `data` of every event. */
  onMessage: (data: string, type: string) => void
  /** A successful open; `reconnected` is false only for the first connection of this stream. */
  onOpen?: (info: { reconnected: boolean }) => void
  onStatus?: (status: EventStreamStatus) => void
  /** Default `new EventSource(url)`. */
  createEventSource?: (url: string) => EventSourceLike
  /** First reconnect delay, doubled per failed attempt. Default 2000. */
  baseDelayMs?: number
  /** Reconnect delay cap. Default 60000. */
  maxDelayMs?: number
  /** Default `Math.random` (jitter). */
  random?: () => number
}

export interface EventStream {
  /** Connects (no-op when started). */
  start: () => void
  /** Closes the connection and cancels reconnects. */
  stop: () => void
  readonly status: EventStreamStatus
}

function defaultEventSource(url: string): EventSourceLike {
  return new EventSource(url)
}

function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

export function createEventStream(options: EventStreamOptions): EventStream {
  const create = options.createEventSource ?? defaultEventSource
  const baseDelay = options.baseDelayMs ?? 2000
  const maxDelay = options.maxDelayMs ?? 60_000
  const random = options.random ?? Math.random

  let status: EventStreamStatus = 'idle'
  let started = false
  let source: EventSourceLike | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  let connections = 0
  let waitingForPage = false

  function setStatus(next: EventStreamStatus) {
    if (status === next)
      return
    status = next
    options.onStatus?.(next)
  }

  function closeSource() {
    const current = source
    source = null
    current?.close()
  }

  function clearTimer() {
    if (timer !== undefined)
      clearTimeout(timer)
    timer = undefined
  }

  function connect() {
    clearTimer()
    waitingForPage = false
    if (!started)
      return
    if (pageHidden()) {
      waitingForPage = true
      setStatus('waiting')
      return
    }
    closeSource()
    connections += 1
    const reconnected = connections > 1
    setStatus('connecting')
    let current: EventSourceLike
    try {
      current = create(options.url)
    }
    catch {
      scheduleReconnect()
      return
    }
    source = current
    const deliver = (event: MessageEvent) => {
      if (source === current && typeof event.data === 'string')
        options.onMessage(event.data, event.type)
    }
    current.addEventListener('open', () => {
      if (source !== current)
        return
      failures = 0
      setStatus('open')
      options.onOpen?.({ reconnected })
    })
    current.addEventListener('error', () => {
      if (source !== current)
        return
      closeSource()
      scheduleReconnect()
    })
    current.addEventListener('message', deliver)
    for (const type of options.eventTypes)
      current.addEventListener(type, deliver)
  }

  function scheduleReconnect() {
    if (!started)
      return
    const delay = Math.min(maxDelay, baseDelay * 2 ** failures)
    failures = Math.min(failures + 1, 30)
    const jittered = Math.round(delay * (0.8 + random() * 0.4))
    setStatus('waiting')
    clearTimer()
    timer = setTimeout(connect, jittered)
  }

  function onVisibilityChange() {
    if (waitingForPage && !pageHidden())
      connect()
  }

  function onOnline() {
    if (started && status === 'waiting')
      connect()
  }

  function start() {
    if (started)
      return
    started = true
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onOnline)
      document.addEventListener('visibilitychange', onVisibilityChange)
    }
    connect()
  }

  function stop() {
    if (!started)
      return
    started = false
    waitingForPage = false
    clearTimer()
    closeSource()
    failures = 0
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
    setStatus('idle')
  }

  return {
    start,
    stop,
    get status() {
      return status
    },
  }
}
