import type { SourcesTestApp, SourcesTestAppOptions } from '../../plugins/marketplaces/testing.ts'
// Marketplace routes (API.md 5.34; Phase 12, W12.2-T6): every answer over HTTP with the fake remote behind the service
// (no real network): list 200, add 201 / 400 / 404 / 409 exists / 409 offline / 413 / 429 / 502, get 200 / 404,
// refresh 200 / 404 / 409 / 429, remove 204 / 404; no route needs fresh auth.
import type { FakeRemoteRoutes } from '../../testing/fake-remote.ts'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMarketplaceId, harnessErrorEnvelopeSchema, LIMITS, marketplaceDetailSchema, marketplaceListSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createSourcesTestApp } from '../../plugins/marketplaces/testing.ts'
import { CLAUDE_MARKETPLACE, claudeMarketplaceFiles, registerClaudeMarketplaceRemote, writeFileTree } from '../../testing/claude-fixtures.ts'
import { createFakeRemoteRoutes } from '../../testing/fake-remote.ts'

const PASSWORD = 'correct horse battery staple'
const apps: SourcesTestApp[] = []
const folders: string[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true })
})

async function start(options: SourcesTestAppOptions = {}): Promise<SourcesTestApp> {
  const app = await createSourcesTestApp(options)
  apps.push(app)
  return app
}

interface Result {
  status: number
  body: unknown
  headers: Headers
}

async function send(app: SourcesTestApp, method: string, path: string, body?: unknown, cookie?: string): Promise<Result> {
  const headers = new Headers()
  if (body !== undefined)
    headers.set('content-type', 'application/json')
  if (cookie !== undefined)
    headers.set('cookie', cookie)
  const response = await app.t.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await response.text()
  return { status: response.status, body: text === '' ? null : JSON.parse(text) as unknown, headers: response.headers }
}

function error(result: Result): { code: string, message: string, retryAfterMs?: number, details?: unknown } {
  return harnessErrorEnvelopeSchema.parse(result.body).error
}

function routesWithMarketplace(): FakeRemoteRoutes {
  const routes = createFakeRemoteRoutes()
  registerClaudeMarketplaceRemote(routes)
  return routes
}

describe('marketplace routes', () => {
  it('list 200, add 201, get 200, refresh 200, remove 204, then 404s', async () => {
    const app = await start({ routes: routesWithMarketplace() })
    const empty = await send(app, 'GET', '/api/marketplaces')
    expect(empty.status).toBe(200)
    expect(marketplaceListSchema.parse(empty.body)).toMatchObject({ items: [], updates: [], suggestions: [{ name: 'claude-plugins-official' }] })

    const added = await send(app, 'POST', '/api/marketplaces', { source: { type: 'github', repo: CLAUDE_MARKETPLACE.repo } })
    expect(added.status).toBe(201)
    const detail = marketplaceDetailSchema.parse(added.body)
    expect(detail).toMatchObject({ name: 'acme-tools', plugins: 14 })

    const got = await send(app, 'GET', `/api/marketplaces/${detail.id}`)
    expect(got.status).toBe(200)
    expect(got.body).toEqual(added.body)
    const refreshed = await send(app, 'POST', `/api/marketplaces/${detail.id}/refresh`)
    expect(refreshed.status).toBe(200)
    expect(marketplaceDetailSchema.parse(refreshed.body).resolvedRef).toBe(detail.resolvedRef)
    const listed = marketplaceListSchema.parse((await send(app, 'GET', '/api/marketplaces')).body)
    expect(listed.items.map(item => item.id)).toEqual([detail.id])

    const removed = await send(app, 'DELETE', `/api/marketplaces/${detail.id}`)
    expect(removed.status).toBe(204)
    expect(removed.body).toBeNull()
    for (const [method, path] of [['GET', `/api/marketplaces/${detail.id}`], ['POST', `/api/marketplaces/${detail.id}/refresh`], ['DELETE', `/api/marketplaces/${detail.id}`]] as const) {
      const missing = await send(app, method, path)
      expect(missing.status, `${method} ${path}`).toBe(404)
      expect(error(missing).code).toBe('not_found')
    }
    expect(app.events.ofType('marketplace.changed').map(event => event.data.marketplace === null)).toEqual([false, false, true])
  })

  it('add answers 400 (body, catalog, reserved name), 404, 409 exists, 413, 429 with Retry-After, 502', async () => {
    const routes = routesWithMarketplace()
    routes.commit('acme/broken', { '.claude-plugin/marketplace.json': '[]' })
    routes.commit('evil/official', { '.claude-plugin/marketplace.json': JSON.stringify({ name: 'claude-code-plugins', owner: { name: 'x' }, plugins: [] }) })
    routes.commit('acme/huge', { '.claude-plugin/marketplace.json': JSON.stringify({ name: 'huge', owner: { name: 'x' }, plugins: [], pad: 'x'.repeat(LIMITS.marketplaceJsonBytes) }) })
    routes.serve('https://example.com/down/marketplace.json', { status: 503, body: 'down' })
    const app = await start({ routes })
    const add = (source: unknown): Promise<Result> => send(app, 'POST', '/api/marketplaces', { source })

    expect(error(await add({ type: 'github', repo: 'not-a-repo' }))).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['source', 'repo'] }] } })
    expect((await send(app, 'POST', '/api/marketplaces', { source: { type: 'path', path: '/srv/x' }, name: 'extra' })).status).toBe(400)
    expect(error(await add({ type: 'github', repo: 'acme/broken' }))).toMatchObject({ code: 'validation_error' })
    const reserved = await add({ type: 'github', repo: 'evil/official' })
    expect(reserved.status).toBe(400)
    expect(error(reserved)).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['source'] }] } })
    expect((await add({ type: 'github', repo: 'acme/nothing-here' })).status).toBe(404)
    expect((await add({ type: 'github', repo: 'acme/huge' })).status).toBe(413)
    const down = await add({ type: 'url', url: 'https://example.com/down/marketplace.json' })
    expect(down.status).toBe(502)
    expect(error(down).code).toBe('provider_error')

    expect((await add({ type: 'github', repo: CLAUDE_MARKETPLACE.repo })).status).toBe(201)
    const taken = await add({ type: 'url', url: CLAUDE_MARKETPLACE.jsonUrl })
    expect(taken.status).toBe(409)
    expect(error(taken)).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })

    routes.setRateLimited(true, { resetAt: Math.floor(Date.now() / 1000) + 30 })
    const limited = await add({ type: 'github', repo: 'acme/other' })
    expect(limited.status).toBe(429)
    expect(error(limited).code).toBe('rate_limited')
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    const id = marketplaceListSchema.parse((await send(app, 'GET', '/api/marketplaces')).body).items[0]!.id
    const refreshLimited = await send(app, 'POST', `/api/marketplaces/${id}/refresh`)
    expect(refreshLimited.status).toBe(429)
    expect(marketplaceDetailSchema.parse((await send(app, 'GET', `/api/marketplaces/${id}`)).body).lastError).toMatchObject({ code: 'rate_limited' })
  })

  it('hF_OFFLINE: 409 offline for github and url sources (add and refresh); a folder marketplace adds and refreshes', async () => {
    const app = await start({ routes: routesWithMarketplace(), env: { HF_OFFLINE: '1' } })
    const offline = await send(app, 'POST', '/api/marketplaces', { source: { type: 'github', repo: CLAUDE_MARKETPLACE.repo } })
    expect(offline.status).toBe(409)
    expect(error(offline)).toMatchObject({ code: 'conflict', details: { reason: 'offline' } })
    expect(error(await send(app, 'POST', '/api/marketplaces', { source: { type: 'url', url: CLAUDE_MARKETPLACE.jsonUrl } }))).toMatchObject({ details: { reason: 'offline' } })
    const folder = await realpath(await mkdtemp(join(tmpdir(), 'hf-mkt-route-')))
    folders.push(folder)
    await writeFileTree(folder, claudeMarketplaceFiles())
    const added = await send(app, 'POST', '/api/marketplaces', { source: { type: 'path', path: folder } })
    expect(added.status).toBe(201)
    const id = marketplaceDetailSchema.parse(added.body).id
    expect((await send(app, 'POST', `/api/marketplaces/${id}/refresh`)).status).toBe(200)
    expect(app.routes.requests).toEqual([])
  })

  it('a stale session is enough (no fresh auth); without a session 401; invalid ids are 400', async () => {
    const app = await start({ routes: routesWithMarketplace(), env: { HF_PASSWORD: PASSWORD } })
    expect((await send(app, 'GET', '/api/marketplaces')).status).toBe(401)
    const token = await app.t.deps.sessions.issue({ authAt: Date.now() - 24 * 60 * 60 * 1000 })
    const cookie = `hf_session=${token}`
    expect((await send(app, 'GET', '/api/marketplaces', undefined, cookie)).status).toBe(200)
    expect((await send(app, 'POST', '/api/marketplaces', { source: { type: 'github', repo: CLAUDE_MARKETPLACE.repo } }, cookie)).status).toBe(201)
    expect((await send(app, 'GET', '/api/marketplaces/mkt_short', undefined, cookie)).status).toBe(400)
    expect((await send(app, 'GET', `/api/marketplaces/${createMarketplaceId()}`, undefined, cookie)).status).toBe(404)
  })
})
