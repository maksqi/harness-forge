// The `OAuthClientProvider` of each mode (W14.1-T2): connect (stored tokens only, no registration, a refresh persisted,
// generations on invalidation, the guard as `McpAuthRequired`), start (a fresh state and verifier on the flow, no client
// secret before the pin, the captured authorization URL) and callback (the flow's client with its secret and pin).
import type { OAuthTokens } from '@ai-sdk/mcp'
import type { McpAuthTarget } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { OAuthMcpServer } from '../__fixtures__/oauth-mcp-server.mjs'
import type { ConnectContext, FlowState } from './provider.ts'
import type { AuthServer } from './servers.ts'
import type { McpOAuthRecord } from './store.ts'
import { auth } from '@ai-sdk/mcp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import { startOAuthMcpServer } from '../__fixtures__/oauth-mcp-server.mjs'
import { isMcpOAuthGuardError } from './guard.ts'
import { CONNECT_REDIRECT_URI, createCallbackProvider, createConnectProvider, createStartProvider, mcpOAuthClientMetadata } from './provider.ts'
import { userStorage } from './servers.ts'
import { createTokenStore } from './store.ts'
import { isMcpAuthRequired } from './types.ts'

const TARGET: McpAuthTarget = { kind: 'global', serverId: 'docs' }
const URL_A = 'https://mcp.example.com/mcp'
const REDIRECT = 'http://127.0.0.1:8787/oauth/callback'
const AS = { issuer: 'https://auth.example.com', authorizationServerUrl: 'https://auth.example.com/', tokenEndpoint: 'https://auth.example.com/token' }

let t: TestApp
let fixture: OAuthMcpServer | null = null

beforeEach(async () => {
  t = await createTestApp({ start: false })
})

afterEach(async () => {
  await t.close()
  await fixture?.stop()
  fixture = null
})

function server(fields: Partial<AuthServer> = {}): AuthServer {
  return { target: TARGET, storage: userStorage('docs'), name: 'Docs', type: 'http', url: URL_A, headers: {}, clientId: null, clientSecret: null, scopes: null, ...fields }
}

function tokens(access: string, refresh = `${access}-refresh`): OAuthTokens & { obtainedAt: number } {
  return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, authorization_server: AS.authorizationServerUrl, token_endpoint: AS.tokenEndpoint, issuer: AS.issuer, obtainedAt: 1000 }
}

function dynamicRecord(fields: Partial<McpOAuthRecord> = {}): McpOAuthRecord {
  return {
    v: 1,
    resource: URL_A,
    clientId: 'dyn-client',
    client: { info: { client_id: 'dyn-client', issuer: AS.issuer }, dynamic: true, redirectUris: [REDIRECT] },
    as: AS,
    tokens: tokens('access-one-0000'),
    ...fields,
  }
}

function connect(resolved: AuthServer | null = server()) {
  const store = createTokenStore({ secrets: t.deps.secrets, redactor: t.deps.redactor })
  const context: ConnectContext = { target: TARGET, store, redactor: t.deps.redactor, logger: t.deps.logger, now: () => 5000, resolve: async () => resolved }
  return { provider: createConnectProvider(context), store }
}

async function required(fn: () => unknown): Promise<boolean> {
  try {
    await fn()
    return false
  }
  catch (error) {
    return isMcpAuthRequired(error)
  }
}

describe('the connect mode', () => {
  it('without a record: no tokens, no client (no registration), no redirect, no state, no verifier', async () => {
    const { provider } = connect()
    expect(await provider.tokens()).toBeUndefined()
    expect(provider.redirectUrl).toBe(CONNECT_REDIRECT_URI)
    expect(provider.clientMetadata).toEqual(mcpOAuthClientMetadata(CONNECT_REDIRECT_URI))
    for (const call of [
      () => provider.clientInformation(),
      () => provider.redirectToAuthorization(new URL('https://auth.example.com/authorize')),
      () => provider.state!(),
      () => provider.codeVerifier(),
      () => provider.saveCodeVerifier('verifier'),
      () => provider.saveClientInformation!({ client_id: 'x' }),
      () => provider.validateResourceURL!(URL_A, URL_A),
    ])
      expect(await required(call)).toBe(true)
    expect(await provider.storedState!()).toBeUndefined()
  })

  it('answers the stored tokens and client while the record matches the server', async () => {
    const { provider, store } = connect()
    await store.write(userStorage('docs'), dynamicRecord())
    expect(await provider.tokens()).toEqual({ access_token: 'access-one-0000', token_type: 'Bearer', expires_in: 3600, refresh_token: 'access-one-0000-refresh', authorization_server: AS.authorizationServerUrl, token_endpoint: AS.tokenEndpoint, issuer: AS.issuer })
    expect(await provider.clientInformation()).toEqual({ client_id: 'dyn-client', issuer: AS.issuer })
    expect(await provider.isClientInformationDynamicallyRegistered!()).toBe(true)
    expect(await provider.authorizationServerInformation!()).toEqual(AS)
    expect((await provider.validateResourceURL!(URL_A, URL_A))?.href).toBe(URL_A)
    // Another URL (the server moved): the record is ignored.
    const moved = connect(server({ url: 'https://mcp.example.com/v2' })).provider
    expect(await moved.tokens()).toBeUndefined()
    expect(await required(() => moved.clientInformation())).toBe(true)
  })

  it('a configured client answers its id and the configured secret', async () => {
    const { provider, store } = connect(server({ clientId: 'configured-1', clientSecret: 'configured-secret-1234' }))
    await store.write(userStorage('docs'), { ...dynamicRecord(), clientId: 'configured-1', client: { info: { client_id: 'configured-1' }, dynamic: false, redirectUris: [REDIRECT] } })
    expect(await provider.clientInformation()).toEqual({ client_id: 'configured-1', client_secret: 'configured-secret-1234' })
    expect(await provider.isClientInformationDynamicallyRegistered!()).toBe(false)
  })

  it('persists a refresh, never resurrects a deleted record, and invalidates only the refused generation', async () => {
    const { provider, store } = connect()
    await store.write(userStorage('docs'), dynamicRecord())
    await provider.saveTokens({ access_token: 'access-two-0000', token_type: 'Bearer', refresh_token: 'refresh-two-0000' })
    expect((await store.read(userStorage('docs')))?.tokens).toMatchObject({ access_token: 'access-two-0000', obtainedAt: 5000 })
    // An old generation is not dropped (a concurrent refresh keeps its tokens).
    await provider.invalidateCredentials!('tokens', { tokens: { access_token: 'access-one-0000', token_type: 'Bearer', refresh_token: 'access-one-0000-refresh' } })
    expect((await store.read(userStorage('docs')))?.tokens?.access_token).toBe('access-two-0000')
    await provider.invalidateCredentials!('tokens', { tokens: { access_token: 'access-two-0000', token_type: 'Bearer' } })
    const kept = await store.read(userStorage('docs'))
    expect(kept?.tokens).toBeUndefined()
    expect(kept?.client?.info.client_id).toBe('dyn-client')
    // No tokens left: the next step asks for a sign-in.
    expect(await required(() => provider.validateResourceURL!(URL_A, URL_A))).toBe(true)
    await provider.invalidateCredentials!('all')
    expect(await store.read(userStorage('docs'))).toBeNull()
    await provider.saveTokens({ access_token: 'access-three-0000', token_type: 'Bearer' })
    expect(await store.read(userStorage('docs'))).toBeNull()
  })

  it('a guard refusal or another resource is McpAuthRequired (never a retry)', async () => {
    const { provider, store } = connect()
    await store.write(userStorage('docs'), dynamicRecord())
    expect(await required(() => provider.validateAuthorizationServerURL!(URL_A, 'http://169.254.169.254/'))).toBe(true)
    expect(await required(() => provider.validateResourceURL!(URL_A, 'https://evil.example.com/mcp'))).toBe(true)
    expect(await required(() => provider.validateResourceURL!(URL_A, undefined))).toBe(true)
    expect(() => provider.validateAuthorizationServerURL!(URL_A, 'https://auth.example.com/')).not.toThrow()
  })

  it('auth() in the connect mode never registers a client at the authorization server', async () => {
    fixture = await startOAuthMcpServer()
    const { provider } = connect(server({ url: fixture.url }))
    await expect(auth(provider, { serverUrl: fixture.url })).rejects.toSatisfy(isMcpAuthRequired)
    expect(fixture.counters()).toMatchObject({ registrations: 0, authorizations: 0, tokens: 0 })
  })
})

describe('the start mode', () => {
  function flow(fields: Partial<FlowState> = {}): FlowState {
    return { state: 'state-start-0000000000000000', redirectUri: REDIRECT, server: server(), ...fields }
  }
  const context = () => ({ target: TARGET, store: createTokenStore({ secrets: t.deps.secrets, redactor: t.deps.redactor }), redactor: t.deps.redactor, logger: t.deps.logger, now: () => 7000 })

  it('registers dynamically when nothing is configured; keeps the state, verifier, pin and URL on the flow', async () => {
    const state = flow()
    const provider = createStartProvider(context(), state)
    expect(provider.redirectUrl).toBe(REDIRECT)
    expect(provider.clientMetadata).toEqual({ redirect_uris: [REDIRECT], client_name: 'harness-forge', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' })
    expect(await provider.clientInformation()).toBeUndefined()
    await provider.saveClientInformation!({ client_id: 'registered-1', client_secret: 'registered-secret-1', issuer: AS.issuer })
    expect(state.client).toEqual({ info: { client_id: 'registered-1', client_secret: 'registered-secret-1', issuer: AS.issuer }, dynamic: true, redirectUris: [REDIRECT] })
    expect(await provider.isClientInformationDynamicallyRegistered!()).toBe(true)
    expect(await provider.state!()).toBe(state.state)
    expect(await provider.storedState!()).toBe(state.state)
    await provider.saveCodeVerifier('verifier-0000000000000000000000000000000000000')
    expect(await provider.codeVerifier()).toBe('verifier-0000000000000000000000000000000000000')
    await provider.saveAuthorizationServerInformation!(AS)
    expect(state.as).toEqual(AS)
    await provider.redirectToAuthorization(new URL('https://auth.example.com/authorize?state=x'))
    expect(state.authorizationUrl).toBe('https://auth.example.com/authorize?state=x')
    expect(t.deps.redactor.redactText(`x ${state.state} y`)).not.toContain(state.state)
  })

  it('never hands a non-http(s) authorization URL to the browser', async () => {
    const provider = createStartProvider(context(), flow())
    try {
      await provider.redirectToAuthorization(new URL('javascript:alert(1)'))
      expect.unreachable()
    }
    catch (error) {
      expect(isMcpOAuthGuardError(error) && error.reason).toBe('authorization-url')
    }
  })

  it('a configured client goes without its secret until the flow has a pin', async () => {
    const state = flow({ server: server({ clientId: 'configured-1', clientSecret: 'configured-secret-1234' }) })
    const provider = createStartProvider(context(), state)
    expect(await provider.clientInformation()).toEqual({ client_id: 'configured-1' })
    state.as = AS
    expect(await provider.clientInformation()).toEqual({ client_id: 'configured-1', client_secret: 'configured-secret-1234' })
    expect(await provider.isClientInformationDynamicallyRegistered!()).toBe(false)
  })

  it('offers stored tokens for a refresh; a refreshed token lands on the flow; invalidation marks the flow', async () => {
    const state = flow({ tokens: tokens('access-old-0000') })
    const provider = createStartProvider(context(), state)
    expect((await provider.tokens())?.access_token).toBe('access-old-0000')
    await provider.saveTokens({ access_token: 'access-new-0000', token_type: 'Bearer' })
    expect(state.obtained).toEqual({ access_token: 'access-new-0000', token_type: 'Bearer', obtainedAt: 7000 })
    await provider.invalidateCredentials!('tokens')
    expect(state.tokens).toBeUndefined()
    expect(state.tokensInvalidated).toBe(true)
    await provider.invalidateCredentials!('all')
    expect(state.client).toBeUndefined()
  })

  it('validates the resource and the authorization server like every mode', async () => {
    const state = flow()
    const provider = createStartProvider(context(), state)
    expect((await provider.validateResourceURL!(URL_A, URL_A))?.href).toBe(URL_A)
    expect(state.resource).toBe(URL_A)
    await expect(provider.validateResourceURL!(URL_A, undefined)).rejects.toSatisfy(error => isMcpOAuthGuardError(error) && error.reason === 'no-oauth')
    expect(() => provider.validateAuthorizationServerURL!(URL_A, 'http://10.0.0.1/')).toThrow()
  })
})

describe('the callback mode', () => {
  const context = () => ({ target: TARGET, store: createTokenStore({ secrets: t.deps.secrets, redactor: t.deps.redactor }), redactor: t.deps.redactor, logger: t.deps.logger, now: () => 9000 })

  it('answers the flow\'s client with the configured secret and pin, keeps the issued tokens, never redirects', async () => {
    const state: FlowState = { state: 'state-callback-000000000000', redirectUri: REDIRECT, server: server({ clientId: 'configured-1', clientSecret: 'configured-secret-1234' }), as: AS, codeVerifier: 'verifier-1' }
    const provider = createCallbackProvider(context(), state)
    expect(await provider.clientInformation()).toEqual({ client_id: 'configured-1', client_secret: 'configured-secret-1234' })
    expect(await provider.authorizationServerInformation!()).toEqual(AS)
    expect(await provider.codeVerifier()).toBe('verifier-1')
    expect(await provider.storedState!()).toBe(state.state)
    expect(await provider.tokens()).toBeUndefined()
    await provider.saveTokens({ access_token: 'issued-0000', token_type: 'Bearer' })
    expect(state.obtained).toEqual({ access_token: 'issued-0000', token_type: 'Bearer', obtainedAt: 9000 })
    expect(await required(() => provider.redirectToAuthorization(new URL('https://auth.example.com/authorize')))).toBe(true)

    const dynamic: FlowState = { state: 'state-callback-111111111111', redirectUri: REDIRECT, server: server(), client: { info: { client_id: 'dyn-1' }, dynamic: true, redirectUris: [REDIRECT] } }
    expect(await createCallbackProvider(context(), dynamic).clientInformation()).toEqual({ client_id: 'dyn-1' })
  })

  it('the service hands out start and callback providers only for a pending flow', async () => {
    expect(() => t.deps.mcpAuth.provider(TARGET, 'callback')).toThrow(/No sign-in of this server is pending/)
    expect(() => t.deps.mcpAuth.provider(TARGET, 'start')).toThrow(/No sign-in of this server is pending/)
    expect(typeof t.deps.mcpAuth.provider(TARGET, 'connect').tokens).toBe('function')
  })
})
