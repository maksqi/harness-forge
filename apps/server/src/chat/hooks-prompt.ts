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
// C37 stub (P11-0b): no hook runs and nothing is blocked; `precomputed` records are attached as they are.
import type { ChatRequestBody, HookData, RunOrigin } from '@harness-forge/shared'
import type { Logger } from '../logger.ts'
import type { AppDeps } from '../types.ts'
import type { PreparedRun } from './prepare.ts'
import { HarnessError, isHarnessError } from '@harness-forge/shared'

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

/**
 * Runs `SessionStart` and `UserPromptSubmit` for the new user message of a run (see the module comment). Rejects with
 * the 409 `hook-blocked` of a blocking hook, and on an abort of `input.signal`.
 * C37 stub: no hook runs; answers the `precomputed` records.
 */
export async function runPromptHooks(input: PromptHooksInput): Promise<PromptHooksResult> {
  input.signal.throwIfAborted()
  return { records: [...(input.precomputed ?? [])] }
}
