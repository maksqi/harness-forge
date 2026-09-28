// Error envelope (W1.1-T1): unknown errors never leak their message; secrets are masked in responses and logs.
import type { TestApp } from '../../testing/create-test-app.ts'
import type { AppEnv } from '../types.ts'
import { HarnessError, harnessErrorEnvelopeSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import { accessLogMiddleware } from './access-log.ts'
import { createErrorHandler, INTERNAL_ERROR_MESSAGE } from './error-handler.ts'
import { requestIdMiddleware } from './request-id.ts'

let t: TestApp
let app: Hono<AppEnv>

beforeAll(async () => {
  t = await createTestApp({ start: false })
  t.deps.redactor.addSecret('registered-secret-value')
  app = new Hono<AppEnv>()
  app.use('*', requestIdMiddleware(t.deps))
  app.use('*', accessLogMiddleware(t.deps))
  app.get('/secret-error', () => {
    throw new Error('secret sk-123')
  })
  app.get('/harness-with-secret', () => {
    throw new HarnessError({
      code: 'provider_error',
      message: 'Upstream rejected key registered-secret-value',
      providerId: 'openai',
      details: { upstream: 'invalid api key sk-live-abcdef123456' },
    })
  })
  app.onError(createErrorHandler(t.deps))
})

afterAll(async () => {
  await t.close()
})

describe('error envelope', () => {
  it('a thrown Error("secret sk-123") -> internal_error; sk-123 is in neither the response nor the log', async () => {
    const response = await app.request('/secret-error', { headers: { 'x-request-id': 'req-w11-t1-accept' } })
    expect(response.status).toBe(500)
    const text = await response.text()
    expect(text).not.toContain('sk-123')
    expect(harnessErrorEnvelopeSchema.parse(JSON.parse(text)).error).toEqual({
      code: 'internal_error',
      message: INTERNAL_ERROR_MESSAGE,
      details: { requestId: 'req-w11-t1-accept' },
    })
    const logs = t.logs.text()
    expect(logs).not.toContain('sk-123')
    expect(t.logs.records.some(record => record.reqId === 'req-w11-t1-accept' && record.msg === 'request failed')).toBe(true)
    // The access log carries the request id and the status, never a body.
    expect(t.logs.records).toContainEqual(expect.objectContaining({ msg: 'request', reqId: 'req-w11-t1-accept', status: 500, path: '/secret-error' }))
  })

  it('masks registered secrets and key-like tokens in HarnessError messages and details.upstream', async () => {
    const response = await app.request('/harness-with-secret')
    expect(response.status).toBe(502)
    const text = await response.text()
    expect(text).not.toContain('registered-secret-value')
    expect(text).not.toContain('sk-live-abcdef123456')
    const { error } = harnessErrorEnvelopeSchema.parse(JSON.parse(text))
    expect(error).toMatchObject({ code: 'provider_error', providerId: 'openai', message: 'Upstream rejected key [redacted]' })
    expect(error.details).toEqual({ upstream: 'invalid api key [redacted]' })
  })

  it('the access log never contains query strings', async () => {
    await app.request('/secret-error?api_key=query-secret-123')
    expect(t.logs.text()).not.toContain('query-secret-123')
  })
})
