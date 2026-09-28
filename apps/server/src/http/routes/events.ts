// `GET /events` server-sent events (API.md 5.4 and 7). Owner: W1.5 (W1.5-T1). Keep the export name
// `createEventsRoutes`.
//
// One `deps.events` subscription per connection (`services/events/sse.ts`): `retry: 3000`, then one frame per
// `ServerEvent`, `: ping` every 25 s. The stream ends when the client disconnects (abort), on shutdown (`onClose` of the
// subscription), when the client does not keep up (queue overflow), or when a heartbeat re-check finds the session no
// longer valid (password change, logout elsewhere, expiry). Session auth runs before this route (`events.stream` is not
// public); the handler re-checks `c.var.auth` as a second line of defense. The response is never compressed or
// buffered (`X-Accel-Buffering: no`, one write per frame).
import type { AppDeps } from '../../types.ts'
import type { AppContext, AppEnv, RequestAuth } from '../types.ts'
import { apiRoutes, HarnessError } from '@harness-forge/shared'
import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { streamSSE } from 'hono/streaming'
import { openEventStream, SSE_HEADERS } from '../../services/events/sse.ts'

/** Session cookie name (DECISIONS.md "Identifiers"). */
const SESSION_COOKIE = 'hf_session'

function requestAuth(c: AppContext): RequestAuth | undefined {
  return c.get('auth') as RequestAuth | undefined
}

/** Heartbeat re-check of the session the stream was opened with; undefined when no password is configured. */
function sessionRevalidator(c: AppContext, deps: AppDeps): (() => Promise<boolean>) | undefined {
  const auth = requestAuth(c)
  if (auth === undefined || !auth.enabled || auth.session === null)
    return undefined
  const token = getCookie(c, SESSION_COOKIE)
  if (token === undefined)
    return undefined
  return async () => (await deps.sessions.verify(token)) !== null
}

export function createEventsRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['events.stream'].path, (c) => {
    const auth = requestAuth(c)
    if (auth !== undefined && !auth.authenticated)
      throw new HarnessError({ code: 'unauthorized', message: 'Sign in to receive server events.', action: 'login' })

    for (const [name, value] of Object.entries(SSE_HEADERS))
      c.header(name, value)
    // Hono answers HEAD with the GET response minus its body, which would never be cancelled: do not subscribe.
    if (c.req.method === 'HEAD')
      return c.body(null, 200)

    const logger = c.get('logger') ?? deps.logger
    const revalidate = sessionRevalidator(c, deps)
    const signal = c.req.raw.signal
    return streamSSE(c, async (stream) => {
      const events = openEventStream(deps.events, {
        write: async (frame) => {
          await stream.write(frame)
        },
        close: () => {
          // Cancels the response body: a waiting reader gets end-of-stream, a pending write is released.
          if (!stream.aborted)
            stream.abort()
        },
      }, { logger, revalidate })
      const onClientGone = (): void => events.close('client')
      stream.onAbort(onClientGone)
      signal.addEventListener('abort', onClientGone, { once: true })
      if (signal.aborted)
        onClientGone()
      try {
        await events.closed
      }
      finally {
        signal.removeEventListener('abort', onClientGone)
      }
    })
  })

  return app
}
