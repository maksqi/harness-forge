// Secure headers (ARCHITECTURE.md 10.2) for every response, with `security/headers.ts`. Owner: W1.1 (W1.1-T7).
//
// Third middleware of the chain; runs after the routes and the SPA answered (errors included). Sets, unless the route
// set its own value: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
// `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`,
// `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `X-Robots-Tag: noindex, nofollow` (ADR-025), and
// `Strict-Transport-Security` only over HTTPS (`X-Forwarded-Proto: https` counts from a trusted proxy when
// `HF_TRUST_PROXY` is set, from any peer when it is unset; ADR-026). `/api` responses (and JSON answers elsewhere, e.g.
// the not-found envelope) get `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` and
// `Cache-Control: no-store` unless the route set its own (icons, files, SSE); the SPA HTML CSP (inline-script hashes of
// `200.html`) is set by `http/static.ts`.
// CORS headers are never sent: any `Access-Control-*` header is removed.
import type { AppDeps } from '../../types.ts'
import type { AppMiddleware } from '../types.ts'
import { API_CACHE_CONTROL, API_CSP, HSTS_HEADER_VALUE, SECURITY_HEADERS } from '../../security/headers.ts'
import { apiRelativePath } from '../route-match.ts'
import { isHttpsRequest } from './request-info.ts'
import { setHeaderIfAbsent, updateResponseHeaders } from './response-headers.ts'

function isJsonContentType(contentType: string | null): boolean {
  const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? ''
  return type === 'application/json' || type.endsWith('+json')
}

export function secureHeadersMiddleware(deps: AppDeps): AppMiddleware {
  return async (c, next) => {
    await next()
    const https = isHttpsRequest(c, deps.env)
    const api = apiRelativePath(c.req.path) !== null
    updateResponseHeaders(c, (headers) => {
      for (const [name, value] of Object.entries(SECURITY_HEADERS))
        setHeaderIfAbsent(headers, name, value)
      if (https)
        setHeaderIfAbsent(headers, 'Strict-Transport-Security', HSTS_HEADER_VALUE)
      if (api || isJsonContentType(headers.get('content-type'))) {
        setHeaderIfAbsent(headers, 'Content-Security-Policy', API_CSP)
        setHeaderIfAbsent(headers, 'Cache-Control', API_CACHE_CONTROL)
      }
      const cors = [...headers.keys()].filter(name => name.toLowerCase().startsWith('access-control-'))
      for (const name of cors)
        headers.delete(name)
    })
  }
}
