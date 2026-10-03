// Session authentication (W1.1-T5): the route-table-driven 401 matrix (SEC-A1), cookie verification (tampered,
// expired, revoked), rolling re-issue and cookie attributes (SEC-A2).
import type { ApiRouteDef, ApiRouteKey } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import { API_ROUTE_KEYS, apiRoutes, harnessErrorEnvelopeSchema } from '@harness-forge/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { API_SAMPLES, sampleRequest } from '../../testing/api-samples.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createMemorySecretStore, createMemorySettingsService } from '../../testing/fakes.ts'
import {
  isLocalHostname,
  LOCAL_HOST_ONLY_MESSAGE,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
  SESSION_ROLL_AFTER_MS,
  UNAUTHORIZED_MESSAGE,
} from './session-auth.ts'

/** The password of the `auth.login` sample, so the public login route answers 200 in the matrix. */
const PASSWORD = (API_SAMPLES['auth.login'].body as { password: string }).password
const DAY = 24 * 60 * 60 * 1000

const apps: TestApp[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
})

async function testApp(env: Record<string, string> = { HF_PASSWORD: PASSWORD }): Promise<TestApp> {
  const t = await createTestApp({
    env,
    start: false,
    overrides: { secrets: createMemorySecretStore(), settings: createMemorySettingsService() },
  })
  apps.push(t)
  return t
}

function sessionCookieOf(response: Response): string | null {
  for (const cookie of response.headers.getSetCookie()) {
    if (cookie.startsWith(`${SESSION_COOKIE_NAME}=`))
      return cookie
  }
  return null
}

function tokenOf(setCookie: string | null): string {
  return setCookie?.split(';')[0]?.slice(SESSION_COOKIE_NAME.length + 1) ?? ''
}

function cookieHeader(token: string): Record<string, string> {
  return { cookie: `${SESSION_COOKIE_NAME}=${token}` }
}

async function errorOf(response: Response) {
  return harnessErrorEnvelopeSchema.parse(await response.json()).error
}

describe('without a password', () => {
  it('every request is authenticated and cookies are ignored', async () => {
    const t = await testApp({})
    const response = await t.request('/api/auth/status', { headers: cookieHeader('garbage') })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ enabled: false, authenticated: true, source: null, freshUntil: null })
    expect(sessionCookieOf(response)).toBeNull()
  })
})

describe('without a password: DNS rebinding guard (only local host names)', () => {
  const REBOUND = { host: 'rebind.attacker.example:8787' }

  it.each([
    ['GET', '/api/settings'],
    ['GET', '/api/health'],
    ['GET', '/api/auth/status'],
    ['GET', '/api/events'],
  ])('%s %s for a foreign host name -> 403 forbidden', async (method, path) => {
    const t = await testApp({})
    const response = await t.request(path, { method, headers: REBOUND })
    expect(response.status).toBe(403)
    expect(await errorOf(response)).toEqual({ code: 'forbidden', message: LOCAL_HOST_ONLY_MESSAGE })
  })

  it('a rebound page is same-origin with itself: it passes the Origin check and is still refused', async () => {
    const t = await testApp({})
    const install = await t.request('/api/plugins/install', {
      method: 'POST',
      headers: { ...REBOUND, 'origin': 'http://rebind.attacker.example:8787', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'npm', spec: 'evil-plugin', trust: true }),
    })
    expect(install.status).toBe(403)
    expect((await errorOf(install)).message).toBe(LOCAL_HOST_ONLY_MESSAGE)
  })

  it.each(['localhost:8787', '127.0.0.1:8787', '127.8.9.10', '[::1]:8787', 'LOCALHOST.:8787', 'app.localhost:3000'])('host %s is local and authenticated', async (host) => {
    const t = await testApp({})
    const response = await t.request('/api/auth/status', { headers: { host } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ enabled: false, authenticated: true })
  })

  it('no Host header: the request URL host counts (in-process requests)', async () => {
    const t = await testApp({})
    expect((await t.request('/api/settings')).status).toBe(200)
  })

  it('hF_INSECURE=1 or a password lets other host names through (LAN, reverse proxy, tunnel)', async () => {
    const insecure = await testApp({ HF_INSECURE: '1' })
    expect((await insecure.request('/api/settings', { headers: REBOUND })).status).toBe(200)
    const protectedApp = await testApp()
    const anonymous = await protectedApp.request('/api/settings', { headers: { host: 'harness.example.com' } })
    expect(anonymous.status).toBe(401)
    const token = await protectedApp.deps.sessions.issue({ authAt: Date.now() })
    const withSession = await protectedApp.request('/api/settings', { headers: { host: 'harness.example.com', ...cookieHeader(token) } })
    expect(withSession.status).toBe(200)
  })

  it('isLocalHostname', () => {
    for (const name of ['localhost', 'localhost.', 'a.b.localhost', '127.0.0.1', '127.255.0.9', '::1', '[::1]', '::ffff:127.0.0.1'])
      expect(isLocalHostname(name), name).toBe(true)
    for (const name of ['example.com', 'localhost.example.com', '127.0.0.1.nip.io', '0.0.0.0', '::', '10.0.0.1', '192.168.1.2', 'localhost0', ''])
      expect(isLocalHostname(name), name).toBe(false)
  })
})

describe('with a password and no session', () => {
  let shared: TestApp

  beforeAll(async () => {
    shared = await createTestApp({
      env: { HF_PASSWORD: PASSWORD },
      start: false,
      overrides: { secrets: createMemorySecretStore(), settings: createMemorySettingsService() },
    })
  })

  afterAll(async () => {
    await shared.close()
  })

  const PUBLIC_KEYS = API_ROUTE_KEYS.filter(key => (apiRoutes[key] as ApiRouteDef).public === true)
  const PRIVATE_KEYS = API_ROUTE_KEYS.filter(key => (apiRoutes[key] as ApiRouteDef).public !== true)

  it('the public routes are exactly the ones of ARCHITECTURE.md 10.1', () => {
    expect(PUBLIC_KEYS.sort()).toEqual(['auth.login', 'auth.logout', 'auth.status', 'health.get', 'icons.get', 'icons.list', 'shares.file', 'shares.view'])
    // Phase 6: dictation, read-aloud (ADR-029) and deleting a version (ADR-030) need a session; Phase 7: projects
    // (ADR-031), the master key (ADR-034) and the file cleanup (ADR-035) too.
    expect(PRIVATE_KEYS).toEqual(expect.arrayContaining(['audio.transcribe', 'audio.speech', 'chats.deleteMessage']))
    expect(PRIVATE_KEYS).toEqual(expect.arrayContaining([
      'projects.list',
      'projects.create',
      'projects.update',
      'projects.remove',
      'projects.browse',
      'keys.get',
      'keys.rotate',
      'data.cleanupPreview',
      'data.cleanup',
    ]))
  })

  it.each(PRIVATE_KEYS)('%s answers 401 unauthorized (action login)', async (key: ApiRouteKey) => {
    const { path, init } = sampleRequest(key)
    const response = await shared.request(path, init)
    expect(response.status).toBe(401)
    expect(await errorOf(response)).toEqual({ code: 'unauthorized', message: UNAUTHORIZED_MESSAGE, action: 'login' })
  })

  it.each(PUBLIC_KEYS)('%s stays reachable', async (key: ApiRouteKey) => {
    const { path, init } = sampleRequest(key)
    const response = await shared.request(path, init)
    expect(response.status).not.toBe(401)
  })

  it.each([
    ['GET', '/api/nope'],
    ['GET', '/api'],
    ['DELETE', '/api/health'],
    ['OPTIONS', '/api/settings'],
  ])('unknown route %s %s answers 401 (no route enumeration)', async (method, path) => {
    const response = await shared.request(path, { method })
    expect(response.status).toBe(401)
  })

  it.each([
    '/api/%73ettings',
    '/api/settings/',
    '/api//settings',
    '/api/Settings',
    '/api/auth/status/../../settings',
    '/api/auth/%2e%2e/settings',
    '/api/auth%2fstatus',
    '/api/health/..%2fsettings',
    '/api/icons/lobe/..%2f..%2fsettings',
    '/api/icons/lobe/%2e%2e/%2e%2e/providers',
    '/api/chats%3F/x',
  ])('path confusion %s never reaches a private route without a session', async (path) => {
    const response = await shared.request(path)
    // Private routes answer 401; a public route may answer, but only as itself (the slug is refused).
    expect([400, 401, 404], path).toContain(response.status)
    const body = await response.text()
    expect(body).not.toContain('"displayName"')
    expect(body).not.toContain('"items"')
  })
})

describe('session cookie', () => {
  async function login(t: TestApp, headers: Record<string, string> = {}): Promise<Response> {
    return t.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ password: PASSWORD }),
    })
  }

  it('is set by login with HttpOnly, SameSite=Strict, Path=/ and a 30-day Max-Age', async () => {
    const t = await testApp()
    const cookie = sessionCookieOf(await login(t))
    expect(cookie).not.toBeNull()
    const attributes = (cookie ?? '').split('; ').slice(1)
    expect(attributes.sort()).toEqual(['HttpOnly', `Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`, 'Path=/', 'SameSite=Strict'])
    expect(SESSION_COOKIE_MAX_AGE_SECONDS).toBe(2_592_000)
  })

  it('is Secure over HTTPS (X-Forwarded-Proto: https counts)', async () => {
    const t = await testApp()
    const cookie = sessionCookieOf(await login(t, { 'x-forwarded-proto': 'https', 'origin': 'https://127.0.0.1:8787' }))
    expect(cookie?.split('; ')).toContain('Secure')
  })

  it('authenticates the protected routes', async () => {
    const t = await testApp()
    const token = tokenOf(sessionCookieOf(await login(t)))
    const status = await t.request('/api/auth/status', { headers: cookieHeader(token) })
    expect(await status.json()).toMatchObject({ enabled: true, authenticated: true, source: 'env' })
    const settings = await t.request('/api/settings', { headers: cookieHeader(token) })
    expect(settings.status).not.toBe(401)
  })

  it('rejects a modified, an expired and a revoked cookie', async () => {
    const t = await testApp()
    const token = tokenOf(sessionCookieOf(await login(t)))
    const [version, payload, signature] = token.split('.') as [string, string, string]
    const tampered = `${version}.${payload}.${signature.slice(0, -2)}${signature.endsWith('AA') ? 'BB' : 'AA'}`
    const expired = await t.deps.sessions.issue({ authAt: Date.now() - 40 * DAY, now: Date.now() - 31 * DAY })

    for (const candidate of [tampered, expired, 'v1.e30.AAAA', '']) {
      const response = await t.request('/api/settings', { headers: cookieHeader(candidate) })
      expect(response.status, candidate).toBe(401)
    }

    await t.deps.sessions.revokeAll()
    const revoked = await t.request('/api/settings', { headers: cookieHeader(token) })
    expect(revoked.status).toBe(401)
    expect(await t.request('/api/auth/status', { headers: cookieHeader(token) }).then(async r => r.json())).toMatchObject({ authenticated: false })
  })

  it('is re-issued with the same authAt when older than 24 hours (rolling)', async () => {
    const t = await testApp()
    const authAt = Date.now() - 3 * DAY
    const old = await t.deps.sessions.issue({ authAt, now: Date.now() - SESSION_ROLL_AFTER_MS - 60_000 })
    const response = await t.request('/api/auth/status', { headers: cookieHeader(old) })
    const rolled = tokenOf(sessionCookieOf(response))
    expect(rolled).not.toBe('')
    expect(rolled).not.toBe(old)
    const payload = await t.deps.sessions.verify(rolled)
    expect(payload?.authAt).toBe(authAt)
    expect(Date.now() - (payload?.iat ?? 0)).toBeLessThan(60_000)
    expect(sessionCookieOf(response)?.split('; ')).toContain('HttpOnly')

    const recent = await t.deps.sessions.issue({ authAt: Date.now() })
    expect(sessionCookieOf(await t.request('/api/auth/status', { headers: cookieHeader(recent) }))).toBeNull()
  })

  it('with HF_TRUST_PROXY the re-issued cookie is Secure only when a trusted proxy forwarded HTTPS (ADR-026)', async () => {
    const t = await testApp({ HF_PASSWORD: PASSWORD, HF_TRUST_PROXY: 'loopback' })
    const old = await t.deps.sessions.issue({ authAt: Date.now() - 2 * DAY, now: Date.now() - 2 * DAY })
    const headers = { ...cookieHeader(old), 'x-forwarded-proto': 'https' }
    const viaProxy = sessionCookieOf(await t.request('/api/auth/status', { headers }))
    expect(viaProxy?.split('; ')).toContain('Secure')
    const direct = sessionCookieOf(await t.request('/api/auth/status', { headers }, { remoteAddress: '203.0.113.7' }))
    expect(direct).not.toBeNull()
    expect(direct?.split('; ')).not.toContain('Secure')
  })

  it('a rolling re-issue never overrides the cookie cleared by logout', async () => {
    const t = await testApp()
    const old = await t.deps.sessions.issue({ authAt: Date.now() - 2 * DAY, now: Date.now() - 2 * DAY })
    const response = await t.request('/api/auth/logout', { method: 'POST', headers: cookieHeader(old) })
    expect(response.status).toBe(204)
    const cookies = response.headers.getSetCookie().filter(cookie => cookie.startsWith(`${SESSION_COOKIE_NAME}=`))
    expect(cookies).toHaveLength(1)
    expect(cookies[0]).toMatch(/^hf_session=; Max-Age=0;/)
  })
})
