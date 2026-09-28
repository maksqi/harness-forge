import { describe, expect, it } from 'vitest'
import { apiError } from '../testing.ts'
import { errorFacts, mapProviderError, originOf, redact, retryAfterMs } from './errors.ts'

const PROVIDER = { id: 'acme', name: 'Acme' }

describe('errorFacts', () => {
  it('reads status, lowercase codes, headers, request model and vendor message', () => {
    const facts = errorFacts(apiError({
      status: 429,
      model: 'm-1',
      headers: { 'Retry-After': '3' },
      body: { error: { message: 'Slow down', type: 'Rate_Limit_Error', code: 'X1' } },
    }))
    expect(facts).toMatchObject({ status: 429, modelId: 'm-1', upstreamMessage: 'Slow down', headers: { 'retry-after': '3' } })
    expect([...(facts?.codes ?? [])]).toEqual(expect.arrayContaining(['rate_limit_error', 'x1']))
  })

  it('finds network codes inside causes and AggregateErrors', () => {
    const aggregate = Object.assign(new AggregateError([Object.assign(new Error('connect'), { code: 'EHOSTUNREACH' })], 'connect failed'), {})
    const error = apiError({ url: 'http://10.0.0.5:11434/v1/models', cause: new TypeError('fetch failed', { cause: aggregate }) })
    expect(errorFacts(error)?.networkCode).toBe('EHOSTUNREACH')
    expect(mapProviderError(error, PROVIDER)).toMatchObject({ code: 'provider_unreachable', message: 'Cannot reach Acme at http://10.0.0.5:11434. Check the network connection and the base URL.' })
  })

  it('ignores values that are not errors', () => {
    expect(errorFacts(undefined)).toBeUndefined()
    expect(errorFacts('text')).toBeUndefined()
    expect(mapProviderError(42, PROVIDER)).toBeUndefined()
  })
})

describe('retryAfterMs', () => {
  const now = Date.parse('2026-09-28T12:00:00Z')

  it('prefers retry-after-ms, then retry-after seconds or date, then Google RetryInfo', () => {
    const facts = (headers: Record<string, string>, body?: unknown) => errorFacts(apiError({ status: 429, headers, body }))!
    expect(retryAfterMs(facts({ 'retry-after-ms': '250', 'retry-after': '9' }), now)).toBe(250)
    expect(retryAfterMs(facts({ 'retry-after': '1.5' }), now)).toBe(1500)
    expect(retryAfterMs(facts({ 'retry-after': 'Mon, 28 Sep 2026 12:00:30 GMT' }), now)).toBe(30_000)
    expect(retryAfterMs(facts({}, { error: { details: [{ retryDelay: '2.5s' }] } }), now)).toBe(2500)
    expect(retryAfterMs(facts({ 'retry-after': 'soon' }), now)).toBeUndefined()
  })
})

describe('helpers', () => {
  it('redacts key-like tokens and caps the length', () => {
    expect(redact('Incorrect API key provided: sk-proj-abc*****xyz. Bearer abcdef123456')).toBe('Incorrect API key provided: [redacted]. Bearer [redacted]')
    expect(redact('key=AIzaSyA1234567890abcdef and gsk_live1234')).toBe('key=[redacted] and [redacted]')
    expect(redact('x'.repeat(10) + ' '.repeat(5) + 'y'.repeat(400)).length).toBeLessThanOrEqual(300)
  })

  it('reads URL origins', () => {
    expect(originOf('http://localhost:11434/api/tags')).toBe('http://localhost:11434')
    expect(originOf('not a url')).toBeUndefined()
    expect(originOf(undefined)).toBeUndefined()
  })
})
