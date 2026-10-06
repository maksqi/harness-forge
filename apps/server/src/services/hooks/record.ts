// What the hooks of one event did (Phase 11, ADR-048; API.md 4.31, ARCHITECTURE.md 6.28 "The data-hook part"): the
// combination of every outcome (`combineHookOutcomes`), the `HookEventResult` the chat seams read and the `data-hook`
// record they store. A record is written only when something is worth showing (a decision, an input rewrite, context,
// a block, a stop, an error or a `systemMessage`); a silent success has none.
//
// The record's outcome (`hookRecordOutcomeSchema`), first match wins:
// - `PreToolUse`: `denied` (a block, exit 2 or a deny) > `asked` > `allowed` > `rewritten` (an `updatedInput` alone);
//   the approval seam replays a stored record by these outcomes (`storedDecision`, `chat/hooks.ts`).
// - `stopped` (`continue: false`; for `Stop` it wins over a block: no follow-up turn).
// - a block: `continued` for `Stop` (a follow-up turn), `blocked` for the others (`PostToolUse` feedback,
//   `UserPromptSubmit` refusal, a `SubagentStop` extra round).
// - `context` (model-visible context), then `error` (a non-blocking failure: another exit code, a timeout, invalid output,
//   a hook that could not start, exit 2 of an event that cannot block), then `context` again for a record that only
//   carries a hook's `systemMessage` (shown under the note's line, never sent to the model).
import type { CombinedHookOutcome, HookData, HookEvent, HookOutcome, HookRecordOutcome, HookResult, HookSource } from '@harness-forge/shared'
import type { HookEventResult } from './types.ts'
import { combineHookOutcomes, LIMITS } from '@harness-forge/shared'
import { cutText } from './run-log.ts'

/** One hook that ran for an event (a command hook process, or the code hooks of one plugin). */
export interface RanHook {
  readonly source: HookSource
  /** The redacted command head (≤ `LIMITS.hookLabelMaxChars`), or `<pluginId>: <code event>` for a code hook. */
  readonly label: string
  readonly pluginId?: string
  /** null for a process that did not exit normally and for code hooks. */
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly durationMs: number
  /** Its reading (`readHookOutput`, or the code hooks' output). */
  readonly outcome: HookOutcome
  /** A short, safe error (`HOOK_START_ERROR`, the outcome's error); null = none. */
  readonly error: string | null
  /** Code hooks of several plugins share one outcome: only the first entry joins the combination. */
  readonly shared?: boolean
}

/** The tool call of a `PreToolUse` / `PostToolUse` record. */
export interface RecordTool {
  readonly callId: string
  readonly name: string
}

/** The record outcome of a combination (see the module comment), or null for a silent success. */
export function recordOutcome(event: HookEvent, combined: CombinedHookOutcome, ran: readonly Pick<RanHook, 'outcome' | 'error'>[]): HookRecordOutcome | null {
  if (event === 'PreToolUse') {
    if (combined.block || combined.decision === 'deny')
      return 'denied'
    if (combined.decision === 'ask')
      return 'asked'
    if (combined.decision === 'allow')
      return 'allowed'
    if (combined.updatedInput !== undefined)
      return 'rewritten'
  }
  if (!combined.continue)
    return 'stopped'
  if (combined.block)
    return event === 'Stop' ? 'continued' : 'blocked'
  if (combined.context !== null)
    return 'context'
  if (ran.some(hook => hook.outcome.status === 'error' || hook.error !== null))
    return 'error'
  if (combined.systemMessages.length > 0)
    return 'context'
  return null
}

/** The outcome of one hook on its own (the run log entry; null = a silent success). */
export function singleOutcome(event: HookEvent, hook: RanHook): HookRecordOutcome | null {
  return recordOutcome(event, combineHookOutcomes(event, [{ source: hook.source, outcome: hook.outcome }]), [hook])
}

/** A short text cut to `max`, or undefined when empty. */
function optionalText(value: string | null | undefined, max: number): string | undefined {
  if (typeof value !== 'string')
    return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : cutText(trimmed, max)
}

/** The entry of one hook in a record (`hookResultSchema`). */
export function recordEntry(hook: RanHook): HookResult {
  const error = optionalText(hook.error ?? hook.outcome.error, LIMITS.hookSystemMessageMaxChars)
  const systemMessage = optionalText(hook.outcome.systemMessage, LIMITS.hookSystemMessageMaxChars)
  return {
    source: hook.source,
    label: cutText(hook.label, LIMITS.hookLabelMaxChars),
    ...(hook.pluginId === undefined ? {} : { pluginId: hook.pluginId }),
    exitCode: hook.exitCode,
    ...(hook.timedOut ? { timedOut: true } : {}),
    durationMs: Math.max(0, hook.durationMs),
    ...(error === undefined ? {} : { error }),
    ...(systemMessage === undefined ? {} : { systemMessage }),
  }
}

export interface EventResultInput {
  readonly event: HookEvent
  /** Every hook that ran, in run order (personal, plugin, project; the code hooks with their plugin). */
  readonly ran: readonly RanHook[]
  /** The `hev_` id of the record (also the id of the run log entries). */
  readonly id: string
  readonly createdAt: number
  /** `PreToolUse` / `PostToolUse`: the call the record links to. */
  readonly tool?: RecordTool | null
}

export interface EventResultOutput {
  readonly result: HookEventResult
  readonly combined: CombinedHookOutcome
}

/** The result of an event and its record (see the module comment). */
export function eventResult(input: EventResultInput): EventResultOutput {
  const { event, ran } = input
  const combined = combineHookOutcomes(event, ran.filter(hook => hook.shared !== true).map(hook => ({ source: hook.source, outcome: hook.outcome })))
  const outcome = ran.length === 0 ? null : recordOutcome(event, combined, ran)
  const updatedInput = event === 'PreToolUse' && !combined.block && combined.decision !== 'deny' ? combined.updatedInput : undefined
  let record: HookData | null = null
  if (outcome !== null) {
    const reason = optionalText(outcome === 'stopped' ? (combined.stopReason ?? combined.reason) : combined.reason, LIMITS.hookReasonMaxChars)
    const context = optionalText(combined.context, LIMITS.hookContextMaxChars)
    const tool = input.tool ?? null
    const linked = tool !== null && (event === 'PreToolUse' || event === 'PostToolUse')
    record = {
      id: input.id,
      event,
      outcome,
      ...(linked && tool.callId !== '' ? { toolCallId: cutText(tool.callId, 256) } : {}),
      ...(linked && tool.name !== '' ? { toolName: cutText(tool.name, 256) } : {}),
      createdAt: input.createdAt,
      hooks: ran.slice(0, LIMITS.hooksPerEventMax).map(recordEntry),
      ...(context === undefined ? {} : { context }),
      ...(reason === undefined ? {} : { reason }),
      ...(updatedInput === undefined ? {} : { updatedInput }),
    }
  }
  const result: HookEventResult = {
    ran: ran.length > 0,
    decision: event === 'PreToolUse' ? (combined.block ? 'deny' : combined.decision) : null,
    reason: combined.reason,
    context: combined.context,
    ...(updatedInput === undefined ? {} : { updatedInput }),
    block: combined.block,
    continue: combined.continue,
    stopReason: combined.stopReason,
    record,
  }
  return { result, combined }
}
