// The steer queue of the chat runner (Phase 9, ADR-042, ARCHITECTURE.md 6.20; API.md 4.26). One instance per runner
// (`chat/index.ts`), in memory (lost on a restart), per chat, oldest first, at most `LIMITS.queueItemsMax` items of at
// most `LIMITS.queueItemBytes` each (the body schema checks the size). Signatures FROZEN after P9-0b (C26); the
// implementation is W9.2's.
//
// - `add` normalizes the parts like a `POST /chat` user message (`normalizeUserParts`: file parts must name uploaded
//   files), sets `turnOnly` when the first text is a server command (`/compact` or a registered plugin command: such an
//   item is never steered, only started as the next turn), and throws `not_found` (unknown chat), `conflict` `run-idle`
//   (no run registered and no pending approval), `queue-full` or `exists` (the message id is queued or stored). The
//   checks that depend on the queue run synchronously right before the item is appended (after every await), so a run
//   that ends meanwhile either sees the item at its release or the add answers `run-idle`.
// - Every change emits `queue.changed` (`QueueChangedData`: the whole queue after the change, `removed` with the
//   reasons). The takes are synchronous, so a `DELETE` either wins (never delivered) or loses (404).
// - Clearing: Stop and shutdown call `clear` / `clearAll` (through the runner); the queue itself listens to the event
//   bus (subscribed with its first item) and empties the queue of a deleted chat (`chat.deleted`, also an add still in
//   flight for it) and every queue after a master-key rotation (`key.rotated`: also the chats that wait for an approval,
//   which the rotation does not stop). No timers.
// - Message contents are never logged (ids at `debug` only).
import type { HarnessUIMessagePart, QueueAddBody, QueueChangedData, QueueItem, QueueRemoval, UserMessagePart } from '@harness-forge/shared'
import type { AppDeps } from '../types.ts'
import type { ChatRunOptions, QueueClearReason } from './types.ts'
import { HarnessError, isClientCommand, isHarnessCommand, LIMITS } from '@harness-forge/shared'
import { chatNotFound } from '../services/chats/store.ts'
import { parseSlashCommand } from './commands.ts'
import { normalizeUserParts } from './files.ts'

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

/** `409 conflict` with a queue reason (`run-idle`, `queue-full`, `exists`). */
export function queueConflict(reason: 'run-idle' | 'queue-full' | 'exists', chatId: string): HarnessError {
  const messages = {
    'run-idle': 'Nothing is running in this chat: send the message instead of queueing it.',
    'queue-full': `The queue is full: at most ${LIMITS.queueItemsMax} messages can wait. Wait for the agent to take one.`,
    'exists': 'A message with this id is already queued or stored.',
  } as const
  return new HarnessError({ code: 'conflict', message: messages[reason], details: { reason, chatId } })
}

/** The first text of the parts (the text a slash command is read from), or `''`. */
function firstText(parts: readonly UserMessagePart[]): string {
  for (const part of parts) {
    if (part.type === 'text')
      return part.text
  }
  return ''
}

/**
 * True when `text` starts a server command: the harness command `/compact` or a command a plugin registered (client
 * commands like `/model` are the composer's and never reach the server as commands).
 */
export function isServerCommand(text: string, commands: Pick<AppDeps['registry']['commands'], 'get'>): boolean {
  const parsed = parseSlashCommand(text)
  if (parsed === null || isClientCommand(parsed.name))
    return false
  return isHarnessCommand(parsed.name) || commands.get(parsed.name) !== undefined
}

/** The stored parts of a user message as queue parts (`normalizeUserParts` returns only text and file parts). */
function toQueueParts(parts: readonly HarnessUIMessagePart[]): UserMessagePart[] {
  return parts.flatMap((part): UserMessagePart[] => {
    if (part.type === 'text')
      return [{ type: 'text', text: part.text }]
    if (part.type === 'file')
      return [{ type: 'file', mediaType: part.mediaType, ...(part.filename === undefined ? {} : { filename: part.filename }), url: part.url }]
    return []
  })
}

/** An add still waiting for the database: a `chat.deleted` meanwhile makes it fail instead of queueing. */
interface PendingAdd {
  deleted: boolean
}

/** The queue of a chat runner (see the module comment). */
export function createChatQueue(deps: ChatQueueDeps, options: ChatQueueOptions): ChatQueue {
  const queues = new Map<string, QueueEntry[]>()
  const pending = new Map<string, Set<PendingAdd>>()
  let subscribed = false

  const itemsOf = (chatId: string): QueueItem[] => (queues.get(chatId) ?? []).map(entry => entry.item)

  /** Stores the chat's entries (an empty queue leaves no map entry behind) and emits `queue.changed`. */
  function commit(chatId: string, entries: QueueEntry[], removed: QueueRemoval[]): void {
    if (entries.length === 0)
      queues.delete(chatId)
    else
      queues.set(chatId, entries)
    const data: QueueChangedData = { chatId, items: entries.map(entry => entry.item), ...(removed.length === 0 ? {} : { removed }) }
    deps.events.emit('queue.changed', data)
  }

  function clear(chatId: string, reason: QueueClearReason): QueueItem[] {
    const entries = queues.get(chatId)
    if (entries === undefined || entries.length === 0)
      return []
    const items = entries.map(entry => entry.item)
    commit(chatId, [], items.map(item => ({ id: item.id, reason })))
    deps.logger.debug('queue cleared', { chatId, count: items.length, reason })
    return items
  }

  function clearAll(reason: QueueClearReason): void {
    for (const chatId of [...queues.keys()])
      clear(chatId, reason)
  }

  /** Listens for chat deletions and key rotations (once, with the first add: an empty queue has nothing to clear). */
  function subscribe(): void {
    if (subscribed)
      return
    subscribed = true
    deps.events.subscribe((event) => {
      if (event.type === 'chat.deleted') {
        for (const add of pending.get(event.data.id) ?? [])
          add.deleted = true
        clear(event.data.id, 'stopped')
      }
      else if (event.type === 'key.rotated') {
        clearAll('stopped')
      }
    })
  }

  async function add(chatId: string, body: QueueAddBody, runOptions: ChatRunOptions): Promise<QueueItem> {
    subscribe()
    const token: PendingAdd = { deleted: false }
    const adds = pending.get(chatId) ?? new Set<PendingAdd>()
    adds.add(token)
    pending.set(chatId, adds)
    try {
      const chat = await deps.chats.find(chatId)
      if (chat === null)
        throw chatNotFound(chatId)
      const id = body.message.id
      if (queues.get(chatId)?.some(entry => entry.item.id === id) || await deps.chats.getMessage(chatId, id) !== null)
        throw queueConflict('exists', chatId)
      const parts = toQueueParts(await normalizeUserParts(body.message.parts, deps.files))
      const turnOnly = isServerCommand(firstText(parts), deps.registry.commands)

      // Synchronous from here on: the state the checks read cannot change before the item is appended.
      if (token.deleted)
        throw chatNotFound(chatId)
      if (!options.hasRun(chatId) && !chat.pendingApproval)
        throw queueConflict('run-idle', chatId)
      const entries = queues.get(chatId) ?? []
      if (entries.some(entry => entry.item.id === id))
        throw queueConflict('exists', chatId)
      if (entries.length >= LIMITS.queueItemsMax)
        throw queueConflict('queue-full', chatId)
      const item: QueueItem = {
        id,
        message: { id, role: 'user', parts },
        modelRef: body.modelRef,
        reasoningEffort: body.reasoningEffort,
        toolMode: body.toolMode,
        createdAt: options.now(),
        turnOnly,
      }
      commit(chatId, [...entries, { item, options: runOptions }], [])
      runOptions.logger.debug('message queued', { chatId, itemId: id, turnOnly, queued: entries.length + 1 })
      return item
    }
    finally {
      adds.delete(token)
      if (adds.size === 0 && pending.get(chatId) === adds)
        pending.delete(chatId)
    }
  }

  return {
    list: itemsOf,

    add,

    remove: (chatId, itemId) => {
      const entries = queues.get(chatId) ?? []
      const index = entries.findIndex(entry => entry.item.id === itemId)
      if (index < 0)
        return false
      commit(chatId, entries.filter((_entry, at) => at !== index), [{ id: itemId, reason: 'cancelled' }])
      deps.logger.debug('queued message cancelled', { chatId, itemId })
      return true
    },

    takeSteerable: (chatId) => {
      const entries = queues.get(chatId) ?? []
      const taken = entries.filter(entry => !entry.item.turnOnly)
      if (taken.length === 0)
        return []
      const items = taken.map(entry => entry.item)
      commit(chatId, entries.filter(entry => entry.item.turnOnly), items.map(item => ({ id: item.id, reason: 'delivered' })))
      deps.logger.debug('queued messages steered', { chatId, count: items.length })
      return items
    },

    takeNext: (chatId) => {
      const [first, ...rest] = queues.get(chatId) ?? []
      if (first === undefined)
        return null
      commit(chatId, rest, [{ id: first.item.id, reason: 'started' }])
      return first
    },

    requeue: (chatId, entry) => {
      const entries = queues.get(chatId) ?? []
      if (entries.some(queued => queued.item.id === entry.item.id))
        return
      if (entries.length >= LIMITS.queueItemsMax) {
        // Items queued while the next turn was starting filled the queue: the entry cannot go back.
        commit(chatId, entries, [{ id: entry.item.id, reason: 'failed', error: 'The queue is full.' }])
        return
      }
      commit(chatId, [entry, ...entries], [])
    },

    clear,

    clearAll,
  }
}
