import { createApiClient, HarnessError } from '@harness-forge/shared'
import { describe, expect, it, vi } from 'vitest'
import { createApiFetch, isUnauthorizedResponse } from './api'

function envelope(status: number, code: string, message = 'Failed'): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
  })
}

function setup(response: () => Response) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response())
  const onUnauthorized = vi.fn()
  const apiFetch = createApiFetch({ fetch, onUnauthorized })
  const client = createApiClient({ baseUrl: '/api', fetch: apiFetch })
  return { fetch, onUnauthorized, client }
}

describe('$api 401 handling', () => {
  it('redirects on 401 unauthorized and still throws the HarnessError to the caller', async () => {
    const { client, onUnauthorized, fetch } = setup(() => envelope(401, 'unauthorized', 'Log in first'))
    const error = await client.chats.list().catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(HarnessError)
    expect(error).toMatchObject({ code: 'unauthorized', message: 'Log in first', requestId: 'req-1' })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(onUnauthorized).toHaveBeenCalledWith('/api/chats')
    expect(fetch).toHaveBeenCalledWith('/api/chats', expect.objectContaining({ method: 'GET', credentials: 'same-origin' }))
  })

  it('never redirects for auth_invalid (a provider rejected its key, HTTP 502)', async () => {
    const { client, onUnauthorized } = setup(() => envelope(502, 'auth_invalid', 'Anthropic rejected the API key'))
    await expect(client.providers.test({ params: { id: 'anthropic' }, body: {} })).rejects.toMatchObject({ code: 'auth_invalid' })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('does not redirect for a wrong password on the login request', async () => {
    const { client, onUnauthorized } = setup(() => envelope(401, 'unauthorized', 'Invalid password'))
    await expect(client.auth.login({ body: { password: 'nope' } })).rejects.toMatchObject({ code: 'unauthorized' })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('redirects on the envelope code only, not on the HTTP status alone', async () => {
    const plain = setup(() => new Response('Unauthorized', { status: 401 }))
    await expect(plain.client.settings.get()).rejects.toMatchObject({ code: 'internal_error' })
    expect(plain.onUnauthorized).not.toHaveBeenCalled()

    const forbidden = setup(() => new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Fresh auth required', action: 'login' } }), { status: 403 }))
    await expect(forbidden.client.pluginInstall.trust({ params: { id: 'dice' }, body: { sha256: 'a'.repeat(64) } })).rejects.toMatchObject({ code: 'forbidden', action: 'login' })
    expect(forbidden.onUnauthorized).not.toHaveBeenCalled()
  })

  it('passes successful and 501 stub responses through untouched', async () => {
    const ok = setup(() => new Response(JSON.stringify({ enabled: false, authenticated: true, source: null, freshUntil: null }), { status: 200 }))
    await expect(ok.client.auth.status()).resolves.toMatchObject({ authenticated: true })
    const stub = setup(() => envelope(501, 'not_implemented', 'Not implemented'))
    await expect(stub.client.settings.get()).rejects.toMatchObject({ code: 'not_implemented' })
    expect(stub.onUnauthorized).not.toHaveBeenCalled()
  })

  it('reads the envelope from a clone, leaving the body for the client', async () => {
    const response = envelope(401, 'unauthorized')
    expect(await isUnauthorizedResponse(response)).toBe(true)
    expect(response.bodyUsed).toBe(false)
    expect(await isUnauthorizedResponse(envelope(401, 'auth_invalid'))).toBe(false)
    expect(await isUnauthorizedResponse(envelope(500, 'unauthorized'))).toBe(false)
  })
})
