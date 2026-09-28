// Secure headers (W1.1-T7, ARCHITECTURE.md 10.2, SEC-B2/C1/C2).
import type { TestApp } from '../../testing/create-test-app.ts'
import type { AppEnv } from '../types.ts'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { API_CSP, SECURITY_HEADERS } from '../../security/headers.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createMemorySecretStore, createMemorySettingsService } from '../../testing/fakes.ts'
import { createErrorHandler } from './error-handler.ts'
import { requestIdMiddleware } from './request-id.ts'
import { secureHeadersMiddleware } from './secure-headers.ts'

let t: TestApp
let app: Hono<AppEnv>

beforeAll(async () => {
  t = await createTestApp({ start: false, overrides: { secrets: createMemorySecretStore(), settings: createMemorySettingsService() } })
  app = new Hono<AppEnv>()
  app.use('*', requestIdMiddleware(t.deps))
  app.use('*', secureHeadersMiddleware(t.deps))
  app.get('/api/own-headers', c => c.body('<svg/>', 200, {
    'Content-Type': 'image/svg+xml',
    'Content-Security-Policy': 'default-src \'none\'; style-src \'unsafe-inline\'',
    'Cache-Control': 'public, max-age=86400',
  }))
  app.get('/api/cors', c => c.json({ ok: true }, 200, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Credentials': 'true',
  }))
  // `Response.redirect()` has immutable headers: the middleware must still add its headers.
  app.get('/api/immutable', () => Response.redirect('http://127.0.0.1:8787/api/health', 302))
  app.get('/page', c => c.html('<p>page</p>'))
  app.get('/api/crash', () => {
    throw new Error('boom')
  })
  app.onError(createErrorHandler(t.deps))
})

afterAll(async () => {
  await t.close()
})

function expectSecurityHeaders(response: Response): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS))
    expect(response.headers.get(name), name).toBe(value)
}

describe('secure headers', () => {
  it('every API response gets the security headers, the API CSP and no-store', async () => {
    const response = await t.request('/api/health')
    expectSecurityHeaders(response)
    expect(response.headers.get('content-security-policy')).toBe(API_CSP)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('strict-transport-security')).toBeNull()
  })

  it('error envelopes too (API and non-API paths)', async () => {
    for (const path of ['/api/nope', '/definitely/not/here.json']) {
      const response = await t.request(path, { headers: { accept: 'application/json' } })
      expect(response.status).toBe(404)
      expectSecurityHeaders(response)
      expect(response.headers.get('content-security-policy')).toBe(API_CSP)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('x-request-id')).toBeTruthy()
    }
    const crash = await app.request('/api/crash')
    expect(crash.status).toBe(500)
    expectSecurityHeaders(crash)
  })

  it('hSTS only over HTTPS (X-Forwarded-Proto: https)', async () => {
    const https = await t.request('/api/health', { headers: { 'x-forwarded-proto': 'https' } })
    expect(https.headers.get('strict-transport-security')).toBe('max-age=31536000')
    const http = await t.request('/api/health', { headers: { 'x-forwarded-proto': 'http' } })
    expect(http.headers.get('strict-transport-security')).toBeNull()
  })

  it('keeps a CSP and Cache-Control set by the route (icons, files, SSE)', async () => {
    const response = await app.request('/api/own-headers')
    expect(response.headers.get('content-security-policy')).toBe('default-src \'none\'; style-src \'unsafe-inline\'')
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('never sends CORS headers, even when a route sets them', async () => {
    const response = await app.request('/api/cors', { headers: { origin: 'https://evil.example' } })
    expect(response.status).toBe(200)
    expect([...response.headers.keys()].filter(name => name.startsWith('access-control-'))).toEqual([])
  })

  it('works on responses with immutable headers', async () => {
    const response = await app.request('/api/immutable')
    expect(response.status).toBe(302)
    expectSecurityHeaders(response)
    expect(response.headers.get('x-request-id')).toBeTruthy()
  })

  it('does not put the API CSP on HTML pages (the SPA sets its own)', async () => {
    const response = await app.request('/page')
    expectSecurityHeaders(response)
    expect(response.headers.get('content-security-policy')).toBeNull()
  })
})
