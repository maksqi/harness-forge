// Secure headers (ARCHITECTURE.md 10.2) - Phase 0 pass-through stub. Owner: W1.1 (W1.1-T7), with `security/headers.ts`.
//
// Contract: runs for every response (third middleware of the chain, before the `/api` routes and the SPA). Sets
// `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
// `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`,
// `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `Strict-Transport-Security` only over HTTPS
// (`X-Forwarded-Proto: https` counts); `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` and
// `Cache-Control: no-store` on `/api` JSON responses unless the route set its own (icons, files, SSE); the SPA HTML
// CSP (with the inline-script hashes of `200.html`) is set by `http/static.ts`. Never sends CORS headers.
import type { AppDeps } from '../../types.ts'
import type { AppMiddleware } from '../types.ts'

export function secureHeadersMiddleware(_deps: AppDeps): AppMiddleware {
  return async (_c, next) => {
    await next()
  }
}
