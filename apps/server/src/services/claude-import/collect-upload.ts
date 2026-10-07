import type { CollectedHome } from './collected.ts'
// The upload intake of the home-folder import (ADR-055; W12.3-T2): `POST /claude-import/upload` (multipart, at most
// 32 MiB; no side effect besides the kept plan). Either the files of a picked `.claude` folder (parts `files`, each
// named by its path relative to the folder; the browser already kept only allowlisted paths) or one zip of the folder
// (part `file`), plus the optional `~/.claude.json` (part `claudeJson`). Every path is checked again with the shared
// allowlist (`HomeCollector`): anything else is listed as skipped by name and never read.
//
// A zip is opened with the plugin installer's guards (`openZip` + `EntryCollector`: names, links and special files,
// encryption, duplicates, overlapping entries, the entry count; the expanded size is not capped there because only
// allowlisted entries are ever inflated, each within its own cap and the 32 MiB total). One shared top folder is
// stripped (a zipped `.claude/` folder; not when that folder is itself `agents`, `commands`, `skills` or
// `output-styles`); a `.claude.json` at the zip root next to it is `~/.claude.json`. Never logs.
import type { ClaudeImportUploadFile, ClaudeImportUploadInput } from './types.ts'
import { CLAUDE_JSON_PATH, HarnessError } from '@harness-forge/shared'
import { EntryCollector } from '../../plugins/install/archive.ts'
import { openZip } from '../../plugins/install/zip.ts'
import { HomeCollector } from './collected.ts'

/** Entries a zip of a `.claude` folder may list (histories and transcripts included; only allowlisted ones are read). */
export const UPLOAD_ZIP_ENTRIES_MAX = 20_000

/** Parts named `files` read at most. */
export const UPLOAD_FILES_MAX = 10_000

/** Top-level folders of the allowlist: a zip whose only folder is one of them is not stripped. */
const ALLOWLIST_FOLDERS: ReadonlySet<string> = new Set(['agents', 'commands', 'skills', 'output-styles'])

function invalid(message: string, path: Array<string | number> = ['file']): HarnessError {
  return new HarnessError({ code: 'validation_error', message, details: { issues: [{ path, message, code: 'custom' }] } })
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

/** The folder files of an upload, in path order. */
async function collectFiles(collector: HomeCollector, files: readonly ClaudeImportUploadFile[], hasClaudeJson: boolean): Promise<void> {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const entry of sorted) {
    if (hasClaudeJson && entry.path === CLAUDE_JSON_PATH) {
      collector.skip(entry.path, 'listed twice')
      continue
    }
    const admission = collector.admit(entry.path, entry.file.size)
    if (admission.ok)
      collector.add(admission, await bytesOf(entry.file))
  }
}

/** The folder a zip's entries share (`<name>/`), or `''`. */
function sharedTopFolder(paths: readonly string[]): string {
  const nested = paths.filter(path => path !== CLAUDE_JSON_PATH)
  if (nested.length === 0 || nested.some(path => !path.includes('/')))
    return ''
  const tops = new Set(nested.map(path => path.slice(0, path.indexOf('/'))))
  if (tops.size !== 1)
    return ''
  const [top] = [...tops] as [string]
  return ALLOWLIST_FOLDERS.has(top) ? '' : `${top}/`
}

/** The allowlisted entries of a zip (see the module comment). */
async function collectZip(collector: HomeCollector, zip: Blob, hasClaudeJson: boolean): Promise<void> {
  const opened = await openZip(zip, new EntryCollector({ entries: UPLOAD_ZIP_ENTRIES_MAX, expandedBytes: Number.MAX_SAFE_INTEGER }, ['file']))
  const files = opened.entries.filter(entry => entry.type === 'file')
  const prefix = sharedTopFolder(files.map(entry => entry.path))
  const located = files
    .map(entry => ({ entry, path: prefix !== '' && entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const { entry, path } of located) {
    if (hasClaudeJson && path === CLAUDE_JSON_PATH) {
      collector.skip(path, 'listed twice')
      continue
    }
    const admission = collector.admit(path, entry.size)
    if (admission.ok)
      collector.add(admission, await opened.read(entry, { maxBytes: admission.maxBytes }))
  }
}

/**
 * Collects an upload. Throws `validation_error` for both or none of `zip` / `files` (a `.claude.json` alone is
 * accepted), more than `UPLOAD_FILES_MAX` files and a zip the guards refuse; `payload_too_large` from the zip reader.
 */
export async function collectUpload(input: ClaudeImportUploadInput): Promise<CollectedHome> {
  const files = input.files ?? []
  if (input.zip !== undefined && files.length > 0)
    throw invalid('Send either a zip in the part "file" or the folder\'s files in parts named "files", not both.')
  if (input.zip === undefined && files.length === 0 && input.claudeJson === undefined)
    throw invalid('Send a zip in the part "file" or the folder\'s files in parts named "files".')
  if (files.length > UPLOAD_FILES_MAX)
    throw invalid(`Send at most ${UPLOAD_FILES_MAX} files.`, ['files'])
  const collector = new HomeCollector()
  const hasClaudeJson = input.claudeJson !== undefined
  if (input.zip !== undefined)
    await collectZip(collector, input.zip, hasClaudeJson)
  else
    await collectFiles(collector, files, hasClaudeJson)
  // Last, like the scan: the definitions and settings come first within the total cap.
  if (input.claudeJson !== undefined) {
    const admission = collector.admit(CLAUDE_JSON_PATH, input.claudeJson.size)
    if (admission.ok)
      collector.add(admission, await bytesOf(input.claudeJson))
  }
  return collector.result()
}
