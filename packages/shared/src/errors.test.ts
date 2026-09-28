import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  errorStatusByCode,
  flattenValidationIssues,
  HARNESS_ERROR_CODES,
  HarnessError,
  harnessErrorCodeSchema,
  harnessErrorEnvelopeSchema,
  harnessErrorInitSchema,
  isHarnessError,
  validationError,
} from './errors.ts'

describe('error codes', () => {
  it('has the 16 codes of DECISIONS.md, including not_implemented', () => {
    expect(HARNESS_ERROR_CODES).toHaveLength(16)
    expect(HARNESS_ERROR_CODES).toContain('not_implemented')
    expect(new Set(HARNESS_ERROR_CODES).size).toBe(16)
  })

  it('maps every code to the HTTP status of API.md table 2.2', () => {
    expect(Object.keys(errorStatusByCode).sort()).toEqual([...HARNESS_ERROR_CODES].sort())
    expect(errorStatusByCode).toMatchObject({
      validation_error: 400,
      unauthorized: 401,
      forbidden: 403,
      not_found: 404,
      conflict: 409,
      payload_too_large: 413,
      provider_not_configured: 400,
      auth_invalid: 502,
      rate_limited: 429,
      model_not_found: 404,
      context_overflow: 400,
      provider_unreachable: 502,
      provider_error: 502,
      plugin_error: 500,
      internal_error: 500,
      not_implemented: 501,
    })
  })

  it('rejects unknown codes', () => {
    expect(harnessErrorCodeSchema.safeParse('teapot').success).toBe(false)
    expect(harnessErrorEnvelopeSchema.safeParse({ error: { code: 'teapot', message: 'x' } }).success).toBe(false)
    expect(harnessErrorInitSchema.safeParse({ code: 'unauthorized', message: 'x', extra: 1 }).success).toBe(false)
  })
})

describe('the HarnessError class', () => {
  const full = {
    code: 'rate_limited',
    message: 'Slow down.',
    status: 429,
    providerId: 'openai',
    retryAfterMs: 1500,
    action: 'retry',
    details: { upstream: 'quota' },
  } as const

  it('round trips HarnessError -> JSON -> parse preserving every field', () => {
    const error = new HarnessError(full)
    const envelope = harnessErrorEnvelopeSchema.parse(JSON.parse(JSON.stringify(error)))
    expect(envelope).toEqual({ error: full })
    const again = HarnessError.from(JSON.stringify(error))
    expect(again.toJSON()).toEqual({ error: full })
    expect(again).toMatchObject(full)
  })

  it('derives httpStatus from the code, never from the upstream status', () => {
    expect(new HarnessError({ code: 'auth_invalid', message: 'Bad key', status: 401 }).httpStatus).toBe(502)
    expect(new HarnessError({ code: 'not_implemented', message: 'Stub' }).httpStatus).toBe(501)
  })

  it('omits undefined fields and never serializes requestId or cause', () => {
    const error = new HarnessError({ code: 'not_found', message: 'Nope' }, { requestId: 'req-1', cause: new Error('secret') })
    expect(error.toJSON()).toEqual({ error: { code: 'not_found', message: 'Nope' } })
    expect(Object.keys(error)).toEqual(['code', 'requestId'])
    expect(error.requestId).toBe('req-1')
    expect(JSON.stringify(error)).not.toContain('secret')
  })

  it('is an Error named HarnessError', () => {
    const error = new HarnessError({ code: 'forbidden', message: 'No' })
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('HarnessError')
    expect(String(error)).toBe('HarnessError: No')
    expect(isHarnessError(error)).toBe(true)
    expect(isHarnessError(new Error('x'))).toBe(false)
  })

  it('turns an unknown code into internal_error', () => {
    const error = new HarnessError({ code: 'teapot' as never, message: 'x' })
    expect(error.code).toBe('internal_error')
    expect(error.httpStatus).toBe(500)
  })
})

describe('normalizing errors with HarnessError.from', () => {
  it('returns a HarnessError as is', () => {
    const error = new HarnessError({ code: 'conflict', message: 'Busy' })
    expect(HarnessError.from(error)).toBe(error)
  })

  it('reads envelopes, inits and their JSON', () => {
    expect(HarnessError.from({ error: { code: 'not_found', message: 'Gone' } }).code).toBe('not_found')
    expect(HarnessError.from({ code: 'forbidden', message: 'No' }).code).toBe('forbidden')
    expect(HarnessError.from(' {"error":{"code":"unauthorized","message":"Login"}} ').code).toBe('unauthorized')
  })

  it('reads the AI SDK APICallError responseBody and in-stream error messages', () => {
    const body = JSON.stringify({ error: { code: 'provider_not_configured', message: 'Add a key', action: 'configure-provider' } })
    const apiCallError = Object.assign(new Error(body), { statusCode: 400, responseBody: body, url: '/api/chat' })
    expect(HarnessError.from(apiCallError).toJSON().error).toEqual({
      code: 'provider_not_configured',
      message: 'Add a key',
      action: 'configure-provider',
    })
    const streamError = new Error('{"error":{"code":"auth_invalid","message":"Invalid key","status":401}}')
    const error = HarnessError.from(streamError)
    expect(error.code).toBe('auth_invalid')
    expect(error.status).toBe(401)
    expect(error.cause).toBe(streamError)
  })

  it('reads a HarnessError created by another copy of the module', () => {
    const foreign = Object.assign(new Error('Too big'), { code: 'payload_too_large', details: { limitBytes: 5 }, requestId: 'r' })
    Object.defineProperty(foreign, 'name', { value: 'HarnessError' })
    const error = HarnessError.from(foreign)
    expect(error.code).toBe('payload_too_large')
    expect(error.details).toEqual({ limitBytes: 5 })
    expect(error.requestId).toBe('r')
  })

  it('never leaks the message of an unknown error', () => {
    const error = HarnessError.from(new Error('secret sk-123'))
    expect(error.code).toBe('internal_error')
    expect(JSON.stringify(error.toJSON())).not.toContain('sk-123')
    for (const input of [undefined, null, 42, 'plain text', '{not json', { message: 'x' }, { error: { code: 'teapot', message: 'x' } }])
      expect(HarnessError.from(input).code).toBe('internal_error')
  })

  it('does not accept foreign error bodies with extra keys', () => {
    const openAiStyle = '{"error":{"message":"The model does not exist","type":"invalid_request_error","param":null,"code":"model_not_found"}}'
    expect(HarnessError.from(new Error(openAiStyle)).code).toBe('internal_error')
  })
})

describe('validation errors', () => {
  it('flattens zod issues, including nested record key issues', () => {
    const schema = z.strictObject({
      name: z.string().max(3),
      values: z.record(z.string().regex(/^[a-z]+$/), z.string()),
    })
    const result = schema.safeParse({ name: 'toolong', values: { Bad1: 'x' }, extra: true })
    expect(result.success).toBe(false)
    const issues = flattenValidationIssues(result.error!)
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['name'], code: 'too_big' }),
      expect.objectContaining({ path: ['values', 'Bad1'], code: 'invalid_format' }),
      expect.objectContaining({ path: [], code: 'unrecognized_keys' }),
    ]))
  })

  it('builds a validation_error with details.issues and a readable message', () => {
    const result = z.object({ a: z.object({ b: z.number() }) }).safeParse({ a: { b: 'x' } })
    const error = validationError(result.error!)
    expect(error.code).toBe('validation_error')
    expect(error.httpStatus).toBe(400)
    expect(error.message).toMatch(/^a\.b: /)
    expect(error.details).toEqual({ issues: [expect.objectContaining({ path: ['a', 'b'], code: 'invalid_type' })] })
    expect(validationError([], 'Custom').message).toBe('Custom')
  })
})
