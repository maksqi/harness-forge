// The model's view of a stored message path (Phase 9, ARCHITECTURE.md 6.18). FROZEN after P9-0b (C26, complete).
//
// `buildModelHistory(history)` is the only place that turns a stored path into what the model sees, before
// `prepareModelFiles` (`pipeline.ts`; messages left out never load their files) and `convertToModelMessages`. In this
// order:
//   1. `applyCompaction` (`compaction/history.ts`, W9.1): the latest `data-compaction` marker replaces everything
//      before it; `summaryText` is what the model reads instead;
//   2. `splitSteers` (`@harness-forge/shared`): each assistant message is split at its `data-steer` parts into
//      assistant / user / assistant (a steer is a user message for the model, ADR-042);
//   3. `reduceAgentOutputs` (`subagent/history.ts`, W9.5): a stored `tool-task` output becomes `{ status, report }`;
//   4. `applyCommandExpansions` (`context.ts`): prompt commands send their stored expansion;
//   5. the summary text merged as the **first** part of the following user message (after step 4, because an
//      expansion replaces the first text part), or a standalone user message when the remaining history does not start
//      with a user message: the history never holds two user messages in a row because of the summary.
// A path without a marker, steers and task outputs (every v1.4 path) comes back unchanged (the same message objects).
import type { HarnessUIMessage } from '@harness-forge/shared'
import type { CompactedHistory } from './compaction/history.ts'
import { splitSteers } from '@harness-forge/shared'
import { applyCompaction } from './compaction/history.ts'
import { applyCommandExpansions } from './context.ts'
import { reduceAgentOutputs } from './subagent/history.ts'

/** Id of the user message that carries the summary when no user message follows the marker (never stored). */
export const COMPACTION_SUMMARY_MESSAGE_ID = 'msg_compaction_summary'

/** The stages of `buildModelHistory`, in order (replaceable in tests). */
export interface ModelHistoryStages {
  applyCompaction: (history: readonly HarnessUIMessage[]) => CompactedHistory
  splitSteers: (messages: readonly HarnessUIMessage[]) => HarnessUIMessage[]
  reduceAgentOutputs: (messages: readonly HarnessUIMessage[]) => HarnessUIMessage[]
  applyCommandExpansions: (messages: readonly HarnessUIMessage[]) => HarnessUIMessage[]
}

/** The stages `buildModelHistory` runs. */
export const MODEL_HISTORY_STAGES: Readonly<ModelHistoryStages> = Object.freeze({
  applyCompaction,
  splitSteers: (messages: readonly HarnessUIMessage[]) => splitSteers(messages),
  reduceAgentOutputs,
  applyCommandExpansions,
})

/**
 * Step 5: `summaryText` as the first part of the first message when it is a user message, else as a standalone user
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
  const split = stages.splitSteers(compacted.messages)
  const reduced = stages.reduceAgentOutputs(split)
  const expanded = stages.applyCommandExpansions(reduced)
  return mergeSummary(expanded, compacted.summaryText)
}

/** The history as the model sees it, before files are loaded (see the module comment). */
export function buildModelHistory(history: readonly HarnessUIMessage[]): HarnessUIMessage[] {
  return composeModelHistory(history, MODEL_HISTORY_STAGES)
}
