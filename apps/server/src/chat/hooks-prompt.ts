// `UserPromptSubmit` and `SessionStart` (Phase 11, ADR-048, ARCHITECTURE.md 6.28). Signatures FROZEN after P11-0b (C37
// stub); the implementation is W11.2's.
//
// `runPromptHooks(input)` is called by `prepareRun` (`prepare.ts`) for every request, right after the project folder
// opened and before anything but the chat row is written (`commitHistory` follows `prepareRun`):
// - it applies to a new user message of a chat-model run (`prepared.kind === 'new'`, a chat target, no reply or
//   `/compact` command deciding the reply) the user wrote: never to a server-built carrier (`serverMessage`: a `task` or
//   `hook` turn), never to a regenerate or an approval continuation (they reuse the stored records);
// - `SessionStart` first, when `sessionStartSource(path before the new message)` is `startup` (an empty path) or
//   `compact` (the first turn after a compaction), for `request` and `queue` turns; then `UserPromptSubmit` with the
//   typed text (`prompt`; a slash command's name as `command`), for `request` turns only: a queued turn's
//   `UserPromptSubmit` ran at enqueue and its records come as `precomputed` (attached, never run again);
// - one snapshot per prepare (`deps.hooks.snapshot`, the scope of the run); a block (exit 2, `decision: block`) or
//   `continue: false` of either event throws `HarnessError` 409 `conflict` with `details: { reason: 'hook-blocked',
//   chatId, hook: record }` (`hookBlockedError`) and nothing is stored: `prepareRun` also removes the chat row when this
//   request created it (a blocked first message on `/` leaves no chat);
// - the records with something to show (contexts, errors, system messages) are returned in order and `prepareRun`
//   appends them to the new user message as `data-hook` parts (`splitHooks` turns a context into model text).
// W11.2 (P11-A):
// - `precomputed` records are returned (after a `SessionStart` record) whenever they are given: a queued turn whose turn
//   needs no model call still shows what its hooks did when it was queued;
// - `runQueuedPromptHooks(input)` is the enqueue side (`POST /chat/:id/queue`, called by the queue's `add` through the
//   runner, `queue.ts` / `index.ts`): `UserPromptSubmit` with the queued text runs synchronously before the item is
//   appended (origin `queue`, the chat's project folder opened for the scope); a block is the same 409 `hook-blocked`
//   (nothing queued); the records go with the queued item and are attached when it is delivered (`data-hook` parts on
//   the user message of the turn it starts, or injected after its `data-steer` part by the steer step). A `/compact`
//   item and an image model run no hook (they never reach a model with the text).
// Prompts, contexts and reasons are never logged (the event and the outcome only, at `debug`).
// W11.19: the accepted response of a request whose new user message got records says how many
// (`PROMPT_HOOKS_HEADER`, set by the runner through `withPromptHooksHeader`), so the client reloads that message once.
import type { ChatRequestBody, HarnessUIMessage, HookData, HookEvent, QueueAddBody, RunOrigin, UserMessagePart } from '@harness-forge/shared'
import type { Logger } from '../logger.ts'
import type { ChatRecord } from '../services/chats/types.ts'
import type { HookEventResult, HookRunInput, HookScope, HookSnapshot } from '../services/hooks/types.ts'
import type { OpenWorkspace } from '../services/projects/types.ts'
import type { AppDeps } from '../types.ts'
import type { PreparedRun } from './prepare.ts'
import { createHookRecordId, HarnessError, HOOK_PART_TYPE, isHarnessCommand, isHarnessError, LIMITS, safeParseModelRef, sessionStartSource } from '@harness-forge/shared'
import { parseSlashCommand } from './commands.ts'

/** The planned run the prompt hooks look at (`prepareRun` before it returns). */
export type PromptHooksRun = Pick<PreparedRun, 'kind' | 'chat' | 'target' | 'resolved' | 'history' | 'userMessage' | 'command' | 'workspace'>

/** What `runPromptHooks` needs. */
export interface PromptHooksInput {
  readonly deps: AppDeps
  readonly prepared: PromptHooksRun
  /** The request (its tool mode; `permission_mode` of the payload). */
  readonly body: ChatRequestBody
  /** The run's origin (`request` or `queue` for a user's message; `task` / `hook` turns carry server-built messages). */
  readonly origin: RunOrigin
  /** The new message is a server-built carrier (`PrepareRunOptions.serverMessage`): no prompt hooks. */
  readonly serverMessage: boolean
  /** The `UserPromptSubmit` records of a queued turn, run at enqueue (`PrepareRunOptions.hookRecords`). */
  readonly precomputed?: readonly HookData[]
  readonly signal: AbortSignal
  readonly logger: Logger
}

/** What the prompt hooks add to the new user message. */
export interface PromptHooksResult {
  /** The `data-hook` records for the new user message, in order (`SessionStart`, then `UserPromptSubmit`). */
  readonly records: readonly HookData[]
}

/**
 * W11.19: the response header of an accepted `POST /chat` whose new user message got `data-hook` records from the prompt
 * hooks (`SessionStart` / `UserPromptSubmit`): their number. The client's own copy of that message lacks them, so it
 * reloads the message once the run finished (`useChatSession`) instead of after every turn. Absent without records.
 */
export const PROMPT_HOOKS_HEADER = 'X-Harness-Prompt-Hooks'

/**
 * Sets `PROMPT_HOOKS_HEADER` on the stream response of a request (`origin: 'request'`) whose new user message carries
 * `data-hook` parts (a client message never does: only the prompt hooks add them). Never throws: the response of a
 * launched run goes out either way.
 */
export function withPromptHooksHeader(response: Response, message: Pick<HarnessUIMessage, 'parts'> | null, origin: RunOrigin): Response {
  if (origin !== 'request' || message === null)
    return response
  const count = message.parts.filter(part => part.type === HOOK_PART_TYPE).length
  if (count === 0)
    return response
  try {
    response.headers.set(PROMPT_HOOKS_HEADER, String(count))
  }
  catch {
    // Immutable headers (never for the stream response): the records show after a reload, as before.
  }
  return response
}

/** The 409 of a blocked turn (`details.reason: 'hook-blocked'`, `details.hook`: the blocking record). */
export function hookBlockedError(chatId: string, record: HookData): HarnessError {
  const reason = record.reason?.trim() ?? ''
  const message = reason === '' ? 'A hook blocked this message.' : `A hook blocked this message: ${reason}`
  return new HarnessError({ code: 'conflict', message: message.slice(0, 2000), details: { reason: 'hook-blocked', chatId, hook: record } })
}

/** The error is the 409 `hook-blocked` of a prompt hook. */
export function isHookBlockedError(error: unknown): boolean {
  return isHarnessError(error) && error.code === 'conflict' && (error.details as { reason?: unknown } | undefined)?.reason === 'hook-blocked'
}

/** `text` cut to at most `max` UTF-16 code units, never inside a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max)
    return text
  const last = text.charCodeAt(max - 1)
  return text.slice(0, last >= 0xD800 && last <= 0xDBFF ? max - 1 : max)
}

/**
 * The record a blocking result answers with: the service's record (its reason completed from the result when it has
 * none), else a minimal one (`blocked` for a block, `stopped` for `continue: false`) with the reason or stop reason.
 */
export function blockingRecord(event: HookEvent, result: HookEventResult, now: () => number = Date.now): HookData {
  const reason = (result.block ? result.reason : result.stopReason ?? result.reason)?.trim() ?? ''
  const record = result.record
  if (record !== null)
    return record.reason !== undefined || reason === '' ? record : { ...record, reason: cut(reason, LIMITS.hookReasonMaxChars) }
  return {
    id: createHookRecordId(),
    event,
    outcome: result.block ? 'blocked' : 'stopped',
    createdAt: now(),
    hooks: [],
    ...(reason === '' ? {} : { reason: cut(reason, LIMITS.hookReasonMaxChars) }),
  }
}

/** The result blocks the message: a block or `continue: false`. */
function blocks(result: HookEventResult): boolean {
  return result.block || !result.continue
}

/** The text of the user's message: its text parts joined with a newline (the typed text; expansions are not part of it). */
export function promptText(parts: readonly { readonly type: string, readonly text?: unknown }[]): string {
  return parts.flatMap(part => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : [])).join('\n')
}

/**
 * Runs one prompt event over `snapshot` when it has hooks of the event: the record to keep (null = nothing to show), or
 * the 409 `hook-blocked` of a blocking result. Rejects on an abort of `signal`.
 */
async function runEvent(snapshot: HookSnapshot, event: HookEvent, input: HookRunInput, chatId: string, signal: AbortSignal, logger: Logger): Promise<HookData | null> {
  if (!snapshot.has(event))
    return null
  const result = await snapshot.run(event, input, { signal })
  if (blocks(result)) {
    const record = blockingRecord(event, result)
    logger.info('a prompt hook blocked the message', { event, outcome: record.outcome })
    throw hookBlockedError(chatId, record)
  }
  if (result.record !== null)
    logger.debug('a prompt hook added a record to the message', { event, outcome: result.record.outcome })
  return result.record
}

/** The prompt hooks apply to the planned run (see the module comment). */
function applies(input: PromptHooksInput): boolean {
  const { prepared } = input
  return prepared.kind === 'new'
    && !input.serverMessage
    && prepared.userMessage !== null
    && prepared.userMessage !== undefined
    && prepared.target?.kind === 'chat'
    && prepared.command === null
}

/**
 * Runs `SessionStart` and `UserPromptSubmit` for the new user message of a run (see the module comment). Rejects with
 * the 409 `hook-blocked` of a blocking hook, and on an abort of `input.signal`.
 */
export async function runPromptHooks(input: PromptHooksInput): Promise<PromptHooksResult> {
  input.signal.throwIfAborted()
  const precomputed = [...(input.precomputed ?? [])]
  if (!applies(input))
    return { records: precomputed }
  const { deps, prepared, body, origin, signal, logger } = input
  const message = prepared.userMessage!
  const source = origin === 'request' || origin === 'queue' ? sessionStartSource(prepared.history.slice(0, -1)) : null
  const prompt = origin === 'request'
  if (source === null && !prompt)
    return { records: precomputed }
  const scope: HookScope = {
    chatId: body.chatId,
    projectId: prepared.chat.projectId,
    workspace: prepared.workspace,
    toolMode: body.toolMode,
    origin,
    modelRef: prepared.resolved.modelRef,
  }
  const snapshot = await deps.hooks.snapshot(scope, { signal })
  const records: HookData[] = []
  if (source !== null) {
    const record = await runEvent(snapshot, 'SessionStart', { messageId: message.id, sessionSource: source }, body.chatId, signal, logger)
    if (record !== null)
      records.push(record)
  }
  if (prompt) {
    const command = message.metadata?.command?.name
    const record = await runEvent(snapshot, 'UserPromptSubmit', {
      messageId: message.id,
      prompt: promptText(message.parts),
      ...(typeof command === 'string' && command !== '' ? { command } : {}),
    }, body.chatId, signal, logger)
    if (record !== null)
      records.push(record)
  }
  return { records: [...records, ...precomputed] }
}

/** What `runQueuedPromptHooks` needs (the queue's `add`, through the runner). */
export interface QueuedPromptHooksInput {
  readonly deps: Pick<AppDeps, 'hooks' | 'projects' | 'catalog'>
  /** The chat the item is queued for. */
  readonly chat: Pick<ChatRecord, 'id' | 'projectId'>
  /** The validated queue body (the model, the mode, the message id). */
  readonly body: QueueAddBody
  /** The item's normalized parts (the queued text). */
  readonly parts: readonly UserMessagePart[]
  /** The item is a server command (`turnOnly`): its slash command's name goes into the payload as `command`. */
  readonly turnOnly: boolean
  /** Aborted at shutdown: the hooks are killed and the add fails. */
  readonly signal: AbortSignal
  readonly logger: Logger
}

/** The model of the item is an image model (catalog kind `image`): no prompt reaches a chat model. */
async function isImageModel(deps: Pick<AppDeps, 'catalog'>, modelRef: string): Promise<boolean> {
  const parts = safeParseModelRef(modelRef)
  if (parts === null)
    return false
  const entry = await deps.catalog.get(parts.providerId, parts.modelId).catch(() => null)
  return entry?.kind === 'image'
}

/** The chat's project folder for the scope of a queued message (null without a project or when it does not open). */
async function queuedWorkspace(deps: Pick<AppDeps, 'projects'>, projectId: string | null, logger: Logger): Promise<OpenWorkspace | null> {
  if (projectId === null)
    return null
  try {
    const result = await deps.projects.openWorkspace(projectId)
    return result.ok ? result.workspace : null
  }
  catch (error) {
    logger.warn('the project folder of a queued message could not be opened; its hooks run without it', { projectId, err: error })
    return null
  }
}

/**
 * `UserPromptSubmit` of a queued message (see the module comment): the records to keep with the item (`[]` = nothing to
 * show). Rejects with the 409 `hook-blocked` of a blocking hook and on an abort of `input.signal`.
 */
export async function runQueuedPromptHooks(input: QueuedPromptHooksInput): Promise<HookData[]> {
  const { deps, chat, body, parts, signal, logger } = input
  signal.throwIfAborted()
  const text = promptText(parts)
  const parsed = parseSlashCommand(text)
  if (parsed !== null && isHarnessCommand(parsed.name))
    return []
  if (await isImageModel(deps, body.modelRef))
    return []
  const workspace = await queuedWorkspace(deps, chat.projectId, logger)
  const snapshot = await deps.hooks.snapshot({
    chatId: chat.id,
    projectId: chat.projectId,
    workspace,
    toolMode: body.toolMode,
    origin: 'queue',
    modelRef: body.modelRef,
  }, { signal })
  const command = input.turnOnly && parsed !== null ? parsed.name : undefined
  const record = await runEvent(snapshot, 'UserPromptSubmit', {
    messageId: body.message.id,
    prompt: text,
    ...(command === undefined ? {} : { command }),
  }, chat.id, signal, logger)
  return record === null ? [] : [record]
}
