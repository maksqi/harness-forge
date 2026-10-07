// Import from Claude Code (Phase 12, ADR-055; docs/UI.md 9.14, 11.9; docs/API.md 4.34): the calls of the import dialog,
// without a store (a plan lives on the server for 10 minutes and the dialog keeps its own state). The only caller of the
// import routes. The browser never parses a zip and never receives a file's content or an env / header value: it uploads
// the files `pickClaudeFiles` keeps (each part's file name is its path relative to the `.claude` folder; the filter runs
// here again, so a file outside the allowlist is never sent whoever calls this) or the zip as is, asks the server to scan
// its own `HF_CLAUDE_HOME`, and applies a selection by plan id and item keys. The caps are checked before an upload
// starts: `.claude.json` at most `CLAUDE_HOME_LIMITS.claudeJsonBytes` (400 `validation_error`), an upload at most
// `CLAUDE_HOME_LIMITS.totalBytes` (32 MiB, 413 `payload_too_large`, the server's answer too).
// Fresh routes (`scanServer`, `apply`) throw the 403 with action `login`; the dialog wraps them in
// `useFreshAuth().run(task, { required: true })`. After an apply the dialog refetches the customizations, the hooks, the
// shell rules and the settings. Signature frozen from Gate P12-0b (C46); body W12.10 (P12-A).
import type { ClaudeImportApplyResult, ClaudeImportHome, ClaudeImportPlan } from '@harness-forge/shared'
import type { ClaudeImportSelection } from '~/components/settings/claude-import/claude-import'
import { CLAUDE_HOME_LIMITS, CLAUDE_IMPORT_UPLOAD_PARTS, CLAUDE_JSON_PATH, HarnessError } from '@harness-forge/shared'
import { applyBody, pickClaudeFiles, UPLOAD_LIMIT_TEXT } from '~/components/settings/claude-import/claude-import'
import { withHarnessErrors } from '~/utils/errors'
import { useApi } from './useApi'

/** 413 before the upload: the same answer the server gives for more than 32 MiB. */
function tooLarge(): HarnessError {
  return new HarnessError({ code: 'payload_too_large', message: `The upload is larger than ${UPLOAD_LIMIT_TEXT}.` })
}

export interface ClaudeImport {
  /** `GET /claude-import/home`: whether this server can scan its Claude Code folder, and which one. */
  serverHome: () => Promise<ClaudeImportHome>
  /** `POST /claude-import/scan` (fresh auth): a plan of the server's `HF_CLAUDE_HOME`. */
  scanServer: () => Promise<ClaudeImportPlan>
  /** `POST /claude-import/upload` (multipart `files` + the optional `claudeJson`): a plan of the picked folder's files. */
  planFromFiles: (files: readonly File[], claudeJson: File | null) => Promise<ClaudeImportPlan>
  /** `POST /claude-import/upload` (multipart `file`): a plan of a zip of a `.claude` folder, sent as is. */
  planFromZip: (file: File) => Promise<ClaudeImportPlan>
  /** `POST /claude-import/apply` (fresh auth): imports the picked items of the plan. */
  apply: (planId: string, selection: ClaudeImportSelection) => Promise<ClaudeImportApplyResult>
}

export function useClaudeImport(): ClaudeImport {
  const api = useApi()

  function serverHome(): Promise<ClaudeImportHome> {
    return withHarnessErrors(api.claudeImport.home())
  }

  function scanServer(): Promise<ClaudeImportPlan> {
    return withHarnessErrors(api.claudeImport.scan())
  }

  async function planFromFiles(files: readonly File[], claudeJson: File | null): Promise<ClaudeImportPlan> {
    // The allowlist and the caps again: only what `pickClaudeFiles` keeps is ever sent (idempotent for its own output).
    const kept = pickClaudeFiles(files).files
    if (kept.length === 0 && !claudeJson)
      throw new HarnessError({ code: 'validation_error', message: 'Nothing to import in this folder.' })
    if (claudeJson && claudeJson.size > CLAUDE_HOME_LIMITS.claudeJsonBytes)
      throw new HarnessError({ code: 'validation_error', message: '.claude.json is larger than 16 MiB.' })
    const total = kept.reduce((sum, file) => sum + file.size, claudeJson?.size ?? 0)
    if (total > CLAUDE_HOME_LIMITS.totalBytes)
      throw tooLarge()
    const form = new FormData()
    for (const file of kept)
      form.append(CLAUDE_IMPORT_UPLOAD_PARTS.files, file, file.name)
    if (claudeJson)
      form.append(CLAUDE_IMPORT_UPLOAD_PARTS.claudeJson, claudeJson, CLAUDE_JSON_PATH)
    return await withHarnessErrors(api.claudeImport.upload({ form }))
  }

  async function planFromZip(file: File): Promise<ClaudeImportPlan> {
    if (file.size > CLAUDE_HOME_LIMITS.totalBytes)
      throw tooLarge()
    const form = new FormData()
    const label = [...file.name].filter(char => char >= ' ' && char !== '\u007F').join('').trim().slice(0, 256)
    if (label !== '')
      form.append('label', label)
    form.append(CLAUDE_IMPORT_UPLOAD_PARTS.zip, file, file.name)
    return await withHarnessErrors(api.claudeImport.upload({ form }))
  }

  function apply(planId: string, selection: ClaudeImportSelection): Promise<ClaudeImportApplyResult> {
    return withHarnessErrors(api.claudeImport.apply({ body: applyBody(planId, selection) }))
  }

  return { serverHome, scanServer, planFromFiles, planFromZip, apply }
}
