// Route-table lookup of the current request (public / fresh flags for the auth middleware, keys for logs).
import type { ApiRouteMatch } from '@harness-forge/shared'
import type { AppContext } from './types.ts'
import { matchApiRoute } from '@harness-forge/shared'

/** Base path of the API. */
export const API_BASE_PATH = '/api'

/** The request path relative to `/api` (`/api/chats/x` -> `/chats/x`), or null outside the API. */
export function apiRelativePath(path: string): string | null {
  if (path === API_BASE_PATH)
    return '/'
  return path.startsWith(`${API_BASE_PATH}/`) ? path.slice(API_BASE_PATH.length) : null
}

/**
 * The `apiRoutes` entry of the request (`matchApiRoute` on method + path), memoized in `c.var.apiRoute`. `HEAD`
 * matches `GET` routes. Null for unknown routes and paths outside `/api`.
 */
export function getApiRoute(c: AppContext): ApiRouteMatch | null {
  const cached = c.get('apiRoute') as ApiRouteMatch | null | undefined
  if (cached !== undefined)
    return cached
  const relative = apiRelativePath(c.req.path)
  const method = c.req.method === 'HEAD' ? 'GET' : c.req.method
  const match = relative === null ? null : matchApiRoute(method, relative)
  c.set('apiRoute', match)
  return match
}
