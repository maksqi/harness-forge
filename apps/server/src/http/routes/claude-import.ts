// Claude Code import routes (API.md 5.35, ADR-055). Owner: W12.3. Keep the export name `createClaudeImportRoutes`. Thin:
// validate, call the import service (`services/claude-import/`), map the answer.
//
// - `GET /claude-import/home`: whether the server can scan `HF_CLAUDE_HOME` (`available`, `reason`: `disabled` for
//   `HF_CLAUDE_HOME=0`, `missing`, `unreadable`; `path`). Never reads a file.
// - `POST /claude-import/scan` (fresh auth through the route table, and again in the service): builds a plan from the
//   allowlisted files of `HF_CLAUDE_HOME` (never `.credentials.json`, `projects/`, histories, `plugins/`,
//   `settings.local.json`; from `.claude.json` only the MCP server maps); `409` `disabled` when the scan is off, `404`
//   when the folder is missing.
// - `POST /claude-import/upload` (multipart, at most 32 MiB): one zip in the part `file`, or the folder's files in parts
//   `files` (file name = the path relative to the `.claude` folder) and `.claude.json` in the part `claudeJson`, plus the
//   text field `label`; builds a plan, no other side effect. The body is parsed here (not by the form validator, which
//   would keep a second copy of the body); unknown fields, a text where a file belongs and repeated single parts are 400.
// - `POST /claude-import/apply` (fresh auth): applies the picked items of a plan (`404` when it expired); executable
//   items arrive turned off unless `enable` is sent; one `customization.changed` and one `hooks.changed`.
// - Plans live in memory (10 minutes, at most 4) and keep contents and env / header values on the server: no DTO, log
//   or error carries them. Never logs file contents, commands, prompts or values at `info`.
import type { ClaudeImportUploadFile, ClaudeImportUploadInput } from '../../services/claude-import/types.ts'
import type { AppDeps } from '../../types.ts'
import type { AppContext, AppEnv } from '../types.ts'
import { apiRoutes, CLAUDE_IMPORT_UPLOAD_PARTS, claudeImportApplyBodySchema, claudeImportUploadFormSchema, validationError } from '@harness-forge/shared'
import { Hono } from 'hono'
import { freshAuthOptions } from '../middleware/fresh-auth.ts'
import { validate } from '../validate.ts'

const MULTIPART = /^multipart\/form-data\s*;/i
/** Text fields of the upload besides the file parts. */
const FORM_FIELDS: ReadonlySet<string> = new Set(Object.keys(claudeImportUploadFormSchema.shape))

function invalidRequest(message: string, path: Array<string | number> = ['file']): Error {
  return validationError([{ path, message, code: 'custom' }], message)
}

/** The upload must be multipart (the body-limit middleware checks non-empty bodies; this also covers an empty one). */
function requireMultipart(c: AppContext): void {
  if (!MULTIPART.test(c.req.header('content-type') ?? ''))
    throw invalidRequest('Send multipart/form-data with the zip in the part "file" or the folder\'s files in parts named "files".')
}

/** The parts of a `POST /claude-import/upload` body (see the module comment). */
async function readUpload(c: AppContext): Promise<ClaudeImportUploadInput> {
  requireMultipart(c)
  let body: FormData
  try {
    body = await c.req.formData()
  }
  catch {
    throw invalidRequest('The multipart body cannot be read.', [])
  }
  let zip: File | undefined
  let claudeJson: File | undefined
  const files: ClaudeImportUploadFile[] = []
  // No prototype: a part named "__proto__" is an ordinary (unknown, refused) field.
  const fields: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, value] of body.entries()) {
    const part = key.slice(0, 64)
    if (key === CLAUDE_IMPORT_UPLOAD_PARTS.zip || key === CLAUDE_IMPORT_UPLOAD_PARTS.claudeJson) {
      if (typeof value === 'string')
        throw invalidRequest(`The part "${part}" must be a file.`, [part])
      if ((key === CLAUDE_IMPORT_UPLOAD_PARTS.zip ? zip : claudeJson) !== undefined)
        throw invalidRequest(`Send at most one part "${part}".`, [part])
      if (key === CLAUDE_IMPORT_UPLOAD_PARTS.zip)
        zip = value
      else
        claudeJson = value
      continue
    }
    if (key === CLAUDE_IMPORT_UPLOAD_PARTS.files) {
      if (typeof value === 'string')
        throw invalidRequest('Every part "files" must be a file named by its path in the folder.', [part])
      files.push({ path: value.name, file: value })
      continue
    }
    if (!FORM_FIELDS.has(key))
      throw invalidRequest(`Unknown field "${part}".`, [part])
    if (typeof value !== 'string')
      throw invalidRequest(`The field "${part}" must be text.`, [part])
    if (Object.hasOwn(fields, key))
      throw invalidRequest(`The field "${part}" is sent more than once.`, [part])
    fields[key] = value
  }
  const parsed = claudeImportUploadFormSchema.safeParse({ ...fields })
  if (!parsed.success)
    throw validationError(parsed.error)
  return {
    ...(parsed.data.label === undefined ? {} : { label: parsed.data.label }),
    ...(zip === undefined ? {} : { zip }),
    ...(files.length === 0 ? {} : { files }),
    ...(claudeJson === undefined ? {} : { claudeJson }),
  }
}

export function createClaudeImportRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['claudeImport.home'].path, async c => c.json(await deps.claudeImport.home()))
  app.post(apiRoutes['claudeImport.scan'].path, async c => c.json(await deps.claudeImport.scan(freshAuthOptions(c))))
  app.post(apiRoutes['claudeImport.upload'].path, async c => c.json(await deps.claudeImport.upload(await readUpload(c))))
  app.post(apiRoutes['claudeImport.apply'].path, validate('json', claudeImportApplyBodySchema), async (c) => {
    return c.json(await deps.claudeImport.apply(c.req.valid('json'), freshAuthOptions(c)))
  })
  return app
}
