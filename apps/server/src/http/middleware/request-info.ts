// Request facts shared by the middleware and the routes (ARCHITECTURE.md 10.1, 10.2, 10.6): the TCP peer, the client
// address, the scheme as the client used it, the server origin for the Origin check and the host name for the DNS
// rebinding guard. Owner: W1.1; proxy trust: W5.7 (ADR-026).
//
// Trusted reverse proxies: the helpers take the `HF_TRUST_PROXY` setting as their last parameter (pass `deps.env`).
// - `clientAddress(c, deps.env)`: the TCP peer, or, when the peer is a trusted proxy, the client named by
//   `X-Forwarded-For` (walked right to left, skipping trusted hops; `security/proxy-trust.ts`). `Forwarded` is never
//   read.
// - `requestProtocol(c, deps.env)` (and `isHttpsRequest`, `serverOrigin`): `X-Forwarded-Proto` counts only from a
//   trusted peer when `HF_TRUST_PROXY` is set, from any peer when it is unset (v1).
// - `X-Forwarded-Host` is never read: the Origin check and the password-less host guard use the `Host` header only
//   (a DNS-rebinding page reaches the server from 127.0.0.1 and can set any header, so trusting `loopback` must not
//   let it choose the host).
// Called without the setting (`clientAddress(c)`, `requestProtocol(c)`), the helpers keep the v1 behavior: the TCP
// peer, and `X-Forwarded-Proto` from anyone.
import type { Env } from '../../env.ts'
import type { AppContext } from '../types.ts'
import { getConnInfo } from '@hono/node-server/conninfo'
import { normalizeAddress, proxyTrustFor, resolveClientAddress } from '../../security/proxy-trust.ts'

export type RequestProtocol = 'http' | 'https'

/** The `HF_TRUST_PROXY` setting read by the proxy-aware helpers: pass `deps.env`. */
export type ProxyTrustSetting = Pick<Env, 'trustProxy'>

/** Placeholder address when the request carries no node-server socket bindings (a bare `app.request()`). */
export const UNKNOWN_CLIENT_ADDRESS = 'unknown'

/**
 * Address of the TCP peer (IPv4-mapped IPv6 reduced to plain IPv4, IPv6 lowercase and compressed), or
 * `UNKNOWN_CLIENT_ADDRESS`. Behind a reverse proxy this is the proxy.
 */
export function peerAddress(c: AppContext): string {
  let address: unknown
  try {
    address = getConnInfo(c).remote.address
  }
  catch {
    // No node-server bindings.
  }
  if (typeof address !== 'string' || address === '')
    return UNKNOWN_CLIENT_ADDRESS
  return normalizeAddress(address)?.address ?? address.toLowerCase()
}

/** True when `HF_TRUST_PROXY` is set and the TCP peer is one of the listed proxies. */
export function isTrustedProxyPeer(c: AppContext, trust: ProxyTrustSetting): boolean {
  return proxyTrustFor(trust.trustProxy)?.isTrusted(peerAddress(c)) ?? false
}

/**
 * The client address that keys the login and share rate limits: the TCP peer, or, when `trust` lists the peer as a
 * reverse proxy, the client named by `X-Forwarded-For` (a forwarded header from any other peer is ignored: any client
 * can forge it). Without `trust`, or with `HF_TRUST_PROXY` unset, always the TCP peer (v1).
 */
export function clientAddress(c: AppContext, trust?: ProxyTrustSetting): string {
  const peer = peerAddress(c)
  const matcher = proxyTrustFor(trust?.trustProxy ?? null)
  return matcher === null ? peer : resolveClientAddress(peer, c.req.header('x-forwarded-for'), matcher)
}

/** `X-Forwarded-Proto` counts from any peer when `HF_TRUST_PROXY` is unset (v1), else only from a trusted proxy. */
function honorsForwardedProto(c: AppContext, trust: ProxyTrustSetting | undefined): boolean {
  const matcher = proxyTrustFor(trust?.trustProxy ?? null)
  return matcher === null || matcher.isTrusted(peerAddress(c))
}

/**
 * `https` when the first `X-Forwarded-Proto` value is `https` (TLS terminated by a reverse proxy; honored under the
 * rule of `honorsForwardedProto`) or the request URL is HTTPS. A client can only claim HTTPS for its own requests: the
 * answer sets `Secure` cookies, HSTS and the scheme of the Origin check, nothing more.
 */
export function requestProtocol(c: AppContext, trust?: ProxyTrustSetting): RequestProtocol {
  if (honorsForwardedProto(c, trust)) {
    const forwarded = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
    if (forwarded === 'https' || forwarded === 'http')
      return forwarded
  }
  return c.req.url.startsWith('https:') ? 'https' : 'http'
}

export function isHttpsRequest(c: AppContext, trust?: ProxyTrustSetting): boolean {
  return requestProtocol(c, trust) === 'https'
}

/** The serialized origin of an `http(s)` URL or origin string (`https://Example.com:443` -> `https://example.com`). */
export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  }
  catch {
    return null
  }
}

/** The `Host` header (the request URL's host when the header is missing); never `X-Forwarded-Host`. Null when invalid. */
function requestHost(c: AppContext): string | null {
  let host = c.req.header('host')?.trim()
  if (host === undefined || host === '') {
    try {
      host = new URL(c.req.url).host
    }
    catch {
      return null
    }
  }
  if (host === '' || /[\s/\\?#@]/.test(host))
    return null
  return host
}

/** Scheme (`requestProtocol`) + `Host` header, normalized; null when invalid. `X-Forwarded-Host` never counts. */
export function serverOrigin(c: AppContext, trust?: ProxyTrustSetting): string | null {
  const host = requestHost(c)
  return host === null ? null : normalizeOrigin(`${requestProtocol(c, trust)}://${host}`)
}

/**
 * The host name the request was addressed to (`Host` header, else the request URL's host; never `X-Forwarded-Host`):
 * lowercase, without the port, IPv6 brackets or a trailing dot. Null when it cannot be parsed.
 */
export function requestHostname(c: AppContext): string | null {
  const host = requestHost(c)
  if (host === null)
    return null
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase()
    return hostname.replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '') || null
  }
  catch {
    return null
  }
}
