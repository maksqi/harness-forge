// `plugin.json` rules of the files API (API.md 5.18): a written manifest must stay valid with the same id; the manifest,
// the entry named by `main` and a file icon cannot be deleted; whether a plugin runs code (fresh auth, trust) is also
// read from the manifest on disk, failing closed when it cannot be read.
import type { PluginManifest } from '@harness-forge/plugin-sdk'
import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import { flattenValidationIssues, HarnessError, LIMITS, manifestRequiresTrust, pluginManifestSchema } from '@harness-forge/shared'
import { fileTooLarge, readRegularFile } from './paths.ts'

export const MANIFEST_FILE = 'plugin.json'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string): { ok: true, value: unknown } | { ok: false, message: string } {
  try {
    return { ok: true, value: JSON.parse(text.replace(/^\uFEFF/, '')) as unknown }
  }
  catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** The parsed `plugin.json` of `dir` (not validated); undefined when it is missing, too large or not JSON. */
export async function readManifestJson(dir: string): Promise<unknown> {
  try {
    const { bytes } = await readRegularFile(join(dir, MANIFEST_FILE), LIMITS.manifestBytes)
    const parsed = parseJson(bytes.toString('utf8'))
    return parsed.ok ? parsed.value : undefined
  }
  catch {
    return undefined
  }
}

/**
 * Whether a manifest (possibly invalid) makes the plugin run code: a `main` entry or a stdio MCP server. Anything that
 * is not a JSON object counts as code (fail closed).
 */
export function manifestRunsCode(json: unknown): boolean {
  if (!isRecord(json))
    return true
  if (json.main !== undefined)
    return true
  const contributes = json.contributes
  const servers = isRecord(contributes) && Array.isArray(contributes.mcpServers) ? contributes.mcpServers : []
  return servers.some(server => !isRecord(server) || !isRecord(server.transport) || server.transport.type === 'stdio')
}

/** Paths that cannot be deleted: `plugin.json`, the entry (`main`) and a file icon. */
export function protectedPaths(json: unknown): Set<string> {
  const paths = new Set([MANIFEST_FILE])
  if (isRecord(json)) {
    if (typeof json.main === 'string')
      paths.add(json.main)
    if (typeof json.icon === 'string' && !json.icon.startsWith('lobe:'))
      paths.add(json.icon)
  }
  return paths
}

/** Validates the new content of `plugin.json`: JSON, the strict manifest schema and the unchanged id. */
export function parseManifestWrite(content: string, pluginId: string): PluginManifest {
  if (Buffer.byteLength(content, 'utf8') > LIMITS.manifestBytes)
    throw fileTooLarge(LIMITS.manifestBytes)
  const json = parseJson(content)
  if (!json.ok) {
    const message = `${MANIFEST_FILE} is not valid JSON: ${json.message}`
    throw new HarnessError({ code: 'validation_error', message, details: { issues: [{ path: ['content'], message, code: 'invalid_json' }] } })
  }
  const parsed = pluginManifestSchema.safeParse(json.value)
  if (!parsed.success) {
    const issues = flattenValidationIssues(parsed.error)
    const first = issues[0]
    const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : ''
    throw new HarnessError({
      code: 'validation_error',
      message: `Invalid ${MANIFEST_FILE}: ${where}${first?.message ?? 'invalid manifest'}`,
      details: { issues },
    })
  }
  if (parsed.data.id !== pluginId) {
    const message = `The id in ${MANIFEST_FILE} must stay "${pluginId}".`
    throw new HarnessError({ code: 'validation_error', message, details: { issues: [{ path: ['id'], message, code: 'custom' }] } })
  }
  return parsed.data
}

/** A valid manifest makes the plugin run code (fresh auth for its writes). */
export function validManifestRunsCode(manifest: PluginManifest): boolean {
  return manifestRequiresTrust(manifest)
}
