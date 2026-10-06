// Code plugins created and edited in the browser (W3.4-T2, T3; API.md 5.18, PLUGINS.md 8 / 13, ADR-017). Implements
// `PluginFiles` of `../types.ts` on top of the plugin host:
//
// - `scaffold`: renders a template (`../templates`) into `plugins/.staging/scaffold-<uuid>`, renames it to
//   `plugins/<id>` (atomic, fails on an existing id), pins the trust hash (`source: 'created'`) and loads the plugin.
//   The route enforces fresh auth (the route table marks it `fresh`).
// - `list` / `read` / `write` / `remove`: the traversal-safe file API (`paths.ts`); only `created`, `copy` and `link`
//   plugins are writable (`PluginDetail.editable`). Writes and deletes of plugins that run code need fresh auth
//   (`options.requireFreshAuth()`), also when the new `plugin.json` would make the plugin run code. Writes are atomic,
//   bypass the hot-reload watcher and check `baseEtag`. A `created` plugin that was trusted before the edit is
//   re-pinned, so editor saves never make it untrusted while files changed outside the editor still need re-trust.
//   Writing `plugin.json` of a declarative plugin reloads it; code changes take effect on build. Otherwise the host
//   refreshes the plugin (`PluginHost.refresh`), so its detail shows the new trust hash and pin right away.
// - `build`: compiles / checks the entry through the host (diagnostics and build log lines as `plugin.log` events),
//   re-pins a `created` plugin on success and reloads it unless `reload: false` (then it refreshes it).
import type { PluginManifest } from '@harness-forge/plugin-sdk'
import type { BuildDiagnostic, BuildResult, PluginDetail, PluginFileEntry, PluginSource, ScaffoldRequest } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { NameRegistry } from '../templates/index.ts'
import type { PluginFiles, PluginRecord } from '../types.ts'
import type { ResolvedPluginPath } from './paths.ts'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { HarnessError, isReservedPluginId } from '@harness-forge/shared'
import { PLUGIN_TEMPLATES, renderPluginTemplate } from '../templates/index.ts'
import { createKeyedLock } from './lock.ts'
import { MANIFEST_FILE, manifestRunsCode, parseManifestWrite, protectedPaths, readManifestJson, validManifestRunsCode } from './manifest.ts'
import {
  decodeText,
  fileNotFound,
  fileTooLarge,
  isWithin,
  pathError,
  PLUGIN_FILE_MAX_BYTES,
  readRegularFile,
  resolvePluginPath,
  TEMP_FILE_PREFIX,
} from './paths.ts'
import { listPluginFiles } from './tree.ts'

/** Maximum length of a plugin name (`PluginManifest.name`). */
export const PLUGIN_NAME_MAX_LENGTH = 64

const SOURCE_LABELS: Readonly<Record<PluginSource, string>> = {
  builtin: 'the server',
  created: 'the app',
  zip: 'a zip file',
  npm: 'npm',
  url: 'a URL',
  link: 'a linked folder',
  copy: 'a copied folder',
  github: 'GitHub',
  marketplace: 'a marketplace',
}

function forbidden(message: string): HarnessError {
  return new HarnessError({ code: 'forbidden', message })
}

function conflict(message: string, reason: 'exists' | 'stale'): HarnessError {
  return new HarnessError({ code: 'conflict', message, details: { reason } })
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined
}

/** The trimmed display name of a new plugin (the manifest allows 1-64 characters). */
export function checkPluginName(name: string): string {
  const trimmed = name.trim()
  const invalid = (message: string, code: string): HarnessError =>
    new HarnessError({ code: 'validation_error', message, details: { issues: [{ path: ['name'], message, code }] } })
  if (trimmed.length === 0)
    throw invalid('Enter a name.', 'too_small')
  if (trimmed.length > PLUGIN_NAME_MAX_LENGTH)
    throw invalid(`Use at most ${PLUGIN_NAME_MAX_LENGTH} characters.`, 'too_big')
  // eslint-disable-next-line no-control-regex -- control characters are what is rejected
  if (/[\u0000-\u001F\u007F\u2028\u2029]/.test(trimmed))
    throw invalid('Names cannot contain line breaks or control characters.', 'invalid_string')
  return trimmed
}

interface EditTarget {
  detail: PluginDetail
  /** Realpath of the plugin directory. */
  dir: string
}

/** Trust facts captured before an edit (ADR-017 re-pinning of `created` plugins). */
interface TrustBefore {
  record: PluginRecord | null
  /** Trust hash of the files before the edit; null when they do not form a valid plugin. */
  hash: string | null
  /** The plugin runs code (trust required) before the edit. */
  runsCode: boolean
}

export function createPluginFiles(deps: AppDeps): PluginFiles {
  const lock = createKeyedLock()

  const names: NameRegistry = {
    tool: name => deps.registry.tools.get(name) !== undefined,
    provider: id => deps.registry.providers.get(id) !== undefined,
    mcpServer: id => deps.registry.mcpServers.get(id) !== undefined,
    command: name => deps.registry.commands.get(name) !== undefined,
  }

  // ---------- helpers ----------

  async function target(id: string): Promise<EditTarget> {
    const detail = await deps.plugins.get(id)
    if (detail.builtin)
      throw forbidden('Builtin plugins are part of the server: they have no files to open.')
    const dir = await deps.plugins.directory(id)
    if (dir === null)
      throw new HarnessError({ code: 'not_found', message: `The folder of the plugin "${id}" is missing.` })
    return { detail, dir }
  }

  function requireEditable(detail: PluginDetail): void {
    if (!detail.editable)
      throw forbidden(`Installed from ${SOURCE_LABELS[detail.source]}. Editing is disabled.`)
  }

  /** The trust hash of a plugin directory, or null when it is not a valid plugin right now. */
  async function currentHash(dir: string): Promise<string | null> {
    try {
      return (await deps.plugins.inspectDirectory(dir)).sha256
    }
    catch {
      return null
    }
  }

  async function trustBefore(id: string, dir: string, runsCode: boolean): Promise<TrustBefore> {
    return { record: await deps.plugins.record(id), hash: await currentHash(dir), runsCode }
  }

  /**
   * After an editor write of a `created` plugin: pins the new hash when the plugin was trusted before the edit (or did
   * not need trust). A plugin whose files had changed outside the editor keeps needing an explicit Trust.
   */
  async function repinAfterEdit(id: string, dir: string, before: TrustBefore): Promise<void> {
    const record = before.record
    if (record?.source !== 'created')
      return
    const trusted = !before.runsCode || (before.hash !== null && record.trustedHash === before.hash)
    if (!trusted) {
      deps.plugins.log(id, 'warn', 'Saved. The plugin stays untrusted: its files were changed outside the editor. Review and trust it.')
      return
    }
    const hash = await currentHash(dir)
    if (hash === null || hash === record.trustedHash)
      return
    await deps.plugins.saveRecord({ id, source: 'created', version: record.version, trustedHash: hash })
  }

  /**
   * After files changed without a load: the host re-reads the plugin so its detail shows the current trust hash and
   * pin (and announces the change). Best effort: the files are already written.
   */
  async function refreshDetail(id: string): Promise<void> {
    try {
      await deps.plugins.refresh?.(id)
    }
    catch (error) {
      deps.logger.warn('cannot refresh the plugin after a file change', { pluginId: id, err: error })
    }
  }

  function entryOf(path: string, type: 'file' | 'dir', size: number, mtimeMs: number, editable: boolean): PluginFileEntry {
    return { path, type, size, mtime: Math.max(0, Math.floor(mtimeMs)), editable }
  }

  /** Writes through a temporary file in the same folder and a rename (never a partially written file). */
  async function writeAtomically(root: string, resolved: ResolvedPluginPath, bytes: Uint8Array): Promise<void> {
    const parent = dirname(resolved.absolute)
    await mkdir(parent, { recursive: true, mode: 0o755 })
    if (!isWithin(root, await realpath(parent)))
      throw pathError('The path points outside the plugin directory.')
    const temporary = join(parent, `${TEMP_FILE_PREFIX}${randomUUID()}.tmp`)
    // Keep the permission bits of an existing file (new files: 0644).
    const mode = resolved.stats === null ? 0o644 : resolved.stats.mode & 0o777
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode })
      await rename(temporary, resolved.absolute)
    }
    catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  /** Removes the folders of `path` that became empty (never the plugin directory itself). */
  async function removeEmptyParents(root: string, path: string): Promise<void> {
    const segments = path.split('/').slice(0, -1)
    for (let length = segments.length; length > 0; length--) {
      try {
        await rmdir(join(root, ...segments.slice(0, length)))
      }
      catch {
        return
      }
    }
  }

  async function assertFreeId(id: string): Promise<void> {
    const taken = deps.plugins.state(id) !== null
      || await deps.plugins.record(id) !== null
      || await lstat(join(deps.env.paths.plugins, id)).then(() => true, () => false)
    if (taken)
      throw conflict(`A plugin with the id "${id}" already exists.`, 'exists')
  }

  function loadDiagnostic(detail: PluginDetail): BuildDiagnostic | null {
    const error = (message: string): BuildDiagnostic => ({ severity: 'error', file: null, line: null, column: null, message })
    switch (detail.state) {
      case 'active':
      case 'disabled':
      case 'loading':
        return null
      case 'untrusted':
        return error('The plugin is untrusted: its files changed since they were trusted. Review and trust it to load it.')
      case 'incompatible':
        return error(detail.lastError?.message ?? 'The plugin needs another plugin API version (engines.harness).')
      case 'error':
        return error(`The plugin failed to load: ${detail.lastError?.message ?? 'unknown error'}`)
    }
  }

  // ---------- service ----------

  return {
    scaffold: async (request: ScaffoldRequest) => {
      const { id, template } = request
      if (isReservedPluginId(id))
        throw forbidden(`The plugin id "${id}" is reserved (core-*, mock and builtin provider ids).`)
      const name = checkPluginName(request.name)
      return lock(id, async () => {
        await assertFreeId(id)
        const rendered = renderPluginTemplate({ template, id, name, language: request.language ?? 'js', registry: names })
        const staging = join(deps.env.paths.pluginStaging, `scaffold-${randomUUID()}`)
        const dir = join(deps.env.paths.plugins, id)
        try {
          await mkdir(staging, { recursive: true, mode: 0o755 })
          for (const [path, content] of Object.entries(rendered.files)) {
            await mkdir(dirname(join(staging, path)), { recursive: true, mode: 0o755 })
            await writeFile(join(staging, path), content, { flag: 'wx', mode: 0o644 })
          }
          try {
            await rename(staging, dir)
          }
          catch (error) {
            if (['EEXIST', 'ENOTEMPTY', 'EPERM', 'EISDIR'].includes(errorCode(error) ?? ''))
              throw conflict(`A plugin with the id "${id}" already exists.`, 'exists')
            throw error
          }
        }
        finally {
          await rm(staging, { recursive: true, force: true }).catch(() => {})
        }

        let recorded = false
        try {
          const inspection = await deps.plugins.inspectDirectory(dir)
          await deps.plugins.saveRecord({
            id,
            source: 'created',
            sourceRef: null,
            version: inspection.manifest.version,
            enabled: true,
            trustedHash: inspection.sha256,
          })
          recorded = true
          deps.plugins.log(id, 'info', `Created from the ${PLUGIN_TEMPLATES[template].label} template.`)
        }
        catch (error) {
          // Never leave a half-created plugin behind.
          await rm(dir, { recursive: true, force: true }).catch(() => {})
          if (recorded)
            await deps.plugins.forget(id).catch(() => {})
          throw error
        }
        return deps.plugins.load(id)
      })
    },

    list: async (id) => {
      const { detail, dir } = await target(id)
      return listPluginFiles(dir, detail.editable)
    },

    read: async (id, path) => {
      const { dir } = await target(id)
      const resolved = await resolvePluginPath(dir, path)
      if (resolved.stats === null)
        throw fileNotFound(path)
      if (!resolved.stats.isFile())
        throw pathError(`"${path}" is a folder.`)
      const { bytes, stats } = await readRegularFile(resolved.absolute)
      const content = decodeText(bytes)
      if (content === null)
        throw pathError(`"${path}" is not a UTF-8 text file, so it cannot be opened in the editor.`)
      return { path: resolved.path, content, etag: sha256Hex(bytes), mtime: Math.max(0, Math.floor(stats.mtimeMs)) }
    },

    write: async (id, path, write, options) => {
      const { detail, dir } = await target(id)
      requireEditable(detail)
      if (write.content.includes('\0'))
        throw new HarnessError({ code: 'validation_error', message: 'Files cannot contain NUL characters.', details: { issues: [{ path: ['content'], message: 'Files cannot contain NUL characters.', code: 'custom' }] } })
      const bytes = Buffer.from(write.content, 'utf8')
      if (bytes.length > PLUGIN_FILE_MAX_BYTES)
        throw fileTooLarge()
      return lock(id, async () => {
        const resolved = await resolvePluginPath(dir, path, { modify: true })
        if (resolved.stats !== null && !resolved.stats.isFile())
          throw pathError(`"${path}" is a folder.`)
        const isManifest = resolved.path === MANIFEST_FILE
        const nextManifest: PluginManifest | null = isManifest ? parseManifestWrite(write.content, id) : null
        const runsCode = detail.kind === 'code' || detail.trust.required || manifestRunsCode(await readManifestJson(dir))
        if (runsCode || (nextManifest !== null && validManifestRunsCode(nextManifest)))
          options.requireFreshAuth()

        if (write.baseEtag !== undefined) {
          if (resolved.stats === null)
            throw conflict(`"${path}" was deleted after you opened it.`, 'stale')
          const { bytes: current } = await readRegularFile(resolved.absolute)
          if (sha256Hex(current) !== write.baseEtag)
            throw conflict(`"${path}" changed after you opened it. Reload it to see the changes.`, 'stale')
        }

        const before = await trustBefore(id, dir, runsCode)
        await deps.plugins.withoutWatch(id, () => writeAtomically(dir, resolved, bytes))
        await repinAfterEdit(id, dir, before)
        // Declarative plugins reload when their manifest is written; code changes take effect on build.
        if (nextManifest !== null && nextManifest.main === undefined)
          await deps.plugins.load(id)
        else
          await refreshDetail(id)
        const written = await lstat(resolved.absolute)
        return entryOf(resolved.path, 'file', written.size, written.mtimeMs, true)
      })
    },

    remove: async (id, path, options) => {
      const { detail, dir } = await target(id)
      requireEditable(detail)
      return lock(id, async () => {
        const resolved = await resolvePluginPath(dir, path, { modify: true })
        if (resolved.stats === null)
          throw fileNotFound(path)
        if (!resolved.stats.isFile())
          throw pathError(`"${path}" is a folder: delete the files inside it instead.`)
        const manifest = await readManifestJson(dir)
        if (protectedPaths(manifest).has(resolved.path)) {
          throw pathError(resolved.path === MANIFEST_FILE
            ? `${MANIFEST_FILE} cannot be deleted.`
            : `"${resolved.path}" is used by ${MANIFEST_FILE} (entry or icon) and cannot be deleted.`)
        }
        const runsCode = detail.kind === 'code' || detail.trust.required || manifestRunsCode(manifest)
        if (runsCode)
          options.requireFreshAuth()
        const before = await trustBefore(id, dir, runsCode)
        await deps.plugins.withoutWatch(id, async () => {
          await rm(resolved.absolute)
          await removeEmptyParents(dir, resolved.path)
        })
        await repinAfterEdit(id, dir, before)
        await refreshDetail(id)
      })
    },

    build: async (id, body) => {
      const started = performance.now()
      const { detail, dir } = await target(id)
      requireEditable(detail)
      const manifest = await readManifestJson(dir)
      const hasEntry = typeof manifest === 'object' && manifest !== null && 'main' in manifest
      if (!hasEntry && detail.kind !== 'code')
        throw forbidden('Declarative plugins have no code to build: saving plugin.json reloads them.')
      return lock(id, async (): Promise<BuildResult> => {
        deps.plugins.log(id, 'info', 'Build started.')
        const record = await deps.plugins.record(id)
        // The hash of the files being built: if they change during the build, the pin no longer matches and the
        // reload ends in `untrusted` instead of trusting unseen changes.
        const hash = await currentHash(dir)
        const compiled = await deps.plugins.compile(id)
        const elapsed = (): number => Math.round((performance.now() - started) * 100) / 100
        if (!compiled.ok)
          return { ok: false, durationMs: elapsed(), diagnostics: compiled.diagnostics, hash: null, state: deps.plugins.state(id) ?? detail.state }

        let pin = record?.trustedHash ?? null
        if (record?.source === 'created' && hash !== null && hash !== pin) {
          await deps.plugins.saveRecord({ id, source: 'created', version: record.version, trustedHash: hash })
          pin = hash
        }
        const diagnostics = [...compiled.diagnostics]
        let state = deps.plugins.state(id) ?? detail.state
        if (body.reload !== false) {
          const loaded = await deps.plugins.load(id)
          state = loaded.state
          const problem = loadDiagnostic(loaded)
          if (problem)
            diagnostics.push(problem)
          deps.plugins.log(id, problem ? 'error' : 'info', problem ? `Reload failed: ${problem.message}` : `Reloaded (${state}).`)
        }
        else {
          await refreshDetail(id)
        }
        return {
          ok: diagnostics.every(diagnostic => diagnostic.severity !== 'error'),
          durationMs: elapsed(),
          diagnostics,
          hash: pin,
          state,
        }
      })
    },
  }
}
