// Frozen HTTP-layer types: the Hono environment of the app (request variables set by the middleware chain of
// `app.ts`) and the route module factory signature.
import type { ApiRouteMatch } from '@harness-forge/shared'
import type { HttpBindings } from '@hono/node-server'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import type { Logger } from '../logger.ts'
import type { PasswordSource, SessionPayload } from '../security/types.ts'
import type { AppDeps } from '../types.ts'

/** Fresh-auth window (ADR-017): sensitive routes need a password login at most this long ago. */
export const FRESH_AUTH_WINDOW_MS = 10 * 60 * 1000

/**
 * Authentication state of an `/api` request, set by `sessionAuthMiddleware` before any route runs. Without a password
 * every request is authenticated (`enabled: false`).
 */
export interface RequestAuth {
  /** A password is configured (`HF_PASSWORD` or stored). */
  enabled: boolean
  /** A valid session, or no password configured. */
  authenticated: boolean
  source: PasswordSource | null
  /** The verified `hf_session` payload, else null. */
  session: SessionPayload | null
  /** `session.authAt + FRESH_AUTH_WINDOW_MS`; null when auth is disabled or there is no session. */
  freshUntil: number | null
}

/** Request variables (`c.get(...)` / `c.var`). */
export interface AppVariables {
  /** Set by `requestIdMiddleware` (every request); echoed as `X-Request-Id`. */
  requestId: string
  /** Request-scoped logger carrying `reqId`; set by `accessLogMiddleware` (every request). */
  logger: Logger
  /** Set by `sessionAuthMiddleware` for every `/api` request. */
  auth: RequestAuth
  /** Cached route-table match of the request (`getApiRoute(c)`); null for unknown routes. */
  apiRoute: ApiRouteMatch | null
}

/**
 * The Hono environment of the whole app. `Bindings` are the `@hono/node-server` bindings (`getConnInfo(c)` of
 * `@hono/node-server/conninfo` reads `incoming.socket`). `createTestApp().request()` passes equivalent test bindings;
 * a bare `app.request(url)` without them has `c.env === undefined`.
 */
export interface AppEnv {
  Bindings: Partial<HttpBindings>
  Variables: AppVariables
}

export type AppContext = Context<AppEnv>
export type AppMiddleware = MiddlewareHandler<AppEnv>

/** Every route module exports `create<Module>Routes: RouteFactory` (paths relative to `/api`). */
export type RouteFactory = (deps: AppDeps) => Hono<AppEnv>
