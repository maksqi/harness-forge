import type { TestApp } from '../testing/create-test-app.ts'
import { APICallError } from '@ai-sdk/provider'
import { HarnessError } from '@harness-forge/shared'
import { InvalidToolApprovalSignatureError, InvalidToolInputError, MissingToolResultsError, NoSuchToolError, RetryError } from 'ai'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mockAuthError } from '../builtin-plugins/mock/models.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { abortReason, errorEnvelopeText, isAbortError, isToolCallError, mapRunError, preStreamError, toolErrorText, ToolFailure } from './errors.ts'

let t: TestApp

beforeAll(async () => {
  t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
})

afterAll(async () => {
  await t.close()
})

function apiError(statusCode: number, body: unknown = { error: { message: 'upstream said no' } }, headers: Record<string, string> = {}): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'https://api.openai.com/v1/responses',
    requestBodyValues: {},
    statusCode,
    responseHeaders: headers,
    responseBody: JSON.stringify(body),
    isRetryable: statusCode >= 500 || statusCode === 429,
  })
}

function networkError(code: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ${code}`), { code }) })
}

describe('mapRunError: provider mapError first, then the default table', () => {
  it('uses provider.mapError when it handles the error (mock:error -> auth_invalid), also inside a RetryError', () => {
    const expected = { code: 'auth_invalid', status: 401, providerId: 'mock', action: 'configure-provider', message: 'Mock authentication failure' }
    expect(mapRunError(t.deps.providers, 'mock', mockAuthError()).toJSON().error).toMatchObject(expected)
    const retry = new RetryError({ message: 'failed', reason: 'maxRetriesExceeded', errors: [mockAuthError()] })
    expect(mapRunError(t.deps.providers, 'mock', retry).toJSON().error).toMatchObject(expected)
  })

  it.each([
    [apiError(401), { code: 'auth_invalid', status: 401, action: 'configure-provider' }],
    [apiError(403), { code: 'auth_invalid', status: 403, action: 'configure-provider' }],
    [apiError(429, {}, { 'retry-after': '7' }), { code: 'rate_limited', status: 429, retryAfterMs: 7000, action: 'retry' }],
    [apiError(404), { code: 'model_not_found', status: 404, action: 'refresh-models' }],
    [apiError(400, { error: { code: 'context_length_exceeded', message: 'too long' } }), { code: 'context_overflow', status: 400 }],
    [apiError(400, { error: { message: 'This model\'s maximum context length is 128000 tokens.' } }), { code: 'context_overflow' }],
    [networkError('ECONNREFUSED'), { code: 'provider_unreachable', action: 'retry' }],
    [networkError('ENOTFOUND'), { code: 'provider_unreachable' }],
    [apiError(500), { code: 'provider_error', status: 500, action: 'retry' }],
    [new Error('something odd'), { code: 'provider_error' }],
  ])('%s', (error, expected) => {
    const mapped = mapRunError(t.deps.providers, 'openai', error).toJSON().error
    expect(mapped).toMatchObject({ ...expected, providerId: 'openai' })
  })

  it('keeps HarnessErrors and maps local SDK errors without blaming the provider', () => {
    const own = new HarnessError({ code: 'plugin_error', message: 'x', details: { pluginId: 'demo' } })
    expect(mapRunError(t.deps.providers, 'openai', own)).toBe(own)
    const signature = new InvalidToolApprovalSignatureError({ approvalId: 'a', toolCallId: 'c', reason: 'invalid signature' })
    expect(mapRunError(t.deps.providers, 'openai', signature).code).toBe('validation_error')
    expect(mapRunError(t.deps.providers, 'openai', new MissingToolResultsError({ toolCallIds: ['c'] })).code).toBe('validation_error')
  })

  it('pre-stream errors keep the HarnessError status mapping (auth_invalid -> 502, never 401)', () => {
    expect(new HarnessError({ code: 'auth_invalid', message: 'x', status: 401 }).httpStatus).toBe(502)
    expect(preStreamError(new HarnessError({ code: 'provider_not_configured', message: 'x' }), 'req').httpStatus).toBe(400)
    const internal = preStreamError(new Error('secret detail'), 'req-1')
    expect(internal.toJSON().error).toEqual({ code: 'internal_error', message: 'An unexpected error occurred.', action: 'retry', details: { requestId: 'req-1' } })
  })
})

describe('error texts', () => {
  it('sends run errors as the envelope JSON', () => {
    const error = new HarnessError({ code: 'auth_invalid', message: 'Bad key', status: 401, providerId: 'openai', action: 'configure-provider' })
    expect(JSON.parse(errorEnvelopeText(error))).toEqual({ error: { code: 'auth_invalid', message: 'Bad key', status: 401, providerId: 'openai', action: 'configure-provider' } })
  })

  it('keeps tool errors as plain, redacted and capped text', () => {
    expect(isToolCallError(new ToolFailure('blocked'))).toBe(true)
    expect(isToolCallError('plain string')).toBe(true)
    expect(isToolCallError(new InvalidToolInputError({ toolName: 't', toolInput: '{}', cause: new Error('bad') }))).toBe(true)
    expect(isToolCallError(new NoSuchToolError({ toolName: 't' }))).toBe(true)
    expect(isToolCallError(apiError(500))).toBe(false)
    expect(toolErrorText(new ToolFailure('key sk-123 leaked'), text => text.replace('sk-123', '[redacted]'))).toBe('key [redacted] leaked')
    expect(toolErrorText(new ToolFailure(''), text => text)).toBe('The tool call failed.')
    expect(toolErrorText(new ToolFailure('x'.repeat(5000)), text => text)).toHaveLength(2003)
  })

  it('recognizes aborts', () => {
    expect(isAbortError(abortReason('stopped'))).toBe(true)
    expect(abortReason('stopped').message).toBe('stopped')
    expect(isAbortError(new Error('x'))).toBe(false)
  })
})
