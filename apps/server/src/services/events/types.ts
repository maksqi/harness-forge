// Frozen interface of the in-process event bus behind `GET /api/events` (ARCHITECTURE.md 6.7, API.md section 7).
// Implementation: `createEventBus(deps)` in `services/events/index.ts` (W1.5; `disconnectAll` C16); the SSE route is
// `http/routes/events.ts` (W1.5).
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { ServerEvent, ServerEventDataMap, ServerEventType } from '@harness-forge/shared'

export type ServerEventListener = (event: ServerEvent) => void

export interface EventSubscribeOptions {
  /** Called once when the bus stops (shutdown); an SSE stream closes itself here so the HTTP server can close. */
  onClose?: () => void
  /**
   * Called once by `disconnectAll()` (Phase 7), after every event published before it was delivered: the subscriber
   * writes what it still has queued, then ends (an SSE stream flushes its frames and closes its response; the browser
   * reconnects and is authenticated again). The bus has already removed the subscription. A subscriber without
   * `onDisconnect` gets `onClose` instead.
   */
  onDisconnect?: () => void | Promise<void>
}

/**
 * Typed publish/subscribe for `ServerEvent`s. Producers: W1.2 / W1.4 `provider.changed`, W1.4 `catalog.changed`,
 * W1.3 `plugin.changed` / `plugin.log`, W1.5 `chat.*`, W2.1 `run.*`.
 *
 * Delivery is synchronous and in subscription order; producers never block on slow consumers (each SSE connection
 * keeps its own bounded queue of 256 events and closes on overflow). A throwing listener is logged and never
 * breaks `emit`.
 */
export interface EventBus {
  /** Publishes `{ type, data, at: Date.now() }`. */
  readonly emit: <T extends ServerEventType>(type: T, data: ServerEventDataMap[T]) => void
  /** Publishes a prebuilt event (its `at` is kept). */
  readonly publish: (event: ServerEvent) => void
  /** Receives every event until disposed. */
  readonly subscribe: (listener: ServerEventListener, options?: EventSubscribeOptions) => Disposable
  /** Live subscribers (tests: a closed SSE connection leaves no listener behind). */
  readonly subscriberCount: () => number
  /** Shutdown: calls every `onClose`, then drops all subscribers; later `emit`s are ignored. */
  readonly stop: () => Promise<void>
  /**
   * Ends every event stream without stopping the bus (Phase 7, ADR-034: after `key.rotated`; `PUT /auth/password`):
   * events already published, including those queued while a delivery runs (a listener that calls this), are delivered
   * first; then every subscription that has `onDisconnect` or `onClose` (the SSE streams) is removed and notified
   * (`onDisconnect`, else `onClose`). In-process listeners without either stay subscribed; later subscriptions and
   * `emit`s work as before. Resolves once every `onDisconnect` settled (a rejection is logged, never thrown).
   */
  readonly disconnectAll: () => Promise<void>
}
