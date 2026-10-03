import { describe, expect, it } from 'vitest'
import { compactionNote, contextUsage, formatUsd, toLanguageModelUsage, usedContextTokens } from './context-usage'

describe('context usage', () => {
  it('uses the context tokens of the last step', () => {
    expect(contextUsage({ inputTokens: 900_000, outputTokens: 10_000, contextTokens: 84_000 }, 200_000))
      .toEqual({ used: 84_000, max: 200_000, percent: 42, level: 'normal' })
  })

  it('falls back to input + output, then total', () => {
    expect(usedContextTokens({ inputTokens: 1000, outputTokens: 500 })).toBe(1500)
    expect(usedContextTokens({ totalTokens: 700 })).toBe(700)
    expect(usedContextTokens({})).toBeNull()
  })

  it('colors from 80% (warning) and 95% (danger), clamped at 100%', () => {
    expect(contextUsage({ contextTokens: 159_000 }, 200_000)?.level).toBe('normal')
    expect(contextUsage({ contextTokens: 160_000 }, 200_000)?.level).toBe('warning')
    expect(contextUsage({ contextTokens: 190_000 }, 200_000)?.level).toBe('danger')
    expect(contextUsage({ contextTokens: 250_000 }, 200_000)?.percent).toBe(100)
  })

  it('is hidden without usage or a context window', () => {
    expect(contextUsage(null, 200_000)).toBeNull()
    expect(contextUsage({ contextTokens: 10 }, null)).toBeNull()
    expect(contextUsage({ contextTokens: 10 }, 0)).toBeNull()
    expect(contextUsage({}, 1000)).toBeNull()
  })

  it('maps usage to the AI SDK shape for the hover card rows', () => {
    expect(toLanguageModelUsage({ inputTokens: 10, outputTokens: 20, reasoningTokens: 5, cacheReadTokens: 3, totalTokens: 30 })).toMatchObject({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      inputTokenDetails: { cacheReadTokens: 3 },
      outputTokenDetails: { reasoningTokens: 5 },
    })
  })

  it('formats costs', () => {
    expect(formatUsd(0.12)).toBe('$0.12')
    expect(formatUsd(0.004)).toBe('$0.004')
    expect(formatUsd(12.5)).toBe('$12.50')
    expect(formatUsd(0)).toBe('$0')
    expect(formatUsd(-1)).toBe('')
  })

  it('drops right after /compact: the reply reports the context after the compaction (Phase 9)', () => {
    expect(contextUsage({ inputTokens: 190_000, outputTokens: 2_000, contextTokens: 9_000 }, 200_000))
      .toEqual({ used: 9_000, max: 200_000, percent: 5, level: 'normal' })
  })

  it('ends the hover card with a note per the autoCompact setting (Phase 9)', () => {
    expect(compactionNote(true)).toBe('Older messages are summarized automatically near the limit. Type /compact to do it now.')
    expect(compactionNote(false)).toBe('Automatic compaction is off. Older messages are left out near the limit.')
  })
})
