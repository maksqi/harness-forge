// The compaction prompt (Phase 9, ADR-040, ARCHITECTURE.md 6.18). Signatures FROZEN after P9-0b (C26); the
// implementation is W9.1's.
//
// W9.1: `compactionInstructions(focus)`: the summarizer instructions, containing `COMPACT_INSTRUCTIONS_MARKER`
// (`chat/markers.ts`; the mock models read it) and Claude Code-style sections (request and intent, files and code,
// errors and fixes, every user message, pending tasks, current work, next step) plus the focus when set.
// `renderTranscript(messages, budgetChars)`: the model messages as one text transcript (tool calls as
// `[tool name(args ≤ 500 characters)]`, results cut at 2,000 characters, files and images as `[file …]`, reasoning
// dropped), so the summarizer never gets tool content without tool definitions; above `budgetChars` the middle is cut
// (the head, which holds an earlier summary, and the newest part stay).
//
// P9-0b stubs: both throw `not_implemented` (nothing calls them before W9.1).
import type { ModelMessage } from 'ai'
import { notImplementedError } from '../../not-implemented.ts'

/** The instructions of the summarizer call (stub until W9.1; see the module comment). */
export function compactionInstructions(_focus: string | null): string {
  throw notImplementedError('The compaction instructions')
}

/** The messages to summarize as one text transcript of at most `budgetChars` characters (stub until W9.1). */
export function renderTranscript(_messages: readonly ModelMessage[], _budgetChars: number): string {
  throw notImplementedError('The compaction transcript')
}
