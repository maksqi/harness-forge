// The steer queue of the chat runner (Phase 9, ADR-042, ARCHITECTURE.md 6.20; API.md 4.26). One instance per runner
// (`chat/index.ts`), in memory (lost on a restart), per chat, oldest first, at most `LIMITS.queueItemsMax` items of at
// most `LIMITS.queueItemBytes` each. Signatures FROZEN after P9-0b (C26); the implementation is W9.2's.
//
// Contract (W9.2): `add` normalizes the parts like a `POST /chat` user message (`normalizeUserParts`: file parts must
// name uploaded files), sets `turnOnly` when the first text is a server command (`/compact` or a registered plugin
// command: such an item is never steered, only started as the next turn), and throws `not_found` (unknown chat),
// `conflict` `run-idle` (no run registered and no pending approval), `queue-full` or `exists` (the message id is
// queued or stored); every change emits `queue.changed` (`QueueChangedData`, with `removed` reasons); the takes are
// synchronous, so a `DELETE` either wins (never delivered) or loses (404). Message contents are never logged at info.
//
// P9-0b stub: `add` and `requeue` throw `not_implemented`; the reads and removals answer the empty queue (nothing can be
// queued yet), so Stop, chat delete, shutdown and the step boundary keep working unchanged.
import type { QueueAddBody, QueueItem } from '@harness-forge/shared'
import type { AppDeps } from '../types.ts'
import type { ChatRunOptions, QueueClearReason } from './types.ts'
import { notImplementedError } from '../not-implemented.ts'

/** A queued item with the options of the request that queued it (the server-started turn logs with them). */
export interface QueueEntry {
  readonly item: QueueItem
  readonly options: ChatRunOptions
}

export interface ChatQueue {
  /** The chat's queued items, oldest first (`[]` when none, also for an unknown chat). */
  readonly list: (chatId: string) => QueueItem[]
  /** `ChatRunner.enqueue` (see the module comment for the checks and errors). */
  readonly add: (chatId: string, body: QueueAddBody, options: ChatRunOptions) => Promise<QueueItem>
  /** `ChatRunner.dequeue`: removes a queued item (reason `cancelled`); false when it is not queued. */
  readonly remove: (chatId: string, itemId: string) => boolean
  /**
   * The steer step (synchronous): removes and returns every steerable item (`turnOnly: false`), oldest first, reported
   * `delivered`; the `turnOnly` items stay queued.
   */
  readonly takeSteerable: (chatId: string) => QueueItem[]
  /** The run end (synchronous): removes and returns the oldest item (any kind) as the next turn, reported `started`. */
  readonly takeNext: (chatId: string) => QueueEntry | null
  /** Puts a taken entry back at the head of the queue (its next turn lost the race to a user's `POST /chat`). */
  readonly requeue: (chatId: string, entry: QueueEntry) => void
  /** `ChatRunner.clearQueue`: empties the chat's queue and returns the removed items, oldest first. */
  readonly clear: (chatId: string, reason: QueueClearReason) => QueueItem[]
  /** Empties every chat's queue (shutdown: before the runs are aborted). */
  readonly clearAll: (reason: QueueClearReason) => void
}

/** What the queue reads (lazily, inside its methods: the runner is built inside the deps factory). */
export type ChatQueueDeps = Pick<AppDeps, 'chats' | 'files' | 'registry' | 'events' | 'logger'>

export interface ChatQueueOptions {
  /** The runs registry holds the chat (a run in any phase): `add` accepts items only then or with a pending approval. */
  readonly hasRun: (chatId: string) => boolean
  /** The clock (`createdAt`). */
  readonly now: () => number
}

/** The queue of a chat runner (stub until W9.2: see the module comment). */
export function createChatQueue(_deps: ChatQueueDeps, _options: ChatQueueOptions): ChatQueue {
  return {
    list: () => [],
    add: async () => {
      throw notImplementedError('The steer queue')
    },
    remove: () => false,
    takeSteerable: () => [],
    takeNext: () => null,
    requeue: () => {
      throw notImplementedError('The steer queue')
    },
    clear: () => [],
    clearAll: () => {},
  }
}
