// Master-key routes (API.md 5.23, ADR-034). Owner: W7.7. Keep the export name `createKeysRoutes`. Thin: validate, call
// `deps.keys`, map to the response.
//
// - `GET /keys` reports the key state (never the key).
// - `POST /keys/rotate` needs fresh auth (route table flag, checked by the middleware; the service checks again) and
//   the typed confirmation `ROTATE`. It re-encrypts every secret, invalidates every session (the caller gets ONE new
//   cookie that keeps its `authAt`, so it stays signed in and fresh), share URL and pending approval, emits
//   `key.rotated` and closes every event stream. A key from `HF_MASTER_KEY` is `409` (`env-key`, rotate offline with
//   the CLI); a key that fails the key check is `409` (`key-mismatch`); another maintenance operation is `409` (`busy`).
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, keyRotateBodySchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { freshAuthOptions } from '../middleware/fresh-auth.ts'
import { setSessionCookie } from '../middleware/session-auth.ts'
import { validate } from '../validate.ts'

export function createKeysRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['keys.get'].path, async c => c.json(await deps.keys.status()))

  app.post(apiRoutes['keys.rotate'].path, validate('json', keyRotateBodySchema), async (c) => {
    const result = await deps.keys.rotate(c.req.valid('json'), freshAuthOptions(c))
    // Every session was signed with the old key: the caller gets a new cookie under the new key, keeping its login time.
    const { session } = c.get('auth')
    if (session !== null)
      setSessionCookie(c, await deps.sessions.issue({ authAt: session.authAt }), deps.env)
    return c.json(result)
  })

  return app
}
