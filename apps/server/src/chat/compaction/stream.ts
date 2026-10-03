// The manual `/compact [focus]` (Phase 9, ADR-040, ARCHITECTURE.md 6.18, API.md 6.9): `launchRun` (`pipeline.ts`)
// dispatches a `compact` command resolution here instead of a model call. Signature FROZEN after P9-0b (C26).
//
// `createUIMessageStream` writing `start` → the transient `data-activity` `compacting` (`session.bindWriter` +
// `session.writeTransient`) → `summarizeHistory` of `buildModelHistory(history without the /compact message)` → one
// `data-compaction` (`trigger: 'manual'`, `keep: 'none'`, `focus`, the `latestTodos` snapshot) → `data-activity` `idle`
// → `finish` with `metadata.usage.contextTokens = tokensAfter` (the context ring drops at once). Nothing after the
// latest marker (only `/compact` exchanges, or nothing at all) → `replyStream` with `NOTHING_TO_COMPACT_TEXT`. A
// summarizer failure ends the reply as failed (an `error` chunk, the error in the metadata, no marker, no trimming); an
// abort ends it `aborted`. A regenerate of the reply runs it again (`prepare.ts`); an image model as the run model is
// refused with a 400 before the stream (`prepare.ts`).
import type { CompactionData, HarnessUIMessage, MessageUsage } from '@harness-forge/shared'
import type { LanguageModelUsage, UIMessageChunk } from 'ai'
import type { RunSession } from '../pipeline.ts'
import { isContentPart, latestTodos, LIMITS } from '@harness-forge/shared'
import { convertToModelMessages, createUIMessageStream } from 'ai'
import { compactNeedsChatModel } from '../commands.ts'
import { estimateTokens } from '../context.ts'
import { buildModelHistory } from '../model-history.ts'
import { conversionTools, replyStream } from '../pipeline.ts'
import { applyCompaction, compactionSummaryText } from './history.ts'
import { summarizeHistory } from './summarize.ts'

/** The reply of a `/compact` with nothing to summarize yet. */
export const NOTHING_TO_COMPACT_TEXT = 'There is nothing to compact yet.'

/** A `/compact` user message (its stored invocation). */
function isCompactCommand(message: HarnessUIMessage): boolean {
  return message.role === 'user' && message.metadata?.command?.type === 'compact'
}

/**
 * The history `/compact` summarizes: the path without the `/compact` message itself (the last message of a new turn
 * and of a regenerate).
 */
export function historyToCompact(history: readonly HarnessUIMessage[]): HarnessUIMessage[] {
  const last = history.at(-1)
  return last !== undefined && isCompactCommand(last) ? history.slice(0, -1) : [...history]
}

/**
 * Whether the model still sees anything to compact: content after the latest marker other than `/compact` messages and
 * their replies.
 */
export function hasSomethingToCompact(history: readonly HarnessUIMessage[]): boolean {
  const visible = applyCompaction(history).messages
  return visible.some((message, index) => {
    if (isCompactCommand(message))
      return false
    const previous = visible[index - 1]
    if (message.role === 'assistant' && previous !== undefined && isCompactCommand(previous))
      return false
    return message.parts.some(isContentPart)
  })
}

/** The context the chat showed before: the latest assistant message's `contextTokens` (0 without one). */
function shownContextTokens(history: readonly HarnessUIMessage[]): number {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]
    if (message?.role === 'assistant' && message.metadata?.usage?.contextTokens !== undefined)
      return message.metadata.usage.contextTokens
  }
  return 0
}

/** `MessageUsage` of the summarizer call, with the context after the compaction as `contextTokens`. */
function compactUsage(usage: LanguageModelUsage, contextTokens: number): MessageUsage {
  const count = (value: number | undefined): number | undefined => (value === undefined || !Number.isFinite(value) ? undefined : Math.max(0, Math.round(value)))
  const entries: [keyof MessageUsage, number | undefined][] = [
    ['inputTokens', count(usage.inputTokens)],
    ['outputTokens', count(usage.outputTokens)],
    ['reasoningTokens', count(usage.outputTokenDetails?.reasoningTokens)],
    ['totalTokens', count(usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)))],
    ['contextTokens', count(contextTokens)],
  ]
  const result: MessageUsage = {}
  for (const [key, value] of entries) {
    if (value !== undefined)
      result[key] = value
  }
  return result
}

/**
 * The reply stream of `/compact [focus]` (see the module comment). `focus` is the command input, trimmed (null when
 * empty; at most `LIMITS.compactFocusMaxChars`, checked by `resolveCommand`).
 */
export async function compactStream(session: RunSession, focus: string | null): Promise<ReadableStream<UIMessageChunk>> {
  const { prepared, run, logger } = session.ctx
  const target = prepared.target
  // `prepare.ts` refuses an image model for `/compact` before the history changes; this only guards that rule.
  if (target.kind !== 'chat')
    throw compactNeedsChatModel()
  const history = historyToCompact(prepared.history)
  if (!hasSomethingToCompact(history))
    return replyStream(session, NOTHING_TO_COMPACT_TEXT)
  session.mode = 'compact'
  const visible = buildModelHistory(history)
  const messagesCompacted = applyCompaction(history).messages.length
  const todos = latestTodos(history)?.todos ?? []

  return createUIMessageStream<HarnessUIMessage>({
    originalMessages: prepared.history,
    generateId: () => session.assistantId,
    execute: async ({ writer }) => {
      session.bindWriter(writer)
      writer.write({ type: 'start', messageId: session.assistantId, messageMetadata: session.startMetadata() })
      session.writeTransient({ type: 'data-activity', data: { kind: 'compacting' } })
      let data: CompactionData
      let usage: LanguageModelUsage
      try {
        // Tool outputs as their model text (`toModelOutput` of the registered tools), like the model saw them.
        const tools = conversionTools(session.ctx.deps, {}, logger)
        const messages = await convertToModelMessages<HarnessUIMessage>(visible, { tools, ignoreIncompleteToolCalls: true })
        const result = await summarizeHistory({ session, runModel: target.model, messages, focus, signal: run.signal })
        const base = {
          trigger: 'manual' as const,
          keep: 'none' as const,
          summary: result.summary,
          ...(focus === null ? {} : { focus }),
          ...(todos.length === 0 ? {} : { todos: todos.slice(0, LIMITS.todoItemsMax) }),
          modelRef: result.modelRef,
          messagesCompacted,
          tokensBefore: Math.round(Math.max(estimateTokens(messages), shownContextTokens(history))),
          createdAt: session.ctx.now(),
        }
        const tokensAfter = estimateTokens([{ role: 'user', content: compactionSummaryText({ ...base, tokensAfter: 0 }) }])
        data = { ...base, tokensAfter: Math.round(tokensAfter) }
        usage = result.usage
      }
      catch (error) {
        session.writeTransient({ type: 'data-activity', data: { kind: 'idle' } })
        if (run.signal.aborted) {
          writer.write({ type: 'abort' })
          return
        }
        session.recordFatal(error)
        writer.write({ type: 'error', errorText: session.errorText(error) })
        return
      }
      writer.write({ type: 'data-compaction', data })
      session.writeTransient({ type: 'data-activity', data: { kind: 'idle' } })
      logger.info('conversation compacted', { trigger: 'manual', messagesCompacted: data.messagesCompacted, tokensBefore: data.tokensBefore, tokensAfter: data.tokensAfter })
      session.finished = true
      session.finishMetadata = { ...session.buildFinishMetadata(session.ctx.now(), 'completed'), usage: compactUsage(usage, data.tokensAfter) }
      writer.write({ type: 'finish', finishReason: 'stop', messageMetadata: session.finishMetadata })
    },
    onError: error => session.errorText(error),
    onEnd: session.onEnd,
  }) as ReadableStream<UIMessageChunk>
}
