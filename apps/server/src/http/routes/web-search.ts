// Web search test route (API.md 5.40, ADR-063) - Phase 14 stub (501). Owner: W14.5. Keep the export name
// `createWebSearchRoutes`. Thin: validate, run one search through `core-search`'s backend client.
//
// - `POST /web-search/test` (body `{ backend? }`, default the backend selected in the `core-search` settings; no fresh
//   auth): runs one fixed query with the stored key of that backend (through `createPluginSourceFetch`: https only,
//   10 s, 1 MB, no redirects) and answers `{ ok: true, backend, results, ms }`. `400` `provider_not_configured` when the
//   backend has no key, `502` `provider_error` "key rejected" for a 401 / 403 (the key is never echoed), `429`
//   `rate_limited`, `502` `provider_unreachable`. `HF_OFFLINE` does not block it (an explicit user action).
// - Never logs the query or the key at `info`.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, webSearchTestBodySchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createWebSearchRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.post(apiRoutes['webSearch.test'].path, validate('json', webSearchTestBodySchema), notImplemented('webSearch.test'))
  return app
}
