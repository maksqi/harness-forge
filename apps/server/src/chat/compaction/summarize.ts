// The compaction summarizer (Phase 9, ADR-040, ARCHITECTURE.md 6.18). Signature FROZEN after P9-0b (C26); the
// implementation is W9.1's.
//
// W9.1: `renderTranscript` of the messages (`prompt.ts`) → `generateText` with `compactionInstructions(focus)` (they
// carry `COMPACT_INSTRUCTIONS_MARKER`), reasoning off, `maxOutputTokens = clamp(0.2 × window, 256, 8192)`, the signal,
// a 120 s timeout and `maxRetries: 2`; the model is `settings.compactModelRef` when it resolves (else the run model,
// with a warning); the summary is capped at `LIMITS.compactionSummaryMaxChars`; one usage row with purpose `compact`
// (`messageId` = the reply) and its cost through `session.addExtraCost`. The summary is never logged at info. Only mock
// models in tests.
//
// P9-0b stub: throws `not_implemented` (nothing calls it before W9.1).
import type { LanguageModelUsage, ModelMessage } from 'ai'
import type { ResolvedModel } from '../../providers/types.ts'
import type { RunSession } from '../pipeline.ts'
import { notImplementedError } from '../../not-implemented.ts'

export interface SummarizeInput {
  /**
   * The run: deps (providers, usage rows), settings (`compactModelRef`), chat and reply ids, `addExtraCost`, the
   * logger.
   */
  readonly session: RunSession
  /** The run's model (the summarizer when `compactModelRef` is unset or cannot be resolved). */
  readonly runModel: ResolvedModel
  /** What to summarize, as the model sees it (rendered as a text transcript). */
  readonly messages: readonly ModelMessage[]
  /** The focus of `/compact [focus]`, or null. */
  readonly focus: string | null
  /** The signal of the call (the run signal, or a sub-agent's). */
  readonly signal: AbortSignal
}

export interface SummarizeResult {
  /** The summary (Markdown, at most `LIMITS.compactionSummaryMaxChars`). */
  summary: string
  /** The model that wrote it (`CompactionData.modelRef`). */
  modelRef: string
  /** Tokens of the summarizer call. */
  usage: LanguageModelUsage
  /** Its estimated cost (already added to the reply through `session.addExtraCost`), or null when unknown. */
  costUsd: number | null
}

/** Writes the summary of `messages` (stub until W9.1: throws `not_implemented`; see the module comment). */
export async function summarizeHistory(_input: SummarizeInput): Promise<SummarizeResult> {
  throw notImplementedError('Compaction')
}
