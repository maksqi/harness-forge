// The model's view of a stored message path (Phase 9, ARCHITECTURE.md 6.18). FROZEN after P9-0b (C26, complete);
// Phase 10 (C31, ADR-046) adds the task-result stage; Phase 11 (C37, ADR-048) the hook stage; FROZEN again after P11-0b.
//
// `buildModelHistory(history)` is the only place that turns a stored path into what the model sees, before
// `prepareModelFiles` (`pipeline.ts`; messages left out never load their files) and `convertToModelMessages`. In this
// order:
//   1. `applyCompaction` (`compaction/history.ts`, W9.1): the latest `data-compaction` marker replaces everything
//      before it; `summaryText` is what the model reads instead;
//   2. `splitSteers` (`@harness-forge/shared`): each assistant message is split at its `data-steer` parts into
//      assistant / user / assistant (a steer is a user message for the model, ADR-042);
//   3. `splitTaskResults` (`@harness-forge/shared`, Phase 10): each assistant message is split at its
//      `data-task-result` parts into assistant / user / assistant (a delivered background task result is a user message
//      `taskResultText` for the model), and the user-role carrier message of a server-started turn (`origin: 'task'`,
//      only `data-task-result` parts) becomes a user message with one text part per result;
//   4. `splitHooks` (`@harness-forge/shared`, Phase 11, ADR-048): each assistant message is split at its `data-hook`
//      records that have model text (`hookModelText(data, 'assistant')`: a `PostToolUse` context or block reason) into
//      assistant / user / assistant, display-only records are dropped; in a user message (a `UserPromptSubmit` /
//      `SessionStart` context, the carrier of a `Stop` continuation, `origin: 'hook'`) each record becomes its model text
//      (`<hook-context …>` / `<hook-feedback event="Stop">`) in place; a carrier without model text is dropped;
//   5. `reduceAgentOutputs` (`subagent/history.ts`, W9.5): a stored `tool-task` output becomes `{ status, report }`;
//   6. `applyCommandExpansions` (`context.ts`): prompt commands send their stored expansion;
//   7. the summary text merged as the **first** part of the following user message (after step 6, because an
//      expansion replaces the first text part), or a standalone user message when the remaining history does not start
//      with a user message: the history never holds two user messages in a row because of the summary.
// A path without a marker, steers, task results, hook records and task outputs (every v1.4 – v1.6 path without them)
// comes back unchanged (the same message objects).
import type { HarnessUIMessage } from '@harness-forge/shared'
import type { CompactedHistory } from './compaction/history.ts'
import { splitHooks, splitSteers, splitTaskResults } from '@harness-forge/shared'
import { applyCompaction } from './compaction/history.ts'
import { applyCommandExpansions } from './context.ts'
import { reduceAgentOutputs } from './subagent/history.ts'

/** Id of the user message that carries the summary when no user message follows the marker (never stored). */
export const COMPACTION_SUMMARY_MESSAGE_ID = 'msg_compaction_summary'

/** The stages of `buildModelHistory`, in order (replaceable in tests). */
export interface ModelHistoryStages {
  applyCompaction: (history: readonly HarnessUIMessage[]) => CompactedHistory
  splitSteers: (messages: readonly HarnessUIMessage[]) => HarnessUIMessage[]
  /** Phase 10 (ADR-046): delivered background task results and carrier messages as user messages. */
  splitTaskResults: (messages: readonly HarnessUIMessage[]) => HarnessUIMessage[]
  /** Phase 11 (ADR-048): hook records as model text (`splitHooks`), after the task results. */
  splitHooks: (messages: readonly HarnessUIMessage[]) => HarnessUIMessage[]
  reduceAgentOutputs: (messages: readonly HarnessUIMessage[]) => HarnessUIMessage[]
  applyCommandExpansions: (messages: readonly HarnessUIMessage[]) => HarnessUIMessage[]
}

/** The stages `buildModelHistory` runs. */
export const MODEL_HISTORY_STAGES: Readonly<ModelHistoryStages> = Object.freeze({
  applyCompaction,
  splitSteers: (messages: readonly HarnessUIMessage[]) => splitSteers(messages),
  splitTaskResults: (messages: readonly HarnessUIMessage[]) => splitTaskResults(messages),
  splitHooks: (messages: readonly HarnessUIMessage[]) => splitHooks(messages),
  reduceAgentOutputs,
  applyCommandExpansions,
})

/**
 * Step 7: `summaryText` as the first part of the first message when it is a user message, else as a standalone user
 * message before it. Null leaves the messages as they are.
 */
export function mergeSummary(messages: readonly HarnessUIMessage[], summaryText: string | null): HarnessUIMessage[] {
  if (summaryText === null)
    return [...messages]
  const summary = { type: 'text' as const, text: summaryText }
  const [first, ...rest] = messages
  if (first?.role === 'user')
    return [{ ...first, parts: [summary, ...first.parts] }, ...rest]
  return [{ id: COMPACTION_SUMMARY_MESSAGE_ID, role: 'user', parts: [summary] }, ...messages]
}

/** `buildModelHistory` with explicit stages (see the module comment for the order). */
export function composeModelHistory(history: readonly HarnessUIMessage[], stages: Readonly<ModelHistoryStages>): HarnessUIMessage[] {
  const compacted = stages.applyCompaction(history)
  const steered = stages.splitSteers(compacted.messages)
  const split = stages.splitTaskResults(steered)
  const hooked = stages.splitHooks(split)
  const reduced = stages.reduceAgentOutputs(hooked)
  const expanded = stages.applyCommandExpansions(reduced)
  return mergeSummary(expanded, compacted.summaryText)
}

/** The history as the model sees it, before files are loaded (see the module comment). */
export function buildModelHistory(history: readonly HarnessUIMessage[]): HarnessUIMessage[] {
  return composeModelHistory(history, MODEL_HISTORY_STAGES)
}
