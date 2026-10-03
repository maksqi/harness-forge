// In-process event bus behind `GET /api/events` (ARCHITECTURE.md 6.7, API.md section 7). Owner: W1.5 (W1.5-T1).
//
// Delivery is synchronous and in subscription order. Events published while a delivery is running (a listener that
// emits) are queued and delivered right after the current one, before the outer `emit` returns, so every listener sees
// every event in the same global order. A throwing listener is logged and never breaks `emit`. Events reach in-process
// listeners as published; the SSE layer (`./sse.ts`) validates them with `serverEventSchema` before sending.
//
// `disconnectAll()` (Phase 7, C16-T4) ends every event stream but keeps the bus running: called from inside a delivery
// it waits until the queued events were delivered, then removes every subscription with `onDisconnect` / `onClose`
// and notifies it (an SSE stream flushes its own queue, then closes).
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { ServerEvent } from '@harness-forge/shared'
import type { Logger } from '../../logger.ts'
import type { AppDeps } from '../../types.ts'
import type { EventBus, EventSubscribeOptions, ServerEventListener } from './types.ts'
import { createServerEvent } from '@harness-forge/shared'

interface Subscription {
  readonly listener: ServerEventListener
  readonly options: EventSubscribeOptions
}

const NOOP_DISPOSABLE: Disposable = Object.freeze({ dispose: () => {} })

/** A bus that logs listener failures to `logger`. Exported for tests and for code that needs a standalone bus. */
export function createEventBusWithLogger(logger: Logger): EventBus {
  const subscriptions = new Set<Subscription>()
  const pending: ServerEvent[] = []
  /** `disconnectAll()` calls made during a delivery: they run once the queue is empty. */
  const afterDelivery: (() => void)[] = []
  let delivering = false
  let stopped = false

  function deliver(event: ServerEvent): void {
    for (const subscription of [...subscriptions]) {
      // A listener disposed by an earlier listener of the same round no longer receives events.
      if (!subscriptions.has(subscription))
        continue
      try {
        subscription.listener(event)
      }
      catch (error) {
        logger.warn('event listener failed', { event: event.type, err: error })
      }
    }
  }

  function dispatch(event: ServerEvent): void {
    if (stopped)
      return
    pending.push(event)
    if (delivering)
      return
    delivering = true
    try {
      for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
        // A listener may stop the bus: the rest of the queue is dropped.
        if (stopped)
          break
        deliver(next)
      }
    }
    finally {
      pending.length = 0
      delivering = false
    }
    for (let next = afterDelivery.shift(); next !== undefined; next = afterDelivery.shift())
      next()
  }

  function closeSubscription(subscription: Subscription): void {
    try {
      subscription.options.onClose?.()
    }
    catch (error) {
      logger.warn('event subscriber onClose failed', { err: error })
    }
  }

  /** Removes and notifies every stream subscription (`onDisconnect`, else `onClose`). */
  async function disconnectStreams(): Promise<void> {
    if (stopped)
      return
    const streams = [...subscriptions].filter(({ options }) => options.onDisconnect !== undefined || options.onClose !== undefined)
    for (const subscription of streams)
      subscriptions.delete(subscription)
    const settled = await Promise.allSettled(streams.map(async ({ options }) => {
      if (options.onDisconnect !== undefined)
        await options.onDisconnect()
      else
        options.onClose?.()
    }))
    for (const result of settled) {
      if (result.status === 'rejected')
        logger.warn('event subscriber disconnect failed', { err: result.reason })
    }
  }

  return {
    emit: (type, data) => dispatch(createServerEvent(type, data)),
    // A shallow copy: every publish is a distinct event (the SSE layer numbers events by identity).
    publish: event => dispatch({ ...event }),
    subscribe: (listener, options = {}) => {
      if (stopped) {
        // The bus is shutting down: tell the subscriber asynchronously (it may not hold its Disposable yet).
        queueMicrotask(() => closeSubscription({ listener, options }))
        return NOOP_DISPOSABLE
      }
      const subscription: Subscription = { listener, options }
      subscriptions.add(subscription)
      return { dispose: () => void subscriptions.delete(subscription) }
    },
    subscriberCount: () => subscriptions.size,
    stop: async () => {
      if (stopped)
        return
      stopped = true
      pending.length = 0
      const closing = [...subscriptions]
      for (const subscription of closing)
        closeSubscription(subscription)
      subscriptions.clear()
      // A `disconnectAll()` still waiting for a delivery has nothing left to do.
      for (let next = afterDelivery.shift(); next !== undefined; next = afterDelivery.shift())
        next()
    },
    disconnectAll: () => {
      if (!delivering)
        return disconnectStreams()
      return new Promise<void>((resolve) => {
        afterDelivery.push(() => resolve(disconnectStreams()))
      })
    },
  }
}

export function createEventBus(deps: AppDeps): EventBus {
  return createEventBusWithLogger(deps.logger.child({ component: 'events' }))
}
