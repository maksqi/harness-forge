// The MCP OAuth service (W14.1-T5 / T10) end to end against the OAuth MCP fixture (`__fixtures__/oauth-mcp-server.mjs`,
// loopback only, in process): the start URL (S256, state, resource, redirect_uri), the callback, the connected server,
// the refresh after expiry, `invalid_grant` → `needs-auth`, the sign-out with its RFC 7009 revocation, a configured
// client with a secret (`preRegistered`), a plugin server with a templated client id, the guard (`foreignAs`), a server
// without OAuth metadata, the start and callback errors, the flow drops, and the leak test (canary token values in the
// logs, the answers and a backup zip).
import type { McpAuthTarget } from '@harness-forge/shared'
import type { McpTestApp } from '../__fixtures__/harness.ts'
import type { OAuthMcpServer } from '../__fixtures__/oauth-mcp-server.mjs'
import type { McpOAuthRecord } from './store.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HarnessError, mcpAuthStartSchema, mcpServerSchema } from '@harness-forge/shared'
import { strFromU8, unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { TEST_ORIGIN } from '../../testing/create-test-app.ts'
import { readAllBytes } from '../../testing/fakes.ts'
import { callTool, createMcpTestApp, echoStdio, outputJson, waitFor } from '../__fixtures__/harness.ts'
import { FIXTURE_CLIENT_ID, FIXTURE_CLIENT_SECRET, FIXTURE_SCOPE, FIXTURE_SUBJECT, startOAuthMcpServer } from '../__fixtures__/oauth-mcp-server.mjs'
import { NEEDS_AUTH_MESSAGE } from '../errors.ts'
import { AUTHORIZATION_SERVER_REFUSED_MESSAGE, NO_OAUTH_MESSAGE } from './guard.ts'
import { createMcpAuthServiceCore, STALE_SIGN_IN_MESSAGE } from './index.ts'
import { followAuthorization, signIn, TEST_REDIRECT_URI } from './sign-in.test-util.ts'
import { parseRecord } from './store.ts'

const GLOBAL: McpAuthTarget = { kind: 'global', serverId: 'fixture' }

let app: McpTestApp | null = null
let fixture: OAuthMcpServer | null = null

afterEach(async () => {
  await app?.close()
  app = null
  await fixture?.stop()
  fixture = null
})

async function open(toggles: Parameters<typeof startOAuthMcpServer>[0] = {}, options: Parameters<typeof createMcpTestApp>[0] = {}) {
  fixture = await startOAuthMcpServer(toggles)
  app = await createMcpTestApp({ manager: { retryDelaysMs: [20, 20] }, ...options })
  return { h: app, fixture }
}

async function statusOf(h: McpTestApp, id: string, status: string) {
  return waitFor(async () => {
    const server = await h.t.deps.mcp.get(id)
    return server.status === status ? server : null
  })
}

async function recordOf(h: McpTestApp, scope: `mcp:${string}` | `plugin:${string}`, name: string): Promise<McpOAuthRecord | null> {
  const value = await h.t.deps.secrets.get(scope, name)
  return value === null ? null : parseRecord(value)
}

async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  }
  catch (error) {
    expect(error).toBeInstanceOf(HarnessError)
    return error as HarnessError
  }
  throw new Error('expected a rejection')
}

describe('signing in to a personal server', () => {
  it('needs-auth after one connect; the start URL carries S256, state, resource and redirect_uri; the callback connects', async () => {
    const { h, fixture } = await open()
    await h.t.deps.mcp.create({ id: 'fixture', name: 'Fixture', transport: { type: 'http', url: fixture.url } })
    const waiting = await statusOf(h, 'fixture', 'needs-auth')
    expect(mcpServerSchema.parse(waiting)).toMatchObject({ error: { code: 'auth_invalid', status: 401, message: NEEDS_AUTH_MESSAGE }, auth: null, tools: [] })
    await new Promise(resolve => setTimeout(resolve, 300))
    // The background never registers a client or retries.
    expect(fixture.counters()).toMatchObject({ connects: 1, registrations: 0, authorizations: 0 })

    const start = mcpAuthStartSchema.parse(await h.t.deps.mcpAuth.start(GLOBAL, { origin: TEST_ORIGIN, returnTo: '/plugins/core-mcp' }))
    expect(start.redirectUri).toBe(TEST_REDIRECT_URI)
    expect(start.expiresAt).toBeGreaterThan(Date.now() + 9 * 60_000)
    const url = new URL(start.authorizationUrl!)
    expect(url.origin).toBe(fixture.origin)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/)
    expect(url.searchParams.get('state')).toMatch(/^[\w-]{43}$/)
    expect(url.searchParams.get('resource')).toBe(fixture.url)
    expect(url.searchParams.get('redirect_uri')).toBe(TEST_REDIRECT_URI)
    expect(url.searchParams.get('scope')).toBe(FIXTURE_SCOPE)
    expect(fixture.counters()).toMatchObject({ connects: 2, registrations: 1 })

    const redirect = await followAuthorization(start.authorizationUrl!)
    expect(redirect.location.href.startsWith(`${TEST_REDIRECT_URI}?`)).toBe(true)
    const result = await h.t.deps.mcpAuth.complete({ state: redirect.state, code: redirect.code, iss: redirect.iss! }, { origin: TEST_ORIGIN })
    expect(result).toEqual({ target: GLOBAL, status: 'connected', returnTo: '/plugins/core-mcp' })

    const server = mcpServerSchema.parse(await h.t.deps.mcp.get('fixture'))
    expect(server.status).toBe('connected')
    expect(server.tools).toContain('mcp__fixture__whoami')
    expect(server.auth).toEqual({ signedIn: true, expiresAt: expect.any(Number), scope: FIXTURE_SCOPE, client: 'dynamic', issuer: fixture.origin })
    expect(outputJson(await callTool(h.t, 'mcp__fixture__whoami'))).toMatchObject({ subject: FIXTURE_SUBJECT, scope: FIXTURE_SCOPE })
    const record = await recordOf(h, 'mcp:fixture', 'oauth.record')
    expect(record).toMatchObject({ v: 1, resource: fixture.url, client: { dynamic: true, redirectUris: [TEST_REDIRECT_URI] }, as: { issuer: fixture.origin } })
    expect(record?.tokens?.access_token).toEqual(expect.any(String))

    // The callback is single use.
    const replay = await rejection(h.t.deps.mcpAuth.complete({ state: redirect.state, code: redirect.code }, { origin: TEST_ORIGIN }))
    expect(replay.toJSON().error).toMatchObject({ code: 'conflict', message: STALE_SIGN_IN_MESSAGE, details: { reason: 'stale' } })
  })

  it('a refresh after expiry is saved; a stored refresh token answers the next start without a redirect; invalid_grant is needs-auth', async () => {
    const { h, fixture } = await open({ toggles: { tokenLifeSec: 1 } })
    await h.t.deps.mcp.create({ id: 'fixture', name: 'Fixture', transport: { type: 'http', url: fixture.url } })
    await statusOf(h, 'fixture', 'needs-auth')
    await signIn(h.t, GLOBAL)
    const first = await recordOf(h, 'mcp:fixture', 'oauth.record')
    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(outputJson(await callTool(h.t, 'mcp__fixture__whoami'))).toMatchObject({ subject: FIXTURE_SUBJECT })
    expect(fixture.counters().refreshes).toBe(1)
    const refreshed = await recordOf(h, 'mcp:fixture', 'oauth.record')
    expect(refreshed?.tokens?.access_token).not.toBe(first?.tokens?.access_token)
    expect(refreshed?.tokens?.obtainedAt).toBeGreaterThan(first!.tokens!.obtainedAt)

    // A start with a working refresh token: no browser round trip.
    const again = await h.t.deps.mcpAuth.start(GLOBAL, { origin: TEST_ORIGIN, returnTo: null })
    expect(again).toEqual({ authorizationUrl: null, redirectUri: TEST_REDIRECT_URI, expiresAt: expect.any(Number) })
    expect(fixture.counters()).toMatchObject({ refreshes: 2, authorizations: 1 })
    expect((await h.t.deps.mcp.get('fixture')).status).toBe('connected')

    // Every token revoked at the authorization server: the refresh is refused (invalid_grant) → needs-auth.
    fixture.revokeAll()
    await expect(callTool(h.t, 'mcp__fixture__whoami')).rejects.toThrow()
    const dropped = await statusOf(h, 'fixture', 'needs-auth')
    expect(dropped.error).toMatchObject({ code: 'auth_invalid', status: 401 })
    expect(dropped.auth).toMatchObject({ signedIn: false, client: 'dynamic' })
    expect((await recordOf(h, 'mcp:fixture', 'oauth.record'))?.tokens).toBeUndefined()
  })

  it('sign-out deletes the record (the configured client secret stays), revokes the token and leaves needs-auth', async () => {
    const { h, fixture } = await open({ toggles: { preRegistered: true } })
    await h.t.deps.mcp.create({ id: 'fixture', name: 'Fixture', transport: { type: 'http', url: fixture.url, oauth: { clientId: FIXTURE_CLIENT_ID, clientSecret: FIXTURE_CLIENT_SECRET, scopes: 'mcp:read' } } })
    await statusOf(h, 'fixture', 'needs-auth')
    const { authorizationUrl } = await signIn(h.t, GLOBAL)
    expect(new URL(authorizationUrl).searchParams.get('client_id')).toBe(FIXTURE_CLIENT_ID)
    expect(new URL(authorizationUrl).searchParams.get('scope')).toBe('mcp:read')
    expect(fixture.counters()).toMatchObject({ registrations: 0, tokens: 1 })
    const server = await h.t.deps.mcp.get('fixture')
    expect(server).toMatchObject({ status: 'connected', auth: { signedIn: true, client: 'configured', scope: 'mcp:read' } })
    expect(outputJson(await callTool(h.t, 'mcp__fixture__whoami'))).toMatchObject({ clientId: FIXTURE_CLIENT_ID })
    expect(JSON.stringify(await h.t.deps.mcp.list())).not.toContain(FIXTURE_CLIENT_SECRET)

    await h.t.deps.mcpAuth.signOut(GLOBAL)
    expect(fixture.counters().revocations).toBe(1)
    expect(await h.t.deps.secrets.get('mcp:fixture', 'oauth.record')).toBeNull()
    expect(await h.t.deps.secrets.get('mcp:fixture', 'oauth.clientSecret')).toBe(FIXTURE_CLIENT_SECRET)
    const after = await h.t.deps.mcp.get('fixture')
    expect(after).toMatchObject({ status: 'needs-auth', auth: null })
    // Idempotent.
    await h.t.deps.mcpAuth.signOut(GLOBAL)
    expect(fixture.counters().revocations).toBe(1)
  })

  it('refuses an authorization server the guard does not allow, before any request reaches it', async () => {
    for (const foreign of ['http://169.254.169.254/', 'http://10.0.0.1/']) {
      const { h, fixture } = await open({ toggles: { foreignAs: foreign } })
      await h.t.deps.mcp.create({ id: 'fixture', name: 'Fixture', transport: { type: 'http', url: fixture.url } })
      await statusOf(h, 'fixture', 'needs-auth')
      const error = await rejection(h.t.deps.mcpAuth.start(GLOBAL, { origin: TEST_ORIGIN, returnTo: null }))
      expect(error.toJSON().error).toMatchObject({ code: 'provider_error', message: AUTHORIZATION_SERVER_REFUSED_MESSAGE })
      expect(error.httpStatus).toBe(502)
      expect(fixture.counters()).toMatchObject({ registrations: 0, authorizations: 0 })
      await app?.close()
      app = null
      await fixture.stop()
    }
    fixture = null
  })

  it('a 401 without OAuth metadata gives the clearer message', async () => {
    const { h, fixture } = await open({ toggles: { noMetadata: true } })
    await h.t.deps.mcp.create({ id: 'fixture', name: 'Fixture', transport: { type: 'http', url: fixture.url } })
    await statusOf(h, 'fixture', 'needs-auth')
    const error = await rejection(h.t.deps.mcpAuth.start(GLOBAL, { origin: TEST_ORIGIN, returnTo: null }))
    expect(error.toJSON().error).toMatchObject({ code: 'provider_error', message: NO_OAUTH_MESSAGE })
    expect(fixture.counters()).toMatchObject({ registrations: 0, authorizations: 0 })
  })

  it('a server that answers without credentials needs no sign-in (it reconnects)', async () => {
    const { h, fixture } = await open({ toggles: { noAuth: true } })
    await h.t.deps.mcp.create({ id: 'fixture', name: 'Fixture', transport: { type: 'http', url: fixture.url } })
    await statusOf(h, 'fixture', 'connected')
    expect(await h.t.deps.mcpAuth.start(GLOBAL, { origin: TEST_ORIGIN, returnTo: null })).toMatchObject({ authorizationUrl: null, redirectUri: TEST_REDIRECT_URI })
    expect((await h.t.deps.mcp.get('fixture')).status).toBe('connected')
  })

  it('the start rules: 404 unknown, 400 stdio and an Authorization header, 409 disabled, 400 an origin that is no URL', async () => {
    const { h, fixture } = await open()
    await h.t.deps.mcp.create({ id: 'local', name: 'Local', enabled: false, transport: echoStdio() })
    await h.t.deps.mcp.create({ id: 'keyed', name: 'Keyed', enabled: false, transport: { type: 'http', url: fixture.url, headers: { Authorization: 'Bearer own-key-123456' } } })
    await h.t.deps.mcp.create({ id: 'off', name: 'Off', enabled: false, transport: { type: 'http', url: fixture.url } })
    const start = (serverId: string, origin = TEST_ORIGIN) => rejection(h.t.deps.mcpAuth.start({ kind: 'global', serverId }, { origin, returnTo: null }))
    expect((await start('nope')).code).toBe('not_found')
    expect((await start('local')).toJSON().error).toMatchObject({ code: 'validation_error' })
    expect((await start('keyed')).toJSON().error).toMatchObject({ code: 'validation_error', message: 'This server is set up with its own Authorization header, so it does not sign in.' })
    expect((await start('off')).toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'disabled' } })
    expect((await start('off', 'javascript:alert(1)')).code).toBe('validation_error')
    await expect(h.t.deps.mcpAuth.signOut({ kind: 'global', serverId: 'local' })).rejects.toMatchObject({ code: 'validation_error' })
    await expect(h.t.deps.mcpAuth.signOut({ kind: 'global', serverId: 'nope' })).rejects.toMatchObject({ code: 'not_found' })
    expect(fixture.counters().connects).toBe(0)
  })
})

describe('the callback', () => {
  it('unknown, replayed, expired or another origin → 409 stale; an error → 502 with plain text; a foreign iss → 400', async () => {
    const { h, fixture } = await open()
    await h.t.deps.mcp.create({ id: 'fixture', name: 'Fixture', transport: { type: 'http', url: fixture.url } })
    await statusOf(h, 'fixture', 'needs-auth')
    const complete = (body: Parameters<typeof h.t.deps.mcpAuth.complete>[0], origin = TEST_ORIGIN) => rejection(h.t.deps.mcpAuth.complete(body, { origin }))

    expect((await complete({ state: 'unknown-state-0000000', code: 'x' })).toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'stale' } })

    // Another origin: the flow is used up.
    let start = await h.t.deps.mcpAuth.start(GLOBAL, { origin: TEST_ORIGIN, returnTo: null })
    let redirect = await followAuthorization(start.authorizationUrl!)
    expect((await complete({ state: redirect.state, code: redirect.code }, 'http://localhost:3000')).toJSON().error).toMatchObject({ details: { reason: 'stale' } })
    expect((await complete({ state: redirect.state, code: redirect.code })).toJSON().error).toMatchObject({ details: { reason: 'stale' } })

    // The authorization server's error: its text as plain text, the target named.
    start = await h.t.deps.mcpAuth.start(GLOBAL, { origin: TEST_ORIGIN, returnTo: null })
    const state = new URL(start.authorizationUrl!).searchParams.get('state')!
    const denied = (await complete({ state, error: 'access_denied', errorDescription: `The user said no.${'x'.repeat(400)}` })).toJSON().error
    expect(denied).toMatchObject({ code: 'auth_invalid', details: { target: GLOBAL } })
    expect(denied.message.startsWith('The authorization server refused the sign-in (access_denied: The user said no.')).toBe(true)
    expect(denied.message.length).toBeLessThanOrEqual(300)

    // An `iss` of another server.
    start = await h.t.deps.mcpAuth.start(GLOBAL, { origin: TEST_ORIGIN, returnTo: null })
    redirect = await followAuthorization(start.authorizationUrl!)
    expect((await complete({ state: redirect.state, code: redirect.code, iss: 'https://evil.example.com' })).toJSON().error).toMatchObject({ code: 'validation_error', details: { target: GLOBAL } })

    // A refused code (used before): 502 auth_invalid.
    start = await h.t.deps.mcpAuth.start(GLOBAL, { origin: TEST_ORIGIN, returnTo: null })
    const fresh = await followAuthorization(start.authorizationUrl!)
    const refused = (await complete({ state: fresh.state, code: redirect.code })).toJSON().error
    expect(refused).toMatchObject({ code: 'auth_invalid', details: { target: GLOBAL } })
    expect(fixture.counters().tokens).toBeGreaterThanOrEqual(1)
    expect((await h.t.deps.mcp.get('fixture')).status).toBe('needs-auth')
  })

  it('an expired flow is stale; key rotation, the deletion of the server and stop() drop pending flows', async () => {
    const { h, fixture } = await open()
    await h.t.deps.mcp.create({ id: 'fixture', name: 'Fixture', transport: { type: 'http', url: fixture.url } })
    await statusOf(h, 'fixture', 'needs-auth')
    const pending = (service: ReturnType<typeof createMcpAuthServiceCore>) => {
      try {
        service.provider(GLOBAL, 'callback')
        return true
      }
      catch {
        return false
      }
    }

    const short = createMcpAuthServiceCore(h.t.deps, { flowTtlMs: 30 })
    const expiring = await short.start(GLOBAL, { origin: TEST_ORIGIN, returnTo: null })
    const late = await followAuthorization(expiring.authorizationUrl!)
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(pending(short)).toBe(false)
    await expect(short.complete({ state: late.state, code: late.code }, { origin: TEST_ORIGIN })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'stale' } })
    await short.stop()

    const service = createMcpAuthServiceCore(h.t.deps)
    const rotated = await service.start(GLOBAL, { origin: TEST_ORIGIN, returnTo: null })
    expect(pending(service)).toBe(true)
    h.events.emit('key.rotated', { keyVersion: 2, rotatedAt: Date.now(), chatIds: [] })
    expect(pending(service)).toBe(false)
    await expect(service.complete({ state: new URL(rotated.authorizationUrl!).searchParams.get('state')!, code: 'x' }, { origin: TEST_ORIGIN })).rejects.toMatchObject({ details: { reason: 'stale' } })

    await service.start(GLOBAL, { origin: TEST_ORIGIN, returnTo: null })
    expect(pending(service)).toBe(true)
    h.events.clear()
    await h.t.deps.mcp.remove('fixture')
    await waitFor(() => h.events.ofType('plugin.changed').length > 0)
    expect(pending(service)).toBe(false)

    await h.t.deps.mcp.create({ id: 'fixture', name: 'Fixture', transport: { type: 'http', url: fixture.url } })
    const stopped = await service.start(GLOBAL, { origin: TEST_ORIGIN, returnTo: null })
    await service.stop()
    expect(pending(service)).toBe(false)
    await expect(service.complete({ state: new URL(stopped.authorizationUrl!).searchParams.get('state')!, code: 'x' }, { origin: TEST_ORIGIN })).rejects.toMatchObject({ details: { reason: 'stale' } })
    await expect(service.start(GLOBAL, { origin: TEST_ORIGIN, returnTo: null })).rejects.toMatchObject({ code: 'conflict' })
  })
})

describe('plugin servers', () => {
  it('a declaration whose client id is {{settings.clientId}} signs in with the configured client; the record lives in the plugin scope', async () => {
    fixture = await startOAuthMcpServer({ toggles: { preRegistered: true } })
    const url = fixture.url
    app = await createMcpTestApp({
      beforeStart: async (t) => {
        const manifest = {
          manifestVersion: 1,
          id: 'oauth-plugin',
          name: 'OAuth plugin',
          version: '1.0.0',
          engines: { harness: '^1.0.0' },
          settings: { type: 'object', properties: { clientId: { type: 'string', title: 'Client id', default: 'seed-plugin-client' } } },
          contributes: { mcpServers: [{ id: 'oauth-plugin', name: 'OAuth', transport: { type: 'http', url, oauth: { clientId: '{{settings.clientId}}', scopes: 'mcp:read' } } }] },
        }
        const dir = join(t.env.paths.plugins, 'oauth-plugin')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`)
        await t.deps.plugins.saveRecord({ id: 'oauth-plugin', source: 'copy', version: '1.0.0' })
      },
    })
    const h = app
    const target: McpAuthTarget = { kind: 'global', serverId: 'oauth-plugin' }
    await statusOf(h, 'oauth-plugin', 'needs-auth')
    expect(h.t.deps.mcp.authTarget('oauth-plugin')).toEqual({ kind: 'plugin', scope: 'plugin:oauth-plugin', name: 'mcp-oauth.oauth-plugin' })
    const { authorizationUrl, result } = await signIn(h.t, target)
    expect(new URL(authorizationUrl).searchParams.get('client_id')).toBe('seed-plugin-client')
    expect(result.status).toBe('connected')
    expect(fixture.counters().registrations).toBe(0)
    expect(await recordOf(h, 'plugin:oauth-plugin', 'mcp-oauth.oauth-plugin')).toMatchObject({ clientId: 'seed-plugin-client', client: { dynamic: false } })
    expect((await h.t.deps.mcp.get('oauth-plugin')).auth).toMatchObject({ signedIn: true, client: 'configured' })

    // Another client id in the settings: the record no longer matches (ignored); an empty one is named at sign-in.
    await h.t.deps.plugins.updateSettings('oauth-plugin', { clientId: 'seed-client' })
    await waitFor(async () => (await h.t.deps.mcp.get('oauth-plugin')).auth === null)
    await h.t.deps.plugins.updateSettings('oauth-plugin', { clientId: '' })
    await waitFor(async () => (await h.t.deps.mcp.get('oauth-plugin')).status === 'needs-auth')
    await expect(h.t.deps.mcpAuth.start(target, { origin: TEST_ORIGIN, returnTo: null })).rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('"clientId"') })

    // Uninstalling the plugin (without keeping its data) removes the record with the plugin's secret scope.
    expect(await h.t.deps.secrets.get('plugin:oauth-plugin', 'mcp-oauth.oauth-plugin')).not.toBeNull()
    await h.t.deps.plugins.uninstall('oauth-plugin', { keepData: false })
    expect(await h.t.deps.secrets.get('plugin:oauth-plugin', 'mcp-oauth.oauth-plugin')).toBeNull()
  })
})

describe('hygiene (W14.1-T10)', () => {
  it('tokens, codes, states and verifiers never reach a log line, an answer or a backup', async () => {
    const { h } = await open()
    await h.t.deps.mcp.create({ id: 'fixture', name: 'Fixture', transport: { type: 'http', url: fixture!.url } })
    await statusOf(h, 'fixture', 'needs-auth')
    const { redirect, authorizationUrl } = await signIn(h.t, GLOBAL)
    await callTool(h.t, 'mcp__fixture__whoami')
    const record = await recordOf(h, 'mcp:fixture', 'oauth.record')
    const canaries = [record!.tokens!.access_token, record!.tokens!.refresh_token!, redirect.code, redirect.state, new URL(authorizationUrl).searchParams.get('code_challenge')!]
    expect(canaries.every(value => value.length >= 16)).toBe(true)
    h.t.deps.logger.info(`a careless line ${record!.tokens!.access_token}`)

    const answers = [
      await (await h.t.request('/api/mcp')).text(),
      JSON.stringify(await h.t.deps.mcp.get('fixture')),
      JSON.stringify(await h.t.deps.mcpAuth.info(GLOBAL)),
    ]
    const logs = JSON.stringify(h.t.logs.records) + JSON.stringify(await h.t.deps.plugins.logs('core-mcp'))
    const entries = unzipSync(await readAllBytes((await h.t.deps.data.exportBackup({})).stream))
    const backup = Object.values(entries).map(bytes => strFromU8(bytes)).join('\n')
    for (const canary of canaries) {
      for (const text of [...answers, logs, backup])
        expect(text.includes(canary)).toBe(false)
    }
    // The sign-in steps are logged with the server id, the origin kind, the step and the outcome.
    expect(h.t.logs.records.some(entry => entry.msg === 'MCP sign-in' && (entry as Record<string, unknown>).step === 'callback' && (entry as Record<string, unknown>).outcome === 'signed-in' && (entry as Record<string, unknown>).origin === 'user')).toBe(true)
  })
})
