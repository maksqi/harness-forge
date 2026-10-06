// Import from Claude Code (Phase 12, ADR-055; docs/UI.md 9.14, 11.9; docs/API.md 4.34): the calls of the import dialog,
// without a store (a plan lives on the server for 10 minutes and the dialog keeps its own state). The only caller of the
// import routes. The browser never parses a zip and never receives a file's content or an env / header value: it uploads
// the files `pickClaudeFiles` kept (each part's file name is its path relative to the `.claude` folder) or the zip as is,
// asks the server to scan its own `HF_CLAUDE_HOME`, and applies a selection by plan id and item keys.
// Fresh routes (`scanServer`, `apply`) throw the 403 with action `login`; the dialog wraps them in
// `useFreshAuth().run(task, { required: true })`. After an apply the dialog refetches the customizations, the hooks and
// the settings. Signature frozen from Gate P12-0b (C46); W12.10 owns the body (P12-A).
import type { ClaudeImportApplyResult, ClaudeImportHome, ClaudeImportPlan } from '@harness-forge/shared'
import type { ClaudeImportSelection } from '~/components/settings/claude-import/claude-import'
import { CLAUDE_IMPORT_UPLOAD_PARTS } from '@harness-forge/shared'
import { applyBody } from '~/components/settings/claude-import/claude-import'
import { withHarnessErrors } from '~/utils/errors'
import { useApi } from './useApi'

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

  function planFromFiles(files: readonly File[], claudeJson: File | null): Promise<ClaudeImportPlan> {
    const form = new FormData()
    for (const file of files)
      form.append(CLAUDE_IMPORT_UPLOAD_PARTS.files, file, file.name)
    if (claudeJson)
      form.append(CLAUDE_IMPORT_UPLOAD_PARTS.claudeJson, claudeJson, claudeJson.name)
    return withHarnessErrors(api.claudeImport.upload({ form }))
  }

  function planFromZip(file: File): Promise<ClaudeImportPlan> {
    const form = new FormData()
    form.append(CLAUDE_IMPORT_UPLOAD_PARTS.zip, file, file.name)
    form.append('label', file.name.slice(0, 256))
    return withHarnessErrors(api.claudeImport.upload({ form }))
  }

  function apply(planId: string, selection: ClaudeImportSelection): Promise<ClaudeImportApplyResult> {
    return withHarnessErrors(api.claudeImport.apply({ body: applyBody(planId, selection) }))
  }

  return { serverHome, scanServer, planFromFiles, planFromZip, apply }
}
