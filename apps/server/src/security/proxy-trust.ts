// Trusted reverse proxies (ADR-026, ARCHITECTURE.md 10.6): the `HF_TRUST_PROXY` format and the address matcher.
// Owner: W5.7.
//
// `HF_TRUST_PROXY` is a comma-separated list of `loopback` (127.0.0.0/8, ::1), `private` (10.0.0.0/8, 172.16.0.0/12,
// 192.168.0.0/16, fc00::/7), IP addresses and CIDR ranges. `parseTrustProxy` validates it at boot (`env.ts` turns a
// failure into an `EnvError`): `1`, `true`, hop counts, `/0` ranges and unknown tokens are refused, because trusting
// every peer lets anyone who reaches the port directly forge `X-Forwarded-For`. `proxyTrustFor` compiles the parsed
// list into a `node:net` `BlockList` (cached per list), and `resolveClientAddress` walks `X-Forwarded-For`.
//
// Addresses are normalized before they are compared or used as a key: an IPv4-mapped IPv6 address (`::ffff:10.0.0.1`)
// is its IPv4 address, IPv6 is lowercase and compressed (`2001:DB8:0::1` -> `2001:db8::1`), and anything else
// (host names, ports, brackets, zone ids, IPv4 with leading zeros) is not an address.
import { BlockList, isIP, SocketAddress } from 'node:net'

export type IpFamily = 'ipv4' | 'ipv6'

/** A parsed IP address in its canonical text form. */
export interface NormalizedAddress {
  readonly address: string
  readonly family: IpFamily
}

/** The ranges behind the `HF_TRUST_PROXY` keywords. */
export const TRUST_PROXY_KEYWORDS: Readonly<Record<'loopback' | 'private', readonly string[]>> = Object.freeze({
  loopback: Object.freeze(['127.0.0.0/8', '::1']),
  private: Object.freeze(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7']),
})

/** At most this many `X-Forwarded-For` entries are examined, from the right. */
export const MAX_FORWARDED_FOR_ENTRIES = 32

/** How to write `HF_TRUST_PROXY`; ends every parse error. */
export const TRUST_PROXY_FORMAT = 'HF_TRUST_PROXY takes a comma-separated list of loopback (127.0.0.0/8, ::1), private '
  + '(10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7), IP addresses and CIDR ranges, for example '
  + 'HF_TRUST_PROXY=loopback or HF_TRUST_PROXY=10.0.0.2,192.168.1.0/24. Leave it unset when no reverse proxy is used.'

/** Why booleans, hop counts and `/0` are refused. */
const TRUST_EVERYONE_REASON = 'it would trust every peer, so anyone who reaches the port directly could forge X-Forwarded-For'

const BOOLEAN_WORDS: ReadonlySet<string> = new Set(['true', 'false', 'yes', 'no', 'on', 'off', 'all', 'any', 'everyone', '*'])

/** Prefix of an IPv4-mapped IPv6 address in canonical (`inet_ntop`) form: `::ffff:a.b.c.d`. */
const IPV4_MAPPED_PREFIX = '::ffff:'

/** Longest accepted address text (a full IPv6 address with an embedded IPv4 address is 45 characters). */
const MAX_ADDRESS_LENGTH = 64

function isKeyword(value: string): value is keyof typeof TRUST_PROXY_KEYWORDS {
  return Object.hasOwn(TRUST_PROXY_KEYWORDS, value)
}

/** Canonical IPv6 text (`inet_ntop` form), or null. IPv4-mapped addresses keep their `::ffff:a.b.c.d` form here. */
function canonicalIPv6(value: string): string | null {
  try {
    return new SocketAddress({ address: value, family: 'ipv6' }).address
  }
  catch {
    return null
  }
}

/** The IPv4 address of a canonical IPv4-mapped IPv6 address, else null. */
function mappedIPv4(canonical: string): string | null {
  if (!canonical.startsWith(IPV4_MAPPED_PREFIX))
    return null
  const ipv4 = canonical.slice(IPV4_MAPPED_PREFIX.length)
  return isIP(ipv4) === 4 ? ipv4 : null
}

/**
 * Parses one IP address (no port, brackets or zone id) into its canonical form; IPv4-mapped IPv6 becomes IPv4. Null
 * for anything else.
 */
export function normalizeAddress(value: string): NormalizedAddress | null {
  if (value === '' || value.length > MAX_ADDRESS_LENGTH || value.includes('%'))
    return null
  const version = isIP(value)
  if (version === 4)
    return { address: value, family: 'ipv4' }
  if (version !== 6)
    return null
  const canonical = canonicalIPv6(value)
  if (canonical === null)
    return null
  const ipv4 = mappedIPv4(canonical)
  return ipv4 === null ? { address: canonical, family: 'ipv6' } : { address: ipv4, family: 'ipv4' }
}

/** A validated range: one address, or a network and its prefix length. */
interface ParsedRange {
  readonly address: string
  readonly family: IpFamily
  readonly prefix: number | null
}

function unknownToken(token: string): string {
  if (token.toLowerCase() === 'localhost')
    return `"${token}" is not supported: use loopback. ${TRUST_PROXY_FORMAT}`
  return `"${token}" is not loopback, private, an IP address or a CIDR range. ${TRUST_PROXY_FORMAT}`
}

/** Parses an address or CIDR entry (never a keyword); an error message when invalid. */
function parseRange(token: string): ParsedRange | string {
  const slash = token.indexOf('/')
  if (slash === -1) {
    const address = normalizeAddress(token)
    return address === null ? unknownToken(token) : { ...address, prefix: null }
  }
  const network = token.slice(0, slash)
  const prefixText = token.slice(slash + 1)
  const version = isIP(network)
  if (version === 0 || network.includes('%') || !/^\d{1,3}$/.test(prefixText))
    return unknownToken(token)
  const family: IpFamily = version === 4 ? 'ipv4' : 'ipv6'
  const prefix = Number(prefixText)
  const maxPrefix = family === 'ipv4' ? 32 : 128
  if (prefix > maxPrefix)
    return `"${token}": the prefix length of an ${family === 'ipv4' ? 'IPv4' : 'IPv6'} range is at most ${maxPrefix}. ${TRUST_PROXY_FORMAT}`
  const address = family === 'ipv4' ? network : canonicalIPv6(network)
  if (address === null)
    return unknownToken(token)
  // `::ffff:a.b.c.d/96..128` is the IPv4 range it maps.
  const ipv4 = family === 'ipv6' && prefix >= 96 ? mappedIPv4(address) : null
  const range: ParsedRange = ipv4 === null
    ? { address, family, prefix }
    : { address: ipv4, family: 'ipv4', prefix: prefix - 96 }
  if (range.prefix === 0)
    return `"${token}" is not supported: ${TRUST_EVERYONE_REASON}. ${TRUST_PROXY_FORMAT}`
  // A single-address range is written as the address.
  return range.prefix === (range.family === 'ipv4' ? 32 : 128) ? { ...range, prefix: null } : range
}

function formatRange(range: ParsedRange): string {
  return range.prefix === null ? range.address : `${range.address}/${range.prefix}`
}

/** Parses one list entry into its canonical form (`loopback`, `private`, an address or a CIDR range). */
function parseEntry(raw: string): { entry: string } | { error: string } {
  const token = raw.trim()
  const lower = token.toLowerCase()
  if (isKeyword(lower))
    return { entry: lower }
  if (/^\d+$/.test(token))
    return { error: `"${token}" looks like a hop count, which is not supported: ${TRUST_EVERYONE_REASON}. ${TRUST_PROXY_FORMAT}` }
  if (BOOLEAN_WORDS.has(lower))
    return { error: `"${token}" is not supported: ${TRUST_EVERYONE_REASON}. ${TRUST_PROXY_FORMAT}` }
  const range = parseRange(token)
  return typeof range === 'string' ? { error: range } : { entry: formatRange(range) }
}

export type TrustProxyParseResult
  = | { readonly ok: true, readonly entries: readonly string[] }
    | { readonly ok: false, readonly message: string }

/**
 * Validates an `HF_TRUST_PROXY` value: the canonical entries (keywords lowercase, addresses normalized, a `/32` or
 * `/128` range written as its address, duplicates and empty items dropped), or the message of the first invalid entry.
 */
export function parseTrustProxy(value: string): TrustProxyParseResult {
  const entries: string[] = []
  for (const raw of value.split(',')) {
    if (raw.trim() === '')
      continue
    const parsed = parseEntry(raw)
    if ('error' in parsed)
      return { ok: false, message: parsed.error }
    if (!entries.includes(parsed.entry))
      entries.push(parsed.entry)
  }
  if (entries.length === 0)
    return { ok: false, message: `The list names no proxy. ${TRUST_PROXY_FORMAT}` }
  return { ok: true, entries: Object.freeze(entries) }
}

/** The address ranges of parsed entries, keywords expanded, without duplicates (for the boot log). */
export function trustedRanges(entries: readonly string[]): readonly string[] {
  const ranges: string[] = []
  for (const entry of entries) {
    for (const range of isKeyword(entry) ? TRUST_PROXY_KEYWORDS[entry] : [entry]) {
      if (!ranges.includes(range))
        ranges.push(range)
    }
  }
  return Object.freeze(ranges)
}

/** A compiled `HF_TRUST_PROXY` list. */
export interface ProxyTrust {
  /** The parsed entries (`Env.trustProxy`). */
  readonly entries: readonly string[]
  /** Every trusted range, keywords expanded. */
  readonly ranges: readonly string[]
  /** True when `address` (any accepted text form, IPv4-mapped included) is a trusted proxy. */
  readonly isTrusted: (address: string) => boolean
}

/** Compiles parsed entries into a `BlockList` matcher. Throws on an invalid entry (`env.ts` validated them). */
export function createProxyTrust(entries: readonly string[]): ProxyTrust {
  const list = new BlockList()
  const ranges = trustedRanges(entries)
  for (const range of ranges) {
    const parsed = parseRange(range)
    if (typeof parsed === 'string')
      throw new TypeError(parsed)
    if (parsed.prefix === null)
      list.addAddress(parsed.address, parsed.family)
    else
      list.addSubnet(parsed.address, parsed.prefix, parsed.family)
  }
  return Object.freeze({
    entries,
    ranges,
    isTrusted: (address: string) => {
      const normalized = normalizeAddress(address)
      return normalized !== null && list.check(normalized.address, normalized.family)
    },
  })
}

const compiled = new WeakMap<readonly string[], ProxyTrust>()

/** The matcher of `Env.trustProxy` (compiled once per list), or null when `HF_TRUST_PROXY` is unset. */
export function proxyTrustFor(entries: readonly string[] | null): ProxyTrust | null {
  if (entries === null)
    return null
  let trust = compiled.get(entries)
  if (trust === undefined) {
    trust = createProxyTrust(entries)
    compiled.set(entries, trust)
  }
  return trust
}

/**
 * The client address of a request whose TCP peer is `peer` (normalized): the peer itself unless it is a trusted
 * proxy; then `X-Forwarded-For` walked right to left, skipping trusted hops, and the first untrusted entry is the
 * client. The walk stops at a malformed entry and after `MAX_FORWARDED_FOR_ENTRIES` entries; the answer is then the
 * last well-formed address seen (a trusted hop), so a forged or broken header never yields an arbitrary string.
 */
export function resolveClientAddress(peer: string, forwardedFor: string | undefined, trust: ProxyTrust): string {
  if (forwardedFor === undefined || !trust.isTrusted(peer))
    return peer
  const entries = forwardedFor.split(',')
  const stop = Math.max(0, entries.length - MAX_FORWARDED_FOR_ENTRIES)
  let client = peer
  for (let index = entries.length - 1; index >= stop; index -= 1) {
    const entry = normalizeAddress(entries[index]?.trim() ?? '')
    if (entry === null)
      break
    client = entry.address
    if (!trust.isTrusted(entry.address))
      break
  }
  return client
}
