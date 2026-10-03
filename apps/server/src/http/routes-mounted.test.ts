// Route-table contract of the app (Phase 0 acceptance, kept valid while later waves replace the stubs):
// - every `apiRoutes` entry is registered under `/api` with its exact method and path;
// - `GET /api/health` answers the `Health` DTO;
// - every route that is still a Phase 0 stub answers 501 `not_implemented` from its own handler (no shadowing);
// - unknown `/api/*` routes answer the `not_found` envelope (never the SPA), invalid input `validation_error`.
// Only health and stub routes are requested, so implemented routes never run with side effects here.
import type { ApiRouteDef, ApiRouteKey } from '@harness-forge/shared'
import type { TestApp } from '../testing/create-test-app.ts'
import { API_MODULES, API_ROUTE_KEYS, apiRoutes, harnessErrorEnvelopeSchema, healthSchema } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ROUTE_MODULES, UNKNOWN_API_ROUTE_MESSAGE } from '../app.ts'
import { API_SAMPLES, sampleRequest } from '../testing/api-samples.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { stubRouteKeys } from './validate.ts'

let t: TestApp

beforeAll(async () => {
  t = await createTestApp()
})

afterAll(async () => {
  await t.close()
})

async function send(key: ApiRouteKey): Promise<{ status: number, body: unknown, headers: Headers }> {
  const { path, init } = sampleRequest(key)
  const response = await t.request(path, init)
  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  }
  catch {
    // Not JSON.
  }
  return { status: response.status, body, headers: response.headers }
}

/** Hono paths a route may be registered with: the table path, or its rest path `*` bound as `:path{.+}`. */
function honoPaths(route: ApiRouteDef): string[] {
  const paths = [`/api${route.path}`]
  if (route.path.endsWith('/*'))
    paths.push(`/api${route.path.slice(0, -1)}:path{.+}`)
  return paths
}

const NON_HEALTH_KEYS = API_ROUTE_KEYS.filter(key => key !== 'health.get')

describe('route table', () => {
  it('has a route module factory for every API module', () => {
    expect(Object.keys(ROUTE_MODULES).sort()).toEqual([...API_MODULES].sort())
  })

  it('has a sample request for every route', () => {
    expect(Object.keys(API_SAMPLES).sort()).toEqual([...API_ROUTE_KEYS].sort())
  })

  it.each(API_ROUTE_KEYS)('%s: the sample is valid for the route schemas', (key) => {
    const route: ApiRouteDef = apiRoutes[key]
    const sample = API_SAMPLES[key] as { params?: unknown, query?: unknown, body?: unknown }
    if (route.params)
      expect(route.params.safeParse(sample.params).error).toBeUndefined()
    if (route.query)
      expect(route.query.safeParse(sample.query ?? {}).error).toBeUndefined()
    if (route.body && sample.body !== undefined)
      expect(route.body.safeParse(sample.body).error).toBeUndefined()
  })

  it.each(API_ROUTE_KEYS)('%s is registered under /api with its method and path', (key) => {
    const route: ApiRouteDef = apiRoutes[key]
    const registered = new Set(t.app.routes.map(entry => `${entry.method} ${entry.path}`))
    const found = honoPaths(route).some(path => registered.has(`${route.method} ${path}`))
    expect(found, `${route.method} /api${route.path}`).toBe(true)
  })
})

describe('health and stubs', () => {
  it('gET /api/health answers 200 with the Health DTO', async () => {
    const { status, body, headers } = await send('health.get')
    expect(status).toBe(200)
    const health = healthSchema.parse(body)
    expect(health.ok).toBe(true)
    expect(health.safeMode).toBe(false)
    expect(health.pluginApiVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(health.versions.hono).toMatch(/^\d+\.\d+\.\d+/)
    expect(health.versions.ai).toMatch(/^\d+\.\d+\.\d+/)
    expect(headers.get('x-request-id')).toBeTruthy()
  })

  it('health is never a stub; every stub is a route of the table', () => {
    const stubs = stubRouteKeys()
    expect(stubs.has('health.get')).toBe(false)
    for (const key of stubs)
      expect(API_ROUTE_KEYS).toContain(key)
  })

  it.each(NON_HEALTH_KEYS)('%s: while stubbed, answers 501 not_implemented from its own handler', async (key) => {
    if (!stubRouteKeys().has(key))
      return
    const { status, body, headers } = await send(key)
    expect(status).toBe(501)
    const envelope = harnessErrorEnvelopeSchema.parse(body)
    expect(envelope.error.code).toBe('not_implemented')
    // The message names the route key: the request reached its own handler (no route shadows another).
    expect(envelope.error.message).toContain(`(${key})`)
    expect(headers.get('x-request-id')).toBeTruthy()
  })
})

describe('unknown routes and invalid input', () => {
  it.each([
    ['GET', '/api/nope'],
    ['GET', '/api'],
    ['POST', '/api/health'],
    ['PATCH', '/api/settings'],
    ['GET', '/api/plugins/sample-plugin/files/'],
  ])('%s %s -> 404 not_found envelope', async (method, path) => {
    const response = await t.request(path, { method })
    expect(response.status).toBe(404)
    const envelope = harnessErrorEnvelopeSchema.parse(await response.json())
    expect(envelope.error.code).toBe('not_found')
    expect(envelope.error.message).toContain(UNKNOWN_API_ROUTE_MESSAGE)
  })

  it('unknown non-API, non-HTML requests answer 404', async () => {
    const response = await t.request('/definitely/not/a/file.json', { headers: { accept: 'application/json' } })
    expect(response.status).toBe(404)
  })

  it('invalid path params -> 400 validation_error with issues', async () => {
    const response = await t.request('/api/chats/not-a-uuid')
    expect(response.status).toBe(400)
    const envelope = harnessErrorEnvelopeSchema.parse(await response.json())
    expect(envelope.error.code).toBe('validation_error')
    expect(envelope.error.details).toMatchObject({ issues: [expect.objectContaining({ path: ['id'] })] })
  })

  it('invalid JSON bodies -> 400 validation_error', async () => {
    const response = await t.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxSteps: 0, unknownKey: true }),
    })
    expect(response.status).toBe(400)
    expect(harnessErrorEnvelopeSchema.parse(await response.json()).error.code).toBe('validation_error')
  })

  it.each([
    ['PATCH', '/api/projects/browse', { name: 'x' }, ['id']],
    ['DELETE', '/api/projects/prj_short', undefined, ['id']],
    ['POST', '/api/projects', { name: 'x', path: '/srv', newFolder: '../escape' }, ['newFolder']],
    ['POST', '/api/projects', { name: 'x', path: '/srv\u0000x' }, ['path']],
    ['GET', '/api/projects/browse?path=%00', undefined, ['path']],
    ['POST', '/api/keys/rotate', { confirm: 'rotate' }, ['confirm']],
  ] as const)('the Phase 7 routes validate their input first: %s %s -> 400', async (method, path, body, issuePath) => {
    const init: RequestInit = { method }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const response = await t.request(path, init)
    expect(response.status).toBe(400)
    const envelope = harnessErrorEnvelopeSchema.parse(await response.json())
    expect(envelope.error.code).toBe('validation_error')
    expect(envelope.error.details).toMatchObject({ issues: [expect.objectContaining({ path: [...issuePath] })] })
  })

  it('malformed JSON -> 400 validation_error', async () => {
    const response = await t.request('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"displayName":' })
    expect(response.status).toBe(400)
    expect(harnessErrorEnvelopeSchema.parse(await response.json()).error.code).toBe('validation_error')
  })

  it.each([
    '/api/plugins/sample-plugin/files/..%2f..%2fpackage.json',
    '/api/plugins/sample-plugin/files/a/%2e%2e/%2e%2e/secret.key',
    '/api/plugins/sample-plugin/files/a%5Cb.txt',
  ])('rejects the plugin file path %s', async (path) => {
    const response = await t.request(path)
    expect([400, 404]).toContain(response.status)
    const envelope = harnessErrorEnvelopeSchema.parse(await response.json())
    expect(['validation_error', 'not_found']).toContain(envelope.error.code)
  })

  it('echoes a valid incoming X-Request-Id and replaces an invalid one', async () => {
    const kept = await t.request('/api/health', { headers: { 'x-request-id': 'req-12345678' } })
    expect(kept.headers.get('x-request-id')).toBe('req-12345678')
    const replaced = await t.request('/api/health', { headers: { 'x-request-id': 'bad id!' } })
    expect(replaced.headers.get('x-request-id')).not.toBe('bad id!')
    expect(replaced.headers.get('x-request-id')).toMatch(/^[\w.-]{8,64}$/)
  })
})
