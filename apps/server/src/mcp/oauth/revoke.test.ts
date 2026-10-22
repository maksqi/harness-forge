// The RFC 7009 revocation of a sign-out (W14.1-T5): the metadata's `revocation_endpoint`, the refresh token first, the
// client authentication, the authorization-server rule for every URL and the loopback `safeFetch` only for a loopback
// pair. A recording `SafeFetch` stands in for the network.
import type { SafeFetch, SafeFetchOptions } from '../../security/types.ts'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { revokeTokens } from './revoke.ts'

interface Call { url: string, options: SafeFetchOptions, loopback: boolean }

function recorder(metadata: Record<string, unknown> | null, status = 200) {
  const calls: Call[] = []
  const fetchFor = (loopback: boolean): SafeFetch => async (url, options) => {
    calls.push({ url, options, loopback })
    if (options.method === 'POST')
      return { url, status, headers: new Headers(), body: new Uint8Array() }
    const found = metadata !== null && url.includes('/.well-known/oauth-authorization-server')
    return { url, status: found ? 200 : 404, headers: new Headers(), body: new TextEncoder().encode(found ? JSON.stringify(metadata) : 'no') }
  }
  return { calls, fetchFor }
}

const AS = { issuer: 'https://auth.example.com', authorizationServerUrl: 'https://auth.example.com/', tokenEndpoint: 'https://auth.example.com/token' }
const TOKENS = { access_token: 'access-0000', token_type: 'Bearer', refresh_token: 'refresh-0000' }

describe('revokeTokens', () => {
  it('posts the refresh token to the revocation endpoint with the public client id', async () => {
    const { calls, fetchFor } = recorder({ issuer: AS.issuer, revocation_endpoint: 'https://auth.example.com/revoke' })
    expect(await revokeTokens({ mcpUrl: 'https://mcp.example.com/mcp', as: AS, tokens: TOKENS, client: { client_id: 'public-1' } }, { fetchFor })).toBe('revoked')
    const post = calls.find(call => call.options.method === 'POST')
    expect(post?.url).toBe('https://auth.example.com/revoke')
    expect(post?.loopback).toBe(false)
    expect(post?.options.maxRedirects).toBe(0)
    expect(Object.fromEntries(new URLSearchParams(String(post?.options.body)))).toEqual({ token: 'refresh-0000', token_type_hint: 'refresh_token', client_id: 'public-1' })
  })

  it('authenticates a confidential client with client_secret_basic (or post when only that is supported)', async () => {
    const basic = recorder({ revocation_endpoint: 'https://auth.example.com/revoke' })
    await revokeTokens({ mcpUrl: 'https://mcp.example.com/mcp', as: AS, tokens: { access_token: 'access-0000', token_type: 'Bearer' }, client: { client_id: 'conf-1', client_secret: 'conf-secret' } }, { fetchFor: basic.fetchFor })
    const post = basic.calls.find(call => call.options.method === 'POST')!
    expect(post.options.headers?.authorization).toBe(`Basic ${Buffer.from('conf-1:conf-secret').toString('base64')}`)
    expect(Object.fromEntries(new URLSearchParams(String(post.options.body)))).toEqual({ token: 'access-0000', token_type_hint: 'access_token' })
    const form = recorder({ revocation_endpoint: 'https://auth.example.com/revoke', revocation_endpoint_auth_methods_supported: ['client_secret_post'] })
    await revokeTokens({ mcpUrl: 'https://mcp.example.com/mcp', as: AS, tokens: TOKENS, client: { client_id: 'conf-1', client_secret: 'conf-secret' } }, { fetchFor: form.fetchFor })
    const formPost = form.calls.find(call => call.options.method === 'POST')!
    expect(formPost.options.headers?.authorization).toBeUndefined()
    expect(new URLSearchParams(String(formPost.options.body)).get('client_secret')).toBe('conf-secret')
  })

  it('reaches nothing the authorization-server rule refuses; loopback only for a loopback pair', async () => {
    const internal = recorder({ revocation_endpoint: 'http://10.0.0.1/revoke' })
    expect(await revokeTokens({ mcpUrl: 'https://mcp.example.com/mcp', as: AS, tokens: TOKENS, client: { client_id: 'x' } }, { fetchFor: internal.fetchFor })).toBe('unsupported')
    expect(internal.calls.some(call => call.options.method === 'POST')).toBe(false)
    const foreign = recorder({})
    expect(await revokeTokens({ mcpUrl: 'https://mcp.example.com/mcp', as: { ...AS, issuer: 'http://169.254.169.254', authorizationServerUrl: 'http://169.254.169.254/' }, tokens: TOKENS, client: { client_id: 'x' } }, { fetchFor: foreign.fetchFor })).toBe('unsupported')
    expect(foreign.calls).toEqual([])
    const local = recorder({ revocation_endpoint: 'http://127.0.0.1:4100/revoke' })
    const loopbackAs = { issuer: 'http://127.0.0.1:4100', authorizationServerUrl: 'http://127.0.0.1:4100/', tokenEndpoint: 'http://127.0.0.1:4100/token' }
    expect(await revokeTokens({ mcpUrl: 'http://127.0.0.1:4100/mcp', as: loopbackAs, tokens: TOKENS, client: { client_id: 'x' } }, { fetchFor: local.fetchFor })).toBe('revoked')
    expect(local.calls.every(call => call.loopback)).toBe(true)
  })

  it('answers an outcome for anything else and never throws', async () => {
    expect(await revokeTokens({ mcpUrl: 'https://mcp.example.com/mcp', as: AS, tokens: undefined, client: { client_id: 'x' } }, { fetchFor: recorder(null).fetchFor })).toBe('no-token')
    expect(await revokeTokens({ mcpUrl: 'https://mcp.example.com/mcp', as: AS, tokens: TOKENS, client: { client_id: 'x' } }, { fetchFor: recorder(null).fetchFor })).toBe('unsupported')
    expect(await revokeTokens({ mcpUrl: 'https://mcp.example.com/mcp', as: AS, tokens: TOKENS, client: { client_id: 'x' } }, { fetchFor: recorder({ revocation_endpoint: 'https://auth.example.com/revoke' }, 400).fetchFor })).toBe('refused')
    const failing = (): SafeFetch => async () => {
      throw new Error('network down')
    }
    const metadataOk = recorder({ revocation_endpoint: 'https://auth.example.com/revoke' })
    expect(await revokeTokens({ mcpUrl: 'https://mcp.example.com/mcp', as: AS, tokens: TOKENS, client: { client_id: 'x' } }, { fetchFor: loopback => (loopback ? failing() : async (url, options) => (options.method === 'POST' ? failing()(url, options) : metadataOk.fetchFor(false)(url, options))) })).toBe('failed')
  })
})
