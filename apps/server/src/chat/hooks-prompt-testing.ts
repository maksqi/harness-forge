// Test helper of W12.6 (ADR-057): the `HookEventResult` a prompt hook's answer gives an event, built with the shared
// helpers the prompt-hook runner (W12.5) uses, so the chat seams can be tested against what a prompt hook decides
// without a model call: the model's text through `readPromptHookAnswer`, its outcome through `promptHookOutcome`, the
// combination through `combineHookOutcomes`, and a prompt-hook record (`fakePromptHookRecord`) whose outcome follows the
// service's rules (`services/hooks/record.ts`: `denied` for a PreToolUse block, `stopped` for `continue: false`,
// `continued` for a Stop block, `blocked` for another block, `context` for a context, `error` for an unreadable answer;
// none for a silent `ok: true` or an `impossible` stop).
//
//   fake.results.set('Stop', promptHookResult('Stop', '{"ok":false,"reason":"run the tests"}'))   // a hook turn
//   fake.results.set('Stop', promptHookResult('Stop', '{"ok":false,"reason":"x","impossible":true}'))   // none
import type { HookEvent, HookRecordOutcome } from '@harness-forge/shared'
import type { HookEventResult } from '../services/hooks/types.ts'
import { combineHookOutcomes, promptHookOutcome, readPromptHookAnswer } from '@harness-forge/shared'
import { fakePromptHookResult } from '../testing/fake-hooks.ts'

/** Options of `promptHookResult` (the handler's `continueOnBlock`). */
export interface PromptHookResultOptions {
  readonly continueOnBlock?: boolean
}

/** The record outcome the hook service would store for this combination (see the module comment), or undefined. */
function outcomeOf(event: HookEvent, combined: ReturnType<typeof combineHookOutcomes>, invalid: boolean): HookRecordOutcome | undefined {
  if (event === 'PreToolUse' && (combined.block || combined.decision === 'deny'))
    return 'denied'
  if (!combined.continue)
    return 'stopped'
  if (combined.block)
    return event === 'Stop' ? 'continued' : 'blocked'
  if (combined.context !== null)
    return 'context'
  return invalid ? 'error' : undefined
}

/**
 * The result of one prompt hook of `event` whose model answered `text` (see the module comment). The record carries the
 * reason of a block or stop.
 */
export function promptHookResult(event: HookEvent, text: string, options: PromptHookResultOptions = {}): HookEventResult {
  const read = readPromptHookAnswer(text)
  const outcome = promptHookOutcome(event, read.valid ? read.answer : null, { ...options, ...(read.valid ? {} : { error: read.error }) })
  const combined = combineHookOutcomes(event, [{ source: 'personal', outcome }])
  const recordOutcome = outcomeOf(event, combined, !read.valid)
  const result = fakePromptHookResult({
    decision: combined.decision,
    reason: combined.reason,
    context: combined.context,
    block: combined.block,
    continue: combined.continue,
    stopReason: combined.stopReason,
  }, event, recordOutcome)
  if (result.record === null || recordOutcome === undefined)
    return { ...result, record: null }
  const reason = combined.reason ?? combined.stopReason
  return { ...result, record: { ...result.record, ...(reason === null ? {} : { reason }) } }
}
