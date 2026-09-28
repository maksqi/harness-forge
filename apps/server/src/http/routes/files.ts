// Upload routes (API.md 5.11). Owner: W1.5 (W1.5-T5). Keep the export name `createFilesRoutes`.
//
// `POST /files`: `multipart/form-data` with exactly one file part named `file` and nothing else. The body size is
// limited by the body-limit middleware; the service enforces the 20 MB per-file limit and the type rules.
// `GET /files/:id`: the stored bytes with the stored type, `nosniff`, a sandboxing CSP (not for PDF), immutable private
// caching with the sha256 as ETag, and `inline` only for PNG, JPEG, GIF, WebP, AVIF and PDF (everything else, SVG and
// text included, is an `attachment`).
import type { StoredFile } from '../../services/files/types.ts'
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, fileParamsSchema, fileUploadFormSchema, HarnessError, validationError } from '@harness-forge/shared'
import { Hono } from 'hono'
import { contentDisposition } from '../../services/files/names.ts'
import { validate } from '../validate.ts'

/** Types a browser may render in place (raster images and PDF); everything else is downloaded. */
const INLINE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'application/pdf'])
const MULTIPART = /^multipart\/form-data\s*;/i
const CACHE_CONTROL = 'private, max-age=31536000, immutable'

function invalidUpload(message: string): HarnessError {
  return validationError([{ path: ['file'], message, code: 'custom' }], message)
}

function etagOf(file: StoredFile): string {
  return `"${file.sha256}"`
}

/** `If-None-Match` (a list, weak tags or `*`) matches the ETag. */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined)
    return false
  return header.split(',').some((tag) => {
    const value = tag.trim()
    return value === '*' || value.replace(/^W\//, '') === etag
  })
}

function downloadHeaders(file: StoredFile): Record<string, string> {
  return {
    'Content-Type': file.mime.startsWith('text/') ? `${file.mime}; charset=utf-8` : file.mime,
    'Content-Length': String(file.size),
    'ETag': etagOf(file),
    'Cache-Control': CACHE_CONTROL,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': file.mime === 'application/pdf'
      ? 'default-src \'none\'; style-src \'unsafe-inline\''
      : 'default-src \'none\'; style-src \'unsafe-inline\'; sandbox',
    'Content-Disposition': contentDisposition(INLINE_TYPES.has(file.mime) ? 'inline' : 'attachment', file.name),
  }
}

export function createFilesRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post(apiRoutes['files.upload'].path, validate('form', fileUploadFormSchema), async (c) => {
    if (!MULTIPART.test(c.req.header('content-type') ?? ''))
      throw invalidUpload('Send multipart/form-data with one file part named "file".')
    const form = await c.req.formData()
    let file: File | undefined
    for (const [key, value] of form.entries()) {
      if (key !== 'file')
        throw invalidUpload('Only one part, named "file", is allowed.')
      if (typeof value === 'string')
        throw invalidUpload('The part "file" must be a file.')
      if (file !== undefined)
        throw invalidUpload('Send exactly one file.')
      file = value
    }
    if (file === undefined)
      throw invalidUpload('The file part "file" is missing.')
    return c.json(await deps.files.upload(file), 201)
  })

  app.get(apiRoutes['files.get'].path, validate('param', fileParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    const stored = await deps.files.get(id)
    if (stored === null)
      throw new HarnessError({ code: 'not_found', message: `File ${id} not found.` })
    if (matchesEtag(c.req.header('if-none-match'), etagOf(stored)))
      return c.body(null, 304, { 'ETag': etagOf(stored), 'Cache-Control': CACHE_CONTROL })
    const { file, stream } = await deps.files.open(id)
    // Hono answers HEAD with the GET response minus its body, which is never read: release the file right away.
    if (c.req.method === 'HEAD') {
      await stream.cancel()
      return c.body(null, 200, downloadHeaders(file))
    }
    return c.body(stream, 200, downloadHeaders(file))
  })

  return app
}
