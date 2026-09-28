// Global error and not-found handlers (API.md section 2). Every non-2xx response is a `HarnessErrorEnvelope` whose HTTP
// status comes from `errorStatusByCode[code]` (never from the envelope `status`, which is an upstream status).
// Mapping: `HarnessError` (any copy of the class) -> as is; zod errors -> `validation_error` with `details.issues`;
// Hono `HTTPException`s (malformed JSON, ...) -> the code of their status; anything else -> `internal_error` with a
// generic message and `details.requestId` (the original is logged, redacted, never sent). As a safety net the sent
// `message` and `details.upstream` pass through the redactor (registered secrets, `sk-...`-like tokens). The logged
// path masks a share token like the access log (ADR-025). Owner after Phase 0: W1.1.
import type { HarnessErrorCode, HarnessErrorEnvelope } from '@harness-forge/shared'
import type { ErrorHandler, NotFoundHandler } from 'hono'
import type { Redactor } from '../../security/types.ts'
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { randomUUID } from 'node:crypto'
import { HarnessError, isHarnessError, validationError } from '@harness-forge/shared'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { redactSharePath } from '../../security/redact.ts'
import { staticSiteFor } from '../static.ts'

/** Message of `internal_error` responses. */
export const INTERNAL_ERROR_MESSAGE = 'An unexpected error occurred.'

const CODE_BY_HTTP_STATUS: Record<number, HarnessErrorCode> = {
  400: 'validation_error',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  429: 'rate_limited',
  501: 'not_implemented',
}

function fromHttpException(error: HTTPException, requestId: string): HarnessError {
  const code = CODE_BY_HTTP_STATUS[error.status] ?? (error.status >= 500 ? 'internal_error' : 'validation_error')
  if (code === 'internal_error')
    return new HarnessError({ code, message: INTERNAL_ERROR_MESSAGE, details: { requestId } }, { cause: error })
  const message = error.message.trim() || 'The request could not be processed.'
  if (code === 'validation_error')
    return new HarnessError({ code, message, details: { issues: [{ path: [], message, code: 'custom' }] } }, { cause: error })
  return new HarnessError({ code, message, ...(code === 'unauthorized' ? { action: 'login' as const } : {}) }, { cause: error })
}

/** Normalizes anything thrown by a middleware or route into the `HarnessError` that is sent. */
export function toHarnessError(error: unknown, requestId: string): HarnessError {
  if (isHarnessError(error)) {
    const harnessError = error instanceof HarnessError ? error : HarnessError.from(error)
    // API.md 2.3: `internal_error` carries `details.requestId`.
    if (harnessError.code === 'internal_error' && harnessError.details === undefined)
      return new HarnessError({ ...harnessError.toJSON().error, details: { requestId } }, { cause: harnessError })
    return harnessError
  }
  if (error instanceof z.core.$ZodError)
    return validationError(error)
  if (error instanceof HTTPException)
    return fromHttpException(error, requestId)
  return new HarnessError({ code: 'internal_error', message: INTERNAL_ERROR_MESSAGE, details: { requestId } }, { cause: error })
}

/** The envelope of an error with secrets masked in `message` and `details.upstream` (API.md 2.3). */
export function redactedEnvelope(error: HarnessError, redactor: Redactor): HarnessErrorEnvelope {
  const envelope = error.toJSON()
  envelope.error.message = redactor.redactText(envelope.error.message)
  const details = envelope.error.details
  if (typeof details === 'object' && details !== null && !Array.isArray(details) && typeof (details as { upstream?: unknown }).upstream === 'string') {
    const upstream = (details as { upstream: string }).upstream
    envelope.error.details = { ...details, upstream: redactor.redactText(upstream) }
  }
  return envelope
}

/** `app.onError(...)`: renders the envelope, logs server-side failures (redacted) with the request id. */
export function createErrorHandler(deps: AppDeps): ErrorHandler<AppEnv> {
  return (error, c) => {
    const requestId = c.get('requestId') ?? randomUUID()
    const harnessError = toHarnessError(error, requestId)
    const logger = c.get('logger') ?? deps.logger.child({ reqId: requestId })
    const fields = { method: c.req.method, path: redactSharePath(c.req.path), code: harnessError.code, status: harnessError.httpStatus }
    if (harnessError.code === 'internal_error')
      logger.error('request failed', { ...fields, err: error })
    else if (harnessError.httpStatus >= 500 && harnessError.code !== 'not_implemented')
      logger.warn(harnessError.message, fields)
    else
      logger.debug(harnessError.message, fields)

    const response = c.json(redactedEnvelope(harnessError, deps.redactor), harnessError.httpStatus)
    response.headers.set('Cache-Control', 'no-store')
    if (harnessError.code === 'rate_limited' && harnessError.retryAfterMs !== undefined)
      response.headers.set('Retry-After', String(Math.max(1, Math.ceil(harnessError.retryAfterMs / 1000))))
    return response
  }
}

/**
 * `app.notFound(...)`: a request outside `/api` that no route or file answered. A navigation that wants HTML gets the
 * SPA document (`200.html`, `http/static.ts`), so the fallback only applies after every route; anything else gets the
 * `not_found` envelope. (Unknown `/api/*` paths never get here: they throw `not_found` inside the API sub-app.)
 */
export function createNotFoundHandler(deps: AppDeps): NotFoundHandler<AppEnv> {
  const site = staticSiteFor(deps)
  return async (c) => {
    const spa = await site.fallback(c.req.raw)
    if (spa !== null)
      return spa
    const error = new HarnessError({ code: 'not_found', message: `Not found: ${c.req.method} ${c.req.path}` })
    const response = c.json(error.toJSON(), error.httpStatus)
    response.headers.set('Cache-Control', 'no-store')
    return response
  }
}
