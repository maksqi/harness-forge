// Auth routes (W1.1-T4, API.md 5.2): status, login + rate limit, logout, password set / change / remove.
import type { AuthStatus } from '@harness-forge/shared'
import type { TestApp, TestRequestOptions } from '../../testing/create-test-app.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authStatusSchema, harnessErrorEnvelopeSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createMemorySecretStore, createMemorySettingsService } from '../../testing/fakes.ts'
import { FRESH_AUTH_REQUIRED_MESSAGE } from '../middleware/fresh-auth.ts'
import { SESSION_COOKIE_NAME } from '../middleware/session-auth.ts'
import { FRESH_AUTH_WINDOW_MS } from '../types.ts'
import { INVALID_PASSWORD_MESSAGE } from './auth.ts'

const ENV_PASSWORD = 'env password 123'
const MINUTE = 60_000

const apps: TestApp[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
})

async function testApp(env: Record<string, string> = {}): Promise<TestApp> {
  const t = await createTestApp({
    env,
    start: false,
    overrides: { secrets: createMemorySecretStore(), settings: createMemorySettingsService() },
  })
  apps.push(t)
  return t
}

function sessionCookie(response: Response): string | null {
  return response.headers.getSetCookie().find(cookie => cookie.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? null
}

function tokenOf(response: Response): string {
  return sessionCookie(response)?.split(';')[0]?.slice(SESSION_COOKIE_NAME.length + 1) ?? ''
}

function withCookie(token: string | undefined): Record<string, string> {
  return token === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${token}` }
}

async function errorOf(response: Response) {
  return harnessErrorEnvelopeSchema.parse(await response.json()).error
}

async function statusOf(response: Response): Promise<AuthStatus> {
  return authStatusSchema.parse(await response.json())
}

function login(t: TestApp, password: string, options: TestRequestOptions = {}): Promise<Response> {
  return t.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  }, options)
}

function setPassword(t: TestApp, body: unknown, token?: string): Promise<Response> {
  return t.request('/api/auth/password', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...withCookie(token) },
    body: JSON.stringify(body),
  })
}

function authStatus(t: TestApp, token?: string): Promise<AuthStatus> {
  return t.request('/api/auth/status', { headers: withCookie(token) }).then(statusOf)
}

describe('without a password', () => {
  it('gET /auth/status: enabled false, authenticated true', async () => {
    const t = await testApp()
    expect(await authStatus(t)).toEqual({ enabled: false, authenticated: true, source: null, freshUntil: null })
  })

  it('pOST /auth/login answers the disabled status without a cookie', async () => {
    const t = await testApp()
    const response = await login(t, 'anything')
    expect(response.status).toBe(200)
    expect(await statusOf(response)).toEqual({ enabled: false, authenticated: true, source: null, freshUntil: null })
    expect(sessionCookie(response)).toBeNull()
  })
})

describe('login with HF_PASSWORD', () => {
  it('reports the env password and no session', async () => {
    const t = await testApp({ HF_PASSWORD: ENV_PASSWORD })
    expect(await authStatus(t)).toEqual({ enabled: true, authenticated: false, source: 'env', freshUntil: null })
  })

  it('a wrong password -> 401 unauthorized "Invalid password", no cookie', async () => {
    const t = await testApp({ HF_PASSWORD: ENV_PASSWORD })
    const response = await login(t, 'wrong password')
    expect(response.status).toBe(401)
    expect(await errorOf(response)).toEqual({ code: 'unauthorized', message: INVALID_PASSWORD_MESSAGE })
    expect(sessionCookie(response)).toBeNull()
  })

  it('the right password -> 200 AuthStatus + hf_session, fresh for 10 minutes', async () => {
    const t = await testApp({ HF_PASSWORD: ENV_PASSWORD })
    const before = Date.now()
    const response = await login(t, ENV_PASSWORD)
    expect(response.status).toBe(200)
    const status = await statusOf(response)
    expect(status).toMatchObject({ enabled: true, authenticated: true, source: 'env' })
    expect(status.freshUntil).toBeGreaterThanOrEqual(before + FRESH_AUTH_WINDOW_MS)
    expect(status.freshUntil).toBeLessThanOrEqual(Date.now() + FRESH_AUTH_WINDOW_MS)

    const token = tokenOf(response)
    expect(await authStatus(t, token)).toEqual({ enabled: true, authenticated: true, source: 'env', freshUntil: status.freshUntil })
  })

  it('validates the body', async () => {
    const t = await testApp({ HF_PASSWORD: ENV_PASSWORD })
    for (const body of [{}, { password: '' }, { password: ENV_PASSWORD, extra: true }, { password: 'x'.repeat(1025) }]) {
      const response = await t.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      expect(response.status, JSON.stringify(body)).toBe(400)
      expect((await errorOf(response)).code).toBe('validation_error')
    }
  })

  it('never logs the password', async () => {
    const t = await testApp({ HF_PASSWORD: ENV_PASSWORD })
    await login(t, 'a guessed password 42')
    await login(t, ENV_PASSWORD)
    const logs = t.logs.text()
    expect(logs).not.toContain('a guessed password 42')
    expect(logs).not.toContain(ENV_PASSWORD)
    expect(logs).toContain('password check failed')
  })
})

describe('login rate limit', () => {
  it('5 failures per address -> 429 rate_limited with Retry-After, even for the right password', async () => {
    const t = await testApp({ HF_PASSWORD: ENV_PASSWORD })
    for (let i = 0; i < 5; i += 1)
      expect((await login(t, `wrong ${i}`)).status).toBe(401)
    const blocked = await login(t, ENV_PASSWORD)
    expect(blocked.status).toBe(429)
    const error = await errorOf(blocked)
    expect(error).toMatchObject({ code: 'rate_limited', action: 'retry' })
    expect(error.retryAfterMs).toBeGreaterThan(14 * MINUTE)
    expect(error.retryAfterMs).toBeLessThanOrEqual(15 * MINUTE)
    expect(Number(blocked.headers.get('retry-after'))).toBe(Math.ceil((error.retryAfterMs ?? 0) / 1000))
    expect(sessionCookie(blocked)).toBeNull()

    // Another address is not affected.
    expect((await login(t, ENV_PASSWORD, { remoteAddress: '192.168.1.20' })).status).toBe(200)
  })

  it('a successful login resets the address', async () => {
    const t = await testApp({ HF_PASSWORD: ENV_PASSWORD })
    for (let i = 0; i < 4; i += 1)
      await login(t, `wrong ${i}`)
    expect((await login(t, ENV_PASSWORD)).status).toBe(200)
    for (let i = 0; i < 5; i += 1)
      expect((await login(t, `wrong again ${i}`)).status).toBe(401)
    expect((await login(t, ENV_PASSWORD)).status).toBe(429)
  })
})

describe('logout', () => {
  it('pOST /auth/logout -> 204 and clears the cookie (idempotent)', async () => {
    const t = await testApp({ HF_PASSWORD: ENV_PASSWORD })
    const token = tokenOf(await login(t, ENV_PASSWORD))
    for (const headers of [withCookie(token), {}]) {
      const response = await t.request('/api/auth/logout', { method: 'POST', headers })
      expect(response.status).toBe(204)
      expect(await response.text()).toBe('')
      expect(sessionCookie(response)).toBe(`${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`)
    }
  })
})

describe('pUT /auth/password', () => {
  it('sets the first password without a login and starts a fresh session for the caller', async () => {
    const t = await testApp()
    const response = await setPassword(t, { newPassword: 'first password' })
    expect(response.status).toBe(200)
    const status = await statusOf(response)
    expect(status).toMatchObject({ enabled: true, authenticated: true, source: 'settings' })
    expect(status.freshUntil).toBeGreaterThan(Date.now())

    const token = tokenOf(response)
    expect(await authStatus(t, token)).toMatchObject({ enabled: true, authenticated: true, source: 'settings' })
    expect(await authStatus(t)).toEqual({ enabled: true, authenticated: false, source: 'settings', freshUntil: null })
    expect((await t.request('/api/settings')).status).toBe(401)
    expect((await login(t, 'first password')).status).toBe(200)
  })

  it('changes the password: requires the current one; every other session ends', async () => {
    const t = await testApp()
    const first = tokenOf(await setPassword(t, { newPassword: 'first password' }))
    const other = tokenOf(await login(t, 'first password'))

    const missing = await setPassword(t, { newPassword: 'second password' }, first)
    expect(missing.status).toBe(403)
    expect(await errorOf(missing)).toMatchObject({ code: 'forbidden' })
    expect((await errorOf(await setPassword(t, { newPassword: 'second password' }, first))).action).toBeUndefined()

    const wrong = await setPassword(t, { currentPassword: 'not it', newPassword: 'second password' }, first)
    expect(wrong.status).toBe(403)
    expect((await errorOf(wrong)).message).toMatch(/current password is incorrect/)

    const changed = await setPassword(t, { currentPassword: 'first password', newPassword: 'second password' }, first)
    expect(changed.status).toBe(200)
    const caller = tokenOf(changed)
    expect(await authStatus(t, caller)).toMatchObject({ authenticated: true, source: 'settings' })
    expect(await authStatus(t, first)).toMatchObject({ authenticated: false })
    expect(await authStatus(t, other)).toMatchObject({ authenticated: false })
    expect((await login(t, 'first password')).status).toBe(401)
    expect((await login(t, 'second password')).status).toBe(200)
  })

  it('removes the password (newPassword null): every request is authenticated again', async () => {
    const t = await testApp()
    const token = tokenOf(await setPassword(t, { newPassword: 'first password' }))
    const response = await setPassword(t, { currentPassword: 'first password', newPassword: null }, token)
    expect(response.status).toBe(200)
    expect(await statusOf(response)).toEqual({ enabled: false, authenticated: true, source: null, freshUntil: null })
    expect(sessionCookie(response)).toMatch(/^hf_session=; Max-Age=0;/)
    expect(await authStatus(t)).toEqual({ enabled: false, authenticated: true, source: null, freshUntil: null })
    expect((await t.request('/api/settings')).status).not.toBe(401)
  })

  it('needs fresh auth: a session older than 10 minutes -> 403 forbidden (action login)', async () => {
    const t = await testApp()
    await setPassword(t, { newPassword: 'first password' })
    const stale = await t.deps.sessions.issue({ authAt: Date.now() - 11 * MINUTE })
    const response = await setPassword(t, { currentPassword: 'first password', newPassword: 'second password' }, stale)
    expect(response.status).toBe(403)
    expect(await errorOf(response)).toEqual({ code: 'forbidden', message: FRESH_AUTH_REQUIRED_MESSAGE, action: 'login' })
    // The web logs in again (password prompt) and retries with the fresh cookie.
    const fresh = tokenOf(await login(t, 'first password'))
    expect((await setPassword(t, { currentPassword: 'first password', newPassword: 'second password' }, fresh)).status).toBe(200)
  })

  it('409 conflict (env-password) while HF_PASSWORD is set', async () => {
    const t = await testApp({ HF_PASSWORD: ENV_PASSWORD })
    const token = tokenOf(await login(t, ENV_PASSWORD))
    const response = await setPassword(t, { currentPassword: ENV_PASSWORD, newPassword: 'another password' }, token)
    expect(response.status).toBe(409)
    expect(await errorOf(response)).toMatchObject({ code: 'conflict', details: { reason: 'env-password' } })
  })

  it('409 conflict (insecure-bind) when removing the password on a non-loopback bind without HF_INSECURE=1', async () => {
    const t = await testApp({ HF_HOST: '0.0.0.0' })
    const token = tokenOf(await setPassword(t, { newPassword: 'first password' }))
    const response = await setPassword(t, { currentPassword: 'first password', newPassword: null }, token)
    expect(response.status).toBe(409)
    expect(await errorOf(response)).toMatchObject({ code: 'conflict', details: { reason: 'insecure-bind' } })
    // Changing it is fine.
    expect((await setPassword(t, { currentPassword: 'first password', newPassword: 'second password' }, token)).status).toBe(200)

    const insecure = await testApp({ HF_HOST: '0.0.0.0', HF_INSECURE: '1' })
    const insecureToken = tokenOf(await setPassword(insecure, { newPassword: 'first password' }))
    expect((await setPassword(insecure, { currentPassword: 'first password', newPassword: null }, insecureToken)).status).toBe(200)
  })

  it('wrong current passwords count toward the login rate limit', async () => {
    const t = await testApp()
    const token = tokenOf(await setPassword(t, { newPassword: 'first password' }))
    for (let i = 0; i < 5; i += 1)
      expect((await setPassword(t, { currentPassword: `guess ${i}`, newPassword: 'second password' }, token)).status).toBe(403)
    expect((await setPassword(t, { currentPassword: 'first password', newPassword: 'second password' }, token)).status).toBe(429)
    expect((await login(t, 'first password')).status).toBe(429)
  })

  it('validates the body (new password 8..1024 characters, strict)', async () => {
    const t = await testApp()
    for (const body of [{ newPassword: 'short' }, {}, { newPassword: 'long enough', extra: 1 }]) {
      const response = await setPassword(t, body)
      expect(response.status, JSON.stringify(body)).toBe(400)
    }
  })
})

describe('with the real secrets and settings services', () => {
  it('stores the hash encrypted, persists the session epoch and survives a restart on the same database', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harness-forge-auth-'))
    const databasePath = join(dataDir, 'harness.db')
    try {
      const first = await createTestApp({ dataDir, databasePath, start: false })
      let firstToken = ''
      try {
        const response = await setPassword(first, { newPassword: 'persisted password' })
        expect(response.status).toBe(200)
        firstToken = tokenOf(response)
        const stored = await first.database.client.execute('SELECT scope, name FROM secrets WHERE scope = \'auth\'')
        expect(stored.rows).toHaveLength(1)
        const raw = JSON.stringify((await first.database.client.execute('SELECT * FROM secrets')).rows)
        expect(raw).not.toContain('persisted password')
        expect(raw).not.toContain('scrypt$')
        const changed = await setPassword(first, { currentPassword: 'persisted password', newPassword: 'second password' }, firstToken)
        expect(changed.status).toBe(200)
        expect(await authStatus(first, firstToken)).toMatchObject({ authenticated: false })
        firstToken = tokenOf(changed)
      }
      finally {
        await first.close()
      }

      const second = await createTestApp({ dataDir, databasePath, start: false })
      try {
        expect(await authStatus(second)).toEqual({ enabled: true, authenticated: false, source: 'settings', freshUntil: null })
        // Same (fake) keyring and the persisted epoch: the session of the first process is still valid.
        expect(await authStatus(second, firstToken)).toMatchObject({ authenticated: true })
        expect((await login(second, 'persisted password')).status).toBe(401)
        expect((await login(second, 'second password')).status).toBe(200)
      }
      finally {
        await second.close()
      }
    }
    finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
