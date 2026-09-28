// Access log + request-scoped logger (ARCHITECTURE.md 12). Sets `c.var.logger` (a child of `deps.logger` carrying
// `reqId`) and logs one record per request: method, path (never the query string; a share token is masked as
// `/api/share/[redacted]...` / `/share/[redacted]`, ADR-025), status, duration, bytes. Never logged: bodies, headers,
// cookies, client addresses. `GET /api/health` and successful static file requests are logged at `debug`, everything
// else at `info`. Also warns once per untrusted peer that sends forwarded headers (`proxy-warning.ts`, ADR-026). Second
// middleware of the chain. Owner after Phase 0: W1.1; share masking and the proxy hint: W5.7.
import type { AppDeps } from '../../types.ts'
import type { AppMiddleware } from '../types.ts'
import { performance } from 'node:perf_hooks'
import { redactSharePath } from '../../security/redact.ts'
import { apiRelativePath } from '../route-match.ts'
import { createUntrustedProxyWarner } from './proxy-warning.ts'

export function accessLogMiddleware(deps: AppDeps): AppMiddleware {
  const warnUntrustedProxy = createUntrustedProxyWarner(deps.env)
  return async (c, next) => {
    const started = performance.now()
    const logger = deps.logger.child({ reqId: c.get('requestId') })
    c.set('logger', logger)
    warnUntrustedProxy(c, logger)
    let failed = true
    try {
      await next()
      failed = false
    }
    finally {
      const status = failed ? 500 : c.res.status
      const fields = {
        method: c.req.method,
        path: redactSharePath(c.req.path),
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
