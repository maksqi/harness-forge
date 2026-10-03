// The manual `/compact [focus]` (Phase 9, ADR-040, ARCHITECTURE.md 6.18, API.md 6.9): `launchRun` (`pipeline.ts`)
// dispatches a `compact` command resolution here instead of a model call. Signature FROZEN after P9-0b (C26); the
// implementation is W9.1's.
//
// W9.1: `createUIMessageStream` writing `start` → the transient `data-activity` `compacting` (`session.bindWriter` +
// `session.writeTransient`) → `summarizeHistory` of `buildModelHistory(history without the /compact message)` → one
// `data-compaction` (`trigger: 'manual'`, `keep: 'none'`, `focus`) → `data-activity` `idle` → `finish` with
// `metadata.usage.contextTokens = tokensAfter`; nothing after the latest marker → `replyStream` with
// `NOTHING_TO_COMPACT_TEXT`; a summarizer failure ends the reply as failed (no marker, no trimming); an abort ends it
// `aborted`.
//
// P9-0b stub: always the reply "There is nothing to compact yet."
import type { UIMessageChunk } from 'ai'
import type { RunSession } from '../pipeline.ts'
import { replyStream } from '../pipeline.ts'

/** The reply of a `/compact` with nothing to summarize yet. */
export const NOTHING_TO_COMPACT_TEXT = 'There is nothing to compact yet.'

/**
 * The reply stream of `/compact [focus]` (stub until W9.1; see the module comment). `focus` is the command input,
 * trimmed (null when empty; at most `LIMITS.compactFocusMaxChars`, checked by `resolveCommand`).
 */
export async function compactStream(session: RunSession, _focus: string | null): Promise<ReadableStream<UIMessageChunk>> {
  return replyStream(session, NOTHING_TO_COMPACT_TEXT)
}
