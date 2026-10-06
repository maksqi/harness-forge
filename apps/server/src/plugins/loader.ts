// Plugin directory validation and entry import (PLUGINS.md 2, 3, 8, 11 "Validation steps", 13 "Pinning"). Owner: W1.3
// (W1.3-T1).
//
// `readPluginDirectory()` runs the validation steps that do not execute plugin code, in the documented order:
//   1. `plugin.json` exists, is a file inside the directory, <= 256 KB, valid JSON          -> error
//   2. lenient pre-parse: `engines.harness` satisfied by `PLUGIN_API_VERSION`               -> incompatible
//   3. strict manifest schema (`pluginManifestBaseSchema`)                                  -> error
//   4. the directory name equals `id`; `id` is not reserved                                 -> error
//   5. realpath of `main` and of a file `icon` inside the directory; allowed extension      -> error
// and computes the content hash that trust pins. The trust check (step 6) needs the `plugins` row and runs in the host.
// Plugin API 1.5.0 (ADR-048, ADR-052): a manifest with command hooks or `!` spans requires trust too; the declarative
// hash still covers `plugin.json` only (the scripts a hook calls are not pinned, like the other files of a code
// plugin), and `declaredContributions` counts the declared command hook handlers and lists the output styles.
import type { PluginManifest } from '@harness-forge/plugin-sdk'
import type { HarnessErrorInit, PluginContributions, PluginKind } from '@harness-forge/shared'
import type { PluginDirectoryInspection } from './types.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN_API_VERSION } from '@harness-forge/plugin-sdk'
import {
  countHookHandlers,
  flattenValidationIssues,
  HarnessError,
  isReservedPluginId,
  LIMITS,
  manifestRequiresTrust,
  pluginManifestBaseSchema,
  semverRangeSchema,
  semverSchema,
} from '@harness-forge/shared'
import semver from 'semver'

export const MANIFEST_FILE = 'plugin.json'
/** `plugin.json` size limit. */
export const MANIFEST_MAX_BYTES = LIMITS.manifestBytes
/** Size limit of a file icon. */
export const ICON_MAX_BYTES = LIMITS.iconFileBytes
/** Size limit of a code entry (single-file plugins may inline their helpers). */
export const ENTRY_MAX_BYTES = LIMITS.uploadBytes
/** Extensions of code entries. */
export const ENTRY_EXTENSIONS = ['.mjs', '.js', '.ts'] as const
/** Extensions of file icons and their content types. */
export const ICON_CONTENT_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png' } as const

// ---------- paths ----------

/** True when `target` is strictly inside `root` (both absolute, already resolved). */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Realpath of `relativePath` inside `root`, or null when it is missing or escapes `root` (symlinks included). */
export async function resolveInside(root: string, relativePath: string): Promise<string | null> {
  try {
    const real = await realpath(join(root, relativePath))
    return isInside(root, real) ? real : null
  }
  catch {
    return null
  }
}

// ---------- hashes (PLUGINS.md 13 "Pinning") ----------

export function sha256Hex(...parts: readonly Uint8Array[]): string {
  const hash = createHash('sha256')
  for (const part of parts)
    hash.update(part)
  return hash.digest('hex')
}

/**
 * The trust hash of a plugin's files: code plugins hash `plugin.json`, one `0x00` byte and the entry file; declarative
 * plugins hash `plugin.json` only.
 */
export function contentHash(manifestBytes: Uint8Array, entryBytes: Uint8Array | null): string {
  return entryBytes === null ? sha256Hex(manifestBytes) : sha256Hex(manifestBytes, Buffer.from([0]), entryBytes)
}

/** The pin of a linked folder: `path:` + SHA-256 of its realpath. */
export function pathPin(realDir: string): string {
  return `path:${sha256Hex(Buffer.from(realDir, 'utf8'))}`
}

// ---------- manifest ----------

/** Fields read from a manifest that failed the strict schema (display only). */
export interface LenientManifest {
  id?: string
  name?: string
  version?: string
  description?: string
  icon?: string
  /** `main` when it is a string (the plugin is then shown as a code plugin). */
  main?: string
  /** `engines.harness` when it is a valid semver range. */
  harness?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Picks the display fields that are individually valid. */
export function lenientManifest(json: unknown): LenientManifest {
  if (!isRecord(json))
    return {}
  const result: LenientManifest = {}
  const text = (value: unknown, max: number): string | undefined =>
    typeof value === 'string' && value.trim() !== '' && value.length <= max ? value.trim() : undefined
  result.id = text(json.id, 40)
  result.name = text(json.name, 64)
  const version = text(json.version, 256)
  if (version !== undefined && semverSchema.safeParse(version).success)
    result.version = version
  result.description = text(json.description, 280)
  result.icon = text(json.icon, 256)
  result.main = text(json.main, 256)
  const engines = json.engines
  if (isRecord(engines) && typeof engines.harness === 'string' && semverRangeSchema.safeParse(engines.harness).success)
    result.harness = engines.harness
  return result
}

/** `engines.harness` satisfied by the running plugin API. */
export function isCompatibleRange(range: string): boolean {
  try {
    return semver.satisfies(PLUGIN_API_VERSION, range)
  }
  catch {
    return false
  }
}

/** A manifest that satisfies `pluginManifestBaseSchema`, for plugins whose own manifest could not be parsed. */
export function synthesizeManifest(id: string, lenient: LenientManifest): PluginManifest {
  const manifest: PluginManifest = {
    manifestVersion: 1,
    id,
    name: lenient.name ?? id,
    version: lenient.version ?? '0.0.0',
    engines: { harness: lenient.harness ?? '*' },
  }
  if (lenient.description !== undefined)
    manifest.description = lenient.description
  const parsed = pluginManifestBaseSchema.safeParse(manifest)
  return parsed.success ? parsed.data : { manifestVersion: 1, id, name: id, version: '0.0.0', engines: { harness: '*' } }
}

/** Contributions declared by a manifest (code plugins may register more at runtime). */
export function declaredContributions(manifest: PluginManifest | null): PluginContributions {
  const contributes = manifest?.contributes
  const providers = (contributes?.providers ?? []).map(provider => provider.id)
  const models = (contributes?.providers ?? []).reduce((sum, provider) => sum + (provider.models?.length ?? 0), 0)
    + (contributes?.models ?? []).reduce((sum, entry) => sum + entry.models.length, 0)
  return {
    providers,
    models,
    tools: [],
    mcpServers: (contributes?.mcpServers ?? []).map(server => server.id),
    commands: (contributes?.commands ?? []).map(command => command.name).sort(),
    hooks: [],
    // Plugin API 1.4.0 (ADR-045): the declared agents and skills.
    agents: (contributes?.agents ?? []).map(agent => agent.name).sort(),
    skills: (contributes?.skills ?? []).map(skill => skill.name).sort(),
    // Plugin API 1.5.0 (ADR-048, ADR-051): the declared command hooks and output styles.
    commandHooks: countHookHandlers(contributes?.hooks),
    outputStyles: (contributes?.outputStyles ?? []).map(style => style.name).sort(),
  }
}

export function manifestKind(manifest: Pick<PluginManifest, 'main'> | null): PluginKind {
  return manifest?.main === undefined ? 'declarative' : 'code'
}

// ---------- directory validation ----------

/** Why a plugin cannot load before its code runs. */
export interface LoadProblem {
  state: 'error' | 'incompatible'
  error: HarnessErrorInit
}

export interface PluginDirectoryRead {
  /** Realpath of the directory (null when it is missing). */
  dir: string | null
  manifestBytes: Buffer | null
  /** Valid manifest (steps 1-3 passed), else null. */
  manifest: PluginManifest | null
  lenient: LenientManifest
  /** `engines.harness` satisfied; null when unknown (no readable range). */
  compatible: boolean | null
  /** First failing step, or null. */
  problem: LoadProblem | null
  /** First failing step whose state is `error` (it may follow an `incompatible` problem), or null. */
  firstError: LoadProblem | null
  /** Realpath of the entry (code plugins). */
  entryPath: string | null
  entryBytes: Buffer | null
  /** Realpath of a file icon. */
  iconPath: string | null
  /** First 8 hex chars of the icon file's SHA-256 (`?v=` of the icon URL). */
  iconVersion: string | null
  /** Trust hash of the files (`contentHash`); null when `plugin.json` (or the entry) is unreadable. */
  hash: string | null
  /**
   * `manifestRequiresTrust`: a code plugin, or a manifest that declares a stdio MCP server, (plugin API 1.5.0) command
   * hooks or a `` !`cmd` `` span in a command template.
   */
  requiresTrust: boolean
}

export interface ReadPluginDirectoryOptions {
  /** The plugin id the directory must declare (its name); omitted for staging directories. */
  expectedId?: string
  /** Fail reserved ids (step 4). Default true. */
  rejectReserved?: boolean
}

function loadProblem(pluginId: string | undefined, message: string, extra: Record<string, unknown> = {}, state: LoadProblem['state'] = 'error'): LoadProblem {
  return {
    state,
    error: { code: 'plugin_error', message, details: { pluginId: pluginId ?? 'unknown', phase: 'load', ...extra } },
  }
}

async function readRegularFile(path: string, maxBytes: number): Promise<{ bytes: Buffer } | { error: 'not-file' | 'too-large' | 'unreadable' }> {
  try {
    const info = await stat(path)
    if (!info.isFile())
      return { error: 'not-file' }
    if (info.size > maxBytes)
      return { error: 'too-large' }
    const bytes = await readFile(path)
    return bytes.length > maxBytes ? { error: 'too-large' } : { bytes }
  }
  catch {
    return { error: 'unreadable' }
  }
}

/**
 * Runs validation steps 1-5 on a plugin directory without executing plugin code. Never throws. `problem` is the first
 * failing step; after an `incompatible` range the remaining steps still run when the manifest parses, so the result
 * carries the manifest and hash for display, inspection and trust pinning.
 */
export async function readPluginDirectory(dir: string, options: ReadPluginDirectoryOptions = {}): Promise<PluginDirectoryRead> {
  const expectedId = options.expectedId
  const result: PluginDirectoryRead = {
    dir: null,
    manifestBytes: null,
    manifest: null,
    lenient: {},
    compatible: null,
    problem: null,
    firstError: null,
    entryPath: null,
    entryBytes: null,
    iconPath: null,
    iconVersion: null,
    hash: null,
    requiresTrust: false,
  }
  /** Records a problem unless an earlier step already failed; returns the result for early exits. */
  const fail = (message: string, extra?: Record<string, unknown>, state: LoadProblem['state'] = 'error'): PluginDirectoryRead => {
    const problem = loadProblem(result.manifest?.id ?? expectedId ?? result.lenient.id, message, extra, state)
    result.problem ??= problem
    if (state === 'error')
      result.firstError ??= problem
    return result
  }

  try {
    const info = await stat(dir)
    if (!info.isDirectory())
      return fail('The plugin path is not a directory.')
    result.dir = await realpath(dir)
  }
  catch {
    return fail('The plugin directory is missing.')
  }
  const root = result.dir

  // 1. plugin.json
  const manifestPath = await resolveInside(root, MANIFEST_FILE)
  if (manifestPath === null)
    return fail(`${MANIFEST_FILE} is missing (or points outside the plugin directory).`)
  const manifestFile = await readRegularFile(manifestPath, MANIFEST_MAX_BYTES)
  if ('error' in manifestFile) {
    return fail(manifestFile.error === 'too-large'
      ? `${MANIFEST_FILE} is larger than ${MANIFEST_MAX_BYTES / 1024} KB.`
      : `${MANIFEST_FILE} cannot be read.`)
  }
  result.manifestBytes = manifestFile.bytes
  result.hash = contentHash(manifestFile.bytes, null)
  let json: unknown
  try {
    json = JSON.parse(manifestFile.bytes.toString('utf8').replace(/^\uFEFF/, ''))
  }
  catch (error) {
    return fail(`${MANIFEST_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  result.lenient = lenientManifest(json)

  // 2. lenient engines check: a manifest written for a newer plugin API is incompatible, not invalid
  if (result.lenient.harness !== undefined) {
    result.compatible = isCompatibleRange(result.lenient.harness)
    if (!result.compatible) {
      fail(
        `This plugin needs plugin API ${result.lenient.harness}; this server provides ${PLUGIN_API_VERSION}.`,
        { harness: result.lenient.harness },
        'incompatible',
      )
    }
  }

  // 3. strict schema
  const parsed = pluginManifestBaseSchema.safeParse(json)
  if (!parsed.success) {
    const issues = flattenValidationIssues(parsed.error)
    const first = issues[0]
    const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : ''
    return fail(`Invalid ${MANIFEST_FILE}: ${where}${first?.message ?? 'invalid manifest'}`, { issues })
  }
  const manifest = parsed.data
  result.manifest = manifest
  result.compatible = isCompatibleRange(manifest.engines.harness)
  result.requiresTrust = manifestRequiresTrust(manifest)

  // 4. id
  if (expectedId !== undefined && manifest.id !== expectedId)
    fail(`The manifest id "${manifest.id}" does not match the directory name "${expectedId}".`)
  if ((options.rejectReserved ?? true) && isReservedPluginId(manifest.id))
    fail(`The plugin id "${manifest.id}" is reserved (core-*, mock and builtin provider ids).`)

  // 5. entry and icon inside the directory
  if (manifest.main !== undefined) {
    const entryPath = await resolveInside(root, manifest.main)
    if (entryPath === null || !(ENTRY_EXTENSIONS as readonly string[]).includes(extname(entryPath)))
      return fail(`The entry "${manifest.main}" is missing, points outside the plugin directory, or is not a .mjs, .js or .ts file.`)
    const entry = await readRegularFile(entryPath, ENTRY_MAX_BYTES)
    if ('error' in entry)
      return fail(entry.error === 'too-large' ? `The entry "${manifest.main}" is too large.` : `The entry "${manifest.main}" cannot be read.`)
    result.entryPath = entryPath
    result.entryBytes = entry.bytes
    result.hash = contentHash(manifestFile.bytes, entry.bytes)
  }
  if (manifest.icon !== undefined && !manifest.icon.startsWith('lobe:')) {
    const iconPath = await resolveInside(root, manifest.icon)
    const extension = iconPath === null ? '' : extname(iconPath).toLowerCase()
    if (iconPath === null || !Object.hasOwn(ICON_CONTENT_TYPES, extension))
      return fail(`The icon "${manifest.icon}" is missing, points outside the plugin directory, or is not a .svg or .png file.`)
    const icon = await readRegularFile(iconPath, ICON_MAX_BYTES)
    if ('error' in icon)
      return fail(icon.error === 'too-large' ? `The icon "${manifest.icon}" is larger than ${ICON_MAX_BYTES / 1024} KB.` : `The icon "${manifest.icon}" cannot be read.`)
    result.iconPath = iconPath
    result.iconVersion = sha256Hex(icon.bytes).slice(0, 8)
  }
  return result
}

/** Number and total size of the regular files below `root` (symlinks are not followed; at most 10 000 entries). */
export async function countFiles(root: string): Promise<{ count: number, bytes: number }> {
  let count = 0
  let bytes = 0
  let visited = 0
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    }
    catch {
      return
    }
    for (const entry of entries) {
      if (++visited > 10_000)
        return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
      }
      else if (entry.isFile()) {
        count += 1
        try {
          bytes += (await lstat(path)).size
        }
        catch {}
      }
    }
  }
  await walk(root)
  return { count, bytes }
}

/**
 * `PluginHost.inspectDirectory`: validation steps 1-5 without the directory-name and reserved checks (reported as
 * `reserved`) and the content hash. Throws `validation_error` (with issues) for a missing or invalid `plugin.json` and
 * for an entry or icon outside the directory.
 */
export async function inspectPluginDirectory(dir: string): Promise<PluginDirectoryInspection> {
  const read = await readPluginDirectory(dir, { rejectReserved: false })
  const manifest = read.manifest
  if (manifest === null || read.dir === null || read.hash === null || read.firstError !== null) {
    const problem = (read.firstError ?? read.problem)?.error
    const details = problem?.details as { issues?: unknown } | undefined
    throw new HarnessError({
      code: 'validation_error',
      message: problem?.message ?? 'The folder is not a valid plugin.',
      details: { issues: Array.isArray(details?.issues) ? details.issues : [{ path: [], message: problem?.message ?? 'Invalid plugin.', code: 'custom' }] },
    })
  }
  return {
    manifest,
    kind: manifestKind(manifest),
    sha256: read.hash,
    requiresTrust: read.requiresTrust,
    compatible: read.compatible ?? false,
    reserved: isReservedPluginId(manifest.id),
    contributions: declaredContributions(manifest),
    files: await countFiles(read.dir),
    // Phase 12 (C43 compile fix): this reader reads harness plugins; Claude Code plugins are read by W12.1's reader.
    format: 'harness',
    claude: null,
  }
}

// ---------- entry import ----------

const failedImports = new Map<string, number>()

/**
 * Imports a code entry with a cache-busting query (`?v=<hash>`): Node keeps every imported module in memory, so an
 * unchanged file reuses its module and a changed file gets a new one. After a failed import of the same URL an
 * `&attempt=<n>` suffix forces a fresh evaluation (Node caches failed evaluations too).
 */
export async function importEntry(file: string, version: string): Promise<unknown> {
  const base = `${pathToFileURL(file).href}?v=${encodeURIComponent(version)}`
  const attempt = failedImports.get(base) ?? 0
  const url = attempt === 0 ? base : `${base}&attempt=${attempt}`
  try {
    return await import(/* @vite-ignore */ url) as unknown
  }
  catch (error) {
    failedImports.set(base, attempt + 1)
    throw error
  }
}

/** The `PluginModule` default export of an imported entry, or a message describing what is wrong. */
export function pluginModuleOf(namespace: unknown): { module: { setup: (ctx: unknown) => unknown, dispose?: () => unknown } } | { problem: string } {
  const exported = isRecord(namespace) || typeof namespace === 'function' ? (namespace as Record<string, unknown>).default : undefined
  if (!isRecord(exported) && typeof exported !== 'function')
    return { problem: 'The entry must default-export the plugin module: export default { setup(ctx) { ... } }.' }
  const candidate = exported as Record<string, unknown>
  if (typeof candidate.setup !== 'function')
    return { problem: 'The default export has no setup(ctx) function.' }
  if (candidate.dispose !== undefined && typeof candidate.dispose !== 'function')
    return { problem: 'The default export has a "dispose" that is not a function.' }
  return { module: candidate as { setup: (ctx: unknown) => unknown, dispose?: () => unknown } }
}
