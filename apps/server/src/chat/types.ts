// Frozen interface of chat runs (ARCHITECTURE.md 6.1-6.3, API.md 5.10 / 6). Implementation:
// `createChatRunner(deps)` in `chat/index.ts` (W2.1). Consumers: the chat routes (W2.1), the chats service
// (`running`, W1.5), `DELETE /chats/:id` (stops a run first, W1.5) and shutdown.
import type { ChatRequestBody } from '@harness-forge/shared'
import type { Logger } from '../logger.ts'

/** An active run (at most one per chat), kept in memory. */
export interface ActiveRun {
  runId: string
  chatId: string
  /** The assistant message being generated (server-generated id, ADR-019). */
  messageId: string
  modelRef: string
  startedAt: number
}

export interface ChatRunOptions {
  /** Request-scoped logger (carries `reqId`). */
  logger: Logger
  requestId: string
}

/**
 * Runs are decoupled from HTTP requests: a run keeps going when the client disconnects (its own `AbortController`,
 * never the request signal), can be resumed from its buffer and is stopped only by `stop()` or shutdown.
 */
export interface ChatRunner {
  /**
   * `POST /chat`: acquires the chat (`conflict`, reason `run-active`), upserts it, resolves the model
   * (`provider_not_configured` before streaming), applies the history operation and starts streaming. Resolves with
   * the AI SDK v7 UI message stream response; errors before the stream starts are thrown as `HarnessError`s.
   */
  readonly start: (body: ChatRequestBody, options: ChatRunOptions) => Promise<Response>
  /** `GET /chat/:id/stream`: the active run replayed from its first chunk, then live; null when idle (route: 204). */
  readonly resume: (chatId: string) => Response | null
  /** `POST /chat/:id/stop`: aborts and waits until the partial message is persisted; false when no run was active. */
  readonly stop: (chatId: string) => Promise<boolean>
  /** A run is active for the chat (`ChatSummary.running`). */
  readonly isActive: (chatId: string) => boolean
  /** Every active run. */
  readonly active: () => ActiveRun[]
  /** Shutdown: aborts every run (persisted as `aborted`) and waits for persistence. */
  readonly stopAll: () => Promise<void>
}
