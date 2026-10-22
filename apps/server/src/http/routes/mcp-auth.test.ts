// Route tests of the MCP sign-in routes (API.md 5.37, ADR-059; W14.1-T6) for personal and plugin servers, against the
// real MCP manager and OAuth service and the OAuth MCP fixture on loopback: every answer of `POST /mcp/:id/oauth`,
// `DELETE /mcp/:id/oauth` and `POST /mcp/oauth/callback` (session, Origin check, the redirect URI from the request's
// Origin, `returnTo`, 400 / 404 / 409 / 502). The project routes are tested in `project-mcp.test.ts`.
import type { McpTestApp } from '../../mcp/__fixtures__/harness.ts'
import type { OAuthMcpServer } from '../../mcp/__fixtures__/oauth-mcp-server.mjs'
import { harnessErrorEnvelopeSchema, mcpAuthCallbackResultSchema, mcpAuthStartSchema, mcpServerSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createMcpTestApp, echoStdio, waitFor } from '../../mcp/__fixtures__/harness.ts'
import { startOAuthMcpServer } from '../../mcp/__fixtures__/oauth-mcp-server.mjs'
import { followAuthorization } from '../../mcp/oauth/sign-in.test-util.ts'
import { TEST_ORIGIN } from '../../testing/create-test-app.ts'
import { SESSION_COOKIE_NAME } from '../middleware/session-auth.ts'

const PASSWORD = 'correct horse battery staple'

let app: McpTestApp | null = null
let fixture: OAuthMcpServer | null = null

afterEach(async () => {
  await app?.close()
  app = null
  await fixture?.stop()
  fixture = null
})

async function open(): Promise<{ h: McpTestApp, fixture: OAuthMcpServer, session: string }> {
  fixture = await startOAuthMcpServer()
  app = await createMcpTestApp({ env: { HF_PASSWORD: PASSWORD } })
  const session = `${SESSION_COOKIE_NAME}=${await app.t.deps.sessions.issue({ authAt: Date.now() - 60 * 60 * 1000 })}`
  return { h: app, fixture, session }
}

interface JsonResponse { status: number, body: unknown }

async function send(h: McpTestApp, method: string, path: string, options: { session?: string, body?: unknown, origin?: string | null } = {}): Promise<JsonResponse> {
  const headers: Record<string, string> = {}
  if (options.session !== undefined)
    headers.cookie = options.session
  if (options.origin !== null)
    headers.origin = options.origin ?? TEST_ORIGIN
  if (options.body !== undefined)
    headers['content-type'] = 'application/json'
  const response = await h.t.request(path, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) as unknown : null }
}

function errorOf(body: unknown) {
  return harnessErrorEnvelopeSchema.parse(body).error
}

async function needsAuth(h: McpTestApp, id: string): Promise<void> {
  await waitFor(async () => (await h.t.deps.mcp.get(id)).status === 'needs-auth')
}

describe('mCP sign-in routes', () => {
  it('pOST /mcp/:id/oauth → the authorization URL; the callback signs in; DELETE signs out (stale session, no fresh auth)', async () => {
    const { h, fixture, session } = await open()
    await h.t.deps.mcp.create({ id: 'fixture', name: 'Fixture', transport: { type: 'http', url: fixture.url } })
    await needsAuth(h, 'fixture')

    const started = await send(h, 'POST', '/api/mcp/fixture/oauth', { session, body: { returnTo: '/plugins/core-mcp?tab=mcp' } })
    expect(started.status).toBe(200)
    const start = mcpAuthStartSchema.parse(started.body)
    expect(start.redirectUri).toBe(`${TEST_ORIGIN}/oauth/callback`)
    expect(new URL(start.authorizationUrl!).searchParams.get('redirect_uri')).toBe(start.redirectUri)

    const redirect = await followAuthorization(start.authorizationUrl!)
    const callback = await send(h, 'POST', '/api/mcp/oauth/callback', { session, body: { state: redirect.state, code: redirect.code, iss: redirect.iss } })
    expect(callback.status).toBe(200)
    expect(mcpAuthCallbackResultSchema.parse(callback.body)).toEqual({ target: { kind: 'global', serverId: 'fixture' }, status: 'connected', returnTo: '/plugins/core-mcp?tab=mcp' })
    const listed = await send(h, 'GET', '/api/mcp', { session })
    const server = mcpServerSchema.parse((listed.body as { items: unknown[] }).items[0])
    expect(server).toMatchObject({ id: 'fixture', status: 'connected', auth: { signedIn: true, client: 'dynamic' } })
    for (const secret of [redirect.code, redirect.state])
      expect(JSON.stringify([callback.body, listed.body])).not.toContain(secret)

    // A replayed callback: 409 stale.
    const replay = await send(h, 'POST', '/api/mcp/oauth/callback', { session, body: { state: redirect.state, code: redirect.code } })
    expect(replay.status).toBe(409)
    expect(errorOf(replay.body)).toMatchObject({ code: 'conflict', message: 'This sign-in link was already used or expired.', details: { reason: 'stale' } })

    const signedOut = await send(h, 'DELETE', '/api/mcp/fixture/oauth', { session })
    expect(signedOut.status).toBe(200)
    expect(mcpServerSchema.parse(signedOut.body)).toMatchObject({ id: 'fixture', status: 'needs-auth', auth: null })
    expect(fixture.counters().revocations).toBe(1)
  })

  it('needs the session and the Origin check; without an Origin header the server origin gives the redirect URI', async () => {
    const { h, fixture, session } = await open()
    await h.t.deps.mcp.create({ id: 'fixture', name: 'Fixture', transport: { type: 'http', url: fixture.url } })
    await needsAuth(h, 'fixture')
    expect((await send(h, 'POST', '/api/mcp/fixture/oauth', { body: {} })).status).toBe(401)
    expect((await send(h, 'POST', '/api/mcp/oauth/callback', { body: { state: 'state-0000000000000000', code: 'x' } })).status).toBe(401)
    const crossSite = await send(h, 'POST', '/api/mcp/fixture/oauth', { session, body: {}, origin: 'https://evil.example.com' })
    expect(crossSite.status).toBe(403)
    expect((await send(h, 'POST', '/api/mcp/oauth/callback', { session, body: { state: 'state-0000000000000000', code: 'x' }, origin: 'https://evil.example.com' })).status).toBe(403)

    // No body and no Origin header: the server's own origin.
    const response = await h.t.request('/api/mcp/fixture/oauth', { method: 'POST', headers: { cookie: session } })
    expect(response.status).toBe(200)
    expect(mcpAuthStartSchema.parse(await response.json()).redirectUri).toBe(`${TEST_ORIGIN}/oauth/callback`)
  })

  it('validates the bodies: returnTo, strict bodies, exactly one of code / error', async () => {
    const { h, fixture, session } = await open()
    await h.t.deps.mcp.create({ id: 'fixture', name: 'Fixture', enabled: false, transport: { type: 'http', url: fixture.url } })
    for (const returnTo of ['//evil.example.com', 'https://evil.example.com/', 'plugins', `/${'x'.repeat(600)}`, '/a b', '/a\\b'])
      expect((await send(h, 'POST', '/api/mcp/fixture/oauth', { session, body: { returnTo } })).status, returnTo).toBe(400)
    expect((await send(h, 'POST', '/api/mcp/fixture/oauth', { session, body: { returnTo: '/', extra: true } })).status).toBe(400)
    for (const body of [{ state: 'state-0000000000000000' }, { state: 'state-0000000000000000', code: 'x', error: 'access_denied' }, { state: 'short', code: 'x' }, { state: 'state-0000000000000000', code: 'x', extra: 1 }])
      expect((await send(h, 'POST', '/api/mcp/oauth/callback', { session, body })).status, JSON.stringify(body)).toBe(400)
    expect((await send(h, 'POST', '/api/mcp/Not_An_Id/oauth', { session, body: {} })).status).toBe(400)
  })

  it('answers 404 unknown, 400 stdio and an Authorization header, 409 disabled, 409 stale, 502 for the provider\'s error', async () => {
    const { h, fixture, session } = await open()
    await h.t.deps.mcp.create({ id: 'local', name: 'Local', enabled: false, transport: echoStdio() })
    await h.t.deps.mcp.create({ id: 'keyed', name: 'Keyed', enabled: false, transport: { type: 'http', url: fixture.url, headers: { authorization: 'Bearer own-key-123456' } } })
    await h.t.deps.mcp.create({ id: 'off', name: 'Off', enabled: false, transport: { type: 'http', url: fixture.url } })
    await h.t.deps.mcp.create({ id: 'fixture', name: 'Fixture', transport: { type: 'http', url: fixture.url } })
    await needsAuth(h, 'fixture')

    const unknown = await send(h, 'POST', '/api/mcp/nope/oauth', { session, body: {} })
    expect(unknown.status).toBe(404)
    expect(errorOf(unknown.body).code).toBe('not_found')
    expect((await send(h, 'DELETE', '/api/mcp/nope/oauth', { session })).status).toBe(404)
    for (const id of ['local', 'keyed']) {
      const refused = await send(h, 'POST', `/api/mcp/${id}/oauth`, { session, body: {} })
      expect(refused.status, id).toBe(400)
      expect(errorOf(refused.body).code).toBe('validation_error')
    }
    expect(errorOf((await send(h, 'POST', '/api/mcp/keyed/oauth', { session, body: {} })).body).message).toBe('This server is set up with its own Authorization header, so it does not sign in.')
    expect((await send(h, 'DELETE', '/api/mcp/local/oauth', { session })).status).toBe(400)
    const disabled = await send(h, 'POST', '/api/mcp/off/oauth', { session, body: {} })
    expect(disabled.status).toBe(409)
    expect(errorOf(disabled.body)).toMatchObject({ code: 'conflict', details: { reason: 'disabled' } })

    const unknownState = await send(h, 'POST', '/api/mcp/oauth/callback', { session, body: { state: 'never-issued-state-0000', code: 'x' } })
    expect(unknownState.status).toBe(409)
    expect(errorOf(unknownState.body).details).toEqual({ reason: 'stale' })

    const start = mcpAuthStartSchema.parse((await send(h, 'POST', '/api/mcp/fixture/oauth', { session, body: {} })).body)
    const state = new URL(start.authorizationUrl!).searchParams.get('state')!
    const denied = await send(h, 'POST', '/api/mcp/oauth/callback', { session, body: { state, error: 'access_denied', errorDescription: 'Denied by the user.' } })
    expect(denied.status).toBe(502)
    expect(errorOf(denied.body)).toMatchObject({ code: 'auth_invalid', message: 'The authorization server refused the sign-in (access_denied: Denied by the user.).', details: { target: { kind: 'global', serverId: 'fixture' } } })
    expect(JSON.stringify(denied.body)).not.toContain(state)
  })
})
