// Access log + request-scoped logger (ARCHITECTURE.md 12). Sets `c.var.logger` (a child of `deps.logger` carrying
// `reqId`) and logs one record per request: method, path (never the query string), status, duration, bytes. Never
// logged: bodies, headers, cookies. `GET /api/health` and successful static file requests are logged at `debug`,
// everything else at `info`. Second middleware of the chain. Owner after Phase 0: W1.1.
import type { AppDeps } from '../../types.ts'
import type { AppMiddleware } from '../types.ts'
import { performance } from 'node:perf_hooks'
import { apiRelativePath } from '../route-match.ts'

export function accessLogMiddleware(deps: AppDeps): AppMiddleware {
  return async (c, next) => {
    const started = performance.now()
    const logger = deps.logger.child({ reqId: c.get('requestId') })
    c.set('logger', logger)
    let failed = true
    try {
      await next()
      failed = false
    }
    finally {
      const status = failed ? 500 : c.res.status
      const fields = {
        method: c.req.method,
        path: c.req.path,
        status,
        durationMs: Math.round((performance.now() - started) * 10) / 10,
        bytes: failed ? undefined : Number(c.res.headers.get('content-length') ?? 0) || undefined,
      }
      const api = apiRelativePath(c.req.path) !== null
      if (c.req.path === '/api/health' || (!api && status < 400))
        logger.debug('request', fields)
      else
        logger.info('request', fields)
    }
  }
}
