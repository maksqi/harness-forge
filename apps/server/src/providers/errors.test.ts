import { APICallError } from '@ai-sdk/provider'
import { RetryError } from 'ai'
import { describe, expect, it } from 'vitest'
import { defaultProviderError, redactUpstream, retryAfterMs } from './errors.ts'

const OPTIONS = { providerId: 'acme', providerName: 'Acme', now: Date.parse('2026-09-28T00:00:00Z') }

function apiError(status: number, body: unknown = { error: { message: 'Upstream says no' } }, headers: Record<string, string> = {}): APICallError {
  return new APICallError({
    message: `HTTP ${status}`,
    url: 'https://api.acme.test/v1/chat',
    requestBodyValues: {},
    statusCode: status,
    responseHeaders: headers,
    responseBody: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function networkError(code: string): TypeError {
  const cause = Object.assign(new Error(`connect ${code} 127.0.0.1:11434`), { code })
  return new TypeError('fetch failed', { cause })
}

describe('defaultProviderError', () => {
  it.each([
    [401, 'auth_invalid', 'configure-provider'],
    [403, 'auth_invalid', 'configure-provider'],
    [404, 'model_not_found', 'refresh-models'],
    [500, 'provider_error', 'retry'],
    [529, 'provider_error', 'retry'],
  ] as const)('hTTP %i -> %s', (status, code, action) => {
    const mapped = defaultProviderError(apiError(status), OPTIONS)
    expect(mapped).toMatchObject({ code, action, status, providerId: 'acme' })
    expect(mapped.details).toEqual({ upstream: 'Upstream says no' })
  })

  it('maps 429 with retry-after to rate_limited with retryAfterMs', () => {
    expect(defaultProviderError(apiError(429, {}, { 'retry-after': '7' }), OPTIONS)).toMatchObject({
      code: 'rate_limited',
      retryAfterMs: 7000,
      action: 'retry',
      status: 429,
      message: 'Acme rate limit reached. Try again in 7 s.',
    })
    expect(defaultProviderError(apiError(429), OPTIONS)).not.toHaveProperty('retryAfterMs')
  })

  it('maps context length errors to context_overflow', () => {
    const body = { error: { code: 'context_length_exceeded', message: 'This model\'s maximum context length is 8192 tokens.' } }
    expect(defaultProviderError(apiError(400, body), OPTIONS).code).toBe('context_overflow')
    expect(defaultProviderError(apiError(400, { error: { message: 'prompt is too long: 250000 tokens' } }), OPTIONS).code).toBe('context_overflow')
    expect(defaultProviderError(apiError(400, { error: { message: 'invalid temperature' } }), OPTIONS).code).toBe('provider_error')
  })

  it('maps network failures and timeouts to provider_unreachable', () => {
    const refused = new APICallError({ message: 'Cannot connect to API', url: 'http://localhost:11434/v1/chat', requestBodyValues: {}, cause: networkError('ECONNREFUSED') })
    expect(defaultProviderError(refused, OPTIONS)).toMatchObject({
      code: 'provider_unreachable',
      action: 'retry',
      message: 'Cannot reach Acme at http://localhost:11434. Check the network connection and the base URL.',
    })
    expect(defaultProviderError(networkError('ENOTFOUND'), OPTIONS).code).toBe('provider_unreachable')
    expect(defaultProviderError(new DOMException('slow', 'TimeoutError'), OPTIONS)).toMatchObject({
      code: 'provider_unreachable',
      message: 'Acme did not respond in time.',
    })
  })

  it('reads the last error of a RetryError', () => {
    const retry = new RetryError({ message: 'Failed after 3 attempts', reason: 'maxRetriesExceeded', errors: [apiError(500), apiError(401)] })
    expect(defaultProviderError(retry, OPTIONS)).toMatchObject({ code: 'auth_invalid', status: 401 })
  })

  it('maps anything else to provider_error and aborts without status to an aborted message', () => {
    expect(defaultProviderError('weird', OPTIONS)).toMatchObject({ code: 'provider_error', message: 'Acme returned an error.' })
    expect(defaultProviderError(new DOMException('stop', 'AbortError'), OPTIONS)).toMatchObject({ code: 'provider_error', message: 'The request to Acme was aborted.' })
  })

  it('never copies keys into the message or the upstream excerpt', () => {
    const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'
    const body = { error: { message: `Incorrect API key provided: ${key}. You can find your API key at https://platform.test/keys.` } }
    const mapped = defaultProviderError(apiError(401, body), { ...OPTIONS, redactText: text => text.replaceAll('custom-secret', '[redacted]') })
    expect(JSON.stringify(mapped)).not.toContain(key)
    expect(JSON.stringify(mapped)).not.toContain('abcdefghijklmnop')
    expect(mapped.message).toBe('Acme rejected the credentials (HTTP 401). Check the API key in Settings > Providers.')
  })
})

describe('helpers', () => {
  it('parses retry-after headers', () => {
    const now = Date.parse('2026-09-28T00:00:00Z')
    expect(retryAfterMs({ 'retry-after-ms': '1500' }, now)).toBe(1500)
    expect(retryAfterMs({ 'retry-after': '2.5' }, now)).toBe(2500)
    expect(retryAfterMs({ 'retry-after': 'Mon, 28 Sep 2026 00:00:10 GMT' }, now)).toBe(10_000)
    expect(retryAfterMs({ 'retry-after': 'soon' }, now)).toBeUndefined()
    expect(retryAfterMs({}, now)).toBeUndefined()
  })

  it('redacts and truncates upstream text', () => {
    expect(redactUpstream('Bearer abc.def  and   gsk_1234567890abcdef')).toBe('Bearer [redacted] and [redacted]')
    expect(redactUpstream('x'.repeat(10).concat(' ', 'y '.repeat(400))).length).toBeLessThanOrEqual(300)
    expect(redactUpstream('my custom-secret here', text => text.replace('custom-secret', '[redacted]'))).toBe('my [redacted] here')
  })
})
