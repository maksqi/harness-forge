import type { McpTestApp } from '../../mcp/__fixtures__/harness.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

// Phase 14 (ADR-059, W14.1-T7 / T8): the OAuth settings of personal servers, the PATCH rules of the stored sign-in and
// the plugin DTO's client id.
describe('mcp routes: OAuth settings (phase 14)', () => {
  const CLIENT_SECRET = 'route-oauth-client-secret-9876'
  const RECORD = JSON.stringify({ v: 1, resource: 'http://127.0.0.1:9/mcp', clientId: 'client-1', client: { info: { client_id: 'client-1' }, dynamic: false, redirectUris: ['http://127.0.0.1:8787/oauth/callback'] }, tokens: { access_token: 'route-oauth-access-token-1234', token_type: 'Bearer', obtainedAt: 1 } })
  const OAUTH_SERVER = { id: 'docs', name: 'Docs', enabled: false, transport: { type: 'http', url: 'http://127.0.0.1:9/mcp', oauth: { clientId: 'client-1', scopes: 'read write', clientSecret: CLIENT_SECRET } } }

  async function secretNames(app: McpTestApp): Promise<string[]> {
    return (await app.t.deps.secrets.list('mcp:docs')).map(entry => entry.name)
  }

  it('stores the client id and scopes on the row and the client secret as a secret; never answers it', async () => {
    const app = await open()
    const created = await send(app, 'POST', '/api/mcp', OAUTH_SERVER)
    expect(created.status).toBe(201)
    expect(mcpServerSchema.parse(created.body).transport).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:9/mcp',
      headers: {},
      oauth: { clientId: 'client-1', clientSecret: { set: true, hint: expect.any(String), source: 'stored' }, scopes: 'read write' },
    })
    expect(JSON.stringify(created.body)).not.toContain(CLIENT_SECRET)
    expect(await app.t.deps.secrets.get('mcp:docs', 'oauth.clientSecret')).toBe(CLIENT_SECRET)
    // A secret needs a client id; stdio servers have no OAuth settings.
    expect((await send(app, 'POST', '/api/mcp', { ...OAUTH_SERVER, id: 'other', transport: { type: 'http', url: 'http://127.0.0.1:9/mcp', oauth: { clientSecret: 'x-secret' } } })).status).toBe(400)
    expect((await send(app, 'POST', '/api/mcp', { id: 'local', name: 'Local', enabled: false, transport: { ...echoStdio(), oauth: { clientId: 'x' } } })).status).toBe(400)
    // An empty oauth object stores nothing.
    const plain = await send(app, 'POST', '/api/mcp', { id: 'plain', name: 'Plain', enabled: false, transport: { type: 'http', url: 'http://127.0.0.1:9/mcp', oauth: {} } })
    expect(mcpServerSchema.parse(plain.body).transport).toMatchObject({ oauth: null })
  })

  it('pATCH keeps the sign-in and the client secret unless the URL, the type or the client id changes', async () => {
    const app = await open()
    await send(app, 'POST', '/api/mcp', OAUTH_SERVER)
    await app.t.deps.secrets.set('mcp:docs', 'oauth.record', RECORD)
    const sameTransport = { type: 'http', url: 'http://127.0.0.1:9/mcp', oauth: { clientId: 'client-1', scopes: 'read', clientSecret: null } }

    // The name: nothing touched.
    expect((await send(app, 'PATCH', '/api/mcp/docs', { name: 'Docs 2' })).status).toBe(200)
    expect(await secretNames(app)).toEqual(['oauth.clientSecret', 'oauth.record'])
    // The scopes with `clientSecret: null`: both kept.
    const scoped = await send(app, 'PATCH', '/api/mcp/docs', { transport: sameTransport })
    expect(mcpServerSchema.parse(scoped.body).transport).toMatchObject({ oauth: { clientId: 'client-1', scopes: 'read', clientSecret: { set: true } } })
    expect(await secretNames(app)).toEqual(['oauth.clientSecret', 'oauth.record'])
    // An omitted client secret removes it; the sign-in stays.
    await send(app, 'PATCH', '/api/mcp/docs', { transport: { ...sameTransport, oauth: { clientId: 'client-1' } } })
    expect(await secretNames(app)).toEqual(['oauth.record'])
    // A new secret value.
    await send(app, 'PATCH', '/api/mcp/docs', { transport: { ...sameTransport, oauth: { clientId: 'client-1', clientSecret: 'another-secret-value-1' } } })
    expect(await app.t.deps.secrets.get('mcp:docs', 'oauth.clientSecret')).toBe('another-secret-value-1')
    // Another client id: the sign-in and the old secret go.
    await send(app, 'PATCH', '/api/mcp/docs', { transport: { ...sameTransport, oauth: { clientId: 'client-2', clientSecret: null } } })
    expect(await secretNames(app)).toEqual([])
    // Another URL: the sign-in goes (the header of the same PATCH is stored).
    await app.t.deps.secrets.set('mcp:docs', 'oauth.record', RECORD)
    await send(app, 'PATCH', '/api/mcp/docs', { transport: { type: 'http', url: 'http://127.0.0.1:9/v2', headers: { 'X-Team': 'blue' }, oauth: { clientId: 'client-2' } } })
    expect(await secretNames(app)).toEqual(['header.X-Team'])
    // Another type: the same.
    await app.t.deps.secrets.set('mcp:docs', 'oauth.record', RECORD)
    await send(app, 'PATCH', '/api/mcp/docs', { transport: { type: 'sse', url: 'http://127.0.0.1:9/v2', headers: { 'X-Team': null }, oauth: { clientId: 'client-2' } } })
    expect(await secretNames(app)).toEqual(['header.X-Team'])
    // An omitted `oauth` removes the settings; a dynamic sign-in (no client id before or after) stays.
    await app.t.deps.secrets.set('mcp:docs', 'oauth.record', RECORD)
    await send(app, 'PATCH', '/api/mcp/docs', { transport: { type: 'sse', url: 'http://127.0.0.1:9/v2' } })
    expect(await secretNames(app)).toEqual([])
    await app.t.deps.secrets.set('mcp:docs', 'oauth.record', RECORD)
    const dynamic = await send(app, 'PATCH', '/api/mcp/docs', { transport: { type: 'sse', url: 'http://127.0.0.1:9/v2', oauth: { scopes: 'all' } } })
    expect(mcpServerSchema.parse(dynamic.body).transport).toMatchObject({ oauth: { clientId: null, scopes: 'all', clientSecret: { set: false } } })
    expect(await secretNames(app)).toEqual(['oauth.record'])
    // Deleting the server deletes every secret.
    expect((await send(app, 'DELETE', '/api/mcp/docs')).status).toBe(204)
    expect(await secretNames(app)).toEqual([])
  })

  it('shows a plugin server\'s client id with its non-secret settings filled in, never a secret setting', async () => {
    h = await createMcpTestApp({
      beforeStart: async (t) => {
        const manifest = {
          manifestVersion: 1,
          id: 'oauth-kit',
          name: 'OAuth kit',
          version: '1.0.0',
          engines: { harness: '^1.0.0' },
          settings: { type: 'object', properties: { clientId: { type: 'string', title: 'Client id', default: 'kit-client' }, hidden: { type: 'string', format: 'secret', title: 'Hidden' } } },
          contributes: {
            mcpServers: [
              { id: 'oauth-kit', name: 'Kit', transport: { type: 'http', url: 'http://127.0.0.1:9/mcp', oauth: { clientId: 'app-{{settings.clientId}}', scopes: 'read' } } },
              { id: 'oauth-kit-hidden', name: 'Hidden', transport: { type: 'http', url: 'http://127.0.0.1:9/mcp', oauth: { clientId: '{{settings.hidden}}' } } },
            ],
          },
        }
        const dir = join(t.env.paths.plugins, 'oauth-kit')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`)
        await t.deps.plugins.saveRecord({ id: 'oauth-kit', source: 'copy', version: '1.0.0' })
      },
    })
    const app = h
    await app.t.deps.plugins.updateSettings('oauth-kit', { hidden: 'hidden-client-secret-value' })
    const items = listResponseSchema(mcpServerSchema).parse((await send(app, 'GET', '/api/mcp')).body).items
    const byId = new Map(items.map(item => [item.id, item]))
    expect(byId.get('oauth-kit')?.transport).toMatchObject({ oauth: { clientId: 'app-kit-client', scopes: 'read', clientSecret: { set: false } } })
    expect(byId.get('oauth-kit-hidden')?.transport).toMatchObject({ oauth: { clientId: '{{settings.hidden}}' } })
    expect(JSON.stringify(items)).not.toContain('hidden-client-secret-value')
    await waitFor(async () => (await app.t.deps.mcp.get('oauth-kit')).status !== 'connecting')
  })
})
