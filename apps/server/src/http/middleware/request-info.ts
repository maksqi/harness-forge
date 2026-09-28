// Request facts shared by the middleware and the auth routes: the scheme as the client used it (HTTPS behind a reverse
// proxy via `X-Forwarded-Proto`), the server origin for the Origin check, and the TCP peer address for the login rate
// limit. Owner: W1.1.
import type { AppContext } from '../types.ts'
import { getConnInfo } from '@hono/node-server/conninfo'

export type RequestProtocol = 'http' | 'https'

/**
 * `https` when the first `X-Forwarded-Proto` value is `https` (TLS terminated by a reverse proxy) or the request URL is
 * HTTPS. A client can only claim HTTPS for its own requests: the answer sets `Secure` cookies and HSTS, nothing more.
 */
export function requestProtocol(c: AppContext): RequestProtocol {
  const forwarded = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  if (forwarded === 'https' || forwarded === 'http')
    return forwarded
  return c.req.url.startsWith('https:') ? 'https' : 'http'
}

export function isHttpsRequest(c: AppContext): boolean {
  return requestProtocol(c) === 'https'
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

/** Scheme + `Host` header (the request URL's host when the header is missing), normalized; null when invalid. */
export function serverOrigin(c: AppContext): string | null {
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
  return normalizeOrigin(`${requestProtocol(c)}://${host}`)
}

/** Placeholder address when the request carries no node-server socket bindings (a bare `app.request()`). */
export const UNKNOWN_CLIENT_ADDRESS = 'unknown'

/**
 * Address of the TCP peer (never `X-Forwarded-For`, which any client can forge), with the IPv4-mapped IPv6 form
 * reduced to plain IPv4. Behind a reverse proxy every request shares the proxy's address.
 */
export function clientAddress(c: AppContext): string {
  try {
    const address = getConnInfo(c).remote.address
    if (typeof address === 'string' && address !== '')
      return address.replace(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i, '$1').toLowerCase()
  }
  catch {
    // No node-server bindings.
  }
  return UNKNOWN_CLIENT_ADDRESS
}
