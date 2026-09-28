import type { TestApp } from '../testing/create-test-app.ts'
import type { AppEnv } from './types.ts'
import { errorStatusByCode, HARNESS_ERROR_CODES, HarnessError, harnessErrorEnvelopeSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createTestApp } from '../testing/create-test-app.ts'
import { accessLogMiddleware } from './middleware/access-log.ts'
import { createErrorHandler, INTERNAL_ERROR_MESSAGE, toHarnessError } from './middleware/error-handler.ts'
import { requestIdMiddleware } from './middleware/request-id.ts'
import { validate } from './validate.ts'

let t: TestApp
let app: Hono<AppEnv>

beforeAll(async () => {
  t = await createTestApp({ start: false })
  app = new Hono<AppEnv>()
  app.use('*', requestIdMiddleware(t.deps))
  app.use('*', accessLogMiddleware(t.deps))
  app.get('/harness/:code', (c) => {
    const code = c.req.param('code') as (typeof HARNESS_ERROR_CODES)[number]
    throw new HarnessError({ code, message: `Failure ${code}`, status: 401, providerId: 'openai' })
  })
  app.get('/rate-limited', () => {
    throw new HarnessError({ code: 'rate_limited', message: 'Slow down.', retryAfterMs: 1500 })
  })
  app.get('/crash', () => {
    throw new Error('database password is hunter2 and the key is sk-123')
  })
  app.get('/crash-async', async () => {
    await Promise.resolve()
    throw new TypeError('Cannot read properties of undefined (reading "sk-live-abcdef")')
  })
  app.get('/zod', () => {
    z.object({ name: z.string() }).parse({ name: 42 })
    return new Response('unreachable')
  })
  app.get('/http-exception/:status', (c) => {
    throw new HTTPException(Number(c.req.param('status')) as 400, { message: 'Malformed JSON in request body' })
  })
  app.post('/validated', validate('json', z.strictObject({ count: z.int().min(1) })), c => c.json({ ok: true }))
  app.get('/foreign-harness-error', () => {
    // A HarnessError created by another copy of the shared package (e.g. a plugin bundle).
    const foreign = Object.assign(new Error('Plugin says no.'), { name: 'HarnessError', code: 'plugin_error', details: { pluginId: 'x' } })
    throw foreign
  })
  app.onError(createErrorHandler(t.deps))
})

afterAll(async () => {
  await t.close()
})

async function envelopeOf(response: Response) {
  return harnessErrorEnvelopeSchema.parse(await response.json())
}

describe('onError: HarnessError', () => {
  it.each(HARNESS_ERROR_CODES)('%s -> HTTP errorStatusByCode, envelope kept (upstream status separate)', async (code) => {
    const response = await app.request(`/harness/${code}`)
    expect(response.status).toBe(errorStatusByCode[code])
    const { error } = await envelopeOf(response)
    const extra = code === 'internal_error' ? { details: { requestId: response.headers.get('x-request-id') } } : {}
    expect(error).toEqual({ code, message: `Failure ${code}`, status: 401, providerId: 'openai', ...extra })
    expect(response.headers.get('x-request-id')).toBeTruthy()
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('auth_invalid with an upstream 401 answers 502, never 401', async () => {
    const response = await app.request('/harness/auth_invalid')
    expect(response.status).toBe(502)
  })

  it('rate_limited sets Retry-After in whole seconds, rounded up', async () => {
    const response = await app.request('/rate-limited')
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('2')
    expect((await envelopeOf(response)).error.retryAfterMs).toBe(1500)
  })

  it('a HarnessError from another copy of the class keeps its code', async () => {
    const response = await app.request('/foreign-harness-error')
    expect(response.status).toBe(500)
    const { error } = await envelopeOf(response)
    expect(error.code).toBe('plugin_error')
    expect(error.details).toEqual({ pluginId: 'x' })
  })
})

describe('onError: unknown errors', () => {
  it.each(['/crash', '/crash-async'])('%s -> 500 internal_error without leaking the message', async (path) => {
    const response = await app.request(path, { headers: { 'x-request-id': 'req-crash-0001' } })
    expect(response.status).toBe(500)
    const text = await response.text()
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('sk-')
    const { error } = harnessErrorEnvelopeSchema.parse(JSON.parse(text))
    expect(error).toEqual({ code: 'internal_error', message: INTERNAL_ERROR_MESSAGE, details: { requestId: 'req-crash-0001' } })
  })

  it('logs the failure with the request id and redacts secrets from the log', async () => {
    await app.request('/crash', { headers: { 'x-request-id': 'req-crash-0002' } })
    const record = t.logs.records.find(entry => entry.level === 'error' && entry.reqId === 'req-crash-0002')
    expect(record).toBeDefined()
    expect(record?.msg).toBe('request failed')
    const logText = t.logs.text()
    expect(logText).not.toContain('sk-123')
    expect(logText).toContain('[redacted]')
  })
})

describe('onError: validation', () => {
  it('a thrown zod error -> 400 validation_error with flattened issues', async () => {
    const response = await app.request('/zod')
    expect(response.status).toBe(400)
    const { error } = await envelopeOf(response)
    expect(error.code).toBe('validation_error')
    expect(error.details).toEqual({ issues: [expect.objectContaining({ path: ['name'], code: 'invalid_type' })] })
  })

  it('validate() failures -> 400 validation_error with issues', async () => {
    const response = await app.request('/validated', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: 0, extra: true }),
    })
    expect(response.status).toBe(400)
    const { error } = await envelopeOf(response)
    expect(error.code).toBe('validation_error')
    const issues = (error.details as { issues: { path: unknown[] }[] }).issues
    expect(issues.map(issue => issue.path)).toEqual(expect.arrayContaining([['count']]))
  })

  it('validate() passes valid bodies through', async () => {
    const response = await app.request('/validated', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"count":2}' })
    expect(response.status).toBe(200)
  })
})

describe('onError: HTTPException', () => {
  it.each([
    [400, 'validation_error', 400],
    [401, 'unauthorized', 401],
    [403, 'forbidden', 403],
    [404, 'not_found', 404],
    [409, 'conflict', 409],
    [413, 'payload_too_large', 413],
    [429, 'rate_limited', 429],
    [415, 'validation_error', 400],
    [503, 'internal_error', 500],
  ] as const)('hTTP %i -> %s (%i)', async (status, code, httpStatus) => {
    const response = await app.request(`/http-exception/${status}`)
    expect(response.status).toBe(httpStatus)
    expect((await envelopeOf(response)).error.code).toBe(code)
  })
})

describe('toHarnessError', () => {
  it('returns HarnessErrors unchanged', () => {
    const error = new HarnessError({ code: 'conflict', message: 'Busy.', details: { reason: 'run-active' } })
    expect(toHarnessError(error, 'req')).toBe(error)
  })

  it('adds details.requestId to an internal_error without details', () => {
    const error = toHarnessError(new HarnessError({ code: 'internal_error', message: 'Index rebuild failed.' }), 'req-7')
    expect(error.toJSON().error).toEqual({ code: 'internal_error', message: 'Index rebuild failed.', details: { requestId: 'req-7' } })
  })

  it('never turns an arbitrary error message into an envelope', () => {
    const error = new Error(JSON.stringify({ error: { code: 'forbidden', message: 'Injected' } }))
    expect(toHarnessError(error, 'req-x').code).toBe('internal_error')
  })
})
