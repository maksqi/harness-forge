// Request facts behind reverse proxies (W5.7-T3, ADR-026, ARCHITECTURE.md 10.6): the client address and the scheme
// follow `X-Forwarded-For` / `X-Forwarded-Proto` only from a trusted peer; `Forwarded` and `X-Forwarded-Host` are never
// read; the v1 call forms (`clientAddress(c)`, `requestProtocol(c)`) keep the v1 behavior.
import type { AppEnv } from '../types.ts'
import type { ProxyTrustSetting } from './request-info.ts'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { testBindings } from '../../testing/create-test-app.ts'
import {
  clientAddress,
  isHttpsRequest,
  isTrustedProxyPeer,
  peerAddress,
  requestHostname,
  requestProtocol,
  serverOrigin,
  UNKNOWN_CLIENT_ADDRESS,
} from './request-info.ts'

interface Facts {
  peer: string
  client: string
  v1Client: string
  protocol: string
  v1Protocol: string
  https: boolean
  origin: string | null
  hostname: string | null
  trustedPeer: boolean
}

const UNSET: ProxyTrustSetting = { trustProxy: null }
const LOOPBACK: ProxyTrustSetting = { trustProxy: Object.freeze(['loopback']) }
const CHAIN: ProxyTrustSetting = { trustProxy: Object.freeze(['loopback', '10.0.0.2', 'fd00::/8']) }

/** Answers the request facts of every helper for one trust setting. */
function probe(trust: ProxyTrustSetting) {
  const app = new Hono<AppEnv>()
  app.all('*', c => c.json({
    peer: peerAddress(c),
    client: clientAddress(c, trust),
    v1Client: clientAddress(c),
    protocol: requestProtocol(c, trust),
    v1Protocol: requestProtocol(c),
    https: isHttpsRequest(c, trust),
    origin: serverOrigin(c, trust),
    hostname: requestHostname(c),
    trustedPeer: isTrustedProxyPeer(c, trust),
  } satisfies Facts))
  return async (headers: Record<string, string> | Headers, remoteAddress: string | null = '127.0.0.1', url = 'http://127.0.0.1:8787/api/x'): Promise<Facts> => {
    const response = await app.request(url, { headers }, remoteAddress === null ? undefined : testBindings(remoteAddress))
    return response.json() as Promise<Facts>
  }
}

describe('hF_TRUST_PROXY unset and the v1 call forms', () => {
  const facts = probe(UNSET)

  it('the client is the TCP peer: X-Forwarded-For is never read', async () => {
    expect(await facts({ 'x-forwarded-for': '198.51.100.1' })).toMatchObject({ peer: '127.0.0.1', client: '127.0.0.1', v1Client: '127.0.0.1', trustedPeer: false })
  })

  it('x-Forwarded-Proto counts from any peer (v1)', async () => {
    const answer = await facts({ 'x-forwarded-proto': 'https', 'host': 'harness.example.com' }, '203.0.113.7')
    expect(answer).toMatchObject({ protocol: 'https', v1Protocol: 'https', https: true, origin: 'https://harness.example.com' })
    expect(await facts({ 'x-forwarded-proto': 'HTTPS, http' })).toMatchObject({ protocol: 'https' })
    expect(await facts({ 'x-forwarded-proto': 'wss' })).toMatchObject({ protocol: 'http' })
  })

  it('without socket bindings the address is unknown', async () => {
    expect(await facts({ 'x-forwarded-for': '198.51.100.1' }, null)).toMatchObject({ peer: UNKNOWN_CLIENT_ADDRESS, client: UNKNOWN_CLIENT_ADDRESS })
  })

  it('iPv4-mapped peers are reduced to IPv4, IPv6 peers are canonical', async () => {
    expect(await facts({}, '::ffff:192.0.2.4')).toMatchObject({ peer: '192.0.2.4', client: '192.0.2.4' })
    expect(await facts({}, '2001:DB8:0::5')).toMatchObject({ peer: '2001:db8::5', client: '2001:db8::5' })
  })
})

describe('behind a trusted proxy (HF_TRUST_PROXY=loopback)', () => {
  const facts = probe(LOOPBACK)

  it('the client comes from X-Forwarded-For; the v1 form still answers the peer', async () => {
    expect(await facts({ 'x-forwarded-for': '198.51.100.1' })).toMatchObject({ peer: '127.0.0.1', client: '198.51.100.1', v1Client: '127.0.0.1', trustedPeer: true })
    expect(await facts({ 'x-forwarded-for': '2001:db8::7' }, '::1')).toMatchObject({ peer: '::1', client: '2001:db8::7', trustedPeer: true })
    expect(await facts({ 'x-forwarded-for': '198.51.100.1' }, '::ffff:127.0.0.1')).toMatchObject({ peer: '127.0.0.1', client: '198.51.100.1' })
  })

  it('forged left-hand entries are ignored; several header lines are one list', async () => {
    expect(await facts({ 'x-forwarded-for': '6.6.6.6, 198.51.100.1' })).toMatchObject({ client: '198.51.100.1' })
    const lines = new Headers([['x-forwarded-for', '127.0.0.1, 6.6.6.6'], ['x-forwarded-for', '198.51.100.2']])
    expect(await facts(lines)).toMatchObject({ client: '198.51.100.2' })
  })

  it('a malformed entry is never the client', async () => {
    expect(await facts({ 'x-forwarded-for': 'not-an-ip' })).toMatchObject({ client: '127.0.0.1' })
    expect(await facts({ 'x-forwarded-for': '198.51.100.1:443' })).toMatchObject({ client: '127.0.0.1' })
  })

  it('x-Forwarded-Proto counts from the trusted proxy', async () => {
    expect(await facts({ 'x-forwarded-proto': 'https', 'host': 'harness.example.com' })).toMatchObject({ protocol: 'https', https: true, origin: 'https://harness.example.com' })
  })

  it('an untrusted peer: X-Forwarded-For and X-Forwarded-Proto are ignored (the v1 form still reads the scheme)', async () => {
    const answer = await facts({ 'x-forwarded-for': '198.51.100.1', 'x-forwarded-proto': 'https', 'host': 'harness.example.com' }, '203.0.113.7')
    expect(answer).toMatchObject({
      peer: '203.0.113.7',
      client: '203.0.113.7',
      trustedPeer: false,
      protocol: 'http',
      https: false,
      origin: 'http://harness.example.com',
      v1Protocol: 'https',
    })
  })

  it('forwarded and X-Real-IP are never read', async () => {
    const answer = await facts({ 'forwarded': 'for=198.51.100.1;proto=https;host=evil.example', 'x-real-ip': '198.51.100.9' })
    expect(answer).toMatchObject({ client: '127.0.0.1', protocol: 'http', origin: 'http://127.0.0.1:8787', hostname: '127.0.0.1' })
  })

  it('x-Forwarded-Host is never read, even from a trusted proxy', async () => {
    const answer = await facts({ 'host': 'evil.example', 'x-forwarded-host': 'localhost', 'x-forwarded-proto': 'https' })
    expect(answer).toMatchObject({ origin: 'https://evil.example', hostname: 'evil.example' })
    expect(await facts({ 'x-forwarded-host': 'localhost' }, '127.0.0.1', 'http://evil.example/api/x')).toMatchObject({ origin: 'http://evil.example', hostname: 'evil.example' })
  })
})

describe('a proxy chain (HF_TRUST_PROXY=loopback,10.0.0.2,fd00::/8)', () => {
  const facts = probe(CHAIN)

  it('skips every trusted hop from the right', async () => {
    expect(await facts({ 'x-forwarded-for': '198.51.100.1, 10.0.0.2' })).toMatchObject({ client: '198.51.100.1' })
    expect(await facts({ 'x-forwarded-for': '2001:db8::9, fd00::2' }, '10.0.0.2')).toMatchObject({ client: '2001:db8::9' })
  })

  it('stops at the first untrusted hop', async () => {
    expect(await facts({ 'x-forwarded-for': '198.51.100.1, 203.0.113.50, 10.0.0.2' })).toMatchObject({ client: '203.0.113.50' })
  })

  it('a peer outside the list cannot pose as a proxy', async () => {
    expect(await facts({ 'x-forwarded-for': '198.51.100.1' }, '10.0.0.3')).toMatchObject({ client: '10.0.0.3', trustedPeer: false })
  })
})
