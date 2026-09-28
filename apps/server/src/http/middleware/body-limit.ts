// Request body gate (ARCHITECTURE.md 10.4, `LIMITS` of `@harness-forge/shared`). Owner: W1.1.
//
// Last `/api` middleware before the routes, so only authenticated requests are read.
// 1. Size: `payload_too_large` (`details.limitBytes` = the documented limit) when the body exceeds the limit of the
//    matched route. A declared `Content-Length` is checked without reading (node's HTTP parser never delivers more
//    bytes than it announces); a body of unknown length (chunked) is counted while it is buffered, then replayed.
//    An oversized stream is released, never cancelled: cancelling can reset the connection before the 413 is sent,
//    and undici's FormData body pump keeps enqueueing after a cancel (an unhandled rejection in-process); the rest
//    of the body is drained or dropped by the HTTP server after the answer.
//    Limits: `chat.send` `LIMITS.chatBodyBytes`; `files.upload` `LIMITS.uploadBytes` + multipart overhead;
//    `pluginInstall.inspect` / `pluginInstall.install` `LIMITS.pluginZipBytes` + overhead; `data.import`
//    `LIMITS.backupImportBytes` + overhead; `audio.transcribe` `LIMITS.audioUploadBytes` + overhead;
//    `pluginFiles.write` `LIMITS.pluginFileBytes` as JSON (escaping can double the size) + envelope; every other route
//    `LIMITS.jsonBodyBytes`.
// 2. Content type (SEC-B3, no form-encoded CSRF): a non-empty body sent to a route with a JSON `body` schema must be
//    `application/json` (or `+json`); routes with a multipart `form` also accept `multipart/form-data`. Otherwise
//    `400 validation_error`. Routes without a body or form schema ignore bodies.
import type { ApiRouteDef, ApiRouteKey } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { AppContext, AppMiddleware } from '../types.ts'
import { HarnessError, LIMITS } from '@harness-forge/shared'
import { getApiRoute } from '../route-match.ts'

/** Room for multipart boundaries, part headers and small fields, or the JSON envelope around a file. */
const ENVELOPE_BYTES = 64 * 1024

export interface BodyLimit {
  /** Bytes accepted on the wire. */
  maxBytes: number
  /** The documented limit, reported in `details.limitBytes`. */
  limitBytes: number
}

const DEFAULT_LIMIT: BodyLimit = { maxBytes: LIMITS.jsonBodyBytes, limitBytes: LIMITS.jsonBodyBytes }

const ROUTE_LIMITS: Partial<Record<ApiRouteKey, BodyLimit>> = {
  'chat.send': { maxBytes: LIMITS.chatBodyBytes, limitBytes: LIMITS.chatBodyBytes },
  // Chat imports (exports re-imported with tool outputs) are far larger than ordinary JSON bodies.
  'chats.create': { maxBytes: LIMITS.uploadBytes, limitBytes: LIMITS.uploadBytes },
  'files.upload': { maxBytes: LIMITS.uploadBytes + ENVELOPE_BYTES, limitBytes: LIMITS.uploadBytes },
  'pluginInstall.inspect': { maxBytes: LIMITS.pluginZipBytes + ENVELOPE_BYTES, limitBytes: LIMITS.pluginZipBytes },
  'pluginInstall.install': { maxBytes: LIMITS.pluginZipBytes + ENVELOPE_BYTES, limitBytes: LIMITS.pluginZipBytes },
  'pluginFiles.write': { maxBytes: 2 * LIMITS.pluginFileBytes + ENVELOPE_BYTES, limitBytes: LIMITS.pluginFileBytes },
  // Backup zips and chat JSON exports (ADR-024).
  'data.import': { maxBytes: LIMITS.backupImportBytes + ENVELOPE_BYTES, limitBytes: LIMITS.backupImportBytes },
  // Dictation recordings (ADR-029).
  'audio.transcribe': { maxBytes: LIMITS.audioUploadBytes + ENVELOPE_BYTES, limitBytes: LIMITS.audioUploadBytes },
}

/** The body limit of a route (the JSON default for other and unknown routes). */
export function bodyLimitFor(key: ApiRouteKey | undefined): BodyLimit {
  return (key === undefined ? undefined : ROUTE_LIMITS[key]) ?? DEFAULT_LIMIT
}

export function payloadTooLargeError(limitBytes: number): HarnessError {
  const megabytes = Math.round((limitBytes / (1024 * 1024)) * 10) / 10
  return new HarnessError({
    code: 'payload_too_large',
    message: `The request body is larger than the limit of ${megabytes} MB.`,
    details: { limitBytes },
  })
}

function requestError(message: string, issueCode: string): HarnessError {
  return new HarnessError({ code: 'validation_error', message, details: { issues: [{ path: [], message, code: issueCode }] } })
}

function isJsonMediaType(type: string): boolean {
  return type === 'application/json' || /^application\/[\w.+-]+\+json$/.test(type)
}

/** Throws `validation_error` when a body is sent with a content type the route does not accept. */
export function checkBodyContentType(contentType: string | undefined, route: ApiRouteDef): void {
  if (route.body === undefined && route.form === undefined)
    return
  const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? ''
  if (route.body !== undefined && isJsonMediaType(type))
    return
  if (route.form !== undefined && type === 'multipart/form-data')
    return
  const expected = route.form === undefined
    ? 'application/json'
    : route.body === undefined ? 'multipart/form-data' : 'application/json or multipart/form-data'
  throw requestError(`Unsupported Content-Type: send ${expected}.`, 'invalid_content_type')
}

/** The declared body length; null when the length is unknown (chunked transfer encoding or no header). */
function declaredLength(c: AppContext): number | null {
  if (c.req.raw.headers.has('transfer-encoding'))
    return null
  const header = c.req.raw.headers.get('content-length')
  if (header === null)
    return null
  const value = header.trim()
  const bytes = /^\d{1,15}$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(bytes))
    throw requestError('Invalid Content-Length header.', 'invalid_content_length')
  return bytes
}

/** Stops reading an oversized body without cancelling it (see the module comment); no read is pending here. */
function abandonBody(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock()
  }
  catch {
    // Already released.
  }
}

/** A failed read (the client aborted the upload): a `validation_error` rather than an `internal_error` in the log. */
async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> {
  try {
    return await reader.read()
  }
  catch {
    throw requestError('The request body could not be read.', 'body_unreadable')
  }
}

/** Reads a body of unknown length up to the limit and puts it back on the request; returns its size. */
async function bufferBody(c: AppContext, body: ReadableStream<Uint8Array>, limit: BodyLimit): Promise<number> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await readChunk(reader)
    if (done)
      break
    size += value.byteLength
    if (size > limit.maxBytes) {
      abandonBody(reader)
      throw payloadTooLargeError(limit.limitBytes)
    }
    chunks.push(value)
  }
  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(chunk)
      controller.close()
    },
  })
  c.req.raw = new Request(c.req.raw, { body: replay, duplex: 'half' } as RequestInit)
  return size
}

export function bodyLimitMiddleware(_deps: AppDeps): AppMiddleware {
  return async (c, next) => {
    const body = c.req.raw.body
    if (body === null) {
      await next()
      return
    }
    const match = getApiRoute(c)
    const limit = bodyLimitFor(match?.key)
    const declared = declaredLength(c)
    if (declared !== null && declared > limit.maxBytes)
      throw payloadTooLargeError(limit.limitBytes)
    const size = declared ?? await bufferBody(c, body, limit)
    if (size > 0 && match !== null)
      checkBodyContentType(c.req.header('content-type'), match.route)
    await next()
  }
}
