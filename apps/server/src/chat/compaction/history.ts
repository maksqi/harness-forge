// The compaction history rule (Phase 9, ADR-040, ARCHITECTURE.md 6.18). Signatures FROZEN after P9-0b (C26).
//
// `applyCompaction(history)` (over `findCompaction` of `@harness-forge/shared`): the latest `data-compaction` part C on
// the path (message M_k, part p) replaces everything before it: `messages` = (`keep: 'last-user'` ? the last user
// message before M_k : []) ++ M_k with only its parts after p (when any of them is content) ++ M_{k+1 …}, and
// `summaryText` = `compactionSummaryText(C.data)`; without a marker `messages` is the history and `summaryText` null.
// `buildModelHistory` (`model-history.ts`) merges `summaryText` as the first part of the following user message. The
// rule depends only on the path, so it survives the id remapping of a chat import and is branch-aware (ADR-023): a
// branch above C, a regenerate of the reply that held C and a deleted marker message all fall back to the previous
// marker (or the full history).
// `compactionSummaryText(data)`: a fixed preface, the summary, "Current todo list:" plus the items when `todos` is set
// and, for `auto`, "Continue the latest request without asking the user to repeat anything."
import type { CompactionData, HarnessUIMessage } from '@harness-forge/shared'
import { findCompaction, isContentPart } from '@harness-forge/shared'

/** The history the model sees after the latest compaction marker. */
export interface CompactedHistory {
  /** The messages the model still sees verbatim (the whole history without a marker). */
  messages: HarnessUIMessage[]
  /** What the model gets instead of the compacted messages (`compactionSummaryText`), or null without a marker. */
  summaryText: string | null
}

/** The first paragraph of every summary text the model reads. */
export const COMPACTION_SUMMARY_PREFACE
  = 'The earlier part of this conversation was compacted to save context. This summary replaces those messages:'
/** Heads the todo snapshot of a summary text. */
export const COMPACTION_TODOS_HEADING = 'Current todo list:'
/** Ends the summary text of an automatic compaction. */
export const COMPACTION_CONTINUE_TEXT = 'Continue the latest request without asking the user to repeat anything.'

/** The history rule (see the module comment). */
export function applyCompaction(history: readonly HarnessUIMessage[]): CompactedHistory {
  const latest = findCompaction(history)
  if (latest === null)
    return { messages: [...history], summaryText: null }
  const messages: HarnessUIMessage[] = []
  const kept = latest.keptUserIndex === null ? undefined : history[latest.keptUserIndex]
  if (kept !== undefined)
    messages.push(kept)
  const marked = history[latest.messageIndex]
  const after = marked?.parts.slice(latest.partIndex + 1) ?? []
  if (marked !== undefined && after.some(isContentPart))
    messages.push({ ...marked, parts: after })
  messages.push(...history.slice(latest.messageIndex + 1))
  return { messages, summaryText: compactionSummaryText(latest.data) }
}

/** The text the model reads instead of the compacted messages (see the module comment). */
export function compactionSummaryText(data: CompactionData): string {
  const sections = [COMPACTION_SUMMARY_PREFACE, data.summary.trim()]
  if (data.todos !== undefined && data.todos.length > 0)
    sections.push([COMPACTION_TODOS_HEADING, ...data.todos.map(todo => `- [${todo.status}] ${todo.content}`)].join('\n'))
  if (data.trigger === 'auto')
    sections.push(COMPACTION_CONTINUE_TEXT)
  return sections.join('\n\n')
}
