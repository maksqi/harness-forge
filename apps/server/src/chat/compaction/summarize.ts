// The compaction summarizer (Phase 9, ADR-040, ARCHITECTURE.md 6.18). Signature FROZEN after P9-0b (C26).
//
// `renderTranscript` of the messages (`prompt.ts`) → `generateText` with `compactionInstructions(focus)` (they carry
// `COMPACT_INSTRUCTIONS_MARKER`) and the transcript as the user prompt, reasoning off, `maxOutputTokens = clamp(0.2 ×
// window, 256, 8192)`, the signal, a 120 s timeout and `maxRetries: 2`. The model is `settings.compactModelRef` when it
// resolves (else the run model, with a warning). The transcript budget is 0.85 × the summarizer's window, less the
// instructions and the output tokens. The summary is trimmed and capped at `LIMITS.compactionSummaryMaxChars`; an empty
// one is a failure. One usage row with purpose `compact` (`messageId` = the reply) and its cost through
// `session.addExtraCost`. A failed call rejects with the error mapped for the summarizer's provider (an abort of the
// signal rejects with the abort as is). The summary is never logged at info. Only mock models in tests.
import type { LanguageModelUsage, ModelMessage } from 'ai'
import type { ResolvedModel } from '../../providers/types.ts'
import type { RunSession } from '../pipeline.ts'
import { HarnessError, LIMITS } from '@harness-forge/shared'
import { generateText } from 'ai'
import { CHARS_PER_TOKEN, CONTEXT_BUDGET_RATIO } from '../context.ts'
import { mapRunError } from '../errors.ts'
import { providerReasoning } from '../params.ts'
import { catalogCost, reportedCost, roundUsd } from '../usage.ts'
import { compactionInstructions, renderTranscript } from './prompt.ts'

/** The whole summarizer call may take this long (the SDK aborts it with a `TimeoutError`, a failure). */
export const SUMMARIZE_TIMEOUT_MS = 120_000
/** Retries of a failed summarizer call. */
export const SUMMARIZE_MAX_RETRIES = 2
/** `maxOutputTokens` = this share of the summarizer's window, clamped to the bounds below. */
export const SUMMARY_OUTPUT_RATIO = 0.2
export const SUMMARY_OUTPUT_MIN_TOKENS = 256
export const SUMMARY_OUTPUT_MAX_TOKENS = 8192
/** The window assumed for a summarizer whose window is unknown (sizes the output and the transcript budget). */
export const UNKNOWN_WINDOW_TOKENS = 32_000

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** `maxOutputTokens` of the summarizer call for a window (`UNKNOWN_WINDOW_TOKENS` when unknown). */
export function summaryOutputTokens(contextWindow: number | null): number {
  const window = contextWindow !== null && contextWindow > 0 ? contextWindow : UNKNOWN_WINDOW_TOKENS
  return clamp(Math.floor(window * SUMMARY_OUTPUT_RATIO), SUMMARY_OUTPUT_MIN_TOKENS, SUMMARY_OUTPUT_MAX_TOKENS)
}

/**
 * Characters of transcript the summarizer gets: `CONTEXT_BUDGET_RATIO` (0.85) of its window, and never more than what
 * leaves room for the instructions and the output.
 */
export function transcriptBudgetChars(contextWindow: number | null, instructions: string, outputTokens: number): number {
  const window = contextWindow !== null && contextWindow > 0 ? contextWindow : UNKNOWN_WINDOW_TOKENS
  const instructionTokens = Math.ceil(instructions.length / CHARS_PER_TOKEN)
  const tokens = Math.min(Math.floor(window * CONTEXT_BUDGET_RATIO), window - outputTokens - instructionTokens)
  return Math.max(0, tokens) * CHARS_PER_TOKEN
}

/** `text` cut to at most `max` UTF-16 code units, never inside a surrogate pair. */
function cutSummary(text: string, max: number): string {
  if (text.length <= max)
    return text
  const last = text.charCodeAt(max - 1)
  return text.slice(0, last >= 0xD800 && last <= 0xDBFF ? max - 1 : max)
}

/** The summarizer: `compactModelRef` when it resolves, else the run model (with a warning). */
export async function summarizerModel(session: RunSession, runModel: ResolvedModel, signal: AbortSignal): Promise<ResolvedModel> {
  const { deps, prepared, logger } = session.ctx
  const ref = prepared.settings.compactModelRef
  if (ref === null || ref === runModel.modelRef)
    return runModel
  try {
    return await deps.providers.resolveModel(ref, { signal })
  }
  catch (error) {
    if (signal.aborted)
      throw error
    logger.warn('the compaction model cannot be used; the chat model writes the summary', { modelRef: ref, err: error })
    return runModel
  }
}

/** Writes the summary of `messages` (see the module comment). */
export async function summarizeHistory(input: SummarizeInput): Promise<SummarizeResult> {
  const { session, runModel, messages, focus, signal } = input
  const { deps, logger } = session.ctx
  const model = await summarizerModel(session, runModel, signal)
  const instructions = compactionInstructions(focus)
  const outputTokens = summaryOutputTokens(model.entry.contextWindow)
  const transcript = renderTranscript(messages, transcriptBudgetChars(model.entry.contextWindow, instructions, outputTokens))
  const reasoning = providerReasoning(model, 'off', logger)
  let text: string
  let usage: LanguageModelUsage
  let providerMetadata: unknown
  try {
    const result = await generateText({
      model: model.model,
      instructions,
      prompt: transcript,
      maxOutputTokens: Math.max(outputTokens, reasoning?.maxOutputTokens ?? 0),
      maxRetries: SUMMARIZE_MAX_RETRIES,
      abortSignal: signal,
      timeout: SUMMARIZE_TIMEOUT_MS,
      ...(reasoning?.reasoning === undefined ? {} : { reasoning: reasoning.reasoning }),
      ...(reasoning?.providerOptions === undefined ? {} : { providerOptions: reasoning.providerOptions }),
    })
    text = result.text
    usage = result.usage
    providerMetadata = result.providerMetadata
  }
  catch (error) {
    if (signal.aborted)
      throw error
    throw mapRunError(deps.providers, model.providerId, error)
  }
  const costUsd = reportedCost(providerMetadata) ?? catalogCost(usage, model.entry.cost) ?? null
  try {
    await deps.chats.addUsage({
      chatId: session.chatId,
      messageId: session.assistantId,
      purpose: 'compact',
      providerId: model.providerId,
      modelId: model.modelId,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
      cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
      costUsd,
    })
  }
  catch (error) {
    logger.warn('cannot store the compaction usage', { err: error })
  }
  if (costUsd !== null)
    session.addExtraCost(costUsd)
  const summary = cutSummary(text.trim(), LIMITS.compactionSummaryMaxChars)
  if (summary === '') {
    throw new HarnessError({ code: 'provider_error', message: 'The model wrote an empty summary.', providerId: model.providerId, action: 'retry' })
  }
  logger.debug('compaction summary written', { modelRef: model.modelRef, transcriptChars: transcript.length, summaryChars: summary.length })
  return { summary, modelRef: model.modelRef, usage, costUsd: costUsd === null ? null : roundUsd(costUsd) }
}
