import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { createLoginRateLimiter, LOGIN_RATE_LIMIT_DEFAULTS } from './login-rate-limit.ts'

const MINUTE = 60_000
const WINDOW = 15 * MINUTE

function clock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => void (now += ms) }
}

function rateLimited(run: () => unknown): HarnessError {
  try {
    run()
  }
  catch (error) {
    expect(error).toBeInstanceOf(HarnessError)
    return error as HarnessError
  }
  throw new Error('expected rate_limited')
}

describe('login rate limiter', () => {
  it('defaults to 5 failures per address and 50 globally per 15 minutes', () => {
    expect(LOGIN_RATE_LIMIT_DEFAULTS).toEqual({ perAddressLimit: 5, globalLimit: 50, windowMs: WINDOW })
  })

  it('blocks an address after 5 failures until the oldest leaves the window', () => {
    const time = clock()
    const limiter = createLoginRateLimiter({ now: time.now })
    for (let i = 0; i < 5; i += 1) {
      limiter.attempt('10.0.0.1')
      time.advance(MINUTE)
    }
    const error = rateLimited(() => limiter.attempt('10.0.0.1'))
    expect(error).toMatchObject({ code: 'rate_limited', action: 'retry' })
    // The first failure happened 5 minutes ago: it leaves the 15-minute window in 10 minutes.
    expect(error.retryAfterMs).toBe(10 * MINUTE)
    expect(error.httpStatus).toBe(429)
    // Other addresses are unaffected.
    expect(() => limiter.attempt('10.0.0.2')).not.toThrow()

    time.advance(10 * MINUTE - 1)
    expect(() => limiter.attempt('10.0.0.1')).toThrow(HarnessError)
    time.advance(1)
    expect(() => limiter.attempt('10.0.0.1')).not.toThrow()
  })

  it('a successful attempt resets the address and does not count as a failure', () => {
    const time = clock()
    const limiter = createLoginRateLimiter({ now: time.now })
    for (let i = 0; i < 4; i += 1)
      limiter.attempt('10.0.0.1')
    expect(limiter.remaining('10.0.0.1')).toBe(1)
    limiter.attempt('10.0.0.1').succeeded()
    expect(limiter.remaining('10.0.0.1')).toBe(5)
    for (let i = 0; i < 5; i += 1)
      limiter.attempt('10.0.0.1')
    expect(() => limiter.attempt('10.0.0.1')).toThrow(HarnessError)
  })

  it('counts attempts that are still running, so concurrent guesses cannot outrun the limit', () => {
    const limiter = createLoginRateLimiter({ now: clock().now })
    const pending = Array.from({ length: 5 }, () => limiter.attempt('10.0.0.1'))
    expect(() => limiter.attempt('10.0.0.1')).toThrow(HarnessError)
    pending[0]?.succeeded()
    expect(() => limiter.attempt('10.0.0.1')).not.toThrow()
  })

  it('blocks everyone after 50 failures from any addresses', () => {
    const time = clock()
    const limiter = createLoginRateLimiter({ now: time.now })
    for (let i = 0; i < 50; i += 1)
      limiter.attempt(`10.0.${Math.floor(i / 5)}.${i % 5}`)
    time.advance(2 * MINUTE)
    const error = rateLimited(() => limiter.attempt('192.168.1.1'))
    expect(error.retryAfterMs).toBe(13 * MINUTE)
    time.advance(13 * MINUTE)
    expect(() => limiter.attempt('192.168.1.1')).not.toThrow()
  })

  it('never throws for a success reported twice and keeps memory bounded', () => {
    const time = clock()
    const limiter = createLoginRateLimiter({ now: time.now, globalLimit: 10_000 })
    const attempt = limiter.attempt('10.0.0.1')
    attempt.succeeded()
    attempt.succeeded()
    for (let i = 0; i < 1000; i += 1) {
      limiter.attempt(`addr-${i}`)
      time.advance(WINDOW / 100)
    }
    // Every entry older than the window is swept: only the last ~100 addresses can still be blocked.
    expect(limiter.remaining('addr-0')).toBe(5)
    expect(limiter.remaining('addr-999')).toBe(4)
  })
})
