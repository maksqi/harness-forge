// Fresh auth (W1.1-T5, ADR-017, SEC-A5): route-table-driven 403 for every `fresh` route with a stale session, the
// 10-minute window, and the `requireFreshAuth(c)` helper for the conditional cases.
import type { ApiRouteDef, ApiRouteKey } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { AppEnv, RequestAuth } from '../types.ts'
import { API_ROUTE_KEYS, apiRoutes, harnessErrorEnvelopeSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { API_SAMPLES, sampleRequest } from '../../testing/api-samples.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createMemorySecretStore, createMemorySettingsService } from '../../testing/fakes.ts'
import { FRESH_AUTH_WINDOW_MS } from '../types.ts'
import { createErrorHandler } from './error-handler.ts'
import { FRESH_AUTH_REQUIRED_MESSAGE, freshAuthOptions, isFreshAuth, requireFreshAuth } from './fresh-auth.ts'
import { SESSION_COOKIE_NAME } from './session-auth.ts'

const PASSWORD = (API_SAMPLES['auth.login'].body as { password: string }).password
const MINUTE = 60_000
const FRESH_KEYS = API_ROUTE_KEYS.filter(key => (apiRoutes[key] as ApiRouteDef).fresh === true)

let t: TestApp

beforeAll(async () => {
  t = await createTestApp({
    env: { HF_PASSWORD: PASSWORD },
    start: false,
    overrides: { secrets: createMemorySecretStore(), settings: createMemorySettingsService() },
  })
})

afterAll(async () => {
  await t.close()
})

async function cookieFor(authAt: number): Promise<Record<string, string>> {
  return { cookie: `${SESSION_COOKIE_NAME}=${await t.deps.sessions.issue({ authAt })}` }
}

describe('fresh routes of the route table', () => {
  it('are the sensitive operations of ADR-017', () => {
    // The Phase 6 routes (audio, deleting a version) run no code and create nothing lasting: no fresh auth. Phase 7:
    // adding a project (file and shell access to a folder, ADR-031) and rotating the master key (ADR-034) need it;
    // browsing folders, editing or deleting a project and the file cleanup do not.
    expect(FRESH_KEYS.sort()).toEqual([
      'auth.setPassword',
      'data.deleteAll',
      'keys.rotate',
      'pluginFiles.build',
      'pluginFiles.scaffold',
      'pluginInstall.trust',
      'projects.create',
      'shares.create',
      'shares.update',
    ])
    expect(FRESH_AUTH_WINDOW_MS).toBe(10 * MINUTE)
  })

  it.each(FRESH_KEYS)('%s answers 403 forbidden (action login) with a stale session', async (key: ApiRouteKey) => {
    const { path, init } = sampleRequest(key, { headers: await cookieFor(Date.now() - 11 * MINUTE) })
    const response = await t.request(path, init)
    expect(response.status).toBe(403)
    const { error } = harnessErrorEnvelopeSchema.parse(await response.json())
    expect(error).toEqual({ code: 'forbidden', message: FRESH_AUTH_REQUIRED_MESSAGE, action: 'login' })
  })

  it('a session is fresh for 10 minutes after the password login', async () => {
    const body = JSON.stringify({ currentPassword: 'wrong password', newPassword: 'another password' })
    const request = async (authAt: number): Promise<Response> => t.request('/api/auth/password', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(await cookieFor(authAt)) },
      body,
    })
    // Fresh: the route itself answers (409, HF_PASSWORD is set), not the fresh-auth check.
    const fresh = await request(Date.now() - 9 * MINUTE)
    expect(fresh.status).toBe(409)
    const stale = await request(Date.now() - 10 * MINUTE - 5000)
    expect(stale.status).toBe(403)
  })

  it('non-fresh routes accept a stale session', async () => {
    const response = await t.request('/api/auth/status', { headers: await cookieFor(Date.now() - 60 * MINUTE) })
    expect(await response.json()).toMatchObject({ authenticated: true, freshUntil: expect.any(Number) })
  })
})

describe('requireFreshAuth(c)', () => {
  function appWith(auth: RequestAuth | undefined): Hono<AppEnv> {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      if (auth !== undefined)
        c.set('auth', auth)
      await next()
    })
    app.post('/direct', (c) => {
      requireFreshAuth(c)
      return c.text('ok')
    })
    app.post('/service', (c) => {
      // How routes hand the check to a service that decides about it (SensitiveOperationOptions).
      const options = freshAuthOptions(c)
      options.requireFreshAuth()
      return c.text('ok')
    })
    app.onError(createErrorHandler(t.deps))
    return app
  }

  const session = { iat: 0, exp: 0, authAt: 0, epoch: 0 }
  const now = Date.now()

  it.each([
    ['no password', { enabled: false, authenticated: true, source: null, session: null, freshUntil: null }, 200],
    ['fresh session', { enabled: true, authenticated: true, source: 'settings', session, freshUntil: now + MINUTE }, 200],
    ['stale session', { enabled: true, authenticated: true, source: 'settings', session, freshUntil: now - 1 }, 403],
    ['no session', { enabled: true, authenticated: false, source: 'env', session: null, freshUntil: null }, 403],
    ['auth not resolved (outside /api)', undefined, 403],
  ] as const)('%s -> %i', async (_name, auth, status) => {
    const app = appWith(auth as RequestAuth | undefined)
    for (const path of ['/direct', '/service']) {
      const response = await app.request(path, { method: 'POST' })
      expect(response.status, path).toBe(status)
      if (status === 403)
        expect(harnessErrorEnvelopeSchema.parse(await response.json()).error.action).toBe('login')
    }
  })

  it('isFreshAuth: the window end is inclusive', () => {
    const auth: RequestAuth = { enabled: true, authenticated: true, source: 'env', session, freshUntil: 1000 }
    expect(isFreshAuth(auth, 1000)).toBe(true)
    expect(isFreshAuth(auth, 1001)).toBe(false)
    expect(isFreshAuth(undefined, 0)).toBe(false)
    expect(isFreshAuth({ ...auth, enabled: false, freshUntil: null }, 5000)).toBe(true)
  })
})
