// Smoke tests of the OAuth MCP fixture (Phase 14, C53-T3): every endpoint, tool, prompt, resource, toggle and counter,
// driven with the real client of `@ai-sdk/mcp` (`createMCPClient`, `auth`) over loopback only; the stdio variant's
// notifications with the client of `@modelcontextprotocol/sdk`. No custom `fetch` is passed to any MCP transport.
import type { ElicitationRequest, ElicitResult, MCPClient, OAuthClientInformation, OAuthClientProvider, OAuthTokens } from '@ai-sdk/mcp'
import type { OAuthMcpServer } from './oauth-mcp-server.mjs'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { auth, createMCPClient, ElicitationRequestSchema } from '@ai-sdk/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { PromptListChangedNotificationSchema, ResourceListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COUNTER_NAMES,
  DEFAULT_PRE_REGISTERED_CLIENTS,
  ELICITATION_FORM_NAMES,
  ELICITATION_FORMS,
  FIXTURE_CLIENT_ID,
  FIXTURE_CLIENT_SECRET,
  FIXTURE_PROMPTS,
  FIXTURE_RESOURCES,
  FIXTURE_SCOPE,
  LARGE_RESOURCE_BYTES,
  LARGE_URI,
  PIXEL_URI,
  README_TEXT,
  README_URI,
  startOAuthMcpServer,
  TOUCHED_URI,
} from './oauth-mcp-server.mjs'

const FIXTURE_PATH = fileURLToPath(new URL('./oauth-mcp-server.mjs', import.meta.url))
const REDIRECT_URL = 'http://127.0.0.1:9/oauth/callback'
const STATE = 'state-fixture-1'

let fixture: OAuthMcpServer
const clients: MCPClient[] = []

beforeEach(async () => {
  fixture = await startOAuthMcpServer()
})

afterEach(async () => {
  vi.useRealTimers()
  for (const client of clients.splice(0))
    await client.close().catch(() => {})
  await fixture.stop()
})

// ---------- helpers ----------

interface MemoryProvider {
  provider: OAuthClientProvider
  store: { client?: OAuthClientInformation, tokens?: OAuthTokens, verifier?: string, state?: string, authorizationUrl?: URL, as?: { issuer?: string, authorizationServerUrl: string, tokenEndpoint: string } }
}

/** An in-memory OAuth provider (a dynamically registered public client unless `client` is given). */
function memoryProvider(client?: OAuthClientInformation): MemoryProvider {
  const store: MemoryProvider['store'] = client === undefined ? {} : { client }
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return REDIRECT_URL
    },
    get clientMetadata() {
      return { redirect_uris: [REDIRECT_URL], client_name: 'Fixture test', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }
    },
    clientInformation: () => store.client,
    saveClientInformation: (info) => {
      store.client = info
    },
    isClientInformationDynamicallyRegistered: () => client === undefined,
    tokens: () => store.tokens,
    saveTokens: (tokens) => {
      store.tokens = tokens
    },
    redirectToAuthorization: (url) => {
      store.authorizationUrl = url
    },
    saveCodeVerifier: (verifier) => {
      store.verifier = verifier
    },
    codeVerifier: () => store.verifier ?? '',
    state: () => STATE,
    saveState: (value) => {
      store.state = value
    },
    storedState: () => store.state,
    authorizationServerInformation: () => store.as,
    saveAuthorizationServerInformation: (info) => {
      store.as = info
    },
  }
  return { provider, store }
}

/** Follows the authorization URL without following its redirect: the callback's query. */
async function authorizeRedirect(url: URL | string): Promise<URL> {
  const response = await fetch(url, { redirect: 'manual' })
  expect(response.status).toBe(302)
  return new URL(response.headers.get('location') ?? '')
}

/** The whole sign-in: start, authorize (auto-approved), exchange the code. */
async function signIn(memory: MemoryProvider): Promise<void> {
  expect(await auth(memory.provider, { serverUrl: fixture.url })).toBe('REDIRECT')
  const callback = await authorizeRedirect(memory.store.authorizationUrl!)
  expect(await auth(memory.provider, {
    serverUrl: fixture.url,
    authorizationCode: callback.searchParams.get('code') ?? '',
    callbackState: callback.searchParams.get('state') ?? '',
    callbackIssuer: callback.searchParams.get('iss') ?? '',
  })).toBe('AUTHORIZED')
}

async function connect(options: { provider?: OAuthClientProvider, headers?: Record<string, string>, elicitation?: boolean, onElicit?: (request: ElicitationRequest) => ElicitResult | Promise<ElicitResult> } = {}): Promise<MCPClient> {
  const client = await createMCPClient({
    transport: { type: 'http', url: fixture.url, redirect: 'error', ...(options.provider ? { authProvider: options.provider } : {}), ...(options.headers ? { headers: options.headers } : {}) },
    ...(options.elicitation === false ? {} : { capabilities: { elicitation: {} } }),
    experimental_events: undefined,
  })
  clients.push(client)
  if (options.onElicit)
    client.onElicitationRequest(ElicitationRequestSchema, options.onElicit)
  return client
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

/** The first text content of a tool result. */
function text(result: unknown): string {
  const content = (result as { content?: Array<{ type: string, text?: string }> }).content
  return content?.find(part => part.type === 'text')?.text ?? ''
}

function form(body: Record<string, string>): { method: 'POST', headers: Record<string, string>, body: string } {
  return { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() }
}

function challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/** An authorization URL of the pre-registered client (PKCE with `verifier`). */
function authorizeUrl(params: Record<string, string>, verifier = 'v'.repeat(43)): string {
  const url = new URL('/authorize', fixture.origin)
  const all = { response_type: 'code', client_id: FIXTURE_CLIENT_ID, redirect_uri: REDIRECT_URL, code_challenge: challenge(verifier), code_challenge_method: 'S256', state: STATE, resource: fixture.url, ...params }
  for (const [key, value] of Object.entries(all)) {
    if (value !== '')
      url.searchParams.set(key, value)
  }
  return url.href
}

async function postMcp(headers: Record<string, string> = {}): Promise<Response> {
  return fetch(fixture.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
  })
}

// ---------- the MCP endpoint and the metadata ----------

describe('oAuth MCP fixture: the MCP endpoint', () => {
  it('answers 401 with the challenge until a valid Bearer arrives; counts connects and 401s', async () => {
    const response = await postMcp()
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${fixture.origin}/.well-known/oauth-protected-resource/mcp", scope="${FIXTURE_SCOPE}"`)
    const invalid = await postMcp(bearer('at_unknown'))
    expect(invalid.status).toBe(401)
    expect(invalid.headers.get('www-authenticate')).toContain('error="invalid_token"')
    expect(fixture.counters()).toMatchObject({ connects: 2, unauthorized: 2 })
    expect(Object.keys(fixture.counters())).toEqual([...COUNTER_NAMES])
  })

  it('a client without tokens whose provider refuses to sign in (connect mode) makes exactly one connect attempt', async () => {
    class AuthRequired extends Error {}
    const provider: OAuthClientProvider = {
      ...memoryProvider().provider,
      redirectUrl: REDIRECT_URL,
      clientMetadata: { redirect_uris: [REDIRECT_URL] },
      tokens: () => undefined,
      clientInformation: () => {
        throw new AuthRequired('Sign in first.')
      },
    }
    await expect(connect({ provider })).rejects.toBeInstanceOf(AuthRequired)
    // `server/discover` (401), the client's early GET stream (401) and `initialize` (401): one connect, no retry.
    expect(fixture.counters()).toMatchObject({ connects: 1, discovers: 1, unauthorized: 3, registrations: 0, authorizations: 0, tokens: 0 })
  })

  it('serves the protected-resource and authorization-server metadata (no OpenID document)', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      expect(await (await fetch(`${fixture.origin}${path}`)).json()).toEqual({
        resource: fixture.url,
        authorization_servers: [fixture.origin],
        scopes_supported: ['mcp:read', 'mcp:write'],
        bearer_methods_supported: ['header'],
        resource_name: 'OAuth MCP fixture',
      })
    }
    expect(await (await fetch(`${fixture.origin}/.well-known/oauth-authorization-server`)).json()).toMatchObject({
      issuer: fixture.origin,
      authorization_endpoint: `${fixture.origin}/authorize`,
      token_endpoint: `${fixture.origin}/token`,
      registration_endpoint: `${fixture.origin}/register`,
      revocation_endpoint: `${fixture.origin}/revoke`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    })
    expect((await fetch(`${fixture.origin}/.well-known/openid-configuration`)).status).toBe(404)
  })

  it('signs in with dynamic registration, PKCE S256, state and resource, then serves the tools with the token', async () => {
    const memory = memoryProvider()
    await signIn(memory)
    const start = memory.store.authorizationUrl!
    expect(Object.fromEntries(start.searchParams)).toMatchObject({ response_type: 'code', code_challenge_method: 'S256', state: STATE, resource: fixture.url, redirect_uri: REDIRECT_URL, scope: FIXTURE_SCOPE })
    expect(memory.store.tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: FIXTURE_SCOPE })
    expect(memory.store.client?.client_id).toMatch(/^dyn_/)
    expect(memory.store.client?.client_secret).toBeUndefined()
    const client = await connect({ provider: memory.provider })
    expect(Object.keys(await client.tools()).sort()).toEqual(['ask', 'ask_echo', 'slow_ask', 'whoami'])
    const whoami = JSON.parse(text(await client.callTool({ name: 'whoami' }))) as Record<string, unknown>
    expect(whoami).toEqual({ subject: 'fixture-user', clientId: memory.store.client?.client_id, scope: FIXTURE_SCOPE })
    // `server/discover` (protocol 2026-07-28) falls back to `initialize`: one connect.
    expect(fixture.counters()).toMatchObject({ registrations: 1, authorizations: 1, tokens: 1, connects: 1, discovers: 1, toolCalls: 1, unauthorized: 0 })
    expect(client.initializeResult.protocolVersion).toBe('2025-11-25')
  })

  it('refreshes with rotation; a used refresh token, a revoked one and revokeAll answer invalid_grant', async () => {
    const memory = memoryProvider()
    await signIn(memory)
    const first = memory.store.tokens!
    // Tokens expire: Date only is faked, so the HTTP machinery keeps its real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 3601_000)
    expect((await postMcp(bearer(first.access_token))).status).toBe(401)
    expect(await auth(memory.provider, { serverUrl: fixture.url })).toBe('AUTHORIZED')
    const second = memory.store.tokens!
    expect(second.access_token).not.toBe(first.access_token)
    expect(second.refresh_token).not.toBe(first.refresh_token)
    expect(fixture.counters().refreshes).toBe(1)
    const reuse = await fetch(`${fixture.origin}/token`, form({ grant_type: 'refresh_token', refresh_token: first.refresh_token ?? '', client_id: memory.store.client!.client_id }))
    expect(reuse.status).toBe(400)
    expect(await reuse.json()).toMatchObject({ error: 'invalid_grant' })
    fixture.revokeAll()
    const revoked = await fetch(`${fixture.origin}/token`, form({ grant_type: 'refresh_token', refresh_token: second.refresh_token ?? '', client_id: memory.store.client!.client_id }))
    expect(await revoked.json()).toMatchObject({ error: 'invalid_grant' })
    expect((await postMcp(bearer(second.access_token))).status).toBe(401)
  })

  it('revokes access and refresh tokens (RFC 7009) and counts the calls', async () => {
    const pair = fixture.issueToken()
    expect((await postMcp(bearer(pair.accessToken))).status).toBe(200)
    expect((await fetch(`${fixture.origin}/revoke`, form({ token: pair.accessToken, client_id: FIXTURE_CLIENT_ID }))).status).toBe(200)
    expect((await postMcp(bearer(pair.accessToken))).status).toBe(401)
    const other = fixture.issueToken()
    expect((await fetch(`${fixture.origin}/revoke`, form({ token: other.refreshToken, client_id: FIXTURE_CLIENT_ID }))).status).toBe(200)
    expect((await postMcp(bearer(other.accessToken))).status).toBe(401)
    expect((await fetch(`${fixture.origin}/revoke`, form({ token: other.accessToken, client_id: 'nobody' }))).status).toBe(401)
    expect(fixture.counters().revocations).toBe(3)
  })
})

// ---------- authorize and token checks ----------

describe('oAuth MCP fixture: /authorize and /token', () => {
  it('pre-registers the public seed clients; PKCE, single-use codes and the redirect URI are checked', async () => {
    expect(DEFAULT_PRE_REGISTERED_CLIENTS).toEqual(['fixture-client', 'seed-client', 'seed-plugin-client'])
    for (const clientId of DEFAULT_PRE_REGISTERED_CLIENTS) {
      const verifier = `${clientId}-verifier-${'x'.repeat(30)}`
      const callback = await authorizeRedirect(authorizeUrl({ client_id: clientId, redirect_uri: 'http://localhost:3000/oauth/callback' }, verifier))
      expect(callback.searchParams.get('state')).toBe(STATE)
      expect(callback.searchParams.get('iss')).toBe(fixture.origin)
      const code = callback.searchParams.get('code') ?? ''
      const bad = await fetch(`${fixture.origin}/token`, form({ grant_type: 'authorization_code', code, code_verifier: 'wrong', redirect_uri: 'http://localhost:3000/oauth/callback', client_id: clientId }))
      expect(await bad.json()).toMatchObject({ error: 'invalid_grant' })
      // The failed exchange used the code up.
      const reused = await fetch(`${fixture.origin}/token`, form({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'http://localhost:3000/oauth/callback', client_id: clientId }))
      expect(await reused.json()).toMatchObject({ error: 'invalid_grant' })
    }
    // A public seed client may not present a secret; fixture-client may present only its own.
    const verifier = 'w'.repeat(43)
    const exchange = async (clientId: string, extra: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> => {
      const code = (await authorizeRedirect(authorizeUrl({ client_id: clientId }, verifier))).searchParams.get('code') ?? ''
      const request = form({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT_URL, ...extra })
      return fetch(`${fixture.origin}/token`, { ...request, headers: { ...request.headers, ...headers } })
    }
    expect((await exchange('seed-client', { client_id: 'seed-client' })).status).toBe(200)
    expect((await exchange('seed-client', { client_id: 'seed-client', client_secret: 'x' })).status).toBe(401)
    expect((await exchange(FIXTURE_CLIENT_ID, { client_id: FIXTURE_CLIENT_ID })).status).toBe(200)
    expect((await exchange(FIXTURE_CLIENT_ID, {}, { authorization: `Basic ${Buffer.from(`${FIXTURE_CLIENT_ID}:${FIXTURE_CLIENT_SECRET}`).toString('base64')}` })).status).toBe(200)
    const wrong = await exchange(FIXTURE_CLIENT_ID, { client_id: FIXTURE_CLIENT_ID, client_secret: 'nope' })
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toMatchObject({ error: 'invalid_client' })
  })

  it('validates the authorization request: client, redirect URI, response type, PKCE, state and resource', async () => {
    const page = await fetch(authorizeUrl({ client_id: 'unknown' }), { redirect: 'manual' })
    expect(page.status).toBe(400)
    expect(await page.text()).toContain('Unknown client')
    expect((await fetch(authorizeUrl({ redirect_uri: 'javascript:alert(1)' }), { redirect: 'manual' })).status).toBe(400)
    const errorOf = async (params: Record<string, string>): Promise<string | null> => (await authorizeRedirect(authorizeUrl(params))).searchParams.get('error')
    expect(await errorOf({ response_type: 'token' })).toBe('unsupported_response_type')
    expect(await errorOf({ code_challenge_method: 'plain' })).toBe('invalid_request')
    expect(await errorOf({ code_challenge: '' })).toBe('invalid_request')
    expect(await errorOf({ resource: 'http://127.0.0.1:1/other' })).toBe('invalid_target')
    const noState = await authorizeRedirect(authorizeUrl({ state: '' }))
    expect([noState.searchParams.get('error'), noState.searchParams.get('state')]).toEqual(['invalid_request', null])
    expect(fixture.counters().authorizations).toBe(7)
  })

  it('refuses a registration without http(s) redirect URIs and an unknown grant type', async () => {
    const response = await fetch(`${fixture.origin}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['ftp://x'] }) })
    expect(response.status).toBe(400)
    const confidential = await (await fetch(`${fixture.origin}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT_URL] }) })).json() as Record<string, unknown>
    expect(confidential).toMatchObject({ token_endpoint_auth_method: 'client_secret_basic', client_secret: expect.stringMatching(/^cs_/) })
    expect(fixture.counters().registrations).toBe(2)
    const grant = await fetch(`${fixture.origin}/token`, form({ grant_type: 'password', client_id: FIXTURE_CLIENT_ID }))
    expect(await grant.json()).toMatchObject({ error: 'unsupported_grant_type' })
  })
})

// ---------- tools ----------

describe('oAuth MCP fixture: tools', () => {
  it('ask elicits every form and answers the action and the field names, never the values', async () => {
    const requests: ElicitationRequest[] = []
    const token = fixture.issueToken().accessToken
    const client = await connect({
      headers: bearer(token),
      onElicit: (request) => {
        requests.push(request)
        return { action: 'accept', content: { name: 'Ada', email: 'ada@example.com' } }
      },
    })
    expect(JSON.parse(text(await client.callTool({ name: 'ask' })))).toEqual({ action: 'accept', fields: ['name', 'email'] })
    expect(requests[0]?.params).toMatchObject({ message: ELICITATION_FORMS.basic.message, requestedSchema: { type: 'object', required: ['name'] } })
    for (const formName of ELICITATION_FORM_NAMES)
      await client.callTool({ name: 'ask', arguments: { form: formName } })
    expect(requests.map(request => (request.params as { mode?: string }).mode ?? 'form')).toEqual(['form', 'form', 'form', 'form', 'form', 'form', 'url'])
    expect(requests.at(-1)?.params).toMatchObject({ mode: 'url', url: 'https://example.invalid/fixture-elicit' })
    expect(Object.keys((requests[2]?.params as { requestedSchema: { properties: object } }).requestedSchema.properties)).toHaveLength(12)
    expect(fixture.counters()).toMatchObject({ elicitations: 7, toolCalls: 7 })
  })

  it('ask_echo answers the content; a decline answers no fields; a client without the capability gets an error', async () => {
    const token = fixture.issueToken().accessToken
    let action: 'accept' | 'decline' = 'accept'
    const client = await connect({ headers: bearer(token), onElicit: () => (action === 'accept' ? { action, content: { name: 'Bo', count: 3 } } : { action }) })
    expect(JSON.parse(text(await client.callTool({ name: 'ask_echo' })))).toEqual({ action: 'accept', content: { name: 'Bo', count: 3 } })
    action = 'decline'
    expect(JSON.parse(text(await client.callTool({ name: 'ask' })))).toEqual({ action: 'decline', fields: [] })
    expect(JSON.parse(text(await client.callTool({ name: 'ask_echo' })))).toEqual({ action: 'decline', content: null })
    const plain = await connect({ headers: bearer(token), elicitation: false })
    const refused = await plain.callTool({ name: 'ask' })
    expect([refused.isError, text(refused)]).toEqual([true, 'The client does not support elicitation.'])
  })

  it('slow_ask waits 2 s before it asks', async () => {
    const token = fixture.issueToken().accessToken
    let askedAt = 0
    const client = await connect({
      headers: bearer(token),
      onElicit: () => {
        askedAt = Date.now()
        return { action: 'cancel' }
      },
    })
    const started = Date.now()
    expect(JSON.parse(text(await client.callTool({ name: 'slow_ask' })))).toEqual({ action: 'cancel', fields: [] })
    expect(askedAt - started).toBeGreaterThanOrEqual(1900)
  }, 15_000)
})

// ---------- prompts and resources ----------

describe('oAuth MCP fixture: prompts and resources', () => {
  it('lists and expands the prompts; a missing required argument is an error', async () => {
    const client = await connect({ headers: bearer(fixture.issueToken().accessToken) })
    expect((await client.experimental_listPrompts()).prompts.map(prompt => prompt.name)).toEqual(FIXTURE_PROMPTS.map(prompt => prompt.name))
    expect((await client.experimental_getPrompt({ name: 'greet', arguments: { name: 'Ada' } })).messages).toEqual([{ role: 'user', content: { type: 'text', text: 'Hello, Ada!' } }])
    expect((await client.experimental_getPrompt({ name: 'greet', arguments: { name: 'Ada', greeting: 'Hi' } })).messages[0]?.content).toEqual({ type: 'text', text: 'Hi, Ada!' })
    await expect(client.experimental_getPrompt({ name: 'greet', arguments: {} })).rejects.toThrow(/Missing required argument: name/)
    expect((await client.experimental_getPrompt({ name: 'review' })).messages.map(message => message.role)).toEqual(['assistant', 'user'])
    expect((await client.experimental_getPrompt({ name: 'with_resource' })).messages[1]?.content).toEqual({ type: 'resource', resource: { uri: README_URI, mimeType: 'text/markdown', text: README_TEXT } })
    expect((await client.experimental_getPrompt({ name: 'with_image' })).messages[1]?.content).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect(fixture.counters().promptsGet).toBe(6)
  })

  it('lists and reads the resources (text, 6 MiB, PNG blob) and the template; an unknown URI is an error', async () => {
    const client = await connect({ headers: bearer(fixture.issueToken().accessToken) })
    expect((await client.listResources()).resources).toEqual(FIXTURE_RESOURCES.map(resource => ({ ...resource })))
    expect((await client.listResourceTemplates()).resourceTemplates.map(template => template.uriTemplate)).toEqual(['fixture://notes/{name}'])
    expect((await client.readResource({ uri: README_URI })).contents).toEqual([{ uri: README_URI, mimeType: 'text/markdown', text: README_TEXT }])
    const large = (await client.readResource({ uri: LARGE_URI })).contents[0] as { text: string }
    expect(large.text).toHaveLength(LARGE_RESOURCE_BYTES)
    const pixel = (await client.readResource({ uri: PIXEL_URI })).contents[0] as { blob: string, mimeType: string }
    expect(Buffer.from(pixel.blob, 'base64').subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
    await expect(client.readResource({ uri: 'fixture://notes/missing.md' })).rejects.toThrow(/Resource not found/)
    expect(fixture.counters().resourcesRead).toBe(4)
  }, 30_000)
})

// ---------- toggles and test routes ----------

describe('oAuth MCP fixture: toggles', () => {
  it('preRegistered: no registration endpoint, registration refused; a configured client still signs in', async () => {
    fixture.setToggle('preRegistered', true)
    const metadata = await (await fetch(`${fixture.origin}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>
    expect(metadata.registration_endpoint).toBeUndefined()
    expect((await fetch(`${fixture.origin}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT_URL] }) })).status).toBe(400)
    await expect(auth(memoryProvider().provider, { serverUrl: fixture.url })).rejects.toThrow(/dynamic client registration/)
    const configured = memoryProvider({ client_id: 'seed-client' })
    await signIn(configured)
    const confidential = memoryProvider({ client_id: FIXTURE_CLIENT_ID, client_secret: FIXTURE_CLIENT_SECRET, issuer: fixture.origin } as OAuthClientInformation)
    await signIn(confidential)
    expect(fixture.counters()).toMatchObject({ registrations: 1, tokens: 2 })
  })

  it('foreignAs: the metadata names another authorization server, which the client refuses (link-local)', async () => {
    fixture.setToggle('foreignAs', 'http://169.254.169.254/')
    const metadata = await (await fetch(`${fixture.origin}/.well-known/oauth-protected-resource/mcp`)).json() as Record<string, unknown>
    expect(metadata.authorization_servers).toEqual(['http://169.254.169.254/'])
    await expect(auth(memoryProvider().provider, { serverUrl: fixture.url })).rejects.toThrow(/not allowed/)
    expect(() => fixture.setToggle('foreignAs', 'ftp://x' as never)).toThrow()
    fixture.setToggle('foreignAs', null)
    expect(fixture.toggles().foreignAs).toBeNull()
  })

  it('noMetadata: a plain 401 challenge and no well-known documents', async () => {
    fixture.setToggle('noMetadata', true)
    expect((await postMcp()).headers.get('www-authenticate')).toBe('Bearer realm="mcp"')
    expect((await fetch(`${fixture.origin}/.well-known/oauth-protected-resource/mcp`)).status).toBe(404)
    expect((await fetch(`${fixture.origin}/.well-known/oauth-authorization-server`)).status).toBe(404)
  })

  it('tokenLifeSec: short-lived tokens expire', async () => {
    fixture.setToggle('tokenLifeSec', 2)
    const pair = fixture.issueToken()
    expect(pair.expiresIn).toBe(2)
    vi.useFakeTimers({ toFake: ['Date'] })
    expect((await postMcp(bearer(pair.accessToken))).status).toBe(200)
    vi.setSystemTime(Date.now() + 2001)
    expect((await postMcp(bearer(pair.accessToken))).status).toBe(401)
    expect(() => fixture.setToggle('tokenLifeSec', 0)).toThrow()
  })

  it('approvePage: an HTML page with Approve and Deny; approve redirects with a code, deny with access_denied', async () => {
    fixture.setToggle('approvePage', true)
    const decide = async (decision: 'approve' | 'deny'): Promise<URL> => {
      const html = await (await fetch(authorizeUrl({}))).text()
      expect(html).toContain('>Approve</button>')
      expect(html).toContain('>Deny</button>')
      const id = html.match(/name="request" value="([^"]+)"/)?.[1] ?? ''
      const response = await fetch(`${fixture.origin}/authorize/decision`, { ...form({ request: id, decision }), redirect: 'manual' })
      expect(response.status).toBe(302)
      const again = await fetch(`${fixture.origin}/authorize/decision`, { ...form({ request: id, decision }), redirect: 'manual' })
      expect(again.status).toBe(400)
      return new URL(response.headers.get('location') ?? '')
    }
    expect((await decide('approve')).searchParams.get('code')).toMatch(/^code_/)
    const denied = await decide('deny')
    expect([denied.searchParams.get('error'), denied.searchParams.get('state')]).toEqual(['access_denied', STATE])
  })

  it('noAuth: the MCP endpoint answers without a token', async () => {
    fixture.setToggle('noAuth', true)
    const client = await connect()
    expect(JSON.parse(text(await client.callTool({ name: 'whoami' })))).toEqual({ subject: null, clientId: null, scope: null })
    expect(fixture.counters().unauthorized).toBe(0)
  })

  it('protocol2026: server/discover negotiates 2026-07-28; eliciting tools answer input_required', async () => {
    fixture.setToggle('noAuth', true)
    fixture.setToggle('protocol2026', true)
    const client = await connect({ onElicit: () => ({ action: 'accept', content: {} }) })
    expect(client.initializeResult.protocolVersion).toBe('2026-07-28')
    expect(Object.keys(await client.tools()).sort()).toEqual(['ask', 'ask_echo', 'slow_ask', 'whoami'])
    expect(JSON.parse(text(await client.callTool({ name: 'whoami' })))).toEqual({ subject: null, clientId: null, scope: null })
    await expect(client.callTool({ name: 'ask' })).rejects.toThrow(/multi round-trip/)
    expect((await client.experimental_getPrompt({ name: 'greet', arguments: { name: 'Ada' } })).messages[0]?.content).toEqual({ type: 'text', text: 'Hello, Ada!' })
    expect((await client.readResource({ uri: README_URI })).contents[0]).toMatchObject({ text: README_TEXT })
    const plain = await connect({ elicitation: false })
    expect(text(await plain.callTool({ name: 'ask' }))).toBe('The client does not support elicitation.')
    expect(fixture.counters()).toMatchObject({ connects: 2, discovers: 2, elicitations: 1 })
  })

  it('the test routes: counters, reset, toggle and revoke-all', async () => {
    await postMcp()
    expect(await (await fetch(`${fixture.origin}/__counters`)).json()).toEqual(fixture.counters())
    expect(await (await fetch(`${fixture.origin}/__reset`, { method: 'POST' })).json()).toMatchObject({ connects: 0, unauthorized: 0 })
    const toggled = await fetch(`${fixture.origin}/__toggle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'noAuth', value: true }) })
    expect(await toggled.json()).toMatchObject({ noAuth: true })
    expect((await fetch(`${fixture.origin}/__toggle`, { method: 'POST', body: JSON.stringify({ name: 'bogus', value: true }) })).status).toBe(400)
    fixture.setToggle('noAuth', false)
    const pair = fixture.issueToken()
    expect((await fetch(`${fixture.origin}/__revoke-all`, { method: 'POST' })).status).toBe(200)
    expect((await postMcp(bearer(pair.accessToken))).status).toBe(401)
    expect(await (await fetch(fixture.origin)).json()).toEqual({ name: 'oauth-fixture', url: fixture.url })
  })

  it('accepts a custom client list and refuses a non-loopback host', async () => {
    const custom = await startOAuthMcpServer({ clients: ['only-client'] })
    try {
      expect(await (await fetch(`${custom.origin}/authorize?client_id=seed-client`, { redirect: 'manual' })).text()).toContain('Unknown client')
      const url = new URL('/authorize', custom.origin)
      for (const [key, value] of Object.entries({ response_type: 'code', client_id: 'only-client', redirect_uri: REDIRECT_URL, code_challenge: challenge('v'.repeat(43)), code_challenge_method: 'S256', state: STATE }))
        url.searchParams.set(key, value)
      expect((await fetch(url, { redirect: 'manual' })).status).toBe(302)
    }
    finally {
      await custom.stop()
    }
    await expect(startOAuthMcpServer({ host: '10.0.0.1' })).rejects.toThrow(/loopback only/)
  })
})

// ---------- script and stdio variant ----------

describe('oAuth MCP fixture: the script', () => {
  it('prints the URL on its first stdout line, serves, and exits 0 on SIGTERM', async () => {
    const child = spawn(process.execPath, [FIXTURE_PATH, '--port', '0', '--noAuth', '--tokenLifeSec', '5', '--clients', 'a-client,b-client'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
    try {
      const line = await new Promise<string>((resolve, reject) => {
        createInterface({ input: child.stdout! }).once('line', resolve)
        child.once('exit', () => reject(new Error('exited early')))
      })
      const printed = JSON.parse(line) as { url: string, origin: string }
      expect(printed.url).toBe(`${printed.origin}/mcp`)
      expect(printed.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      const counters = await (await fetch(`${printed.origin}/__counters`)).json()
      expect(counters).toMatchObject({ connects: 0 })
      // A known client without a redirect URI: the redirect URI page (an unknown one reads "Unknown client").
      const known = await fetch(`${printed.origin}/authorize?client_id=a-client`, { redirect: 'manual' })
      expect([known.status, await known.text()]).toEqual([400, expect.stringContaining('Invalid redirect URI')])
      expect(await (await fetch(`${printed.origin}/authorize?client_id=seed-client`, { redirect: 'manual' })).text()).toContain('Unknown client')
    }
    finally {
      child.kill('SIGTERM')
    }
    expect(await exited).toBe(0)
  }, 20_000)

  it('refuses a non-loopback host', async () => {
    const child = spawn(process.execPath, [FIXTURE_PATH, '--host', '0.0.0.0'], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    expect(await new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))).toBe(1)
    expect(stderr).toContain('loopback only')
  }, 20_000)

  it('the stdio variant: the same tools plus __touch, which sends list_changed and adds a prompt and a resource', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [FIXTURE_PATH, '--stdio'] })
    const client = new Client({ name: 'fixture-test', version: '1.0.0' }, { capabilities: { elicitation: {} } })
    const notified: string[] = []
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
      notified.push('prompts')
    })
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      notified.push('resources')
    })
    await client.connect(transport)
    try {
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['ask', 'ask_echo', 'slow_ask', 'whoami', '__touch'])
      expect((await client.listPrompts()).prompts).toHaveLength(4)
      await client.callTool({ name: '__touch', arguments: {} })
      await vi.waitFor(() => expect(notified).toEqual(['prompts', 'resources']))
      expect((await client.listPrompts()).prompts.map(prompt => prompt.name)).toContain('touched')
      expect((await client.listResources()).resources.map(resource => resource.uri)).toContain(TOUCHED_URI)
      const whoami = await client.callTool({ name: 'whoami', arguments: {} }) as { content: Array<{ type: string, text?: string }> }
      expect(JSON.parse(text(whoami))).toEqual({ subject: null, clientId: null, scope: null })
    }
    finally {
      await client.close()
    }
  }, 20_000)
})
