// Usage, cost and timing of a run (API.md 4.7 `MessageMetadata`, DECISIONS "Chat request"). The run observes the
// `streamText` parts: `finish-step` usage (and an OpenRouter-reported cost in the provider metadata), the `finish`
// totals, and reasoning activity for `reasoningMs` ("Thought for Ns" after a reload).
import type { MessageUsage, ModelCost } from '@harness-forge/shared'
import type { LanguageModelUsage, TextStreamPart, ToolSet } from 'ai'

/** USD amounts are rounded to 1e-10 (sums of per-token prices otherwise show floating point noise). */
export function roundUsd(value: number): number {
  return Math.round(value * 1e10) / 1e10
}

/** A token count as stored (integer >= 0), or undefined. */
function count(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : Math.max(0, Math.round(value))
}

function add(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined)
    return b
  if (b === undefined)
    return a
  return a + b
}

/** `MessageUsage` of a run: totals over all steps, `contextTokens` from the final step. */
export function toMessageUsage(total: LanguageModelUsage, finalStep: LanguageModelUsage | undefined): MessageUsage {
  const usage: MessageUsage = {}
  const entries: [keyof MessageUsage, number | undefined][] = [
    ['inputTokens', count(total.inputTokens)],
    ['outputTokens', count(total.outputTokens)],
    ['reasoningTokens', count(total.outputTokenDetails?.reasoningTokens)],
    ['cacheReadTokens', count(total.inputTokenDetails?.cacheReadTokens)],
    ['cacheWriteTokens', count(total.inputTokenDetails?.cacheWriteTokens)],
    ['totalTokens', count(total.totalTokens ?? add(total.inputTokens, total.outputTokens))],
    ['contextTokens', finalStep === undefined ? undefined : count(add(finalStep.inputTokens, finalStep.outputTokens))],
  ]
  for (const [key, value] of entries) {
    if (value !== undefined)
      usage[key] = value
  }
  return usage
}

/** Sum of two message usages (an approval continuation extends the message); `contextTokens` from `later`. */
export function addMessageUsage(earlier: MessageUsage | undefined, later: MessageUsage): MessageUsage {
  if (earlier === undefined)
    return later
  const keys = ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'] as const
  const usage: MessageUsage = {}
  for (const key of keys) {
    const value = add(earlier[key], later[key])
    if (value !== undefined)
      usage[key] = value
  }
  const context = later.contextTokens ?? earlier.contextTokens
  if (context !== undefined)
    usage.contextTokens = context
  return usage
}

/**
 * Cost in USD from catalog prices (USD per 1M tokens). Cache reads / writes use their own price, else the input price.
 * Undefined when a used token kind has no price.
 */
export function catalogCost(usage: LanguageModelUsage, cost: ModelCost | null | undefined): number | undefined {
  if (cost === null || cost === undefined)
    return undefined
  const cacheRead = count(usage.inputTokenDetails?.cacheReadTokens) ?? 0
  const cacheWrite = count(usage.inputTokenDetails?.cacheWriteTokens) ?? 0
  const input = count(usage.inputTokens) ?? 0
  const noCache = count(usage.inputTokenDetails?.noCacheTokens) ?? Math.max(0, input - cacheRead - cacheWrite)
  const output = count(usage.outputTokens) ?? 0
  const lines: [number, number | undefined][] = [
    [noCache, cost.input],
    [cacheRead, cost.cacheRead ?? cost.input],
    [cacheWrite, cost.cacheWrite ?? cost.input],
    [output, cost.output],
  ]
  let total = 0
  for (const [tokens, price] of lines) {
    if (tokens === 0)
      continue
    if (price === undefined)
      return undefined
    total += tokens * price
  }
  return roundUsd(total / 1_000_000)
}

/** The cost an OpenRouter response reports in its provider metadata (`openrouter.usage.cost`), else undefined. */
export function reportedCost(providerMetadata: unknown): number | undefined {
  if (typeof providerMetadata !== 'object' || providerMetadata === null)
    return undefined
  const openrouter = (providerMetadata as Record<string, unknown>).openrouter
  if (typeof openrouter !== 'object' || openrouter === null)
    return undefined
  const usage = (openrouter as Record<string, unknown>).usage
  const cost = typeof usage === 'object' && usage !== null ? (usage as Record<string, unknown>).cost : undefined
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined
}

function emptyUsage(): LanguageModelUsage {
  return {
    inputTokens: undefined,
    inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
    outputTokens: undefined,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    totalTokens: undefined,
  }
}

export function sumUsage(a: LanguageModelUsage, b: LanguageModelUsage): LanguageModelUsage {
  return {
    inputTokens: add(a.inputTokens, b.inputTokens),
    inputTokenDetails: {
      noCacheTokens: add(a.inputTokenDetails?.noCacheTokens, b.inputTokenDetails?.noCacheTokens),
      cacheReadTokens: add(a.inputTokenDetails?.cacheReadTokens, b.inputTokenDetails?.cacheReadTokens),
      cacheWriteTokens: add(a.inputTokenDetails?.cacheWriteTokens, b.inputTokenDetails?.cacheWriteTokens),
    },
    outputTokens: add(a.outputTokens, b.outputTokens),
    outputTokenDetails: {
      textTokens: add(a.outputTokenDetails?.textTokens, b.outputTokenDetails?.textTokens),
      reasoningTokens: add(a.outputTokenDetails?.reasoningTokens, b.outputTokenDetails?.reasoningTokens),
    },
    totalTokens: add(a.totalTokens, b.totalTokens),
  }
}

/** Observes the parts of one `streamText` run. */
export class RunTracker {
  /** Usage of every finished step (a `finish` total wins when present). */
  #stepsUsage: LanguageModelUsage = emptyUsage()
  #steps = 0
  #finalStep: LanguageModelUsage | undefined
  #total: LanguageModelUsage | undefined
  #reported: number | undefined
  #unreportedSteps = 0
  #reasoningOpen = new Set<string>()
  #reasoningSince = 0
  #reasoningMs = 0
  #sawReasoning = false
  readonly now: () => number
  finishReason: string | undefined

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  observe(part: TextStreamPart<ToolSet>): void {
    switch (part.type) {
      case 'reasoning-start':
        this.#sawReasoning = true
        if (this.#reasoningOpen.size === 0)
          this.#reasoningSince = this.now()
        this.#reasoningOpen.add(part.id)
        break
      case 'reasoning-end':
        if (this.#reasoningOpen.delete(part.id) && this.#reasoningOpen.size === 0)
          this.#reasoningMs += this.now() - this.#reasoningSince
        break
      case 'finish-step': {
        this.#steps += 1
        this.#stepsUsage = sumUsage(this.#stepsUsage, part.usage)
        this.#finalStep = part.usage
        const reported = reportedCost(part.providerMetadata)
        if (reported === undefined)
          this.#unreportedSteps += 1
        else
          this.#reported = (this.#reported ?? 0) + reported
        break
      }
      case 'finish':
        this.#total = part.totalUsage
        this.finishReason = part.finishReason
        break
      default:
        break
    }
  }

  /** At least one step finished (usage is known). */
  get hasUsage(): boolean {
    return this.#steps > 0 || this.#total !== undefined
  }

  get usage(): LanguageModelUsage {
    return this.#total ?? this.#stepsUsage
  }

  get finalStepUsage(): LanguageModelUsage | undefined {
    return this.#finalStep
  }

  /** Reasoning time so far (open reasoning counts until now); undefined when the run had no reasoning. */
  reasoningMs(): number | undefined {
    if (!this.#sawReasoning)
      return undefined
    const open = this.#reasoningOpen.size > 0 ? this.now() - this.#reasoningSince : 0
    return Math.max(0, Math.round(this.#reasoningMs + open))
  }

  /** OpenRouter-reported cost when every finished step reported one, else the catalog price. */
  cost(prices: ModelCost | null | undefined): number | undefined {
    if (this.#reported !== undefined && this.#unreportedSteps === 0)
      return roundUsd(this.#reported)
    return this.hasUsage ? catalogCost(this.usage, prices) : undefined
  }
}
