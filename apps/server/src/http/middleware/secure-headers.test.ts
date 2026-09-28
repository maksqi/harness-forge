// Secure headers (W1.1-T7, ARCHITECTURE.md 10.2, SEC-B2/C1/C2) and `X-Robots-Tag` on every response (C8-T5, ADR-025).
import type { TestApp } from '../../testing/create-test-app.ts'
import type { AppEnv } from '../types.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { API_CSP, SECURITY_HEADERS } from '../../security/headers.ts'
import { SAMPLE_SHARE_TOKEN } from '../../testing/api-samples.ts'
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

const ROBOTS = 'noindex, nofollow'
const SPA_HTML = '<!DOCTYPE html><html><head><title>spa</title><script>window.a = 1</script></head><body><div id="__nuxt"></div></body></html>'

describe('x-Robots-Tag: noindex, nofollow on every response (ADR-025)', () => {
  let webRoot: string
  let web: TestApp

  beforeAll(async () => {
    webRoot = mkdtempSync(join(tmpdir(), 'harness-forge-robots-'))
    writeFileSync(join(webRoot, 'index.html'), SPA_HTML)
    writeFileSync(join(webRoot, '200.html'), SPA_HTML)
    mkdirSync(join(webRoot, '_nuxt'))
    writeFileSync(join(webRoot, '_nuxt', 'app.js'), 'console.log("app")\n')
    web = await createTestApp({
      env: { HF_WEB_DIR: webRoot },
      start: false,
      overrides: { secrets: createMemorySecretStore(), settings: createMemorySettingsService() },
    })
  })

  afterAll(async () => {
    await web.close()
    rmSync(webRoot, { recursive: true, force: true })
  })

  it('is part of the security headers', () => {
    expect(SECURITY_HEADERS['X-Robots-Tag']).toBe(ROBOTS)
  })

  it('is on API responses: JSON, error envelopes and the public share routes', async () => {
    const health = await web.request('/api/health')
    expect(health.status).toBe(200)
    expect(health.headers.get('x-robots-tag')).toBe(ROBOTS)

    const missing = await web.request('/api/nope', { headers: { accept: 'application/json' } })
    expect(missing.status).toBe(404)
    expect(missing.headers.get('x-robots-tag')).toBe(ROBOTS)

    for (const path of [`/api/share/${SAMPLE_SHARE_TOKEN}`, `/api/share/${SAMPLE_SHARE_TOKEN}/files/file_sample0000000001`]) {
      const response = await web.request(path)
      expect(response.status, path).toBeGreaterThanOrEqual(400)
      expect(response.headers.get('x-robots-tag'), path).toBe(ROBOTS)
    }
  })

  it('is on SPA responses: the documents, deep links such as the share page, and static assets', async () => {
    const html = { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }
    for (const path of ['/', `/share/${SAMPLE_SHARE_TOKEN}`, '/settings/data']) {
      const response = await web.request(path, { headers: html })
      expect(response.status, path).toBe(200)
      expect(response.headers.get('content-type'), path).toMatch(/^text\/html/)
      expect(await response.text(), path).toContain('<div id="__nuxt">')
      expect(response.headers.get('x-robots-tag'), path).toBe(ROBOTS)
      expectSecurityHeaders(response)
    }
    const head = await web.request(`/share/${SAMPLE_SHARE_TOKEN}`, { method: 'HEAD', headers: html })
    expect(head.headers.get('x-robots-tag')).toBe(ROBOTS)

    const asset = await web.request('/_nuxt/app.js')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('x-robots-tag')).toBe(ROBOTS)

    const missingAsset = await web.request('/_nuxt/missing.js')
    expect(missingAsset.status).toBe(404)
    expect(missingAsset.headers.get('x-robots-tag')).toBe(ROBOTS)
  })

  it('keeps a value set by the route', async () => {
    const custom = new Hono<AppEnv>()
    custom.use('*', secureHeadersMiddleware(web.deps))
    custom.get('/api/own-robots', c => c.json({ ok: true }, 200, { 'X-Robots-Tag': 'none' }))
    expect((await custom.request('/api/own-robots')).headers.get('x-robots-tag')).toBe('none')
  })
})
