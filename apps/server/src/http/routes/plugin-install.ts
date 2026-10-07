// Plugin install / trust / export routes (API.md 5.16). Owner: W3.2 (W3.2-T6, T7).
//
// `inspect` and `install` accept JSON (`pluginInspectBodySchema` / `pluginInstallBodySchema`) or multipart (the zip in
// the part `file`; `install` also takes the `pluginInstallFormSchema` fields), so their bodies are validated here, not
// by middleware (the body-limit middleware already capped the size and checked the content type).
// Fresh auth (ADR-017): `pluginInstall.trust` is `fresh` in the route table (middleware) and is checked again here;
// installing a plugin that requires trust (code, or a stdio MCP server) calls `requireFreshAuth` through
// `PluginInstallOptions.authorize`, after the package was validated and before anything is committed.
// Review pin: the optional `sha256` of the body / form (the `PluginInspection.sha256` the user reviewed) is handed to
// the installer, which answers `409 conflict` (`reason: 'stale'`) when the package now hashes differently.
// Phase 12 (ADR-053 / ADR-054, W12.2): the JSON bodies take the `github` and `marketplace` sources and `format?` on every
// source; the multipart forms take `format` next to the zip (`pluginInspectFormSchema` / `pluginInstallFormSchema`);
// `409 offline` / `429 rate_limited` / `404` come from the installer; fresh auth still applies whenever the inspection
// requires trust (a Claude Code plugin with a command hook, a stdio MCP server or a `!` span). The details answered
// carry the Phase 12 fields (`plugins-detail.ts`).
import type { PluginInstallRequestInput } from '../../plugins/install/index.ts'
import type { ReviewedInstallOptions } from '../../plugins/install/reviews.ts'
import type { AppDeps } from '../../types.ts'
import type { AppContext, AppEnv } from '../types.ts'
import {
  apiRoutes,
  fileUploadFormSchema,
  HarnessError,
  LIMITS,
  pluginInspectBodySchema,
  pluginInspectFormSchema,
  pluginInstallBodySchema,
  pluginInstallFormSchema,
  pluginParamsSchema,
  pluginTrustBodySchema,
  validationError,
} from '@harness-forge/shared'
import { Hono } from 'hono'
import { contentDisposition } from '../../services/files/names.ts'
import { requireFreshAuth } from '../middleware/fresh-auth.ts'
import { validate } from '../validate.ts'
import { completeDetail } from './plugins-detail.ts'

const MULTIPART = /^multipart\/form-data\s*;/i

interface InstallRequest {
  input: PluginInstallRequestInput
  trust?: boolean
  enable?: boolean
  /** The reviewed `PluginInspection.sha256`. */
  sha256?: string
}

/** Multipart fields of `POST /plugins/install` besides the part `file`. */
const INSTALL_FORM_FIELDS: ReadonlySet<string> = new Set(Object.keys(pluginInstallFormSchema.shape))
/** Multipart fields of `POST /plugins/inspect` besides the part `file` (Phase 12: `format`). */
const INSPECT_FORM_FIELDS: ReadonlySet<string> = new Set(Object.keys(pluginInspectFormSchema.shape))

function invalidRequest(message: string, path: Array<string | number> = []): HarnessError {
  return validationError([{ path, message, code: 'custom' }], message)
}

/** The zip part and the other (string) fields of a multipart body. */
async function readMultipart(c: AppContext): Promise<{ file: File, fields: Record<string, string> }> {
  let form: FormData
  try {
    form = await c.req.formData()
  }
  catch {
    throw invalidRequest('The multipart body cannot be read.')
  }
  let file: File | undefined
  // No prototype: a part named "__proto__" is an ordinary (unknown, refused) field.
  const fields: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, value] of form.entries()) {
    if (key === 'file') {
      if (typeof value === 'string')
        throw invalidRequest('The part "file" must be a file.', ['file'])
      if (file !== undefined)
        throw invalidRequest('Send exactly one file.', ['file'])
      file = value
      continue
    }
    if (typeof value !== 'string')
      throw invalidRequest(`Only the part "file" may be a file ("${key}" is one).`, [key])
    if (Object.hasOwn(fields, key))
      throw invalidRequest(`The field "${key}" is sent more than once.`, [key])
    fields[key] = value
  }
  if (file === undefined)
    throw invalidRequest('Attach the plugin zip in the part named "file".', ['file'])
  if (file.size > LIMITS.pluginZipBytes) {
    throw new HarnessError({
      code: 'payload_too_large',
      message: `The zip is larger than ${LIMITS.pluginZipBytes / (1024 * 1024)} MB.`,
      details: { limitBytes: LIMITS.pluginZipBytes },
    })
  }
  return { file, fields }
}

async function readJson(c: AppContext): Promise<unknown> {
  try {
    return await c.req.json()
  }
  catch {
    throw invalidRequest('The request body is not valid JSON.')
  }
}

async function readInspectRequest(c: AppContext): Promise<PluginInstallRequestInput> {
  if (MULTIPART.test(c.req.header('content-type') ?? '')) {
    const { file, fields } = await readMultipart(c)
    const unknown = Object.keys(fields).find(key => !INSPECT_FORM_FIELDS.has(key))
    if (unknown !== undefined)
      throw invalidRequest(`Unknown field "${unknown}": send the part "file" and optionally "format".`, [unknown])
    const { format: formatField, ...rest } = fields
    fileUploadFormSchema.parse(rest)
    const parsed = pluginInspectFormSchema.safeParse(formatField === undefined ? {} : { format: formatField })
    if (!parsed.success)
      throw validationError(parsed.error)
    return {
      source: 'zip',
      fileName: file.name,
      data: new Uint8Array(await file.arrayBuffer()),
      ...(parsed.data.format === undefined ? {} : { format: parsed.data.format }),
    }
  }
  const parsed = pluginInspectBodySchema.safeParse(await readJson(c))
  if (!parsed.success)
    throw validationError(parsed.error)
  return parsed.data
}

async function readInstallRequest(c: AppContext): Promise<InstallRequest> {
  if (MULTIPART.test(c.req.header('content-type') ?? '')) {
    const { file, fields } = await readMultipart(c)
    const unknown = Object.keys(fields).find(key => !INSTALL_FORM_FIELDS.has(key))
    if (unknown !== undefined)
      throw invalidRequest(`Unknown field "${unknown}".`, [unknown])
    const parsed = pluginInstallFormSchema.safeParse(fields)
    if (!parsed.success)
      throw validationError(parsed.error)
    return {
      input: {
        source: 'zip',
        fileName: file.name,
        data: new Uint8Array(await file.arrayBuffer()),
        ...(parsed.data.format === undefined ? {} : { format: parsed.data.format }),
      },
      ...(parsed.data.trust === undefined ? {} : { trust: parsed.data.trust === 'true' }),
      ...(parsed.data.enable === undefined ? {} : { enable: parsed.data.enable === 'true' }),
      ...(parsed.data.sha256 === undefined ? {} : { sha256: parsed.data.sha256 }),
    }
  }
  const parsed = pluginInstallBodySchema.safeParse(await readJson(c))
  if (!parsed.success)
    throw validationError(parsed.error)
  const { trust, enable, sha256, ...input } = parsed.data
  return {
    input,
    ...(trust === undefined ? {} : { trust }),
    ...(enable === undefined ? {} : { enable }),
    ...(sha256 === undefined ? {} : { sha256 }),
  }
}

export function createPluginInstallRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post(apiRoutes['pluginInstall.inspect'].path, async (c) => {
    const input = await readInspectRequest(c)
    return c.json(await deps.installer.inspect(input))
  })

  app.post(apiRoutes['pluginInstall.install'].path, async (c) => {
    const request = await readInstallRequest(c)
    const options: ReviewedInstallOptions = {
      ...(request.trust === undefined ? {} : { trust: request.trust }),
      ...(request.enable === undefined ? {} : { enable: request.enable }),
      ...(request.sha256 === undefined ? {} : { sha256: request.sha256 }),
      authorize: (inspection) => {
        // ADR-017: code plugins and stdio MCP servers run programs on the server, trusted or not.
        if (inspection.requiresTrust)
          requireFreshAuth(c)
      },
    }
    const detail = await deps.installer.install(request.input, options)
    return c.json(await completeDetail(deps, detail), 201)
  })

  app.post(apiRoutes['pluginInstall.trust'].path, validate('param', pluginParamsSchema), validate('json', pluginTrustBodySchema), async (c) => {
    requireFreshAuth(c)
    const { id } = c.req.valid('param')
    const { sha256 } = c.req.valid('json')
    return c.json(await completeDetail(deps, await deps.plugins.trust(id, sha256)))
  })

  app.get(apiRoutes['pluginInstall.export'].path, validate('param', pluginParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    const { fileName, data } = await deps.installer.export(id)
    const body = data.buffer instanceof ArrayBuffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data)
    return c.body(body, 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition('attachment', fileName),
      'Content-Length': String(data.byteLength),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
  })

  return app
}
