// CSRF Origin check (W1.1-T6, ARCHITECTURE.md 10.2, SEC-B1/B2).
import type { TestApp } from '../../testing/create-test-app.ts'
import { harnessErrorEnvelopeSchema } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createMemorySecretStore, createMemorySettingsService } from '../../testing/fakes.ts'
import { CROSS_ORIGIN_MESSAGE, CROSS_SITE_MESSAGE } from './origin-check.ts'

let dev: TestApp
let production: TestApp
let protectedApp: TestApp

function options(env: Record<string, string>) {
  return { env, start: false, overrides: { secrets: createMemorySecretStore(), settings: createMemorySettingsService() } }
}

beforeAll(async () => {
  dev = await createTestApp(options({}))
  // A password, so requests for other host names (a reverse proxy) reach the Origin check (session-auth.ts).
  production = await createTestApp(options({ NODE_ENV: 'production', HF_PASSWORD: 'a password 123' }))
  protectedApp = await createTestApp(options({ HF_PASSWORD: 'a password 123' }))
})

afterAll(async () => {
  await Promise.all([dev.close(), production.close(), protectedApp.close()])
})

/** `POST /api/auth/logout`: public, no body, no side effects: 204 when the Origin check passes. */
function logout(t: TestApp, headers: Record<string, string>): Promise<Response> {
  return t.request('/api/auth/logout', { method: 'POST', headers })
}

async function expectForbidden(response: Response, message: string): Promise<void> {
  expect(response.status).toBe(403)
  expect(harnessErrorEnvelopeSchema.parse(await response.json()).error).toEqual({ code: 'forbidden', message })
  expect([...response.headers.keys()].filter(name => name.startsWith('access-control-'))).toEqual([])
}

describe('state-changing requests', () => {
  it.each([
    ['no Origin, no Sec-Fetch-Site (curl)', {}],
    ['the server origin', { origin: 'http://127.0.0.1:8787' }],
    ['a Host header that spells out the default port', { origin: 'http://harness.example.com', host: 'harness.example.com:80' }],
    ['an Origin with upper-case letters', { origin: 'http://HARNESS.example.com', host: 'harness.example.com' }],
    ['Sec-Fetch-Site same-origin', { 'sec-fetch-site': 'same-origin' }],
    ['Sec-Fetch-Site none (typed URL, bookmark)', { 'sec-fetch-site': 'none' }],
    ['the HTTPS origin behind a TLS proxy', { 'origin': 'https://harness.example.com', 'host': 'harness.example.com', 'x-forwarded-proto': 'https' }],
    ['a same-origin Origin with any Sec-Fetch-Site', { 'origin': 'http://127.0.0.1:8787', 'sec-fetch-site': 'cross-site' }],
  ])('pass: %s', async (_name, headers: Record<string, string>) => {
    expect((await logout(production, headers)).status).toBe(204)
  })

  it.each([
    ['a foreign Origin', { origin: 'https://evil.example' }],
    ['the opaque origin "null"', { origin: 'null' }],
    ['a malformed Origin', { origin: 'not a url' }],
    ['the same host on another port', { origin: 'http://127.0.0.1:9999' }],
    ['the same host over another scheme', { origin: 'https://127.0.0.1:8787' }],
    ['an Origin that does not match the Host header', { origin: 'http://127.0.0.1:8787', host: 'localhost:8787' }],
    ['plain HTTP behind a TLS proxy', { 'origin': 'http://harness.example.com', 'host': 'harness.example.com', 'x-forwarded-proto': 'https' }],
    ['the dev origin in production', { origin: 'http://localhost:3000' }],
  ])('403 forbidden: %s', async (_name, headers: Record<string, string>) => {
    await expectForbidden(await logout(production, headers), CROSS_ORIGIN_MESSAGE)
  })

  it.each(['cross-site', 'same-site', 'something-else'])('403 forbidden without Origin and Sec-Fetch-Site: %s', async (site) => {
    await expectForbidden(await logout(production, { 'sec-fetch-site': site }), CROSS_SITE_MESSAGE)
  })

  it.each(['http://localhost:3000', 'http://127.0.0.1:3000'])('development accepts the nuxt dev origin %s', async (origin) => {
    expect((await logout(dev, { origin })).status).toBe(204)
    await expectForbidden(await logout(dev, { origin: 'http://localhost:3001' }), CROSS_ORIGIN_MESSAGE)
  })

  it.each(['PUT', 'PATCH', 'DELETE'])('%s is checked too', async (method) => {
    await expectForbidden(await production.request('/api/settings', { method, headers: { origin: 'https://evil.example' } }), CROSS_ORIGIN_MESSAGE)
  })

  it('runs before authentication: a cross-site request never learns about the session', async () => {
    await expectForbidden(await logout(protectedApp, { origin: 'https://evil.example' }), CROSS_ORIGIN_MESSAGE)
    const settings = await protectedApp.request('/api/settings', { method: 'PUT', headers: { origin: 'https://evil.example' } })
    expect(settings.status).toBe(403)
  })
})

describe('safe methods', () => {
  it.each(['GET', 'HEAD'])('%s passes with any Origin', async (method) => {
    const response = await production.request('/api/health', { method, headers: { 'origin': 'https://evil.example', 'sec-fetch-site': 'cross-site' } })
    expect(response.status).toBe(200)
  })

  it('oPTIONS (a CORS preflight) never gets CORS headers', async () => {
    const response = await production.request('/api/settings', {
      method: 'OPTIONS',
      headers: { 'origin': 'https://evil.example', 'access-control-request-method': 'PUT' },
    })
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('access-control-allow-methods')).toBeNull()
    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})
