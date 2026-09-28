// Route-table driven request guards: every route of the shared route table is sent a sample request.
// - SEC-B1: every state-changing route refuses a foreign `Origin` or a cross-site `Sec-Fetch-Site` with `403 forbidden`
//   (also with a valid session cookie) and nothing changes.
// - SEC-B2: no route ever answers with CORS headers (preflights included); GET and HEAD never change stored state.
// - SEC-B3: every JSON route refuses non-JSON bodies (form-encoded, text/plain, multipart where no form is accepted).
// - SEC-C1 / SEC-C2: every answer carries nosniff, `Referrer-Policy: no-referrer`, COOP, `X-Frame-Options: DENY` and a
//   restrictive CSP (API answers: `default-src 'none'`).
import type { ApiRouteDef, ApiRouteKey } from '@harness-forge/shared'
import type { TestApp } from '../testing/create-test-app.ts'
import { Buffer } from 'node:buffer'
import { API_ROUTE_KEYS, apiRoutes, apiUrl, createChatId, harnessErrorEnvelopeSchema } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chatBody } from '../chat/testing.ts'
import { CROSS_ORIGIN_MESSAGE, CROSS_SITE_MESSAGE } from '../http/middleware/origin-check.ts'
import { SESSION_COOKIE_NAME } from '../http/middleware/session-auth.ts'
import { createInstaller } from '../plugins/install/index.ts'
import { createFakeRegistry, FAKE_REGISTRY } from '../plugins/install/testing.ts'
import { API_SAMPLES, sampleRequest } from '../testing/api-samples.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { API_CSP } from './headers.ts'

const PASSWORD = 'correct horse battery staple'
const FOREIGN_ORIGIN = 'https://evil.example'
const STATE_CHANGING_KEYS = API_ROUTE_KEYS.filter(key => apiRoutes[key].method !== 'GET')
const GET_KEYS = API_ROUTE_KEYS.filter(key => apiRoutes[key].method === 'GET')
const JSON_BODY_KEYS = API_ROUTE_KEYS.filter(key => (apiRoutes[key] as ApiRouteDef).body !== undefined)

/** Samples that would leave the machine are pointed at a local address that is never connected (fetch bad port). */
const LOCAL_SAMPLES: Partial<Record<ApiRouteKey, unknown>> = {
  'pluginDrafts.test': { body: { provider: { ...API_SAMPLES['pluginDrafts.test'].body.provider, baseURL: 'http://127.0.0.1:9/v1' }, action: 'list-models' } },
}

async function isolatedApp(env: Record<string, string>, start = false): Promise<TestApp> {
  // An empty fake npm registry: the install samples never reach the network.
  const registry = createFakeRegistry({})
  return createTestApp({
    env: { NODE_ENV: 'production', HF_OFFLINE: '1', ...env },
    start,
    factories: { installer: deps => createInstaller(deps, { fetch: registry.fetch, npmRegistry: FAKE_REGISTRY }) },
  })
}

function request(key: ApiRouteKey, headers: Record<string, string>): { path: string, init: RequestInit } {
  const sample = LOCAL_SAMPLES[key]
  const { path, init } = sampleRequest(key, { headers, ...(sample === undefined ? {} : { sample: sample as never }) })
  return { path, init }
}

/** Reads (and for streams, cancels) the body so no request is left pending. */
async function drain(response: Response): Promise<string> {
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    await response.body?.cancel().catch(() => {})
    return ''
  }
  return Buffer.from(await response.arrayBuffer()).toString('utf8')
}

function corsHeaders(response: Response): string[] {
  return [...response.headers.keys()].filter(name => name.toLowerCase().startsWith('access-control-'))
}

/** Rows of every table (the stored state), for "nothing changed" checks. */
async function storedState(t: TestApp): Promise<Record<string, unknown[]>> {
  const tables = await t.database.client.execute('SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\' AND name NOT LIKE \'__drizzle%\' ORDER BY name')
  const state: Record<string, unknown[]> = {}
  for (const row of tables.rows) {
    const name = String(row.name)
    state[name] = (await t.database.client.execute(`SELECT * FROM "${name}" ORDER BY rowid`)).rows.map(item => ({ ...item }))
  }
  return state
}

describe('sEC-B1: every state-changing route refuses cross-site requests', () => {
  let open: TestApp
  let locked: TestApp
  let cookie: string

  beforeAll(async () => {
    open = await isolatedApp({})
    locked = await isolatedApp({ HF_PASSWORD: PASSWORD })
    cookie = `${SESSION_COOKIE_NAME}=${await locked.deps.sessions.issue({ authAt: Date.now() })}`
  })

  afterAll(async () => {
    await Promise.all([open.close(), locked.close()])
  })

  it.each(STATE_CHANGING_KEYS)('%s', async (key) => {
    const before = [await storedState(open), await storedState(locked)]
    const attempts: Array<[TestApp, Record<string, string>, string]> = [
      [open, { origin: FOREIGN_ORIGIN }, CROSS_ORIGIN_MESSAGE],
      [open, { 'sec-fetch-site': 'cross-site' }, CROSS_SITE_MESSAGE],
      [open, { 'origin': 'null', 'sec-fetch-site': 'cross-site' }, CROSS_ORIGIN_MESSAGE],
      // A valid (fresh) session cookie does not help a cross-site request.
      [locked, { origin: FOREIGN_ORIGIN, cookie }, CROSS_ORIGIN_MESSAGE],
      [locked, { 'sec-fetch-site': 'same-site', cookie }, CROSS_SITE_MESSAGE],
    ]
    for (const [app, headers, message] of attempts) {
      const { path, init } = request(key, headers)
      const response = await app.request(path, init)
      expect(response.status, `${key} ${JSON.stringify(headers)}`).toBe(403)
      expect(harnessErrorEnvelopeSchema.parse(await response.json()).error).toEqual({ code: 'forbidden', message })
      expect(corsHeaders(response)).toEqual([])
    }
    expect([await storedState(open), await storedState(locked)]).toEqual(before)
  })
})

describe('sEC-B2 / SEC-C1 / SEC-C2: headers of every answer', () => {
  let open: TestApp

  beforeAll(async () => {
    open = await isolatedApp({})
  })

  afterAll(async () => {
    await open.close()
  })

  it.each(API_ROUTE_KEYS)('%s', async (key) => {
    const route = apiRoutes[key]
    // A same-origin request (the route really runs) and a cross-origin one; neither gets CORS headers.
    const variants: Array<Record<string, string>> = [{}, { origin: FOREIGN_ORIGIN }]
    for (const headers of variants) {
      const { path, init } = request(key, headers)
      const response = await open.request(path, init)
      await drain(response)
      expect(corsHeaders(response), key).toEqual([])
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin')
      expect(response.headers.get('x-frame-options')).toBe('DENY')
      const csp = response.headers.get('content-security-policy') ?? ''
      expect(csp, key).toMatch(/default-src 'none'/)
      expect(csp).not.toMatch(/unsafe-eval/)
      if (response.status >= 400 || (route.response !== 'binary' && route.response !== 'sse'))
        expect(csp).toBe(API_CSP)
      expect(response.headers.get('cache-control')).toBeTruthy()
      // No password here: every route really ran (or refused the foreign origin), none asked for a login.
      expect(response.status, key).not.toBe(401)
    }
    // The sample of `auth.setPassword` sets a password: remove it so the next routes run without a session too.
    if (key === 'auth.setPassword')
      await open.deps.passwords.set(null)
    // A CORS preflight is never answered with CORS headers.
    const preflight = await open.request(apiUrl(key as never, API_SAMPLES[key] as never, '/api'), {
      method: 'OPTIONS',
      headers: { 'origin': FOREIGN_ORIGIN, 'access-control-request-method': route.method, 'access-control-request-headers': 'content-type' },
    })
    await drain(preflight)
    expect(corsHeaders(preflight)).toEqual([])
    expect(preflight.status).toBeGreaterThanOrEqual(400)
  })
})

describe('sEC-B3: JSON routes refuse non-JSON bodies', () => {
  let open: TestApp

  beforeAll(async () => {
    open = await isolatedApp({})
  })

  afterAll(async () => {
    await open.close()
  })

  it.each(JSON_BODY_KEYS)('%s', async (key) => {
    const route = apiRoutes[key] as ApiRouteDef
    const body = JSON.stringify((API_SAMPLES[key] as { body?: unknown }).body ?? {})
    const before = await storedState(open)
    const types = ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', ...(route.form === undefined ? ['multipart/form-data; boundary=x'] : [])]
    for (const type of types) {
      const { path } = request(key, {})
      const response = await open.request(path, { method: route.method, headers: { 'content-type': type }, body })
      expect(response.status, `${key} ${type}`).toBe(400)
      const { error } = harnessErrorEnvelopeSchema.parse(await response.json())
      expect(error.details, `${key} ${type}`).toEqual({ issues: [expect.objectContaining({ code: 'invalid_content_type' })] })
    }
    expect(await storedState(open)).toEqual(before)
  })
})

describe('sEC-B2: GET and HEAD never change stored state', () => {
  let t: TestApp
  let chatId: string
  let fileId: string

  beforeAll(async () => {
    t = await isolatedApp({ HF_MOCK_PROVIDER: '1' }, true)
    chatId = createChatId()
    const chat = await t.request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chatBody(chatId, 'hello there')) })
    expect(chat.status).toBe(200)
    await chat.text()
    const form = new FormData()
    form.append('file', new File(['notes'], 'notes.txt', { type: 'text/plain' }))
    fileId = ((await (await t.request('/api/files', { method: 'POST', body: form })).json()) as { id: string }).id
    const manifest = { manifestVersion: 1, id: 'get-state', name: 'Get state', version: '1.0.0', engines: { harness: '^1.0.0' } }
    expect((await t.request('/api/plugins', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest }) })).status).toBe(201)
    expect((await t.request('/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'get-web', name: 'Web', enabled: false, transport: { type: 'http', url: 'https://mcp.example.com/mcp' } }) })).status).toBe(201)
    // Settle background work of the writes (titles, catalog) before the baseline is taken.
    await new Promise(resolve => setTimeout(resolve, 200))
  }, 30_000)

  afterAll(async () => {
    await t.close()
  })

  it('every GET route, and HEAD of it, leaves every table as it was', async () => {
    const inputs: Partial<Record<ApiRouteKey, unknown>> = {
      'chats.get': { params: { id: chatId } },
      'chats.export': { params: { id: chatId }, query: { format: 'json' } },
      'chat.resume': { params: { id: chatId } },
      'files.get': { params: { id: fileId } },
      'plugins.get': { params: { id: 'get-state' } },
      'plugins.getSettings': { params: { id: 'get-state' } },
      'plugins.icon': { params: { id: 'get-state' } },
      'plugins.logs': { params: { id: 'get-state' } },
      'pluginInstall.export': { params: { id: 'get-state' } },
      'pluginFiles.list': { params: { id: 'get-state' } },
      'pluginFiles.read': { params: { id: 'get-state', path: 'plugin.json' } },
    }
    const before = await storedState(t)
    // The baseline really holds state for the routes to touch.
    expect(before.chats).toHaveLength(1)
    expect(before.messages!.length).toBeGreaterThanOrEqual(2)
    expect(before.plugins!.map(row => (row as { id: string }).id)).toContain('get-state')
    expect(before.mcp_servers).toHaveLength(1)
    expect(before.files).toHaveLength(1)
    for (const key of GET_KEYS) {
      const path = (apiUrl as (key: ApiRouteKey, input?: unknown, baseUrl?: string) => string)(key, inputs[key] ?? API_SAMPLES[key], '/api')
      for (const method of ['GET', 'HEAD']) {
        const response = await t.request(path, { method })
        await drain(response)
        expect(response.status, `${method} ${path}`).toBeLessThan(500)
      }
    }
    expect(await storedState(t)).toEqual(before)
  })
})
