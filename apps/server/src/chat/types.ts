// Frozen interface of chat runs (ARCHITECTURE.md 6.1-6.3, API.md 5.10 / 6). Implementation:
// `createChatRunner(deps)` in `chat/index.ts` (W2.1). Consumers: the chat routes (W2.1), the chats service
// (`running`, W1.5), `DELETE /chats/:id` (stops a run first, W1.5), shutdown, and in Phase 5 the branch switch
// (`hasRun`, W5.1, ADR-023) and delete-all (`stop` for every chat, W5.3, ADR-024).
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
  /**
   * `POST /chat/:id/stop`: aborts the chat's run in any phase (a `preparing` run is refused before its history is
   * committed) and waits until it is released (the partial message persisted); false when no run was registered or it
   * was already `finishing` (it is still awaited).
   */
  readonly stop: (chatId: string) => Promise<boolean>
  /** A run is streaming for the chat (`ChatSummary.running`, resumable). False while it is `preparing` or `finishing`. */
  readonly isActive: (chatId: string) => boolean
  /**
   * The runs registry holds the chat, in any phase: `preparing` (request accepted, history not committed yet),
   * `streaming` or `finishing` (the reply is being persisted). Unlike `isActive`, this is true from the moment
   * `POST /chat` acquires the chat until the run is released, i.e. whenever a run may still write the chat's messages
   * or its active leaf. `POST /chats/:id/branch` is refused with `409 conflict` (`reason: 'run-active'`) while it is
   * true (ADR-023).
   */
  readonly hasRun: (chatId: string) => boolean
  /** Every active run. */
  readonly active: () => ActiveRun[]
  /** Shutdown: aborts every run (persisted as `aborted`) and waits for persistence. */
  readonly stopAll: () => Promise<void>
}
