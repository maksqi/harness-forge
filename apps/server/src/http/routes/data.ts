// Bulk data routes (API.md 5.19, ADR-024). Owner: W5.3. Keep the export name `createDataRoutes`. Thin: validate, call
// `deps.data`, map to the response.
//
// - `GET /data/export` streams the zip as it is built (`Content-Disposition: attachment`, `no-store`); a `HEAD` request
//   gets the headers only: the stream is cancelled before anything is read (Hono answers HEAD with the GET handler and
//   would otherwise leave the body unread).
// - `POST /data/import` is multipart: the upload in the part `file` plus the `DataImportForm` fields. The body is parsed
//   here rather than by the form validator, which would keep a second copy of the (up to 256 MB) body for the whole
//   request; the body-limit middleware already capped its size and checked its content type.
// - `POST /data/delete` needs fresh auth (route table flag, checked by the middleware and again by the service).
// - `GET /data/cleanup` (a dry run) and `POST /data/cleanup` (no body) remove orphaned files (ADR-035): Phase 7 stubs
//   (501) until W7.8. No fresh auth; another maintenance operation is `409` (`busy`).
import type { DataImportForm } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { AppContext, AppEnv } from '../types.ts'
import { apiRoutes, dataDeleteBodySchema, dataExportQuerySchema, dataImportFormSchema, validationError } from '@harness-forge/shared'
import { Hono } from 'hono'
import { contentDisposition } from '../../services/files/names.ts'
import { freshAuthOptions } from '../middleware/fresh-auth.ts'
import { notImplemented, validate } from '../validate.ts'

const MULTIPART = /^multipart\/form-data\s*;/i
/** Multipart fields of `POST /data/import` besides the part `file`. */
const IMPORT_FORM_FIELDS: ReadonlySet<string> = new Set(Object.keys(dataImportFormSchema.shape))

function invalidRequest(message: string, path: Array<string | number> = ['file']): Error {
  return validationError([{ path, message, code: 'custom' }], message)
}

/** The upload and the parsed fields of a `POST /data/import` body. */
async function readImportForm(c: AppContext): Promise<{ file: File, form: DataImportForm }> {
  if (!MULTIPART.test(c.req.header('content-type') ?? ''))
    throw invalidRequest('Send multipart/form-data with the backup zip or the chat JSON in the part named "file".')
  let body: FormData
  try {
    body = await c.req.formData()
  }
  catch {
    throw invalidRequest('The multipart body cannot be read.', [])
  }
  let file: File | undefined
  // No prototype: a part named "__proto__" is an ordinary (unknown, refused) field.
  const fields: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, value] of body.entries()) {
    if (key === 'file') {
      if (typeof value === 'string')
        throw invalidRequest('The part "file" must be a file.')
      if (file !== undefined)
        throw invalidRequest('Send exactly one file.')
      file = value
      continue
    }
    if (!IMPORT_FORM_FIELDS.has(key))
      throw invalidRequest(`Unknown field "${key.slice(0, 64)}".`, [key.slice(0, 64)])
    if (typeof value !== 'string')
      throw invalidRequest(`Only the part "file" may be a file ("${key}" is one).`, [key])
    if (Object.hasOwn(fields, key))
      throw invalidRequest(`The field "${key}" is sent more than once.`, [key])
    fields[key] = value
  }
  if (file === undefined)
    throw invalidRequest('Attach the backup zip or the chat JSON in the part named "file".')
  const parsed = dataImportFormSchema.safeParse(fields)
  if (!parsed.success)
    throw validationError(parsed.error)
  return { file, form: parsed.data }
}

export function createDataRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['data.summary'].path, async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(await deps.data.summary())
  })

  app.get(apiRoutes['data.export'].path, validate('query', dataExportQuerySchema), async (c) => {
    const backup = await deps.data.exportBackup(c.req.valid('query'))
    const headers = {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition('attachment', backup.filename),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'default-src \'none\'; sandbox',
    }
    if (c.req.method === 'HEAD') {
      await backup.stream.cancel()
      return c.body(null, 200, headers)
    }
    return c.body(backup.stream, 200, headers)
  })

  app.post(apiRoutes['data.import'].path, async (c) => {
    const { file, form } = await readImportForm(c)
    return c.json(await deps.data.importData(file, form))
  })

  app.post(apiRoutes['data.deleteAll'].path, validate('json', dataDeleteBodySchema), async (c) => {
    return c.json(await deps.data.deleteAll(c.req.valid('json'), freshAuthOptions(c)))
  })

  app.get(apiRoutes['data.cleanupPreview'].path, notImplemented('data.cleanupPreview'))
  app.post(apiRoutes['data.cleanup'].path, notImplemented('data.cleanup'))

  return app
}
