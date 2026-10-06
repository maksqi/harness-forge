// Claude Code import routes (API.md 5.35, ADR-055) - Phase 12 stubs (501). Owner: W12.3. Keep the export name
// `createClaudeImportRoutes`. Thin: validate, call the import service (`services/claude-import/`), map the answer.
//
// - `GET /claude-import/home`: whether the server can scan `HF_CLAUDE_HOME` (`available`, `reason`: `disabled` for
//   `HF_CLAUDE_HOME=0`, `missing`, `unreadable`; `path`). Never reads a file.
// - `POST /claude-import/scan` (fresh auth through the route table, and again in the service): builds a plan from the
//   allowlisted files of `HF_CLAUDE_HOME` (never `.credentials.json`, `projects/`, histories, `plugins/`,
//   `settings.local.json`; from `.claude.json` only the MCP server maps); `409` `disabled` when the scan is off.
// - `POST /claude-import/upload` (multipart, at most 32 MiB): one zip in the part `file`, or the folder's files in parts
//   `files` (file name = the path relative to the `.claude` folder) and `.claude.json` in the part `claudeJson`; builds a
//   plan, no other side effect. The body is parsed here (not by the form validator).
// - `POST /claude-import/apply` (fresh auth): applies the picked items of a plan (`404` when it expired); executable
//   items arrive turned off unless `enable` is sent; one `customization.changed` and one `hooks.changed`.
// - Plans live in memory (10 minutes, at most 4) and keep contents and env / header values on the server: no DTO, log
//   or error carries them. Never logs file contents, commands, prompts or values at `info`.
import type { AppDeps } from '../../types.ts'
import type { AppContext, AppEnv } from '../types.ts'
import { apiRoutes, claudeImportApplyBodySchema, validationError } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

const MULTIPART = /^multipart\/form-data\s*;/i

/** The upload must be multipart (the body-limit middleware checks non-empty bodies; this also covers an empty one). */
function requireMultipart(c: AppContext): void {
  if (!MULTIPART.test(c.req.header('content-type') ?? '')) {
    const message = 'Send multipart/form-data with the zip in the part "file" or the folder\'s files in parts named "files".'
    throw validationError([{ path: ['file'], message, code: 'custom' }], message)
  }
}

export function createClaudeImportRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['claudeImport.home'].path, notImplemented('claudeImport.home'))
  app.post(apiRoutes['claudeImport.scan'].path, notImplemented('claudeImport.scan'))
  const upload = notImplemented('claudeImport.upload')
  app.post(apiRoutes['claudeImport.upload'].path, (c) => {
    requireMultipart(c)
    return upload(c)
  })
  app.post(apiRoutes['claudeImport.apply'].path, validate('json', claudeImportApplyBodySchema), notImplemented('claudeImport.apply'))
  return app
}
