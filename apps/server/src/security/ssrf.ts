// Outbound HTTP with the SSRF guard (ARCHITECTURE.md 10.4, the frozen `SafeFetch` of ./types.ts). Owner: W3.5.
// Used by the `web_fetch` tool (core-tools) and by URL installs (W3.2).
//
// Every hop of an exchange (the first URL and each redirect) is checked before any connection is made:
// - only the allowed protocols (default `http:` and `https:`) and no credentials in the URL;
// - an IP literal host is classified directly; a host name is resolved ONCE (every address) and every answer must be a
//   public address, so a DNS rebinding answer that mixes public and private addresses is refused as a whole;
// - the socket connects to one of the checked addresses through a pinned `lookup` (the name is never resolved again
//   between the check and the connection); TLS still verifies the certificate against the host name.
// Redirects are followed manually (at most `maxRedirects`, each hop re-checked), the whole exchange shares one timeout,
// and the body is capped at `maxBytes`, counted on the raw stream and again after decompression (zip-bomb safe).
//
// Phase 12 (ADR-054, C45-T3, FROZEN after Gate P12-0b): `createPluginSourceFetch` is the one `SafeFetch` of plugin
// sources and marketplaces (GitHub API, raw, codeload, archive URLs, hosted `marketplace.json`): https only. With the
// test-only `HF_TEST_REMOTE_URL` (`env.testRemoteUrl`, honored only with `HF_MOCK_PROVIDER=1`; `http://127.0.0.1:<port>`
// of the loopback fake in `testing/fake-remote.ts`) every hop `https://<host>/<path>` is requested from
// `<base>/<host>/<path>` instead; loopback is allowed for that base only, and every other rule is unchanged: the URL
// must still be https without credentials, an IP literal or `localhost` host is classified as usual (so
// `https://127.0.0.1/…` and `http://127.0.0.1:<port>/…` stay refused), redirects are re-checked and rerouted the same way,
// and the result carries the original (logical) URL. No host name is ever resolved in that mode.
import type { LookupAddress } from 'node:dns'
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'node:http'
import type { LookupFunction } from 'node:net'
import type { Readable } from 'node:stream'
import type { SafeFetch, SafeFetchOptions, SafeFetchResult } from './types.ts'
import { Buffer } from 'node:buffer'
import { lookup as dnsLookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP, isIPv4, isIPv6 } from 'node:net'
import zlib from 'node:zlib'
import { HarnessError, isHarnessError } from '@harness-forge/shared'

// ---------- address classification ----------

/**
 * Class of an IP address:
 * - `public`: globally routable, allowed;
 * - `loopback`: 127.0.0.0/8, ::1 (allowed only with `allowLoopback`);
 * - `private`: 10/8, 172.16/12, 192.168/16, IPv6 ULA fc00::/7 and site-local fec0::/10;
 * - `link-local`: 169.254/16, fe80::/10;
 * - `metadata`: cloud metadata endpoints 169.254.169.254 and fd00:ec2::254;
 * - `cgnat`: shared address space 100.64/10;
 * - `multicast`: 224/4, ff00::/8;
 * - `unspecified`: 0/8, ::;
 * - `reserved`: documentation, benchmarking, protocol assignments, 240/4, broadcast, 100::/64, Teredo 2001::/32,
 *   local-use NAT64 64:ff9b:1::/48;
 * - `invalid`: not an IP address.
 * IPv4 addresses embedded in IPv6 (IPv4-mapped, IPv4-compatible, IPv4-translated, NAT64 64:ff9b::/96, 6to4 2002::/16)
 * get the class of the embedded IPv4 address.
 */
export type AddressClass
  = | 'public'
    | 'loopback'
    | 'private'
    | 'link-local'
    | 'metadata'
    | 'cgnat'
    | 'multicast'
    | 'unspecified'
    | 'reserved'
    | 'invalid'

type BlockedClass = Exclude<AddressClass, 'public'>

/** "…, which is <label>" in error messages. */
const CLASS_LABELS: Readonly<Record<BlockedClass, string>> = {
  'loopback': 'a loopback address',
  'private': 'a private network address',
  'link-local': 'a link-local address',
  'metadata': 'a cloud metadata address',
  'cgnat': 'a carrier-grade NAT address',
  'multicast': 'a multicast address',
  'unspecified': 'an unspecified address',
  'reserved': 'a reserved address',
  'invalid': 'not a valid IP address',
}

function ipv4Number(address: string): number | null {
  if (!isIPv4(address))
    return null
  const [a = 0, b = 0, c = 0, d = 0] = address.split('.').map(Number)
  return a * 2 ** 24 + b * 2 ** 16 + c * 2 ** 8 + d
}

/** IPv4 ranges, most specific first where they overlap. */
const IPV4_RULES: ReadonlyArray<readonly [number, number, BlockedClass]> = ([
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'cgnat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.169.254', 32, 'metadata'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'reserved'],
  ['192.0.2.0', 24, 'reserved'],
  ['192.88.99.0', 24, 'reserved'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'reserved'],
  ['198.51.100.0', 24, 'reserved'],
  ['203.0.113.0', 24, 'reserved'],
  ['224.0.0.0', 4, 'multicast'],
  ['255.255.255.255', 32, 'reserved'],
  ['240.0.0.0', 4, 'reserved'],
] as const).map(([base, prefix, kind]) => [ipv4Number(base) ?? 0, prefix, kind] as const)

function ipv4Mask(prefix: number): number {
  return prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0
}

function classifyIPv4Number(value: number): AddressClass {
  for (const [base, prefix, kind] of IPV4_RULES) {
    const mask = ipv4Mask(prefix)
    if (((value & mask) >>> 0) === ((base & mask) >>> 0))
      return kind
  }
  return 'public'
}

/** The 8 groups of an IPv6 address (zone id removed; embedded dotted IPv4 converted), or null. */
function ipv6Groups(address: string): number[] | null {
  const zone = address.indexOf('%')
  const value = zone === -1 ? address : address.slice(0, zone)
  if (!isIPv6(value))
    return null
  let text = value
  const lastColon = value.lastIndexOf(':')
  const tail = value.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = ipv4Number(tail)
    if (v4 === null)
      return null
    text = `${value.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xFFFF).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2)
    return null
  const parse = (part: string | undefined): number[] => (part ? part.split(':').map(group => Number.parseInt(group, 16)) : [])
  const left = parse(halves[0])
  const right = halves.length === 2 ? parse(halves[1]) : []
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0
  if (fill < 0)
    return null
  const groups = [...left, ...Array.from<number>({ length: fill }).fill(0), ...right]
  if (groups.length !== 8 || groups.some(group => !Number.isInteger(group) || group < 0 || group > 0xFFFF))
    return null
  return groups
}

function groupsToBigInt(groups: readonly number[]): bigint {
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n)
}

function ipv6Value(address: string): bigint {
  return groupsToBigInt(ipv6Groups(address) ?? [])
}

function inIPv6Prefix(value: bigint, base: bigint, prefix: number): boolean {
  const shift = BigInt(128 - prefix)
  return (value >> shift) === (base >> shift)
}

const V6 = {
  mapped: ipv6Value('::ffff:0:0'),
  translated: ipv6Value('::ffff:0:0:0'),
  nat64: ipv6Value('64:ff9b::'),
  nat64Local: ipv6Value('64:ff9b:1::'),
  discard: ipv6Value('100::'),
  documentation: ipv6Value('2001:db8::'),
  teredo: ipv6Value('2001::'),
  sixToFour: ipv6Value('2002::'),
  awsMetadata: ipv6Value('fd00:ec2::254'),
  uniqueLocal: ipv6Value('fc00::'),
  linkLocal: ipv6Value('fe80::'),
  siteLocal: ipv6Value('fec0::'),
  multicast: ipv6Value('ff00::'),
} as const

const LOW_32_BITS = 0xFFFFFFFFn

function classifyIPv6Value(value: bigint): AddressClass {
  if (value === 0n)
    return 'unspecified'
  if (value === 1n)
    return 'loopback'
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-translated (::ffff:0:a.b.c.d) and IPv4-compatible (::a.b.c.d).
  if (inIPv6Prefix(value, V6.mapped, 96) || inIPv6Prefix(value, V6.translated, 96) || (value >> 32n) === 0n)
    return classifyIPv4Number(Number(value & LOW_32_BITS))
  if (inIPv6Prefix(value, V6.nat64, 96))
    return classifyIPv4Number(Number(value & LOW_32_BITS))
  if (inIPv6Prefix(value, V6.nat64Local, 48))
    return 'reserved'
  if (inIPv6Prefix(value, V6.discard, 64))
    return 'reserved'
  if (inIPv6Prefix(value, V6.documentation, 32) || inIPv6Prefix(value, V6.teredo, 32))
    return 'reserved'
  if (inIPv6Prefix(value, V6.sixToFour, 16))
    return classifyIPv4Number(Number((value >> 80n) & LOW_32_BITS))
  if (value === V6.awsMetadata)
    return 'metadata'
  if (inIPv6Prefix(value, V6.uniqueLocal, 7))
    return 'private'
  if (inIPv6Prefix(value, V6.linkLocal, 10))
    return 'link-local'
  if (inIPv6Prefix(value, V6.siteLocal, 10))
    return 'private'
  if (inIPv6Prefix(value, V6.multicast, 8))
    return 'multicast'
  return 'public'
}

/** Removes the brackets of an IPv6 URL host (`[::1]` -> `::1`). */
function unbracket(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/** Classifies an IPv4 or IPv6 address (brackets and IPv6 zone ids are accepted). See `AddressClass`. */
export function classifyAddress(address: string): AddressClass {
  const value = unbracket(String(address).trim())
  const v4 = ipv4Number(value)
  if (v4 !== null)
    return classifyIPv4Number(v4)
  const groups = ipv6Groups(value)
  return groups === null ? 'invalid' : classifyIPv6Value(groupsToBigInt(groups))
}

/** True unless the address is public (or loopback while `allowLoopback` is set). Invalid input is blocked. */
export function isBlockedAddress(address: string, options: { allowLoopback?: boolean } = {}): boolean {
  const kind = classifyAddress(address)
  return !(kind === 'public' || (kind === 'loopback' && options.allowLoopback === true))
}

// ---------- configuration ----------

export interface SafeFetchConfig {
  /** Allow loopback targets (127.0.0.0/8, ::1, names resolving only to them). Default false. Everything else non-public stays blocked. */
  allowLoopback?: boolean
  /** DNS resolver (tests simulate rebinding); default `dns.promises.lookup(host, { all: true, order: 'verbatim' })`. */
  lookup?: (hostname: string) => Promise<Array<{ address: string, family: 4 | 6 }>>
  /** Default User-Agent (e.g. `harness-forge/<appVersion>`); the caller's headers win. */
  userAgent?: string
}

/** Default timeout of a whole exchange, redirects and body included. */
export const SAFE_FETCH_TIMEOUT_MS = 10_000
/** Default maximum number of redirects. */
export const SAFE_FETCH_MAX_REDIRECTS = 5
/** Default protocols. */
export const SAFE_FETCH_PROTOCOLS: readonly ('http:' | 'https:')[] = ['http:', 'https:']
/** Default User-Agent when neither the config nor the caller sets one. */
export const SAFE_FETCH_USER_AGENT = 'harness-forge'

/** Longest URL accepted (first URL and redirect locations). */
const MAX_URL_LENGTH = 8192
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])
/** Request headers the caller cannot set (the connection is ours). */
const RESERVED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'proxy-connection',
])
/** Headers dropped when a redirect leaves the origin. */
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(['authorization', 'cookie', 'proxy-authorization'])
/** Node error codes that mean "the host could not be reached". */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NONAME',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTDOWN',
  'ETIMEDOUT',
  'EPIPE',
  'EPROTO',
  'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_SOCKET',
])

async function defaultLookup(hostname: string): Promise<Array<{ address: string, family: 4 | 6 }>> {
  const results = await dnsLookup(hostname, { all: true, order: 'verbatim' })
  return results.map(result => ({ address: result.address, family: result.family === 6 ? 6 : 4 }))
}

// ---------- errors ----------

function invalid(message: string): HarnessError {
  return new HarnessError({ code: 'validation_error', message })
}

function tooLarge(limitBytes: number): HarnessError {
  return new HarnessError({
    code: 'payload_too_large',
    message: `The response is larger than the limit of ${limitBytes} bytes.`,
    details: { limitBytes },
  })
}

function unreachable(host: string, reason?: string): HarnessError {
  return new HarnessError({ code: 'provider_unreachable', message: `Could not reach ${host}${reason ? ` (${reason})` : ''}.`, action: 'retry' })
}

function blocked(host: string, address: string, kind: BlockedClass): HarnessError {
  const target = host === address ? `The address ${address}` : `The host "${host}" resolves to ${address}, which`
  return invalid(`${target} is ${CLASS_LABELS[kind]}: only public internet addresses can be fetched.`)
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** An `AbortError` carrying the caller's abort reason. */
function abortError(reason: unknown): Error {
  if (reason instanceof Error)
    return reason
  const error = new Error('The request was aborted.', { cause: reason })
  error.name = 'AbortError'
  return error
}

// ---------- URLs and addresses ----------

function checkUrl(url: URL, protocols: readonly string[], context: string): URL {
  if (!protocols.includes(url.protocol))
    throw invalid(`${context}: only ${protocols.map(protocol => protocol.slice(0, -1)).join(' and ')} URLs are allowed, not ${url.protocol.slice(0, -1) || 'this one'}.`)
  if (url.username !== '' || url.password !== '')
    throw invalid(`${context}: URLs with credentials are not allowed.`)
  if (url.hostname === '')
    throw invalid(`${context}: the URL has no host.`)
  url.hash = ''
  return url
}

function parseUrl(input: unknown, protocols: readonly string[]): URL {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_URL_LENGTH || !URL.canParse(input))
    throw invalid('Invalid URL: expected an absolute http:// or https:// URL.')
  return checkUrl(new URL(input), protocols, 'Invalid URL')
}

function parseRedirect(location: string, base: URL, protocols: readonly string[]): URL {
  if (location.length > MAX_URL_LENGTH || !URL.canParse(location, base.href))
    throw new HarnessError({ code: 'provider_error', message: `${base.host} redirected to an invalid URL.` })
  return checkUrl(new URL(location, base), protocols, `${base.host} redirected to a URL that is not allowed`)
}

function isLocalhostName(name: string): boolean {
  const host = name.toLowerCase().replace(/\.$/, '')
  return host === 'localhost' || host.endsWith('.localhost')
}

/** Resolves and checks the host of `url`; returns the addresses the connection may use. */
async function checkedAddresses(url: URL, config: Required<Pick<SafeFetchConfig, 'lookup'>> & { allowLoopback: boolean }): Promise<LookupAddress[]> {
  const host = unbracket(url.hostname)
  const family = isIP(host)
  if (family !== 0) {
    const kind = classifyAddress(host)
    if (kind !== 'public' && !(kind === 'loopback' && config.allowLoopback))
      throw blocked(host, host, kind)
    return [{ address: host, family }]
  }
  if (isLocalhostName(host) && !config.allowLoopback)
    throw invalid(`The host "${host}" is ${CLASS_LABELS.loopback}: only public internet addresses can be fetched.`)
  let answers: Array<{ address: string, family: 4 | 6 }>
  try {
    answers = await config.lookup(host)
  }
  catch (error) {
    throw new HarnessError({
      code: 'provider_unreachable',
      message: `Could not resolve the host "${host}"${errorCode(error) ? ` (${errorCode(error)})` : ''}.`,
      action: 'retry',
    })
  }
  if (!Array.isArray(answers) || answers.length === 0)
    throw new HarnessError({ code: 'provider_unreachable', message: `Could not resolve the host "${host}".`, action: 'retry' })
  const addresses: LookupAddress[] = []
  for (const answer of answers) {
    const address = String(answer.address)
    const kind = classifyAddress(address)
    if (kind !== 'public' && !(kind === 'loopback' && config.allowLoopback))
      throw blocked(host, address, kind)
    addresses.push({ address, family: isIP(address) === 6 ? 6 : 4 })
  }
  return addresses
}

function familyOf(value: unknown): 0 | 4 | 6 {
  if (value === 4 || value === 'IPv4')
    return 4
  if (value === 6 || value === 'IPv6')
    return 6
  return 0
}

/** A `lookup` that answers only with the pre-checked addresses (no second resolution). */
function pinnedLookup(addresses: readonly LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const wanted = familyOf(options.family)
    const matches = wanted === 0 ? addresses : addresses.filter(address => address.family === wanted)
    const first = matches[0]
    if (first === undefined) {
      const error: NodeJS.ErrnoException = new Error('No checked address of the requested family.')
      error.code = 'ENOTFOUND'
      callback(error, options.all ? [] : '', 0)
      return
    }
    if (options.all)
      callback(null, matches.map(address => ({ address: address.address, family: address.family })))
    else
      callback(null, first.address, first.family)
  }
}

// ---------- request / response ----------

function requestHeaders(custom: Record<string, string> | undefined, userAgent: string): Record<string, string> {
  const headers: Record<string, string> = {
    'user-agent': userAgent,
    'accept': '*/*',
    'accept-encoding': 'gzip, deflate, br',
  }
  for (const [name, value] of Object.entries(custom ?? {})) {
    const key = name.toLowerCase()
    if (RESERVED_REQUEST_HEADERS.has(key))
      continue
    if (typeof value !== 'string' || /[\r\n\0]/.test(value))
      throw invalid(`The request header "${name}" has an invalid value.`)
    headers[key] = value
  }
  return headers
}

function withoutCredentials(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name)))
}

function openRequest(url: URL, method: 'GET' | 'HEAD', headers: Record<string, string>, addresses: readonly LookupAddress[], signal: AbortSignal): Promise<IncomingMessage> {
  const transport = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    let request: ClientRequest
    try {
      request = transport.request(url, {
        method,
        headers,
        // A fresh agent per request: no pooled socket is ever reused for another (unchecked) resolution.
        agent: false,
        lookup: pinnedLookup(addresses),
        signal,
      }, resolve)
    }
    catch (error) {
      reject(error)
      return
    }
    request.once('error', reject)
    request.end()
  })
}

function responseHeaders(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item !== 'string')
        continue
      try {
        headers.append(name, item)
      }
      catch {
        // A header value that `Headers` refuses is dropped.
      }
    }
  }
  return headers
}

/** A decoder for the response `Content-Encoding`, null for identity; unsupported encodings fail. */
function decoderFor(encoding: string | undefined, host: string): zlib.Gunzip | zlib.Unzip | zlib.BrotliDecompress | null {
  const value = (encoding ?? '').trim().toLowerCase()
  if (value === '' || value === 'identity')
    return null
  if (value === 'gzip' || value === 'x-gzip' || value === 'deflate')
    return zlib.createUnzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH })
  if (value === 'br')
    return zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH })
  throw new HarnessError({ code: 'provider_error', message: `${host} answered with an unsupported content encoding.` })
}

/** Reads the body, counting raw and decoded bytes against `maxBytes`. */
async function readBody(response: IncomingMessage, maxBytes: number, signal: AbortSignal, host: string): Promise<Uint8Array> {
  const declared = response.headers['content-length']
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    response.destroy()
    throw tooLarge(maxBytes)
  }
  const decoder = decoderFor(response.headers['content-encoding'], host)
  let source: Readable = response
  if (decoder !== null) {
    let raw = 0
    response.on('data', (chunk: Buffer) => {
      raw += chunk.length
      if (raw > maxBytes)
        response.destroy(tooLarge(maxBytes))
    })
    response.once('error', error => decoder.destroy(error))
    response.pipe(decoder)
    source = decoder
  }
  const onAbort = (): void => {
    source.destroy(abortError(signal.reason))
  }
  if (signal.aborted)
    onAbort()
  signal.addEventListener('abort', onAbort, { once: true })
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of source) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      total += buffer.length
      if (total > maxBytes)
        throw tooLarge(maxBytes)
      chunks.push(buffer)
    }
  }
  catch (error) {
    if (errorCode(error)?.startsWith('Z_') || errorCode(error) === 'ERR__ERROR' || errorCode(error) === 'ERR_BROTLI_DECOMPRESSION_FAILED')
      throw new HarnessError({ code: 'provider_error', message: `The response of ${host} could not be decompressed.` })
    throw error
  }
  finally {
    signal.removeEventListener('abort', onAbort)
    decoder?.destroy()
    response.destroy()
  }
  const body = Buffer.concat(chunks)
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
}

/** Rejects with the abort reason when `signal` aborts first. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function checkOptions(options: SafeFetchOptions): void {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
    throw invalid('maxBytes must be a non-negative integer.')
  if (options.timeoutMs !== undefined && !(Number.isFinite(options.timeoutMs) && options.timeoutMs > 0))
    throw invalid('timeoutMs must be a positive number.')
  if (options.maxRedirects !== undefined && !(Number.isSafeInteger(options.maxRedirects) && options.maxRedirects >= 0))
    throw invalid('maxRedirects must be a non-negative integer.')
  if (options.method !== undefined && options.method !== 'GET' && options.method !== 'HEAD')
    throw invalid('Only GET and HEAD requests are supported.')
}

// ---------- factory ----------

/** Maps the checked (logical) URL of a hop to the URL actually requested (the test remote); null = the URL itself. */
type HopRoute = (url: URL) => URL

/** A `SafeFetch` with its own policy (`allowLoopback`), resolver and default User-Agent. */
export function createSafeFetch(config: SafeFetchConfig = {}): SafeFetch {
  return createGuardedFetch(config, null)
}

/** The guard of `createSafeFetch`; with `route`, each hop is requested from `route(url)` (see the module comment). */
function createGuardedFetch(config: SafeFetchConfig, route: HopRoute | null): SafeFetch {
  const policy = { lookup: config.lookup ?? defaultLookup, allowLoopback: config.allowLoopback === true }
  // The routed target is always the loopback test remote (an IP literal: no resolution); `route` vetted the logical URL.
  const routedPolicy = { lookup: policy.lookup, allowLoopback: true }
  const userAgent = config.userAgent ?? SAFE_FETCH_USER_AGENT

  return async (input: string, options: SafeFetchOptions): Promise<SafeFetchResult> => {
    checkOptions(options)
    const timeoutMs = options.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS
    const maxRedirects = options.maxRedirects ?? SAFE_FETCH_MAX_REDIRECTS
    const protocols = options.protocols ?? SAFE_FETCH_PROTOCOLS
    const method = options.method ?? 'GET'
    const external = options.signal
    if (external?.aborted)
      throw abortError(external.reason)

    let url = parseUrl(input, protocols)
    let headers = requestHeaders(options.headers, userAgent)
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('timeout'))
    }, timeoutMs)
    const onExternalAbort = (): void => controller.abort(external?.reason)
    external?.addEventListener('abort', onExternalAbort, { once: true })

    try {
      for (let redirects = 0; ; redirects++) {
        const target = route === null ? url : route(url)
        const addresses = await raceAbort(checkedAddresses(target, route === null ? policy : routedPolicy), controller.signal)
        const response = await openRequest(target, method, headers, addresses, controller.signal)
        const status = response.statusCode ?? 0
        const location = response.headers.location
        if (REDIRECT_STATUSES.has(status) && typeof location === 'string' && location.trim() !== '') {
          response.destroy()
          if (redirects >= maxRedirects)
            throw new HarnessError({ code: 'provider_error', message: `Too many redirects: ${url.host} redirected more than ${maxRedirects} times.` })
          const next = parseRedirect(location.trim(), url, protocols)
          if (next.origin !== url.origin)
            headers = withoutCredentials(headers)
          url = next
          continue
        }
        let body: Uint8Array
        if (method === 'HEAD') {
          response.destroy()
          body = new Uint8Array(0)
        }
        else {
          body = await readBody(response, options.maxBytes, controller.signal, url.host)
        }
        return { url: url.href, status, headers: responseHeaders(response.headers), body }
      }
    }
    catch (error) {
      if (timedOut)
        throw new HarnessError({ code: 'provider_unreachable', message: `The request to ${url.host} timed out after ${timeoutMs} ms.`, action: 'retry' })
      if (external?.aborted)
        throw abortError(external.reason)
      if (isHarnessError(error))
        throw error
      const code = errorCode(error)
      if (code === 'ERR_INVALID_CHAR' || code === 'ERR_INVALID_HTTP_TOKEN' || code === 'ERR_UNESCAPED_CHARACTERS')
        throw invalid('The request has an invalid header or URL.')
      if (code !== undefined && (UNREACHABLE_CODES.has(code) || /CERT|TLS|SSL/.test(code)))
        throw unreachable(url.host, code)
      throw unreachable(url.host)
    }
    finally {
      clearTimeout(timer)
      external?.removeEventListener('abort', onExternalAbort)
    }
  }
}

/** The default guard: public addresses only, system DNS. */
export const safeFetch: SafeFetch = createSafeFetch()

// ---------- plugin sources and the test remote (Phase 12) ----------

/** The only protocol of plugin-source and marketplace fetches. */
export const PLUGIN_SOURCE_PROTOCOLS: readonly ('http:' | 'https:')[] = ['https:']

const TEST_REMOTE_URL = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/

/**
 * The base of a valid `HF_TEST_REMOTE_URL` (`http://127.0.0.1:<port>`, port 1 – 65535, an optional trailing slash),
 * normalized without the slash; null for any other value (`localhost`, https, a path, another address).
 */
export function parseTestRemoteUrl(value: string): string | null {
  if (typeof value !== 'string')
    return null
  const match = TEST_REMOTE_URL.exec(value.trim())
  const port = match === null ? 0 : Number(match[1])
  return port >= 1 && port <= 65_535 ? `http://127.0.0.1:${port}` : null
}

/** `https://<host>/<path>?<query>` as the test remote serves it: `<base>/<host>/<path>?<query>` (the fragment dropped). */
export function testRemoteUrlFor(base: string, url: string): string {
  const parsed = new URL(url)
  return `${base.replace(/\/+$/, '')}/${parsed.host}${parsed.pathname}${parsed.search}`
}

/** The hop route of the test remote: vets the logical host like the guard, then points the request at `base`. */
function testRemoteRoute(base: string): HopRoute {
  return (url) => {
    const host = unbracket(url.hostname)
    if (isIP(host) !== 0) {
      const kind = classifyAddress(host)
      if (kind !== 'public')
        throw blocked(host, host, kind)
    }
    else if (isLocalhostName(host)) {
      throw invalid(`The host "${host}" is ${CLASS_LABELS.loopback}: only public internet addresses can be fetched.`)
    }
    return new URL(testRemoteUrlFor(base, url.href))
  }
}

export interface PluginSourceFetchOptions {
  /** `env.testRemoteUrl` (`HF_TEST_REMOTE_URL`; null, undefined or '' = the real hosts). Any other invalid value throws. */
  readonly testRemoteUrl?: string | null
  /** DNS resolver of the normal guard (tests). */
  readonly lookup?: SafeFetchConfig['lookup']
  /** Default User-Agent; the caller's headers win. */
  readonly userAgent?: string
}

/**
 * The `SafeFetch` of plugin sources and marketplaces (GitHub API, raw, codeload, archive and `marketplace.json` URLs):
 * the normal guard restricted to https (`protocols` of a call are ignored). With `testRemoteUrl` every hop goes to the
 * loopback test remote instead (see the module comment).
 */
export function createPluginSourceFetch(options: PluginSourceFetchOptions = {}): SafeFetch {
  const config: SafeFetchConfig = {
    ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
    ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
  }
  const remote = options.testRemoteUrl ?? ''
  let guarded: SafeFetch
  if (remote === '') {
    guarded = createGuardedFetch(config, null)
  }
  else {
    const base = parseTestRemoteUrl(remote)
    if (base === null)
      throw new TypeError('The test remote URL must be http://127.0.0.1:<port>.')
    guarded = createGuardedFetch(config, testRemoteRoute(base))
  }
  return (url, fetchOptions) => guarded(url, { ...fetchOptions, protocols: PLUGIN_SOURCE_PROTOCOLS })
}
