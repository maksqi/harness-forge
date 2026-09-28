import type { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { createShareRateLimiter, SHARE_RATE_LIMIT_DEFAULTS, SHARE_RATE_LIMITED_MESSAGE } from './rate-limit.ts'

const MINUTE = 60_000

function refusal(run: () => void): HarnessError {
  try {
    run()
  }
  catch (error) {
    return error as HarnessError
  }
  throw new Error('expected a refusal')
}

describe('share rate limits', () => {
  it('uses the limits of ARCHITECTURE.md 10.7 by default', () => {
    expect(SHARE_RATE_LIMIT_DEFAULTS).toEqual({
      viewsPerMinute: 60,
      filesPerMinute: 600,
      invalidTokens: 20,
      invalidTokenWindowMs: 10 * MINUTE,
      globalPerMinute: 6000,
    })
  })

  it('admits 60 views per minute per address, then refuses with the wait until a slot frees', () => {
    let now = 1_000_000
    const limits = createShareRateLimiter({ now: () => now })
    for (let index = 0; index < 60; index++) {
      limits.admit('view', '203.0.113.1')
      now += 100
    }
    const error = refusal(() => limits.admit('view', '203.0.113.1'))
    expect(error).toMatchObject({ code: 'rate_limited', message: SHARE_RATE_LIMITED_MESSAGE, action: 'retry' })
    // The first view happened 6 s ago: it leaves the window in 54 s.
    expect(error.retryAfterMs).toBe(MINUTE - 6000)
    // Other addresses and the file route keep their own budgets.
    expect(() => limits.admit('view', '203.0.113.2')).not.toThrow()
    expect(() => limits.admit('file', '203.0.113.1')).not.toThrow()
    now += MINUTE - 6000
    expect(() => limits.admit('view', '203.0.113.1')).not.toThrow()
    expect(() => limits.admit('view', '203.0.113.1')).toThrow()
  })

  it('admits 600 file requests per minute per address', () => {
    let now = 0
    const limits = createShareRateLimiter({ now: () => now })
    for (let index = 0; index < 600; index++)
      limits.admit('file', '198.51.100.7')
    expect(refusal(() => limits.admit('file', '198.51.100.7')).retryAfterMs).toBe(MINUTE)
    now += MINUTE
    expect(() => limits.admit('file', '198.51.100.7')).not.toThrow()
  })

  it('refuses every request of an address after 20 invalid tokens in 10 minutes', () => {
    let now = 0
    const limits = createShareRateLimiter({ now: () => now })
    for (let index = 0; index < 20; index++) {
      limits.admit('view', '192.0.2.9')
      limits.invalidToken('192.0.2.9')
      now += 1000
    }
    // Views of the address are still under their own limit: the invalid-token limit refuses them.
    const error = refusal(() => limits.admit('view', '192.0.2.9'))
    expect(error.code).toBe('rate_limited')
    expect(error.retryAfterMs).toBe(10 * MINUTE - 20_000)
    expect(() => limits.admit('file', '192.0.2.9')).toThrow()
    expect(() => limits.admit('view', '192.0.2.10')).not.toThrow()
    now += 10 * MINUTE - 20_000
    expect(() => limits.admit('view', '192.0.2.9')).not.toThrow()
  })

  it('caps every address together at the global limit', () => {
    let now = 0
    const limits = createShareRateLimiter({ now: () => now, globalPerMinute: 5, viewsPerMinute: 100 })
    for (let index = 0; index < 5; index++)
      limits.admit(index % 2 === 0 ? 'view' : 'file', `10.0.0.${index}`)
    expect(refusal(() => limits.admit('view', '10.0.0.99')).retryAfterMs).toBe(MINUTE)
    now += MINUTE
    expect(() => limits.admit('view', '10.0.0.99')).not.toThrow()
  })

  it('does not count refused requests, and reports the longest wait of the limits reached', () => {
    let now = 0
    const limits = createShareRateLimiter({ now: () => now, viewsPerMinute: 2, invalidTokens: 1, invalidTokenWindowMs: 5 * MINUTE })
    limits.admit('view', 'a')
    limits.admit('view', 'a')
    for (let index = 0; index < 10; index++)
      expect(() => limits.admit('view', 'a')).toThrow()
    now += MINUTE
    // The refused attempts did not extend the window.
    limits.admit('view', 'a')
    limits.admit('view', 'a')
    limits.invalidToken('a')
    // Both the view limit (60 s) and the invalid-token limit (5 min) are reached: the longest wait is reported.
    expect(refusal(() => limits.admit('view', 'a')).retryAfterMs).toBe(5 * MINUTE)
  })

  it('sweeps idle addresses once a minute, so memory stays bounded', () => {
    let now = 0
    const limits = createShareRateLimiter({ now: () => now })
    for (let index = 0; index < 500; index++) {
      limits.admit('file', `2001:db8::${index.toString(16)}`)
      limits.invalidToken(`2001:db8::${index.toString(16)}`)
    }
    expect(limits.trackedKeys()).toBe(1001)
    now += 11 * MINUTE
    limits.admit('view', '203.0.113.50')
    expect(limits.trackedKeys()).toBe(2)
  })
})
