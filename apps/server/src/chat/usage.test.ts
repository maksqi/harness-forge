import type { JSONObject } from '@ai-sdk/provider'
import type { LanguageModelUsage, TextStreamPart, ToolSet } from 'ai'
import { describe, expect, it } from 'vitest'
import { addMessageUsage, catalogCost, reportedCost, roundUsd, RunTracker, sumUsage, toMessageUsage } from './usage.ts'

function usage(input: number | undefined, output: number | undefined, extra: { cacheRead?: number, cacheWrite?: number, reasoning?: number, noCache?: number } = {}): LanguageModelUsage {
  return {
    inputTokens: input,
    inputTokenDetails: { noCacheTokens: extra.noCache, cacheReadTokens: extra.cacheRead, cacheWriteTokens: extra.cacheWrite },
    outputTokens: output,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: extra.reasoning },
    totalTokens: input === undefined || output === undefined ? undefined : input + output,
  }
}

describe('message usage', () => {
  it('maps SDK usage to MessageUsage with contextTokens from the final step', () => {
    expect(toMessageUsage(usage(100, 50, { cacheRead: 20, cacheWrite: 5, reasoning: 10 }), usage(60, 30))).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 10,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
      totalTokens: 150,
      contextTokens: 90,
    })
    expect(toMessageUsage(usage(undefined, undefined), undefined)).toEqual({})
    expect(toMessageUsage(usage(1.6, -3), undefined)).toMatchObject({ inputTokens: 2, outputTokens: 0 })
  })

  it('adds two usages (continuations) and keeps the later context size', () => {
    expect(addMessageUsage(undefined, { inputTokens: 1 })).toEqual({ inputTokens: 1 })
    expect(addMessageUsage({ inputTokens: 10, outputTokens: 5, contextTokens: 15 }, { inputTokens: 20, reasoningTokens: 3, contextTokens: 30 })).toEqual({
      inputTokens: 30,
      outputTokens: 5,
      reasoningTokens: 3,
      contextTokens: 30,
    })
  })

  it('sums SDK usages', () => {
    expect(sumUsage(usage(1, 2, { cacheRead: 1 }), usage(3, undefined))).toMatchObject({ inputTokens: 4, outputTokens: 2, inputTokenDetails: { cacheReadTokens: 1 } })
  })
})

describe('cost', () => {
  it('prices input, cache reads / writes and output per 1M tokens', () => {
    const prices = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
    // 1000 input of which 200 cache reads and 100 cache writes -> 700 uncached.
    expect(catalogCost(usage(1000, 500, { cacheRead: 200, cacheWrite: 100 }), prices)).toBe(roundUsd((700 * 3 + 200 * 0.3 + 100 * 3.75 + 500 * 15) / 1e6))
    expect(catalogCost(usage(1000, 0, { noCache: 1000 }), { input: 1 })).toBe(0.001)
    // Cache prices fall back to the input price.
    expect(catalogCost(usage(100, 0, { cacheRead: 100 }), { input: 2 })).toBe(0.0002)
  })

  it('is unknown without prices or when a used token kind has no price', () => {
    expect(catalogCost(usage(10, 10), null)).toBeUndefined()
    expect(catalogCost(usage(10, 10), { input: 1 })).toBeUndefined()
    expect(catalogCost(usage(10, 0), { input: 1 })).toBe(0.00001)
  })

  it('reads the cost OpenRouter reports', () => {
    expect(reportedCost({ openrouter: { usage: { cost: 0.0042 } } })).toBe(0.0042)
    expect(reportedCost({ openrouter: { usage: {} } })).toBeUndefined()
    expect(reportedCost({ other: {} })).toBeUndefined()
    expect(reportedCost(undefined)).toBeUndefined()
    expect(reportedCost({ openrouter: { usage: { cost: -1 } } })).toBeUndefined()
  })

  it('rounds USD amounts', () => {
    expect(0.1 + 0.2).not.toBe(0.3)
    expect(roundUsd(0.1 + 0.2)).toBe(0.3)
    expect(roundUsd(0.000028000000000000003)).toBe(0.000028)
  })
})

function finishStep(input: number, output: number, providerMetadata?: Record<string, JSONObject>): TextStreamPart<ToolSet> {
  return { type: 'finish-step', usage: usage(input, output), finishReason: 'stop', rawFinishReason: 'stop', providerMetadata, response: {} as never, performance: {} as never }
}

describe('runTracker', () => {
  it('accumulates step usage, the final step and the finish totals', () => {
    const tracker = new RunTracker(() => 0)
    expect(tracker.hasUsage).toBe(false)
    tracker.observe(finishStep(10, 5))
    tracker.observe(finishStep(20, 7))
    expect(tracker.hasUsage).toBe(true)
    expect(tracker.usage.inputTokens).toBe(30)
    expect(tracker.finalStepUsage?.inputTokens).toBe(20)
    tracker.observe({ type: 'finish', finishReason: 'tool-calls', rawFinishReason: undefined, totalUsage: usage(31, 12) })
    expect(tracker.usage.inputTokens).toBe(31)
    expect(tracker.finishReason).toBe('tool-calls')
    expect(tracker.cost({ input: 1, output: 1 })).toBe(0.000043)
  })

  it('prefers a reported cost when every step reported one', () => {
    const tracker = new RunTracker()
    tracker.observe(finishStep(10, 5, { openrouter: { usage: { cost: 0.001 } } }))
    tracker.observe(finishStep(10, 5, { openrouter: { usage: { cost: 0.002 } } }))
    expect(tracker.cost({ input: 1, output: 1 })).toBe(0.003)
    // One step without a reported cost: the catalog price of the whole run (30 input + 15 output tokens).
    tracker.observe(finishStep(10, 5))
    expect(tracker.cost({ input: 1, output: 1 })).toBe(0.000045)
  })

  it('measures reasoning time, overlapping parts once, open parts until now', () => {
    let now = 1000
    const tracker = new RunTracker(() => now)
    expect(tracker.reasoningMs()).toBeUndefined()
    tracker.observe({ type: 'reasoning-start', id: 'a' })
    now = 1400
    tracker.observe({ type: 'reasoning-start', id: 'b' })
    now = 1600
    tracker.observe({ type: 'reasoning-end', id: 'a' })
    now = 2000
    tracker.observe({ type: 'reasoning-end', id: 'b' })
    expect(tracker.reasoningMs()).toBe(1000)
    now = 3000
    tracker.observe({ type: 'reasoning-start', id: 'c' })
    now = 3250
    expect(tracker.reasoningMs()).toBe(1250)
  })
})
