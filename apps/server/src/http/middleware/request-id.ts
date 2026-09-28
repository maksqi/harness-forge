// Request id (ARCHITECTURE.md 12): an incoming `X-Request-Id` matching `^[A-Za-z0-9._-]{8,64}$` is kept, anything
// else is replaced by a new UUID. Sets `c.var.requestId` and the `X-Request-Id` response header (errors included).
// First middleware of the chain (`app.ts`). Owner after Phase 0: W1.1.
import type { AppDeps } from '../../types.ts'
import type { AppMiddleware } from '../types.ts'
import { randomUUID } from 'node:crypto'

export const REQUEST_ID_HEADER = 'X-Request-Id'
const REQUEST_ID_PATTERN = /^[\w.-]{8,64}$/

/** The incoming id when valid, else a new one. */
export function resolveRequestId(incoming: string | undefined): string {
  return incoming !== undefined && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID()
}

export function requestIdMiddleware(_deps: AppDeps): AppMiddleware {
  return async (c, next) => {
    const requestId = resolveRequestId(c.req.header(REQUEST_ID_HEADER))
    c.set('requestId', requestId)
    await next()
    c.res.headers.set(REQUEST_ID_HEADER, requestId)
  }
}
