// The context guard (Phase 9, ADR-040, ARCHITECTURE.md 6.18): the first piece of the step composer (`steps.ts`), run
// before every model call of a run (step 0 included), so the pre-run and the in-run compaction are one code path.
// Signatures FROZEN after P9-0b (C26).
//
// Estimate = max(`estimateTokens(messages, instructions)`, the last step's input + output tokens). Above
// `COMPACT_TRIGGER_RATIO` (0.8) of the model's context window (a known window only):
// - `autoCompact` on and fewer than `LIMITS.compactionsPerRunMax` attempts in this run: summarize the step's messages
//   (`summarizeHistory`), inject `data-compaction` (`trigger: 'auto'`) for the step through `session.inject` (the step
//   injector places it right before the step's `start-step`, so the stored reply rebuilds the same model history,
//   `buildModelHistory`) and return `[merge(summary, keptUser)]` (`keep: 'last-user'`; `keep: 'none'`, the summary
//   alone, when that would still exceed `CONTEXT_BUDGET_RATIO` (0.85) of the window), with the transient
//   `data-activity` `compacting` / `idle` around the call (`session.writeTransient`). The SDK carries the returned
//   messages into the later steps. The todo snapshot is the latest `todo_write` output of this run's steps, else of the
//   history (`latestTodos`).
// - A non-abort failure: on step 0 only, `trimToContext` down to the trigger plus the notice `compaction-failed`; later
//   steps go on untouched, and the guard stops compacting for the rest of the run (a failing summarizer is not called on
//   every step). An abort of the signal re-throws (the run ends `aborted`).
// - The provider reports the call right after a compaction above the trigger again (tool definitions or instructions
//   fill the window, which no summary can shrink): no more compactions in this run.
// - `autoCompact` off: on step 0 only, the v1.4 `trimToContext` (0.85 of the window) plus `context-trimmed` when it left
//   messages out.
// `silent` (sub-agents): no marker, no notice, no activity; the usage row (and the cost) only. A step whose messages are
// a single user message has nothing to compact. Phase 10 (C31-T5): the host is structural (`subagent/host.ts`): a chat
// run's guard takes a `HostSession` (`RunSession`), a silent guard any `ChildSession` (a background child's detached
// session too); behavior unchanged.
import type { CompactionData, CompactionKeep, HarnessUIMessage, NoticeData, TodoItem } from '@harness-forge/shared'
import type { ModelMessage, StepResult, ToolSet } from 'ai'
import type { ResolvedModel } from '../../providers/types.ts'
import type { StepInput, StepPiece, StepPieceResult } from '../steps.ts'
import type { ChildSession, HostSession } from '../subagent/host.ts'
import { latestTodos, LIMITS, todoWriteOutputSchema } from '@harness-forge/shared'
import { CONTEXT_BUDGET_RATIO, estimateTokens, trimToContext } from '../context.ts'
import { NOTICES } from '../notices.ts'
import { applyCompaction, compactionSummaryText } from './history.ts'
import { summarizeHistory } from './summarize.ts'

/** Share of the context window above which the guard compacts. */
export const COMPACT_TRIGGER_RATIO = 0.8

/** The name of the agent tool whose latest output is the todo list (`core-agent`, ADR-041). */
const TODO_WRITE_TOOL_NAME = 'todo_write'

/** The options of every context guard (`ContextGuardInput` adds the host and the mode). */
export interface ContextGuardOptions {
  /** The model of the guarded calls (the run model, or a sub-agent's model): its context window, the summary default. */
  readonly model: ResolvedModel
  /**
   * The user message kept after an automatic compaction (`keep: 'last-user'`), as the model sees it: the run's turn user
   * message after expansions and files and before any summary was merged into it (converted lazily, once), or a
   * sub-agent's prompt; null keeps none.
   */
  readonly keptUser: () => Promise<ModelMessage | null>
  /** The signal of the guarded calls (default: the host's run signal). */
  readonly signal?: AbortSignal
}

/**
 * The guard of a chat run (`silent` absent or false: the host places the marker, the notices and the activity) or a
 * silent one (sub-agents: no marker, no notice, no activity; the usage row only). The host: deps, settings
 * (`autoCompact`, `compactModelRef`), chat and reply ids, history, `addExtraCost`, the run signal and the logger.
 */
export type ContextGuardInput = ContextGuardOptions & (
  | { readonly session: HostSession, readonly silent?: false }
  | { readonly session: ChildSession, readonly silent: true }
)

/** The input + output tokens of the last finished step (0 without one). */
export function lastStepTokens(steps: ReadonlyArray<Pick<StepResult<ToolSet>, 'usage'>>): number {
  const usage = steps.at(-1)?.usage
  if (usage === undefined)
    return 0
  const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  return Number.isFinite(total) ? total : 0
}

/** The context estimate of a step: the larger of the message estimate and the last step's reported tokens. */
export function stepEstimate(step: Pick<StepInput, 'messages' | 'instructions' | 'steps'>): number {
  return Math.max(estimateTokens(step.messages, step.instructions), lastStepTokens(step.steps))
}

/** The summary as the first part of the kept user message (`mergeSummary` of `model-history.ts`, for model messages). */
export function mergeSummaryMessage(summaryText: string, kept: ModelMessage | null): ModelMessage {
  const summary = { type: 'text' as const, text: summaryText }
  if (kept === null || kept.role !== 'user')
    return { role: 'user', content: [summary] }
  const content = typeof kept.content === 'string' ? [{ type: 'text' as const, text: kept.content }] : kept.content
  return { ...kept, content: [summary, ...content] }
}

/**
 * The todo list when a run compacts: the latest valid `todo_write` output of this run's finished steps, else the latest
 * of the history (`latestTodos`); null without one.
 */
export function runTodos(history: readonly HarnessUIMessage[], steps: ReadonlyArray<Pick<StepResult<ToolSet>, 'toolResults'>>): TodoItem[] | null {
  for (let index = steps.length - 1; index >= 0; index--) {
    const results = steps[index]?.toolResults ?? []
    for (let position = results.length - 1; position >= 0; position--) {
      const result = results[position]
      if (result === undefined || result.toolName !== TODO_WRITE_TOOL_NAME || result.preliminary === true)
        continue
      const parsed = todoWriteOutputSchema.safeParse(result.output)
      if (parsed.success)
        return parsed.data.todos
    }
  }
  return latestTodos(history)?.todos ?? null
}

/** The context guard piece (see the module comment). */
export function createContextGuard(input: ContextGuardInput): StepPiece {
  const { session, model, keptUser } = input
  // The chat run that places the marker, the notices and the activity; null for a silent guard.
  const host: HostSession | null = input.silent === true ? null : input.session
  const silent = host === null
  const logger = session.ctx.logger
  let attempts = 0
  let failed = false
  // The step of the latest compaction of this run: when the provider reports the very next call (made on the compacted
  // context) above the trigger again, the context is too large for reasons a summary cannot fix (tool definitions, the
  // instructions), and the guard stops compacting for the rest of the run.
  let compactedAt: number | null = null
  let ineffective = false
  // Messages the model still saw verbatim before the next compaction (`messagesCompacted`): the history after its own
  // latest marker; the reply of this run counts once it has content (a continued reply is part of the history).
  let visibleMessages: number | null = null
  let replyCounted = session.ctx.prepared.continued !== null

  const signalOf = (): AbortSignal => input.signal ?? session.ctx.run.signal

  /** Step 0 only: the trimmed messages and the notice when anything was left out (`always`: the notice anyway). */
  const trim = (step: StepInput, ratio: number, notice: NoticeData, always: boolean): StepPieceResult | undefined => {
    if (step.stepNumber !== 0)
      return undefined
    const trimmed = trimToContext(step.messages, model.entry.contextWindow, step.instructions, ratio)
    if (host !== null && (always || trimmed.removed > 0))
      host.inject({ type: 'data-notice', data: notice }, step.stepNumber)
    return trimmed.removed > 0 ? { messages: trimmed.messages } : undefined
  }

  const compact = async (step: StepInput, window: number, estimate: number, signal: AbortSignal): Promise<StepPieceResult> => {
    signal.throwIfAborted()
    const result = await summarizeHistory({ session, runModel: model, messages: step.messages, focus: null, signal })
    const todos = silent ? null : runTodos(session.ctx.prepared.history, step.steps)
    const base: Omit<CompactionData, 'keep' | 'tokensAfter' | 'messagesCompacted'> = {
      trigger: 'auto',
      summary: result.summary,
      ...(todos === null || todos.length === 0 ? {} : { todos: todos.slice(0, LIMITS.todoItemsMax) }),
      modelRef: result.modelRef,
      tokensBefore: Math.round(estimate),
      createdAt: session.ctx.now(),
    }
    const summaryText = compactionSummaryText({ ...base, keep: 'none', tokensAfter: 0, messagesCompacted: 0 })
    const kept = await keptUser()
    let keep: CompactionKeep = kept === null ? 'none' : 'last-user'
    let messages = [mergeSummaryMessage(summaryText, kept)]
    let tokensAfter = estimateTokens(messages, step.instructions)
    if (keep === 'last-user' && tokensAfter > window * CONTEXT_BUDGET_RATIO) {
      keep = 'none'
      messages = [mergeSummaryMessage(summaryText, null)]
      tokensAfter = estimateTokens(messages, step.instructions)
    }
    if (host !== null) {
      visibleMessages ??= applyCompaction(session.ctx.prepared.history).messages.length
      const replyPart = step.stepNumber > 0 && !replyCounted ? 1 : 0
      const messagesCompacted = Math.max(0, visibleMessages + replyPart - (keep === 'last-user' ? 1 : 0))
      host.inject({ type: 'data-compaction', data: { ...base, keep, messagesCompacted, tokensAfter: Math.round(tokensAfter) } }, step.stepNumber)
      // After this marker the model sees the kept user message, then this reply's later parts.
      visibleMessages = keep === 'last-user' ? 1 : 0
      replyCounted = false
    }
    logger.info('context compacted', { stepNumber: step.stepNumber, silent, keep, tokensBefore: Math.round(estimate), tokensAfter: Math.round(tokensAfter) })
    return { messages }
  }

  return async (step) => {
    const window = model.entry.contextWindow
    if (window === null || window <= 0 || step.messages.length === 0)
      return undefined
    const estimate = stepEstimate(step)
    if (!session.ctx.prepared.settings.autoCompact)
      return trim(step, CONTEXT_BUDGET_RATIO, NOTICES.contextTrimmed(), false)
    if (compactedAt !== null && step.stepNumber === compactedAt + 1 && lastStepTokens(step.steps) > window * COMPACT_TRIGGER_RATIO && !ineffective) {
      ineffective = true
      logger.warn('the compacted context is still above the compaction trigger; no more compactions in this run', { stepNumber: step.stepNumber, silent })
    }
    if (estimate <= window * COMPACT_TRIGGER_RATIO || failed || ineffective || attempts >= LIMITS.compactionsPerRunMax)
      return undefined
    if (step.messages.length === 1 && step.messages[0]?.role === 'user')
      return undefined
    const signal = signalOf()
    attempts += 1
    host?.writeTransient({ type: 'data-activity', data: { kind: 'compacting' } })
    try {
      const result = await compact(step, window, estimate, signal)
      compactedAt = step.stepNumber
      return result
    }
    catch (error) {
      if (signal.aborted || session.ctx.run.signal.aborted)
        throw error
      failed = true
      logger.warn('automatic compaction failed; the conversation is trimmed instead', { stepNumber: step.stepNumber, silent, err: error })
      return trim(step, COMPACT_TRIGGER_RATIO, NOTICES.compactionFailed(), true)
    }
    finally {
      host?.writeTransient({ type: 'data-activity', data: { kind: 'idle' } })
    }
  }
}
