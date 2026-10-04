// Agent state derived from the message path (Phase 9): compaction markers (ADR-040), steers inside replies (ADR-042)
// and the todo list (ADR-041); Phase 10: background task results (ADR-046, `splitTaskResults`, `taskResultText`). Pure and isomorphic; the server (model history, summarizer, share, export) and the web
// (transcript, todo strip) use these functions and never re-implement them.
//
// Every function takes a `path`: the messages of one branch of the chat tree, oldest first (`ChatDetail.messages`, the
// run's history, `useChat` messages). They only look at the given path, so the state is branch-aware (ADR-023): a
// branch above a marker or a todo call does not see it. Markers, steers and todo calls are recognized only in
// assistant messages (the server writes them only there). Malformed input (non-object parts, invalid part data) is
// skipped; nothing throws.
import type { CompactionData, SteerData } from '../chat.ts'
import type { TodoCounts, TodoItem } from '../schemas/agent.ts'
import { compactionDataSchema, steerDataSchema } from '../chat.ts'
import { todoWriteOutputSchema } from '../schemas/agent.ts'

/** A UI message, structurally (`HarnessUIMessage` and the AI SDK `UIMessage` satisfy it). */
export interface AgentStateMessage {
  id: string
  role: 'system' | 'user' | 'assistant'
  parts: ReadonlyArray<{ type: string } & Record<string, unknown>>
}

/** A part of an `AgentStateMessage`. */
export type AgentStatePart = AgentStateMessage['parts'][number]

/** Part type of compaction markers (`data-compaction`). */
export const COMPACTION_PART_TYPE = 'data-compaction'
/** Part type of steers (`data-steer`). */
export const STEER_PART_TYPE = 'data-steer'
/** Part type of `todo_write` calls (`tool-todo_write`). */
export const TODO_WRITE_PART_TYPE = 'tool-todo_write'

/**
 * Part types that are not content: a step boundary, a notice and the (normally transient) activity. An assistant half
 * of `splitSteers` holding only these is dropped, and a marker after only these is not `inline`.
 */
export const NON_CONTENT_PART_TYPES: ReadonlySet<string> = new Set(['step-start', 'data-notice', 'data-activity'])

/** True when `part` is content: any part whose type is not in `NON_CONTENT_PART_TYPES`. */
export function isContentPart(part: { type: string }): boolean {
  return !NON_CONTENT_PART_TYPES.has(part.type)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPart(value: unknown): value is AgentStatePart {
  return isRecord(value) && typeof value.type === 'string'
}

/** The parts of an assistant message, or `null` for anything else (other roles, malformed messages). */
function assistantParts(message: unknown): readonly unknown[] | null {
  if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.parts))
    return null
  return message.parts as readonly unknown[]
}

function compactionDataOf(part: unknown): CompactionData | null {
  if (!isPart(part) || part.type !== COMPACTION_PART_TYPE)
    return null
  const parsed = compactionDataSchema.safeParse(part.data)
  return parsed.success ? parsed.data : null
}

function lastUserBefore(path: readonly unknown[], messageIndex: number): number | null {
  for (let index = messageIndex - 1; index >= 0; index--) {
    const message = path[index]
    if (isRecord(message) && message.role === 'user')
      return index
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------------
// Compaction (ADR-040)

/** The latest compaction marker of a path (`findCompaction`). */
export interface CompactionLocation {
  /** Index of the assistant message that holds the marker. */
  messageIndex: number
  /** Index of the `data-compaction` part in that message. */
  partIndex: number
  /** The marker's data (as parsed by `compactionDataSchema`). */
  data: CompactionData
  /**
   * `keep: 'last-user'`: index of the last user message before `messageIndex` (`null` when there is none); `null` for
   * `keep: 'none'`.
   */
  keptUserIndex: number | null
}

/**
 * The latest valid compaction marker on the path: messages are scanned last to first, parts last to first; a
 * `data-compaction` part whose data fails `compactionDataSchema` is skipped. `null` when the path has none.
 *
 * Model history rule (implemented by the server's `buildModelHistory`): with the marker C at part `partIndex` of
 * message `messageIndex` (M_k), the model sees `[summary of C]` ++ (`keep: 'last-user'` ? `[path[keptUserIndex]]` : [])
 * ++ M_k's parts after `partIndex` (if any) ++ every later message. Everything before the marker (earlier messages and
 * M_k's earlier parts) is replaced by the summary but stays in the transcript. A deleted marker message or a branch
 * above the marker falls back to the previous marker or the full history, because only the path counts.
 */
export function findCompaction(path: readonly AgentStateMessage[]): CompactionLocation | null {
  if (!Array.isArray(path))
    return null
  for (let messageIndex = path.length - 1; messageIndex >= 0; messageIndex--) {
    const parts = assistantParts(path[messageIndex])
    if (parts === null)
      continue
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const data = compactionDataOf(parts[partIndex])
      if (data !== null) {
        const keptUserIndex = data.keep === 'last-user' ? lastUserBefore(path, messageIndex) : null
        return { messageIndex, partIndex, data, keptUserIndex }
      }
    }
  }
  return null
}

/** A compaction marker of a path (`compactionMarkers`). */
export interface CompactionMarker {
  messageIndex: number
  partIndex: number
  data: CompactionData
  /** The `id` of the `data-compaction` part, `null` when it has none. */
  partId: string | null
  /**
   * The marker has earlier content parts in its own message (`isContentPart`): the context was compacted during the
   * reply, so the divider belongs inside the message. `false` for a marker at the start of a reply (only step
   * boundaries, notices or activity before it), such as the `/compact` reply or a compaction before the first step.
   */
  inline: boolean
}

/** Every valid compaction marker on the path, in path order (the last one is the one `findCompaction` returns). */
export function compactionMarkers(path: readonly AgentStateMessage[]): CompactionMarker[] {
  const markers: CompactionMarker[] = []
  if (!Array.isArray(path))
    return markers
  for (let messageIndex = 0; messageIndex < path.length; messageIndex++) {
    const parts = assistantParts(path[messageIndex])
    if (parts === null)
      continue
    let content = false
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex]
      const data = compactionDataOf(part)
      if (data !== null) {
        const id = (part as AgentStatePart).id
        markers.push({ messageIndex, partIndex, data, partId: typeof id === 'string' ? id : null, inline: content })
      }
      if (isPart(part) && isContentPart(part))
        content = true
    }
  }
  return markers
}

/** A position in a path: a message index and a part index in it. */
export interface PathPosition {
  messageIndex: number
  /** May equal the message's part count (the position after its last part). */
  partIndex: number
}

/**
 * The first position the model still sees verbatim after the latest marker (`findCompaction`): the start of the kept
 * user message (`keep: 'last-user'` with a user message before the marker), otherwise the part right after the marker
 * (`partIndex` may then equal the part count of the marker's message). `null` without a marker. The web dims the
 * messages before `messageIndex`; with `keep: 'last-user'` the marker's own message is compacted up to the marker too
 * (see `findCompaction`), which an `inline` marker of `compactionMarkers` shows.
 */
export function compactionCutoff(path: readonly AgentStateMessage[]): PathPosition | null {
  const latest = findCompaction(path)
  if (latest === null)
    return null
  if (latest.keptUserIndex !== null)
    return { messageIndex: latest.keptUserIndex, partIndex: 0 }
  return { messageIndex: latest.messageIndex, partIndex: latest.partIndex + 1 }
}

// ---------------------------------------------------------------------------------------------------------------------
// Steers (ADR-042)

function hasSteer(message: unknown): boolean {
  const parts = assistantParts(message)
  return parts !== null && parts.some(part => isPart(part) && part.type === STEER_PART_TYPE)
}

/**
 * The messages with every assistant message that holds `data-steer` parts split at its steers, in order:
 * `assistant(parts before) / user(steer.parts) / assistant(parts after)` per steer.
 * - The user message has `id = steer.id` (the queued message id), `role: 'user'`, `parts = steer.parts` (text and file
 *   parts) and the other fields of the original message except `metadata`.
 * - Assistant halves keep every field of the original message (`metadata` included); the first kept half keeps the
 *   original id, each later kept half gets `${originalId}~${k}` (k = 1, 2, …). A half without content parts
 *   (`isContentPart`: only step boundaries, notices or activity) is dropped.
 * - A `data-steer` part whose data fails `steerDataSchema` is removed (no split there); so are malformed (non-object)
 *   parts of a split message.
 * - Messages without steers (and non-assistant messages) are returned as the same object, so callers can memoize.
 * A steer is delivered at a step boundary, so the split never separates a tool call from its result. Never throws.
 */
export function splitSteers<M extends AgentStateMessage>(messages: readonly M[]): M[] {
  const result: M[] = []
  if (!Array.isArray(messages))
    return result
  for (const message of messages) {
    if (!hasSteer(message)) {
      result.push(message)
      continue
    }
    let current: AgentStatePart[] = []
    let kept = 0
    const flush = (): void => {
      if (current.some(isContentPart)) {
        result.push({ ...message, id: kept === 0 ? message.id : `${message.id}~${kept}`, parts: current })
        kept++
      }
      current = []
    }
    for (const part of message.parts as readonly unknown[]) {
      if (isPart(part) && part.type === STEER_PART_TYPE) {
        const parsed = steerDataSchema.safeParse(part.data)
        if (!parsed.success)
          continue
        flush()
        result.push(steerMessage(message, parsed.data))
        continue
      }
      if (isPart(part))
        current.push(part)
    }
    flush()
  }
  return result
}

function steerMessage<M extends AgentStateMessage>(message: M, steer: SteerData): M {
  const { metadata: _metadata, ...rest } = message as M & { metadata?: unknown }
  return { ...rest, id: steer.id, role: 'user', parts: steer.parts } as unknown as M
}

// ---------------------------------------------------------------------------------------------------------------------
// Todos (ADR-041)

/** The todo list of a path (`latestTodos`). */
export interface TodoState {
  todos: TodoItem[]
  /** Counted from `todos` (`countTodos`). */
  counts: TodoCounts
  /** Index of the assistant message that holds the `todo_write` call. */
  messageIndex: number
  /** Index of the `tool-todo_write` part in that message. */
  partIndex: number
  toolCallId: string
}

/** The counts of a todo list by status (`todo_write` output `counts`). */
export function countTodos(todos: readonly TodoItem[]): TodoCounts {
  const counts: TodoCounts = { pending: 0, inProgress: 0, completed: 0, total: 0 }
  for (const todo of todos) {
    if (todo.status === 'pending')
      counts.pending++
    else if (todo.status === 'in_progress')
      counts.inProgress++
    else if (todo.status === 'completed')
      counts.completed++
    counts.total++
  }
  return counts
}

/**
 * The todo list of the path: the output of the last `tool-todo_write` part (parts last to first, messages last to
 * first) in `output-available` state that is not `preliminary`, has a string `toolCallId` and whose `output` parses
 * with `todoWriteOutputSchema`. Errored, denied, input-only, streaming and invalid parts are skipped, so the previous
 * list stays in force. `null` when the path has no list. `counts` is recomputed from `todos`. Calls made by sub-agents
 * are not parts of the path, so they never count.
 */
export function latestTodos(path: readonly AgentStateMessage[]): TodoState | null {
  if (!Array.isArray(path))
    return null
  for (let messageIndex = path.length - 1; messageIndex >= 0; messageIndex--) {
    const parts = assistantParts(path[messageIndex])
    if (parts === null)
      continue
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const part = parts[partIndex]
      if (!isPart(part) || part.type !== TODO_WRITE_PART_TYPE || part.state !== 'output-available')
        continue
      if (part.preliminary === true || typeof part.toolCallId !== 'string')
        continue
      const parsed = todoWriteOutputSchema.safeParse(part.output)
      if (!parsed.success)
        continue
      const todos = parsed.data.todos
      return { todos, counts: countTodos(todos), messageIndex, partIndex, toolCallId: part.toolCallId }
    }
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------------
// Background task results (Phase 10, ADR-046)

/** Part type of background task results (`data-task-result`): written into a reply or a carrier user message. */
export const TASK_RESULT_PART_TYPE = 'data-task-result'

/**
 * The fields of a `data-task-result` part's data that `taskResultText` reads. Structural: the shared
 * `{ taskId, toolCallId, messageId, output: TaskOutput, deliveredAt }` data satisfies it.
 */
export interface TaskResultTextInput {
  readonly taskId: string
  readonly output: {
    readonly status: string
    readonly type: string
    readonly description: string
    readonly report: string
    readonly error?: string
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * What the model reads for a background task result:
 * `<background-task id="…" type="…" status="…" description="…">`, a newline, the report (trimmed; `Error: …` when the
 * report is empty and the output has an error; `(no report)` when it has neither), a newline, `</background-task>`.
 * Attribute values escape `&`, `"` and `<`.
 */
export function taskResultText(data: TaskResultTextInput): string {
  const output = data.output
  const attributes = [
    `id="${escapeAttribute(data.taskId)}"`,
    `type="${escapeAttribute(output.type)}"`,
    `status="${escapeAttribute(output.status)}"`,
    `description="${escapeAttribute(output.description)}"`,
  ].join(' ')
  const report = output.report.trim()
  const error = typeof output.error === 'string' ? output.error.trim() : ''
  const content = report !== '' ? report : error !== '' ? `Error: ${error}` : '(no report)'
  return `<background-task ${attributes}>\n${content}\n</background-task>`
}

/** The data of a valid `data-task-result` part (read structurally), else null. */
function taskResultDataOf(part: unknown): TaskResultTextInput | null {
  if (!isPart(part) || part.type !== TASK_RESULT_PART_TYPE)
    return null
  const data = part.data
  if (!isRecord(data) || typeof data.taskId !== 'string' || !isRecord(data.output))
    return null
  const { status, type, description, report, error } = data.output
  if (typeof status !== 'string' || typeof type !== 'string' || typeof description !== 'string' || typeof report !== 'string')
    return null
  if (error !== undefined && typeof error !== 'string')
    return null
  return { taskId: data.taskId, output: error === undefined ? { status, type, description, report } : { status, type, description, report, error } }
}

function isTaskResultPart(part: unknown): boolean {
  return isPart(part) && part.type === TASK_RESULT_PART_TYPE
}

function taskResultTextPart(data: TaskResultTextInput): AgentStatePart {
  return { type: 'text', text: taskResultText(data) }
}

/** A user message whose parts are all `data-task-result` parts: the carrier of a turn the server started. */
function isCarrierMessage(message: unknown): boolean {
  return isRecord(message)
    && message.role === 'user'
    && Array.isArray(message.parts)
    && message.parts.length > 0
    && message.parts.every(isTaskResultPart)
}

function hasTaskResult(message: unknown): boolean {
  const parts = assistantParts(message)
  return parts !== null && parts.some(isTaskResultPart)
}

/**
 * The model's view of background task results (a model-history stage that runs after `splitSteers`):
 * - an assistant message holding `data-task-result` parts is split at each of them, in order, into
 *   `assistant(parts before) / user(result) / assistant(parts after)`, like `splitSteers`: the user message has
 *   `id = data.taskId`, `role: 'user'`, one text part `taskResultText(data)` and the other fields of the original
 *   message except `metadata`; assistant halves keep every field of the original; the first kept half keeps the
 *   original id and each later kept half gets `${originalId}~r${k}` (k = 1, 2, …; `~r` so the ids never collide with
 *   the `~k` halves of `splitSteers`); a half without content parts (`isContentPart`) is dropped; a result part whose
 *   data is invalid and malformed (non-object) parts of a split message are removed;
 * - a user message whose parts are all `data-task-result` parts (the carrier of a server-started turn) keeps every
 *   field and gets one text part `taskResultText(data)` per valid result; a carrier without a valid result is dropped;
 * - every other message is returned as the same object. Idempotent; never throws.
 */
export function splitTaskResults<M extends AgentStateMessage>(messages: readonly M[]): M[] {
  const result: M[] = []
  if (!Array.isArray(messages))
    return result
  for (const message of messages) {
    if (isCarrierMessage(message)) {
      const parts: AgentStatePart[] = []
      for (const part of message.parts) {
        const data = taskResultDataOf(part)
        if (data !== null)
          parts.push(taskResultTextPart(data))
      }
      if (parts.length > 0)
        result.push({ ...message, parts })
      continue
    }
    if (!hasTaskResult(message)) {
      result.push(message)
      continue
    }
    let current: AgentStatePart[] = []
    let kept = 0
    const flush = (): void => {
      if (current.some(isContentPart)) {
        result.push({ ...message, id: kept === 0 ? message.id : `${message.id}~r${kept}`, parts: current })
        kept++
      }
      current = []
    }
    for (const part of message.parts as readonly unknown[]) {
      if (isTaskResultPart(part)) {
        const data = taskResultDataOf(part)
        if (data === null)
          continue
        flush()
        result.push(taskResultMessage(message, data))
        continue
      }
      if (isPart(part))
        current.push(part)
    }
    flush()
  }
  return result
}

function taskResultMessage<M extends AgentStateMessage>(message: M, data: TaskResultTextInput): M {
  const { metadata: _metadata, ...rest } = message as M & { metadata?: unknown }
  return { ...rest, id: data.taskId, role: 'user', parts: [taskResultTextPart(data)] } as unknown as M
}
