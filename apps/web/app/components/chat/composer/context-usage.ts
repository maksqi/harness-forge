// Context ring math (docs/UI.md 7.12): context used by the last assistant turn (input + output tokens of its last
// step, `MessageUsage.contextTokens`) against the model's context window. Muted below 80%, warning from 80%,
// destructive from 95%.
import type { MessageUsage } from '@harness-forge/shared'
import type { LanguageModelUsage } from 'ai'

export type ContextLevel = 'normal' | 'warning' | 'danger'

export interface ContextUsageView {
  used: number
  max: number
  /** 0-100, rounded to a whole percent for display and `data-value`. */
  percent: number
  level: ContextLevel
}

/** Tokens currently in the context: `contextTokens`, else input + output of the message. */
export function usedContextTokens(usage: MessageUsage): number | null {
  if (usage.contextTokens !== undefined)
    return usage.contextTokens
  if (usage.inputTokens === undefined && usage.outputTokens === undefined)
    return usage.totalTokens ?? null
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
}

/** The ring view, or null when it is hidden (no usage yet, or the model has no context window). */
export function contextUsage(usage: MessageUsage | null | undefined, contextWindow: number | null | undefined): ContextUsageView | null {
  if (!usage || !contextWindow || contextWindow <= 0)
    return null
  const used = usedContextTokens(usage)
  if (used === null)
    return null
  const ratio = Math.min(Math.max(used / contextWindow, 0), 1)
  const level: ContextLevel = ratio >= 0.95 ? 'danger' : ratio >= 0.8 ? 'warning' : 'normal'
  return { used, max: contextWindow, percent: Math.round(ratio * 100), level }
}

/** `MessageUsage` in the AI SDK shape the AI Elements context rows read. */
export function toLanguageModelUsage(usage: MessageUsage): LanguageModelUsage {
  return {
    inputTokens: usage.inputTokens,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    },
    outputTokens: usage.outputTokens,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: usage.reasoningTokens,
    },
    totalTokens: usage.totalTokens,
  }
}

/** "$0.12", "$0.004"; small amounts keep up to three significant digits. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value < 0)
    return ''
  if (value === 0)
    return '$0'
  if (value < 0.01)
    return `$${Number(value.toPrecision(2))}`
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value)
}
