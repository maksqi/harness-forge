// Production SPA serving (ARCHITECTURE.md 11) - Phase 0 stub: serves nothing (unknown non-API paths get the
// `not_found` envelope). Owner: W1.1 (W1.1-T9).
//
// Contract: `createStaticRoutes(deps)` returns a Hono app mounted at `/` AFTER the `/api` sub-app, so `/api/*` never
// reaches it. Serve `webPublicDir()` (`paths.ts`) when it exists: `/_nuxt/*` with
// `Cache-Control: public, max-age=31536000, immutable`, other existing files normally, and `200.html`
// (`Cache-Control: no-cache`, the SPA CSP of ARCHITECTURE.md 10.2) for any other GET / HEAD that accepts `text/html`.
// No directory listing, no path traversal outside the root.
import type { AppDeps } from '../types.ts'
import type { AppEnv } from './types.ts'
import { Hono } from 'hono'

export function createStaticRoutes(_deps: AppDeps): Hono<AppEnv> {
  return new Hono<AppEnv>()
}
