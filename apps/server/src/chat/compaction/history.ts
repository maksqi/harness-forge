// The compaction history rule (Phase 9, ADR-040, ARCHITECTURE.md 6.18). Signatures FROZEN after P9-0b (C26); the
// implementation is W9.1's.
//
// `applyCompaction(history)` (W9.1, over `findCompaction` of `@harness-forge/shared`): the latest `data-compaction` part
// C on the path (message M_k, part p) replaces everything before it: `messages` = (`keep: 'last-user'` ? the last user
// message before M_k : []) ++ M_k with only its parts after p (when there are any) ++ M_{k+1 …}, and `summaryText` =
// `compactionSummaryText(C.data)`; without a marker `messages` is the history and `summaryText` null.
// `buildModelHistory` (`model-history.ts`) merges `summaryText` as the first part of the following user message.
// `compactionSummaryText(data)` (W9.1): a fixed preface, the summary, "Current todo list:" plus the items when `todos`
// is set and, for `auto`, "Continue the latest request without asking the user to repeat anything."
//
// P9-0b stub: `applyCompaction` is the identity (`summaryText: null`), `compactionSummaryText` throws `not_implemented`.
import type { CompactionData, HarnessUIMessage } from '@harness-forge/shared'
import { notImplementedError } from '../../not-implemented.ts'

/** The history the model sees after the latest compaction marker. */
export interface CompactedHistory {
  /** The messages the model still sees verbatim (the whole history without a marker). */
  messages: HarnessUIMessage[]
  /** What the model gets instead of the compacted messages (`compactionSummaryText`), or null without a marker. */
  summaryText: string | null
}

/** The history rule (stub until W9.1: the identity; see the module comment). */
export function applyCompaction(history: readonly HarnessUIMessage[]): CompactedHistory {
  return { messages: [...history], summaryText: null }
}

/** The text the model reads instead of the compacted messages (stub until W9.1; see the module comment). */
export function compactionSummaryText(_data: CompactionData): string {
  throw notImplementedError('The compaction summary text')
}
