// Share link routes (API.md 5.20, ADR-025, ARCHITECTURE.md 6.10 / 10.7). Owner: W5.4. Keep the export name
// `createSharesRoutes`.
//
// Owner routes under `/shares` (session; `shares.create` / `shares.update` also need fresh auth through the route table
// flags, `shares.remove` does not) are thin: validate with the shared schemas, call `deps.shares`. The public routes
// `GET /share/:token` and `GET /share/:token/files/:fileId` need no session. They first pass the rate limits of
// ARCHITECTURE.md 10.7 (in memory, per client address, one limiter per app), then answer the same 404 for every failure,
// a malformed token included, so they check the fields of `sharePublicParamsSchema` / `shareFileParamsSchema`
// (`shareTokenSchema`, `fileIdSchema`) themselves instead of `validate('param', ...)` (which would answer 400). A failure
// that is about the token (malformed, bad MAC, revoked, expired, deleted chat) counts against the invalid-token limit; a
// file outside the share does not. Nothing here logs a token.
import type { StoredFile } from '../../services/files/types.ts'
import type { AppDeps } from '../../types.ts'
import type { AppContext, AppEnv } from '../types.ts'
import {
  apiRoutes,
  fileIdSchema,
  shareCreateSchema,
  shareParamsSchema,
  sharesQuerySchema,
  shareTokenSchema,
  shareUpdateSchema,
} from '@harness-forge/shared'
import { Hono } from 'hono'
import { contentDisposition } from '../../services/files/names.ts'
import { isInvalidShareTokenError, shareUnavailableError } from '../../services/shares/errors.ts'
import { createShareRateLimiter } from '../../services/shares/rate-limit.ts'
import { clientAddress } from '../middleware/request-info.ts'
import { validate } from '../validate.ts'

/** Types a browser may render in place (raster images and PDF); everything else is downloaded (as `GET /files/:id`). */
const INLINE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'application/pdf'])

/**
 * The headers of `GET /files/:id` (type, `nosniff`, sandboxing CSP, `inline` only for raster images and PDF), except
 * `Cache-Control: no-store` and no `ETag`: a revoked link must stop serving at once, caches included.
 */
function shareFileHeaders(file: StoredFile): Record<string, string> {
  return {
    'Content-Type': file.mime.startsWith('text/') ? `${file.mime}; charset=utf-8` : file.mime,
    'Content-Length': String(file.size),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': file.mime === 'application/pdf'
      ? 'default-src \'none\'; style-src \'unsafe-inline\''
      : 'default-src \'none\'; style-src \'unsafe-inline\'; sandbox',
    'Content-Disposition': contentDisposition(INLINE_TYPES.has(file.mime) ? 'inline' : 'attachment', file.name),
  }
}

export function createSharesRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const limits = createShareRateLimiter()

  /**
   * The client address that keys the share rate limits: the only `clientAddress` call of this module. Proxy-aware
   * (ADR-026): behind a trusted `HF_TRUST_PROXY` peer it is the forwarded client, else the TCP peer.
   */
  function shareClientAddress(c: AppContext): string {
    return clientAddress(c, deps.env)
  }

  /** Runs a public share operation; a refused token counts against the invalid-token limit of `address`. */
  async function publicCall<T>(address: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    }
    catch (error) {
      if (isInvalidShareTokenError(error))
        limits.invalidToken(address)
      throw error
    }
  }

  app.get(apiRoutes['shares.list'].path, validate('query', sharesQuerySchema), async (c) => {
    return c.json({ items: await deps.shares.list(c.req.valid('query')) })
  })

  app.post(apiRoutes['shares.create'].path, validate('json', shareCreateSchema), async (c) => {
    return c.json(await deps.shares.create(c.req.valid('json')), 201)
  })

  app.patch(apiRoutes['shares.update'].path, validate('param', shareParamsSchema), validate('json', shareUpdateSchema), async (c) => {
    return c.json(await deps.shares.update(c.req.valid('param').id, c.req.valid('json')))
  })

  app.delete(apiRoutes['shares.remove'].path, validate('param', shareParamsSchema), async (c) => {
    await deps.shares.remove(c.req.valid('param').id)
    return c.body(null, 204)
  })

  app.get(apiRoutes['shares.view'].path, async (c) => {
    const address = shareClientAddress(c)
    limits.admit('view', address)
    const view = await publicCall(address, async () => {
      const token = shareTokenSchema.safeParse(c.req.param('token'))
      if (!token.success)
        throw shareUnavailableError('token')
      return deps.shares.view(token.data)
    })
    return c.json(view, 200, { 'Cache-Control': 'no-store' })
  })

  app.get(apiRoutes['shares.file'].path, async (c) => {
    const address = shareClientAddress(c)
    limits.admit('file', address)
    const { file, stream } = await publicCall(address, async () => {
      const token = shareTokenSchema.safeParse(c.req.param('token'))
      if (!token.success)
        throw shareUnavailableError('token')
      // A malformed file id says nothing about the token: the same 404, without counting the token as invalid.
      const fileId = fileIdSchema.safeParse(c.req.param('fileId'))
      if (!fileId.success)
        throw shareUnavailableError('file')
      return deps.shares.openFile(token.data, fileId.data)
    })
    // Hono answers HEAD with the GET response minus its body, which is never read: release the file right away.
    if (c.req.method === 'HEAD') {
      await stream.cancel()
      return c.body(null, 200, shareFileHeaders(file))
    }
    return c.body(stream, 200, shareFileHeaders(file))
  })

  return app
}
