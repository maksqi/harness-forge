import type { McpTestApp } from '../../mcp/__fixtures__/harness.ts'
import { harnessErrorEnvelopeSchema, listResponseSchema, mcpServerSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createMcpTestApp, echoStdio, waitFor } from '../../mcp/__fixtures__/harness.ts'
import { SESSION_COOKIE_NAME } from '../middleware/session-auth.ts'

const PASSWORD = 'correct horse battery staple'
const SECRET = 'route-header-secret-123456'

let h: McpTestApp | null = null

afterEach(async () => {
  await h?.close()
  h = null
})

async function open(env: Record<string, string> = {}): Promise<McpTestApp> {
  h = await createMcpTestApp({ env })
  return h
}

interface JsonResponse { status: number, body: unknown }

async function send(app: McpTestApp, method: string, path: string, body?: unknown, cookie?: string): Promise<JsonResponse> {
  const headers: Record<string, string> = {}
  if (body !== undefined)
    headers['content-type'] = 'application/json'
  if (cookie)
    headers.cookie = cookie
  const response = await app.t.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) as unknown : null }
}

function errorOf(body: unknown) {
  return harnessErrorEnvelopeSchema.parse(body).error
}

async function sessionCookie(app: McpTestApp, ageMs: number): Promise<string> {
  const token = await app.t.deps.sessions.issue({ authAt: Date.now() - ageMs })
  return `${SESSION_COOKIE_NAME}=${token}`
}

const HTTP_SERVER = { id: 'web', name: 'Web', enabled: false, transport: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: `Bearer ${SECRET}` } } }

describe('mcp routes', () => {
  it('creates, lists, updates and deletes a server; header values never come back', async () => {
    const app = await open()
    expect(listResponseSchema(mcpServerSchema).parse((await send(app, 'GET', '/api/mcp')).body).items).toEqual([])

    const created = await send(app, 'POST', '/api/mcp', HTTP_SERVER)
    expect(created.status).toBe(201)
    expect(mcpServerSchema.parse(created.body)).toMatchObject({
      id: 'web',
      status: 'disabled',
      editable: true,
      transport: { type: 'http', headers: { Authorization: { set: true, source: 'stored' } } },
    })
    expect(JSON.stringify(created.body)).not.toContain(SECRET)

    const list = await send(app, 'GET', '/api/mcp')
    expect(listResponseSchema(mcpServerSchema).parse(list.body).items.map(server => server.id)).toEqual(['web'])
    expect(JSON.stringify(list.body)).not.toContain(SECRET)

    const duplicate = await send(app, 'POST', '/api/mcp', HTTP_SERVER)
    expect(duplicate.status).toBe(409)
    expect(errorOf(duplicate.body)).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })

    const renamed = await send(app, 'PATCH', '/api/mcp/web', { name: 'Renamed', transport: { type: 'sse', url: 'http://127.0.0.1:9/sse', headers: { Authorization: null } } })
    expect(renamed.status).toBe(200)
    expect(mcpServerSchema.parse(renamed.body)).toMatchObject({ name: 'Renamed', transport: { type: 'sse', headers: { Authorization: { set: true } } } })

    expect((await send(app, 'DELETE', '/api/mcp/web')).status).toBe(204)
    expect((await send(app, 'DELETE', '/api/mcp/web')).status).toBe(404)
    const gone = await send(app, 'PATCH', '/api/mcp/web', { name: 'x' })
    expect(gone.status).toBe(404)
    expect(errorOf(gone.body).code).toBe('not_found')
  })

  it('validates bodies and params', async () => {
    const app = await open()
    for (const body of [
      { ...HTTP_SERVER, id: 'Bad_Id' },
      { ...HTTP_SERVER, transport: { type: 'http', url: 'ftp://example.com' } },
      { ...HTTP_SERVER, unknown: true },
      { ...HTTP_SERVER, transport: { type: 'http', url: 'http://127.0.0.1:9/', headers: { 'X-A': 'a\r\nb' } } },
    ]) {
      const response = await send(app, 'POST', '/api/mcp', body)
      expect(response.status).toBe(400)
      expect(errorOf(response.body).code).toBe('validation_error')
    }
    const caseDuplicate = await send(app, 'POST', '/api/mcp', { ...HTTP_SERVER, transport: { type: 'http', url: 'http://127.0.0.1:9/', headers: { 'X-A': 'a', 'x-a': 'b' } } })
    expect(caseDuplicate.status).toBe(400)
    expect((await send(app, 'PATCH', '/api/mcp/web', {})).status).toBe(400)
    expect((await send(app, 'POST', '/api/mcp/Not_Valid/reconnect')).status).toBe(400)
  })

  it('reconnects: 404 unknown, 409 disabled, 200 with the new state', async () => {
    const app = await open()
    expect((await send(app, 'POST', '/api/mcp/nope/reconnect')).status).toBe(404)
    await send(app, 'POST', '/api/mcp', HTTP_SERVER)
    const disabled = await send(app, 'POST', '/api/mcp/web/reconnect')
    expect(disabled.status).toBe(409)
    expect(errorOf(disabled.body)).toMatchObject({ code: 'conflict', details: { reason: 'disabled' } })

    await send(app, 'POST', '/api/mcp', { id: 'echo', name: 'Echo', transport: echoStdio() })
    await waitFor(async () => (await app.t.deps.mcp.get('echo')).status === 'connected')
    const reconnected = await send(app, 'POST', '/api/mcp/echo/reconnect')
    expect(reconnected.status).toBe(200)
    expect(mcpServerSchema.parse(reconnected.body)).toMatchObject({ id: 'echo', status: 'connected' })
  })

  it('forbids changing plugin-declared servers', async () => {
    const app = await open()
    app.t.deps.registry.mcpServers.register('acme', { id: 'acme', name: 'Acme', transport: { type: 'http', url: 'http://127.0.0.1:9/mcp' } })
    const list = listResponseSchema(mcpServerSchema).parse((await send(app, 'GET', '/api/mcp')).body).items
    expect(list).toEqual([expect.objectContaining({ id: 'acme', pluginId: 'acme', editable: false })])
    expect((await send(app, 'PATCH', '/api/mcp/acme', { name: 'Mine' })).status).toBe(403)
    expect((await send(app, 'DELETE', '/api/mcp/acme')).status).toBe(403)
    expect(errorOf((await send(app, 'POST', '/api/mcp', { ...HTTP_SERVER, id: 'acme' })).body)).toMatchObject({ code: 'conflict' })
  })

  it('requires fresh auth for stdio servers when a password is set (ADR-017)', async () => {
    const app = await open({ HF_PASSWORD: PASSWORD })
    const stale = await sessionCookie(app, 11 * 60 * 1000)
    const fresh = await sessionCookie(app, 0)
    expect((await send(app, 'GET', '/api/mcp')).status).toBe(401)

    const refused = await send(app, 'POST', '/api/mcp', { id: 'local', name: 'Local', enabled: false, transport: echoStdio() }, stale)
    expect(refused.status).toBe(403)
    expect(errorOf(refused.body)).toMatchObject({ code: 'forbidden', action: 'login' })
    expect(listResponseSchema(mcpServerSchema).parse((await send(app, 'GET', '/api/mcp', undefined, stale)).body).items).toEqual([])

    // HTTP servers and edits that keep the stdio transport do not need it.
    expect((await send(app, 'POST', '/api/mcp', HTTP_SERVER, stale)).status).toBe(201)
    const toStdio = await send(app, 'PATCH', '/api/mcp/web', { transport: echoStdio() }, stale)
    expect(toStdio.status).toBe(403)
    expect(errorOf(toStdio.body).action).toBe('login')

    expect((await send(app, 'POST', '/api/mcp', { id: 'local', name: 'Local', enabled: false, transport: echoStdio() }, fresh)).status).toBe(201)
    expect((await send(app, 'PATCH', '/api/mcp/local', { name: 'Renamed', enabled: false }, stale)).status).toBe(200)
    expect((await send(app, 'PATCH', '/api/mcp/local', { transport: echoStdio(['--changed']) }, stale)).status).toBe(403)
    expect((await send(app, 'PATCH', '/api/mcp/local', { transport: echoStdio(['--changed']) }, fresh)).status).toBe(200)
  })
})
