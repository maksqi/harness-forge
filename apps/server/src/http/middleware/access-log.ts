// Access log + request-scoped logger (ARCHITECTURE.md 12). Sets `c.var.logger` (a child of `deps.logger` carrying
// `reqId`) and logs one record per request: method, path (never the query string), status, duration, bytes.
// `GET /api/health` is logged at `debug`. Second middleware of the chain. Owner after Phase 0: W1.1.
import type { AppDeps } from '../../types.ts'
import type { AppMiddleware } from '../types.ts'
import { performance } from 'node:perf_hooks'

export function accessLogMiddleware(deps: AppDeps): AppMiddleware {
  return async (c, next) => {
    const started = performance.now()
    const logger = deps.logger.child({ reqId: c.get('requestId') })
    c.set('logger', logger)
    await next()
    const fields = {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round((performance.now() - started) * 10) / 10,
      bytes: Number(c.res.headers.get('content-length') ?? 0) || undefined,
    }
    if (c.req.path === '/api/health')
      logger.debug('request', fields)
    else
      logger.info('request', fields)
  }
}
