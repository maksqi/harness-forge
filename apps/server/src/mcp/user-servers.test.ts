// The stored transport of personal MCP servers (W14.1-T7): the OAuth settings on the row and the binding rule that
// decides whether a transport replacement keeps the stored sign-in.
import { describe, expect, it } from 'vitest'
import { oauthBindingChanged, transportRecordOf } from './user-servers.ts'

describe('transportRecordOf', () => {
  it('keeps the client id and the scopes of an http / sse transport, never the secret', () => {
    expect(transportRecordOf({ type: 'http', url: 'https://mcp.example.com/mcp', oauth: { clientId: 'client-1', scopes: 'read', clientSecret: 'secret-value-1' } }))
      .toEqual({ type: 'http', url: 'https://mcp.example.com/mcp', headerNames: [], oauth: { clientId: 'client-1', scopes: 'read' } })
    expect(transportRecordOf({ type: 'sse', url: 'https://mcp.example.com/sse', oauth: { scopes: 'read' } }))
      .toEqual({ type: 'sse', url: 'https://mcp.example.com/sse', headerNames: [], oauth: { clientId: null, scopes: 'read' } })
    // Nothing named: no `oauth` key (a v1.8.1 row stays byte-equal).
    expect(transportRecordOf({ type: 'http', url: 'https://mcp.example.com/mcp', oauth: {} })).toEqual({ type: 'http', url: 'https://mcp.example.com/mcp', headerNames: [] })
    expect(transportRecordOf({ type: 'http', url: 'https://mcp.example.com/mcp', headers: { 'X-A': 'b' } })).toEqual({ type: 'http', url: 'https://mcp.example.com/mcp', headerNames: ['X-A'] })
  })
})

describe('oauthBindingChanged', () => {
  const base = { type: 'http' as const, url: 'https://mcp.example.com/mcp', headerNames: [], oauth: { clientId: 'client-1', scopes: 'read' } }

  it('is false for the scopes, the headers or nothing; true for the URL, the type or the client id', () => {
    expect(oauthBindingChanged(base, { ...base, oauth: { clientId: 'client-1', scopes: 'write' } })).toBe(false)
    expect(oauthBindingChanged(base, { ...base, headerNames: ['X-Team'] })).toBe(false)
    expect(oauthBindingChanged(base, base)).toBe(false)
    expect(oauthBindingChanged(base, { ...base, url: 'https://mcp.example.com/v2' })).toBe(true)
    expect(oauthBindingChanged(base, { ...base, type: 'sse' })).toBe(true)
    expect(oauthBindingChanged(base, { ...base, oauth: { clientId: 'client-2', scopes: 'read' } })).toBe(true)
    expect(oauthBindingChanged(base, { type: 'http', url: base.url, headerNames: [] })).toBe(true)
    expect(oauthBindingChanged({ type: 'http', url: base.url, headerNames: [] }, { type: 'http', url: base.url, headerNames: [], oauth: { clientId: null, scopes: 'x' } })).toBe(false)
    expect(oauthBindingChanged(base, { type: 'stdio', command: 'node', args: [], envNames: [] })).toBe(true)
  })
})
