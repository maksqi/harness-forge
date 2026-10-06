// Frozen interface of chat runs (ARCHITECTURE.md 6.1-6.3, API.md 5.10 / 6). Implementation:
// `createChatRunner(deps)` in `chat/index.ts` (W2.1). Consumers: the chat routes (W2.1), the chats service
// (`running`, W1.5), `DELETE /chats/:id` (stops a run first, W1.5), shutdown, and in Phase 5 the branch switch
// (`hasRun`, W5.1, ADR-023) and delete-all (`stop` for every chat, W5.3, ADR-024). Phase 9 (C24, ADR-042): the steer
// queue members (`queueList`, `enqueue`, `dequeue`, `clearQueue`) behind the `chatQueue` routes (API.md 4.26 / 5.26),
// implemented by delegation to the in-memory queue of `chat/queue.ts` (C26 stubs, W9.2); `stop` and `stopAll` empty the
// queues before they abort runs. Phase 10 (C30, ADR-046): the background task members (`taskList`, `stopTask`,
// `stopTasks`, `hasTasks`) behind the `chatTasks` routes (API.md 4.29 / 5.30) and the project-busy guards, and the boot
// hook `boot()` (the boot sweep of `background_tasks`); implemented by delegation to the runner's background manager
// (`chat/background/types.ts` `BackgroundTasks`; wired by C31, implemented by W10.4); `stopAll` stops the background
// tasks between the queues and the runs. Phase 11 (C36, ADR-048): the run origin `hook` (`RunOrigin`, shared: a Stop
// continuation, a server-started turn from a user-role carrier message that holds only `data-hook` parts) and
// `RunReleaseFollowUp`, what a released run hands to the runner (`RunContext.onReleased(ending, awaitingApproval,
// followUp)`, `chat/pipeline.ts`); the runner starts the hook turn itself (`startHookTurn` in `chat/index.ts`), so
// `ChatRunner` gains no member.
import type { BackgroundTask, ChatRequestBody, HookData, QueueAddBody, QueueItem, QueueRemovalReason } from '@harness-forge/shared'
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
 * What a released run asks the runner to do next (Phase 11, ADR-048): `hook` = the `Stop` hooks blocked the end of the
 * run, so a follow-up turn with run origin `hook` starts from a carrier user message holding `data` (the `data-hook`
 * record of the `Stop` event, outcome `continued`). Priority when a run ends: a queued item, then the hook turn, then
 * the idle background delivery; never while an approval is pending; a lost start (409 `run-active`) drops it. Absent
 * (undefined) = nothing to follow.
 */
export interface RunReleaseFollowUp { readonly kind: 'hook', readonly data: HookData }

/**
 * Why `clearQueue` empties a chat's queue (the `reason` of every `QueueRemoval` of the `queue.changed` event):
 * `stopped` (Stop, chat delete, delete-all, key rotation, shutdown) or `failed` (the run failed).
 */
export type QueueClearReason = Extract<QueueRemovalReason, 'stopped' | 'failed'>

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
   * Phase 9: first empties the chat's steer queue (as `clearQueue(chatId, 'stopped')`, also when no run is registered,
   * e.g. a chat waiting for an approval), so every caller (chat delete, delete-all, key rotation) drops the queue too;
   * every sub-agent of the run aborts through the run's signal. The `chat.stop` route calls `clearQueue(chatId,
   * 'stopped')` itself right before `stop` and answers the removed items as `ChatStopResult.dropped` (absent when
   * empty); the queue is then already empty when `stop` runs.
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
  /**
   * Shutdown, in this order: clears every queue (every chat's steer queue, reason `stopped`, so no queued message can
   * start a new turn), then aborts every background task (Phase 10: `BackgroundTasks.stopAll`, awaited at most 5 s, the
   * rows saved), then aborts every run (persisted as `aborted`; sub-agents abort through their parent run's signal) and
   * waits for persistence.
   */
  readonly stopAll: () => Promise<void>

  // Steer queue (Phase 9, ADR-042; API.md 4.26 / 5.26). In memory, per chat, oldest first, at most
  // `LIMITS.queueItemsMax` items; every change emits `queue.changed` (`QueueChangedData`). Message contents are never
  // logged at info.

  /**
   * `GET /chat/:id/queue`: the chat's queued messages, oldest first (empty when nothing is queued, also for an unknown
   * chat: `queueList` and `dequeue` are synchronous, so the routes answer `404` for an unknown chat themselves).
   */
  readonly queueList: (chatId: string) => QueueItem[]
  /**
   * `POST /chat/:id/queue`: normalizes the message parts like those of a `POST /chat` user message (file parts must name
   * uploaded files; `mediaType` / `filename` rewritten from the stored file), marks server commands (`/compact`, plugin
   * commands) `turnOnly`, appends the item and emits `queue.changed`. `options` (logger, request id) are kept for the
   * turn the server may start from the item. Throws `HarnessError`s: `not_found` (unknown chat), `validation_error`
   * (on `['message', 'parts', i]`), `conflict` with `reason: 'run-idle'` (no run registered and no pending approval),
   * `'queue-full'` (`LIMITS.queueItemsMax` items queued) or `'exists'` (the message id is already queued or stored).
   */
  readonly enqueue: (chatId: string, body: QueueAddBody, options: ChatRunOptions) => Promise<QueueItem>
  /**
   * `DELETE /chat/:id/queue/:itemId`: removes a queued message (reason `cancelled`, emits `queue.changed`); false when
   * it is not queued (route: `404 not_found`): already delivered or started, or never queued. Synchronous, like the
   * step boundary that takes the queue, so a cancel either wins (never delivered) or loses (false).
   */
  readonly dequeue: (chatId: string, itemId: string) => boolean
  /**
   * Empties the chat's queue and returns the removed items, oldest first; emits one `queue.changed` listing every
   * removed item with `reason` (no event, and an empty array, when nothing was queued).
   */
  readonly clearQueue: (chatId: string, reason: QueueClearReason) => QueueItem[]

  // Background tasks (Phase 10, ADR-046; API.md 4.29 / 5.30). Delegated to the runner's `BackgroundTasks` manager
  // (`chat/background/types.ts`). The chat's own `stop` never stops a background task.

  /**
   * Boot hook (`startDeps`, once, right after `checkpoints.start()`): the boot sweep of `background_tasks` (rows still
   * `running` → `aborted`, undelivered results → the in-memory inboxes; no turn is started at boot). Named `boot`
   * because `start` is `POST /chat`. A no-op until W10.4.
   */
  readonly boot: () => Promise<void>
  /** `GET /chat/:id/tasks`: the chat's background tasks, newest first (the route answers `404` for an unknown chat). */
  readonly taskList: (chatId: string) => Promise<BackgroundTask[]>
  /**
   * `POST /chat/:id/tasks/:taskId/stop`: aborts a running task and answers it once its row is saved; a task that already
   * ended is answered as it is; null when the chat has no such task (route: `404`).
   */
  readonly stopTask: (chatId: string, taskId: string) => Promise<BackgroundTask | null>
  /**
   * Aborts every running background task of the chat and waits until their rows are saved (chat delete, project delete,
   * delete-all, key rotation); returns how many were running.
   */
  readonly stopTasks: (chatId: string) => Promise<number>
  /**
   * A background task of the chat is running: its project is busy (`409 conflict`, `reason: 'run-active'`, for rewind,
   * revert, undo, project delete, chat move and version delete; a branch switch stays allowed). Synchronous.
   */
  readonly hasTasks: (chatId: string) => boolean
}
