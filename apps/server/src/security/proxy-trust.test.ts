// Trusted reverse proxies (W5.7-T1..T3, ADR-026, ARCHITECTURE.md 10.6): the `HF_TRUST_PROXY` format, the `BlockList`
// matcher and the `X-Forwarded-For` walk (proxy chains, forged left-hand entries, untrusted peers, malformed entries,
// the 32-entry cap, IPv6 and IPv4-mapped addresses).
import { describe, expect, it } from 'vitest'
import {
  createProxyTrust,
  MAX_FORWARDED_FOR_ENTRIES,
  normalizeAddress,
  parseTrustProxy,
  proxyTrustFor,
  resolveClientAddress,
  TRUST_PROXY_FORMAT,
  trustedRanges,
} from './proxy-trust.ts'

describe('parseTrustProxy', () => {
  it.each([
    ['loopback', ['loopback']],
    ['LOOPBACK, Private', ['loopback', 'private']],
    ['10.0.0.2', ['10.0.0.2']],
    [' 10.0.0.2 , 192.168.1.0/24 ', ['10.0.0.2', '192.168.1.0/24']],
    ['loopback,', ['loopback']],
    ['loopback,loopback,127.0.0.1,127.0.0.1', ['loopback', '127.0.0.1']],
    ['2001:DB8:0:0::1', ['2001:db8::1']],
    ['2001:db8::/32', ['2001:db8::/32']],
    ['::ffff:10.0.0.3', ['10.0.0.3']],
    ['::ffff:10.0.0.0/104', ['10.0.0.0/8']],
    ['10.0.0.2/32', ['10.0.0.2']],
    ['::1/128', ['::1']],
    ['fc00::/7,172.16.0.0/12', ['fc00::/7', '172.16.0.0/12']],
  ])('%s -> %o', (value, entries) => {
    expect(parseTrustProxy(value)).toEqual({ ok: true, entries })
  })

  it.each([
    ['1', 'hop count'],
    ['2', 'hop count'],
    ['0', 'hop count'],
    ['true', 'not supported'],
    ['TRUE', 'not supported'],
    ['false', 'not supported'],
    ['yes', 'not supported'],
    ['all', 'not supported'],
    ['*', 'not supported'],
    ['loopback,true', '"true" is not supported'],
    ['localhost', 'use loopback'],
    ['proxy.example.com', 'is not loopback, private, an IP address or a CIDR range'],
    ['10.0.0.1:8080', 'is not loopback'],
    ['[::1]', 'is not loopback'],
    ['fe80::1%eth0', 'is not loopback'],
    ['010.0.0.1', 'is not loopback'],
    ['10.0.0', 'is not loopback'],
    ['10.0.0.0/', 'is not loopback'],
    ['10.0.0.0/8/9', 'is not loopback'],
    ['10.0.0.0/-1', 'is not loopback'],
    ['10.0.0.0/33', 'at most 32'],
    ['2001:db8::/129', 'at most 128'],
    ['0.0.0.0/0', 'would trust every peer'],
    ['::/0', 'would trust every peer'],
    ['::ffff:0.0.0.0/96', 'would trust every peer'],
    [',', 'names no proxy'],
    [' , ', 'names no proxy'],
  ])('refuses %s (%s) and explains the format', (value, fragment) => {
    const result = parseTrustProxy(value)
    expect(result.ok).toBe(false)
    const message = result.ok ? '' : result.message
    expect(message).toContain(fragment)
    expect(message).toContain(TRUST_PROXY_FORMAT)
  })

  it('the format names every accepted form and the way to turn it off', () => {
    for (const part of ['loopback', 'private', 'IP addresses', 'CIDR ranges', '127.0.0.0/8', 'fc00::/7', 'unset'])
      expect(TRUST_PROXY_FORMAT).toContain(part)
  })
})

describe('normalizeAddress', () => {
  it.each([
    ['127.0.0.1', '127.0.0.1', 'ipv4'],
    ['::ffff:127.0.0.1', '127.0.0.1', 'ipv4'],
    ['::FFFF:7f00:1', '127.0.0.1', 'ipv4'],
    ['0:0:0:0:0:ffff:c633:6401', '198.51.100.1', 'ipv4'],
    ['2001:DB8:0:0::1', '2001:db8::1', 'ipv6'],
    ['::1', '::1', 'ipv6'],
  ])('%s -> %s', (value, address, family) => {
    expect(normalizeAddress(value)).toEqual({ address, family })
  })

  it.each(['', 'localhost', '1.2.3', '01.2.3.4', '1.2.3.4:80', '[::1]', '[::1]:80', 'fe80::1%lo0', ' 1.2.3.4', 'unknown', '1'.repeat(70)])('%s is not an address', (value) => {
    expect(normalizeAddress(value)).toBeNull()
  })
})

describe('the matcher', () => {
  it('loopback: 127.0.0.0/8 and ::1, IPv4-mapped forms included', () => {
    const trust = createProxyTrust(['loopback'])
    for (const address of ['127.0.0.1', '127.255.255.254', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1'])
      expect(trust.isTrusted(address), address).toBe(true)
    for (const address of ['128.0.0.1', '10.0.0.1', '::2', '::ffff:10.0.0.1', 'localhost', 'unknown', ''])
      expect(trust.isTrusted(address), address).toBe(false)
  })

  it('private: 10/8, 172.16/12, 192.168/16, fc00::/7', () => {
    const trust = createProxyTrust(['private'])
    for (const address of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', 'fc00::1', 'fd12:3456::1', '::ffff:192.168.0.9'])
      expect(trust.isTrusted(address), address).toBe(true)
    for (const address of ['172.15.255.255', '172.32.0.1', '192.169.0.1', '127.0.0.1', '::1', 'fe80::1', '8.8.8.8', '2001:db8::1'])
      expect(trust.isTrusted(address), address).toBe(false)
  })

  it('single addresses and CIDR ranges', () => {
    const trust = createProxyTrust(['10.0.0.2', '2001:db8::/32', '192.168.1.0/24'])
    for (const address of ['10.0.0.2', '::ffff:10.0.0.2', '2001:db8:ffff::1', '2001:DB8::abcd', '192.168.1.200'])
      expect(trust.isTrusted(address), address).toBe(true)
    for (const address of ['10.0.0.3', '2001:db9::1', '192.168.2.1'])
      expect(trust.isTrusted(address), address).toBe(false)
  })

  it('lists the trusted ranges with the keywords expanded', () => {
    expect(createProxyTrust(['loopback', 'private', '10.0.0.2']).ranges).toEqual(['127.0.0.0/8', '::1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7', '10.0.0.2'])
    expect(trustedRanges(['loopback', '127.0.0.0/8'])).toEqual(['127.0.0.0/8', '::1'])
  })

  it('refuses entries that did not come from parseTrustProxy', () => {
    expect(() => createProxyTrust(['everyone'])).toThrow(TypeError)
    expect(() => createProxyTrust(['0.0.0.0/0'])).toThrow(TypeError)
  })

  it('proxyTrustFor: null when unset, compiled once per list', () => {
    expect(proxyTrustFor(null)).toBeNull()
    const entries = Object.freeze(['loopback'])
    expect(proxyTrustFor(entries)).toBe(proxyTrustFor(entries))
    expect(proxyTrustFor(entries)?.isTrusted('127.0.0.1')).toBe(true)
  })
})

describe('resolveClientAddress', () => {
  const trust = createProxyTrust(['loopback', '10.0.0.2'])

  it('an untrusted peer is the client, whatever it forwards', () => {
    expect(resolveClientAddress('203.0.113.9', '198.51.100.1', trust)).toBe('203.0.113.9')
    expect(resolveClientAddress('unknown', '198.51.100.1', trust)).toBe('unknown')
  })

  it('a trusted peer without X-Forwarded-For is the client', () => {
    expect(resolveClientAddress('127.0.0.1', undefined, trust)).toBe('127.0.0.1')
  })

  it('a trusted peer names the client', () => {
    expect(resolveClientAddress('127.0.0.1', '198.51.100.1', trust)).toBe('198.51.100.1')
    expect(resolveClientAddress('127.0.0.1', ' 198.51.100.1 ', trust)).toBe('198.51.100.1')
  })

  it('proxy chains: trusted hops are skipped from the right', () => {
    expect(resolveClientAddress('127.0.0.1', '198.51.100.1, 10.0.0.2', trust)).toBe('198.51.100.1')
    expect(resolveClientAddress('10.0.0.2', '198.51.100.1,127.0.0.1,10.0.0.2', trust)).toBe('198.51.100.1')
  })

  it('an untrusted hop stops the walk: what it forwarded cannot be believed', () => {
    // A CDN (not trusted) in front of the trusted proxy: the CDN is the client.
    expect(resolveClientAddress('127.0.0.1', '198.51.100.1, 203.0.113.50', trust)).toBe('203.0.113.50')
  })

  it('forged left-hand entries are ignored', () => {
    // The client sent `X-Forwarded-For: 6.6.6.6` (or a trusted address), the proxy appended the real address.
    expect(resolveClientAddress('127.0.0.1', '6.6.6.6, 198.51.100.1', trust)).toBe('198.51.100.1')
    expect(resolveClientAddress('127.0.0.1', '127.0.0.1, 198.51.100.1', trust)).toBe('198.51.100.1')
    expect(resolveClientAddress('127.0.0.1', '10.0.0.2, 198.51.100.1', trust)).toBe('198.51.100.1')
  })

  it('only trusted hops: the leftmost one', () => {
    expect(resolveClientAddress('127.0.0.1', '10.0.0.2, 127.0.0.1', trust)).toBe('10.0.0.2')
  })

  it('a malformed entry stops the walk at the last well-formed address (never an arbitrary string)', () => {
    expect(resolveClientAddress('127.0.0.1', 'garbage', trust)).toBe('127.0.0.1')
    expect(resolveClientAddress('127.0.0.1', '198.51.100.1, garbage, 10.0.0.2', trust)).toBe('10.0.0.2')
    expect(resolveClientAddress('127.0.0.1', '198.51.100.1:4711', trust)).toBe('127.0.0.1')
    expect(resolveClientAddress('127.0.0.1', '[2001:db8::7]', trust)).toBe('127.0.0.1')
    expect(resolveClientAddress('127.0.0.1', '198.51.100.1,', trust)).toBe('127.0.0.1')
    expect(resolveClientAddress('127.0.0.1', '', trust)).toBe('127.0.0.1')
    expect(resolveClientAddress('127.0.0.1', 'unknown', trust)).toBe('127.0.0.1')
  })

  it(`examines at most ${MAX_FORWARDED_FOR_ENTRIES} entries`, () => {
    const hops = (count: number): string[] => Array.from<string>({ length: count }).fill('10.0.0.2')
    expect(resolveClientAddress('127.0.0.1', ['198.51.100.1', ...hops(MAX_FORWARDED_FOR_ENTRIES - 1)].join(', '), trust)).toBe('198.51.100.1')
    expect(resolveClientAddress('127.0.0.1', ['198.51.100.1', ...hops(MAX_FORWARDED_FOR_ENTRIES)].join(', '), trust)).toBe('10.0.0.2')
    const long = [...Array.from({ length: 5000 }, (_, index) => `198.18.${index % 256}.${index % 200}`), '198.51.100.1'].join(',')
    expect(resolveClientAddress('127.0.0.1', long, trust)).toBe('198.51.100.1')
  })

  it('iPv6 and IPv4-mapped addresses are normalized', () => {
    expect(resolveClientAddress('::1', '2001:DB8:0::7', trust)).toBe('2001:db8::7')
    expect(resolveClientAddress('::ffff:127.0.0.1', '::ffff:198.51.100.1', trust)).toBe('198.51.100.1')
    expect(resolveClientAddress('127.0.0.1', '2001:db8::7, ::ffff:10.0.0.2', trust)).toBe('2001:db8::7')
  })
})
