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
//
// Phase 12 (ADR-057, W12.5):
// - `PermissionRequest`: `denied` (a `behavior: deny`, a block) > `allowed` (`behavior: allow`); the result carries the
//   decision (`allow` / `deny`, never `ask`) and an allow's `updatedInput`, which `chat/hooks.ts` applies through the
//   same gate as a `PreToolUse` allow. Its record, like those of `PostToolUseFailure`, links the tool call
//   (`toolCallId`, `toolName`).
// - A prompt hook's "no" that changes nothing (`impossible: true` on `Stop` / `SubagentStop`, any "no" on
//   `PermissionRequest`) leaves only a reason: such a record is `context` with that `reason` (display only; the model
//   text of a record never reads it outside the feedback events).
// - The entries of prompt hooks carry `kind: 'prompt'` and the answering `model`.
import type { CombinedHookOutcome, HookData, HookEvent, HookOutcome, HookPermissionDecision, HookRecordOutcome, HookResult, HookSource } from '@harness-forge/shared'
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
  /** Phase 12: `prompt` for a prompt hook (absent = a command or a code hook). */
  readonly kind?: 'prompt'
  /** Phase 12: the model ref that answered a prompt hook (absent when none could be resolved). */
  readonly model?: string
}

/** Events whose result carries a permission decision (`PreToolUse`; Phase 12: `PermissionRequest`). */
const DECISION_EVENTS: ReadonlySet<HookEvent> = new Set(['PreToolUse', 'PermissionRequest'])
/** Events whose record links the tool call (Phase 12: also `PostToolUseFailure` and `PermissionRequest`). */
const TOOL_RECORD_EVENTS: ReadonlySet<HookEvent> = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'])

/** The decision a combination gives the event (`PreToolUse`: deny > ask > allow; `PermissionRequest`: deny > allow). */
function resultDecision(event: HookEvent, combined: CombinedHookOutcome): HookPermissionDecision | null {
  if (!DECISION_EVENTS.has(event))
    return null
  if (combined.block || combined.decision === 'deny')
    return 'deny'
  if (event === 'PermissionRequest')
    return combined.decision === 'allow' ? 'allow' : null
  return combined.decision
}

/** The `updatedInput` the result carries: a `PreToolUse` that did not deny, or a `PermissionRequest` allow. */
function resultUpdatedInput(event: HookEvent, combined: CombinedHookOutcome): unknown {
  const decision = resultDecision(event, combined)
  if (event === 'PreToolUse' && decision !== 'deny')
    return combined.updatedInput
  if (event === 'PermissionRequest' && decision === 'allow')
    return combined.updatedInput
  return undefined
}

/** The tool call of a `PreToolUse` / `PostToolUse` record. */
export interface RecordTool {
  readonly callId: string
  readonly name: string
}

/** The record outcome of a combination (see the module comment), or null for a silent success. */
export function recordOutcome(event: HookEvent, combined: CombinedHookOutcome, ran: readonly Pick<RanHook, 'outcome' | 'error' | 'kind'>[]): HookRecordOutcome | null {
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
  if (event === 'PermissionRequest') {
    if (combined.block || combined.decision === 'deny')
      return 'denied'
    if (combined.decision === 'allow')
      return 'allowed'
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
  // Phase 12: a prompt hook's "no" without an effect (`impossible`, `PermissionRequest`): the reason is recorded.
  if (ran.some(hook => hook.kind === 'prompt' && typeof hook.outcome.reason === 'string' && hook.outcome.reason.trim() !== ''))
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
    ...(hook.kind === 'prompt' ? { kind: 'prompt' as const } : {}),
    ...(hook.kind === 'prompt' && hook.model !== undefined && hook.model !== '' ? { model: hook.model } : {}),
  }
}

export interface EventResultInput {
  readonly event: HookEvent
  /** Every hook that ran, in run order (personal, plugin, project; the code hooks with their plugin). */
  readonly ran: readonly RanHook[]
  /** The `hev_` id of the record (also the id of the run log entries). */
  readonly id: string
  readonly createdAt: number
  /** The tool events (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`): the call the record links to. */
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
  const updatedInput = resultUpdatedInput(event, combined)
  let record: HookData | null = null
  if (outcome !== null) {
    const reason = optionalText(outcome === 'stopped' ? (combined.stopReason ?? combined.reason) : combined.reason, LIMITS.hookReasonMaxChars)
    const context = optionalText(combined.context, LIMITS.hookContextMaxChars)
    const tool = input.tool ?? null
    const linked = tool !== null && TOOL_RECORD_EVENTS.has(event)
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
    decision: resultDecision(event, combined),
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
