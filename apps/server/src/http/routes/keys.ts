// Master-key routes (API.md 5.23, ADR-034) - Phase 7 stubs (501). Owner: W7.7. Keep the export name
// `createKeysRoutes`. Thin: validate, call `deps.keys`, map to the response.
//
// - `GET /keys` reports the key state (never the key).
// - `POST /keys/rotate` needs fresh auth (route table flag, checked by the middleware; the service checks again) and
//   the typed confirmation `ROTATE`. It re-encrypts every secret, invalidates every session (the caller gets a new
//   cookie that keeps its `authAt`), share URL and pending approval, emits `key.rotated` and closes every event stream.
//   A key from `HF_MASTER_KEY` is `409` (`env-key`, rotate offline with the CLI); a key that fails the key check is
//   `409` (`key-mismatch`); another maintenance operation is `409` (`busy`).
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, keyRotateBodySchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createKeysRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['keys.get'].path, notImplemented('keys.get'))
  app.post(apiRoutes['keys.rotate'].path, validate('json', keyRotateBodySchema), notImplemented('keys.rotate'))
  return app
}
