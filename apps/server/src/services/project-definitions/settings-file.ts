// The JSON files of the project definition editor (Phase 12, ADR-056, ARCHITECTURE.md 6.36; open point 11): the four
// settings files (only their `hooks` key is edited) and `.mcp.json` (only its `mcpServers` key). Owner: W12.4.
//
// `spliceJsonKey(before, file, value)` replaces one key of the file's JSON object and keeps the value of every other key
// and the key order (an existing key stays where it is, a new one goes last; `null` removes the key; a missing file
// starts from `{}`), then writes `JSON.stringify(object, null, 2)` + a newline: the formatting of the other keys may
// change, their values do not (their trust hashes are canonical). The file on disk is read with a byte cap before
// `JSON.parse` (256 KiB, `LIMITS.projectSettingsFileBytes` / `LIMITS.projectMcpFileBytes`); a file that is not a JSON
// object is refused with `400` (its other keys could not be kept), never replaced. A leading byte order mark is dropped.
//
// `jsonFileDiagnostics(file, text, …)` are the diagnostics of a whole file as the project config reader sees it
// (`readSettingsHooks(…, { prompts: true })`, `parseMcpJson`); a `.mcp.json` whose `mcpServers` key was removed on
// purpose has no "missing servers" error.
import type { ProjectDefinitionDiagnostic } from '@harness-forge/shared'
import { Buffer } from 'node:buffer'
import { LIMITS, parseMcpJson, readSettingsHooks } from '@harness-forge/shared'
import { diagnostic, fromHookDiagnostics, fromMcpDiagnostics, invalidContent } from './diagnostics.ts'

/** The JSON kinds of the editor: a settings file or `.mcp.json`. */
export type JsonDefinitionFile = 'settings' | 'mcp'

/** The edited key of each JSON kind (the issue path of its `400`). */
export const JSON_FILE_KEY: Readonly<Record<JsonDefinitionFile, 'hooks' | 'mcpServers'>> = { settings: 'hooks', mcp: 'mcpServers' }

/** The byte cap of each JSON kind (before `JSON.parse`, and of the file written). */
export const JSON_FILE_MAX_BYTES: Readonly<Record<JsonDefinitionFile, number>> = {
  settings: LIMITS.projectSettingsFileBytes,
  mcp: LIMITS.projectMcpFileBytes,
}

const NAMES: Readonly<Record<JsonDefinitionFile, string>> = { settings: 'The settings file', mcp: 'The .mcp.json file' }

function kib(bytes: number): string {
  return `${Math.floor(bytes / 1024)} KiB`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The `400` of a file on disk whose other keys cannot be kept (too large, not JSON, not an object). */
function unusableFile(file: JsonDefinitionFile, code: string, message: string): never {
  throw invalidContent([diagnostic('error', code, message)], JSON_FILE_KEY[file])
}

/**
 * The JSON object of the file as it is on disk (`null` = the file does not exist: `{}`). Throws `400` for a file larger
 * than the cap, not valid JSON or not a JSON object.
 */
export function readJsonObject(file: JsonDefinitionFile, before: Uint8Array | null): Record<string, unknown> {
  if (before === null)
    return {}
  const max = JSON_FILE_MAX_BYTES[file]
  if (before.byteLength > max)
    unusableFile(file, 'too-large', `${NAMES[file]} on disk is larger than ${kib(max)}; edit it in another editor.`)
  const text = Buffer.from(before.buffer, before.byteOffset, before.byteLength).toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text)
  }
  catch {
    unusableFile(file, 'invalid-json', `${NAMES[file]} on disk is not valid JSON; fix it in another editor first, so its other keys are kept.`)
  }
  if (!isRecord(parsed))
    unusableFile(file, 'not-an-object', `${NAMES[file]} on disk does not hold a JSON object; fix it in another editor first.`)
  return parsed
}

/**
 * The new text of the file: `before` (null = missing) with the edited key (`JSON_FILE_KEY[file]`) set to `value` (null
 * removes it), every other key and the key order kept, as `JSON.stringify(object, null, 2)` + `\n`.
 */
export function spliceJsonKey(file: JsonDefinitionFile, before: Uint8Array | null, value: Record<string, unknown> | null): string {
  const object = readJsonObject(file, before)
  const key = JSON_FILE_KEY[file]
  if (value === null)
    delete object[key]
  else
    object[key] = value
  return `${JSON.stringify(object, null, 2)}\n`
}

/**
 * The diagnostics of a whole settings file or `.mcp.json` text, as the project config reader sees it. `removed`: the
 * edited key was removed on purpose (a `.mcp.json` without `mcpServers` is then no error).
 */
export function jsonFileDiagnostics(file: JsonDefinitionFile, text: string, path: string, removed = false): ProjectDefinitionDiagnostic[] {
  const max = JSON_FILE_MAX_BYTES[file]
  if (file === 'settings')
    return fromHookDiagnostics(readSettingsHooks(text, { file: path, maxBytes: max, prompts: true }).diagnostics)
  const parsed = parseMcpJson(text, { maxBytes: max })
  return fromMcpDiagnostics(removed ? parsed.diagnostics.filter(item => item.code !== 'missing-servers') : parsed.diagnostics)
}
