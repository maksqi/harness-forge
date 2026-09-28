// Plugin installer (PLUGINS.md 12-13, ARCHITECTURE.md 6.5, API.md 5.16). Owner: W3.2.
//
// inspect / install share one pipeline:
//   1. stage   - zip upload, npm tarball (sha512-verified), URL download (SSRF-guarded, SRI-verified) or copied folder
//                -> `data/plugins/.staging/<uuid>` with every archive guard (archive.ts, zip.ts, tar.ts, folder.ts);
//                a linked folder is used in place (realpath outside the data directory).
//   2. examine - the host validates the directory (`PluginHost.inspectDirectory`: manifest, entry / icon inside the
//                directory, trust hash) -> `PluginInspection` (inspection.ts). Reserved ids, incompatible plugins and
//                an id installed from another source are refused at install time.
//   3. install only: `authorize(inspection)` (the route requires fresh auth when the plugin requires trust), then an
//                atomic swap under a mutex: the installed version moves to `.staging/<id>.prev-<uuid>`, the staged
//                directory is renamed to `plugins/<id>`, the row is saved (`trusted_hash` only with `trust`), the host
//                loads it; a load that ends in `error` restores the previous version (or forgets a fresh install).
//                A source inspected shortly before that now yields other files is refused first (reviews.ts).
// The staging directory is removed in every case; `recover()` cleans up after a crash (staging.ts).
import type { PluginDetail, PluginInspection } from '@harness-forge/shared'
import type { SafeFetch } from '../../security/types.ts'
import type { AppDeps } from '../../types.ts'
import type {
  PluginDirectoryInspection,
  PluginInstaller,
  PluginInstallInput,
  PluginInstallOptions,
  PluginRecord,
  PluginRecordInput,
} from '../types.ts'
import type { ArchiveEntry } from './archive.ts'
import type { InstallLimits, IssuePath } from './errors.ts'
import type { ExistingPlugin, InstallSourceKind } from './inspection.ts'
import { lstat, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { PLUGIN_API_VERSION } from '@harness-forge/plugin-sdk'
import { HarnessError } from '@harness-forge/shared'
import { safeFetch as defaultSafeFetch } from '../../security/ssrf.ts'
import { sanitizeFileName } from '../../services/files/names.ts'
import { isInside, pathPin } from '../loader.ts'
import { EntryCollector, MANIFEST_NAME, pluginRootPrefix, verifyTree, writeEntries } from './archive.ts'
import { INSTALL_LIMITS, invalid, megabytes, tooLarge } from './errors.ts'
import { exportPluginDirectory } from './export.ts'
import { readFolder, resolveLocalFolder } from './folder.ts'
import { buildInspection, sourceLabel } from './inspection.ts'
import { createMutex, createSemaphore } from './lock.ts'
import { downloadNpmPackage, NPM_REGISTRY_URL } from './npm.ts'
import { createReviewLog } from './reviews.ts'
import { createStagingArea } from './staging.ts'
import { readTarGz } from './tar.ts'
import { downloadFromUrl } from './url.ts'
import { readZip } from './zip.ts'

/** Staging operations (downloads and extraction in memory) running at the same time. */
const MAX_CONCURRENT_STAGING = 2

export interface InstallerOptions {
  /** Fetch of the npm source (default `globalThis.fetch`; tests pass a fake registry). */
  fetch?: typeof globalThis.fetch
  /** SSRF-guarded fetch of URL installs (default `security/ssrf.ts`). */
  safeFetch?: SafeFetch
  /** npm registry base URL (default `https://registry.npmjs.org`). */
  npmRegistry?: string
  /** Limit overrides (tests). */
  limits?: Partial<InstallLimits>
}

/** A plugin ready to be examined: a staging directory, or a linked folder used in place. */
interface StagedPlugin {
  source: InstallSourceKind
  /** npm `name@version`, URL, folder realpath or zip file name. */
  sourceRef: string
  /** The plugin directory (`.staging/<uuid>` or the linked folder's realpath). */
  dir: string
  /** Staging directory to delete afterwards; null for links and after the directory was moved into place. */
  staging: string | null
  /** Notes of the source for the inspection warnings. */
  notes: string[]
}

type Purpose = 'inspect' | 'install'

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  }
  catch {
    return false
  }
}

function conflict(message: string): HarnessError {
  return new HarnessError({ code: 'conflict', message, details: { reason: 'exists' } })
}

/** The plugin of `id` failed to load after an install: the change was rolled back. */
function loadFailure(id: string, detail: PluginDetail): HarnessError {
  const reason = detail.lastError?.message ?? 'unknown error'
  return new HarnessError({
    code: 'plugin_error',
    message: `The plugin failed to load, so the installation was rolled back: ${reason}`,
    details: { pluginId: id, phase: 'install' },
  })
}

/** A `PluginRecordInput` restoring a previous row. */
function restoredRecord(record: PluginRecord): PluginRecordInput | null {
  if (record.source === 'builtin')
    return null
  return {
    id: record.id,
    source: record.source,
    sourceRef: record.sourceRef,
    version: record.version,
    enabled: record.enabled,
    trustedHash: record.trustedHash,
  }
}

/** The installer with injectable network access (tests). `createPluginInstaller` is the production factory. */
export function createInstaller(deps: AppDeps, options: InstallerOptions = {}): PluginInstaller {
  const limits: InstallLimits = { ...INSTALL_LIMITS, ...options.limits }
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const safeFetch = options.safeFetch ?? defaultSafeFetch
  const registry = options.npmRegistry ?? NPM_REGISTRY_URL
  const paths = deps.env.paths
  const staging = createStagingArea({ pluginsDir: paths.plugins, stagingDir: paths.pluginStaging, logger: deps.logger })
  const commitLock = createMutex()
  const stagingSlots = createSemaphore(MAX_CONCURRENT_STAGING)
  const reviews = createReviewLog()

  // ---------- 1. stage ----------

  /** Writes admitted entries into a fresh staging directory and verifies the tree. */
  async function materialize(entries: ArchiveEntry[], source: InstallSourceKind, sourceRef: string, notes: string[], issuePath: IssuePath, prefix?: string): Promise<StagedPlugin> {
    const root = prefix ?? pluginRootPrefix(entries, issuePath)
    const dir = await staging.create()
    try {
      await writeEntries(dir, entries, root)
      await verifyTree(dir, limits)
    }
    catch (error) {
      await staging.remove(dir).catch(() => {})
      throw error
    }
    return { source, sourceRef, dir, staging: dir, notes }
  }

  async function stageZip(fileName: string, data: Uint8Array): Promise<StagedPlugin> {
    if (data.byteLength > limits.compressedBytes)
      throw tooLarge(`The zip is larger than ${megabytes(limits.compressedBytes)}.`, limits.compressedBytes)
    const entries = await readZip(data, new EntryCollector(limits, ['file']))
    return materialize(entries, 'zip', sanitizeFileName(fileName, 'application/zip'), [], ['file'])
  }

  async function stageNpm(spec: string): Promise<StagedPlugin> {
    const { resolution, tarball } = await downloadNpmPackage(spec, { fetch: fetchImpl, registry, limits })
    const entries = await readTarGz(tarball, new EntryCollector(limits, ['spec']), limits, ['spec'])
    return materialize(entries, 'npm', `${resolution.name}@${resolution.version}`, resolution.warnings, ['spec'])
  }

  async function stageUrl(url: string, integrity: string): Promise<StagedPlugin> {
    const download = await downloadFromUrl(url, integrity, safeFetch, limits)
    const collector = new EntryCollector(limits, ['url'])
    const entries = download.format === 'zip'
      ? await readZip(download.data, collector)
      : await readTarGz(download.data, collector, limits, ['url'])
    return materialize(entries, 'url', url, [], ['url'])
  }

  async function stageFolder(path: string, mode: 'link' | 'copy'): Promise<StagedPlugin> {
    const real = await resolveLocalFolder(path, paths.root)
    if (mode === 'link')
      return { source: 'link', sourceRef: real, dir: real, staging: null, notes: [] }
    const entries = await readFolder(real, new EntryCollector(limits, ['path']))
    if (!entries.some(entry => entry.type === 'file' && entry.path === MANIFEST_NAME))
      throw invalid(`The folder has no ${MANIFEST_NAME} at its top level.`, ['path'])
    return materialize(entries, 'copy', real, [], ['path'], '')
  }

  function stage(input: PluginInstallInput): Promise<StagedPlugin> {
    return stagingSlots(async () => {
      switch (input.source) {
        case 'zip':
          return stageZip(input.fileName, input.data)
        case 'npm':
          return stageNpm(input.spec)
        case 'url':
          return stageUrl(input.url, input.integrity)
        case 'path':
          return stageFolder(input.path, input.mode)
      }
    })
  }

  async function discard(staged: StagedPlugin): Promise<void> {
    if (staged.staging === null)
      return
    const dir = staged.staging
    staged.staging = null
    await staging.remove(dir).catch(error => deps.logger.warn('cannot remove a plugin staging directory', { dir, err: error }))
  }

  // ---------- 2. examine ----------

  async function existingPlugin(id: string): Promise<ExistingPlugin | null> {
    const record = await deps.plugins.record(id)
    if (record === null)
      return null
    return { version: record.version, state: deps.plugins.state(id) ?? 'disabled', source: record.source }
  }

  async function examine(staged: StagedPlugin, purpose: Purpose): Promise<{ inspection: PluginInspection, directory: PluginDirectoryInspection }> {
    const directory = await deps.plugins.inspectDirectory(staged.dir)
    const { manifest } = directory
    if (directory.reserved) {
      const message = `The plugin id "${manifest.id}" is reserved (core-*, mock and builtin provider ids).`
      throw purpose === 'install' ? new HarnessError({ code: 'forbidden', message }) : invalid(message, ['manifest', 'id'])
    }
    if (staged.source === 'link' && basename(staged.dir) !== manifest.id)
      throw invalid(`A linked folder must be named after its plugin id: rename "${basename(staged.dir)}" to "${manifest.id}".`, ['path'])
    const existing = await existingPlugin(manifest.id)
    const inspection = buildInspection({ directory, source: staged.source, existing, notes: staged.notes })
    if (purpose === 'install') {
      if (!directory.compatible)
        throw invalid(`This plugin needs plugin API ${manifest.engines.harness}; this server provides ${PLUGIN_API_VERSION}.`, ['manifest', 'engines', 'harness'])
      if (existing !== null && existing.source !== staged.source)
        throw conflict(`The plugin "${manifest.id}" is installed from ${sourceLabel(existing.source)}; uninstall it before installing it from ${sourceLabel(staged.source)}.`)
    }
    return { inspection, directory }
  }

  // ---------- 3. commit ----------

  /** Removes `plugins/<id>` (only that directory, never through a link). */
  async function removeInstalled(target: string): Promise<void> {
    if (!isInside(paths.plugins, target))
      return
    const info = await lstat(target).catch(() => null)
    if (info === null)
      return
    await rm(target, { recursive: !info.isSymbolicLink(), force: true })
  }

  interface Rollback {
    id: string
    /** `plugins/<id>` holding the new version (staged sources). */
    target: string | null
    /** The previous version moved aside. */
    prevDir: string | null
    previous: PluginRecord | null
  }

  /** Puts the previous version (files and row) back, or forgets a fresh install. Never throws. */
  async function rollback({ id, target, prevDir, previous }: Rollback): Promise<void> {
    const host = deps.plugins
    try {
      await host.unload(id)
      if (target !== null)
        await removeInstalled(target)
      if (target !== null && prevDir !== null)
        await rename(prevDir, target)
      const record = previous === null ? null : restoredRecord(previous)
      if (record === null) {
        await host.forget(id)
        return
      }
      await host.saveRecord(record)
      await host.load(id)
      host.log(id, 'warn', 'The update failed to load: the previous version was restored.')
    }
    catch (error) {
      deps.logger.error('plugin install rollback failed', { pluginId: id, err: error })
    }
  }

  function recordInput(staged: StagedPlugin, directory: PluginDirectoryInspection, previous: PluginRecord | null, options: PluginInstallOptions): PluginRecordInput {
    const pin = staged.source === 'link' ? pathPin(staged.dir) : directory.sha256
    const input: PluginRecordInput = {
      id: directory.manifest.id,
      source: staged.source,
      sourceRef: staged.sourceRef,
      version: directory.manifest.version,
    }
    // A fresh install is enabled unless asked otherwise; an update keeps the user's choice unless `enable` is given.
    const enabled = options.enable ?? (previous === null ? true : undefined)
    if (enabled !== undefined)
      input.enabled = enabled
    // Without `trust` an update keeps the old pin: changed files then leave the plugin `untrusted` until trusted.
    if (options.trust === true && directory.requiresTrust)
      input.trustedHash = pin
    return input
  }

  async function finish(id: string, staged: StagedPlugin, detail: PluginDetail): Promise<PluginDetail> {
    deps.logger.info('plugin installed', { pluginId: id, source: staged.source, version: detail.version, state: detail.state })
    deps.plugins.log(id, 'info', `Installed version ${detail.version} from ${sourceLabel(staged.source)} (${staged.sourceRef}).`)
    return detail
  }

  async function commitStaged(staged: StagedPlugin, directory: PluginDirectoryInspection, options: PluginInstallOptions): Promise<PluginDetail> {
    const host = deps.plugins
    const id = directory.manifest.id
    const target = join(paths.plugins, id)
    const previous = await host.record(id)
    if (previous !== null && previous.source !== staged.source)
      throw conflict(`The plugin "${id}" is installed from ${sourceLabel(previous.source)}; uninstall it first.`)
    const targetExists = await exists(target)
    if (previous === null && targetExists)
      throw conflict(`A folder named "${id}" already exists in the plugins directory.`)

    let prevDir: string | null = null
    if (targetExists) {
      await host.unload(id)
      prevDir = staging.prevPath(id)
      await rename(target, prevDir)
    }
    try {
      await rename(staged.dir, target)
    }
    catch (error) {
      if (prevDir !== null) {
        await rename(prevDir, target).catch(() => {})
        await host.load(id).catch(() => {})
      }
      throw error
    }
    staged.staging = null

    try {
      await host.saveRecord(recordInput(staged, directory, previous, options))
      const detail = await host.load(id)
      if (detail.state === 'error')
        throw loadFailure(id, detail)
      if (prevDir !== null)
        await staging.remove(prevDir).catch(error => deps.logger.warn('cannot remove a replaced plugin version', { pluginId: id, err: error }))
      return finish(id, staged, detail)
    }
    catch (error) {
      await rollback({ id, target, prevDir, previous })
      throw error
    }
  }

  async function commitLink(staged: StagedPlugin, directory: PluginDirectoryInspection, options: PluginInstallOptions): Promise<PluginDetail> {
    const host = deps.plugins
    const id = directory.manifest.id
    const previous = await host.record(id)
    if (previous !== null && previous.source !== 'link')
      throw conflict(`The plugin "${id}" is installed from ${sourceLabel(previous.source)}; uninstall it first.`)
    if (previous === null && await exists(join(paths.plugins, id)))
      throw conflict(`A folder named "${id}" already exists in the plugins directory.`)
    await host.unload(id)
    try {
      await host.saveRecord(recordInput(staged, directory, previous, options))
      const detail = await host.load(id)
      if (detail.state === 'error')
        throw loadFailure(id, detail)
      return finish(id, staged, detail)
    }
    catch (error) {
      await rollback({ id, target: null, prevDir: null, previous })
      throw error
    }
  }

  // ---------- service ----------

  return {
    recover: () => staging.recover(),

    inspect: async (input) => {
      const staged = await stage(input)
      try {
        const { inspection } = await examine(staged, 'inspect')
        reviews.remember(input, inspection.sha256)
        return inspection
      }
      finally {
        await discard(staged)
      }
    },

    install: async (input, options) => {
      const staged = await stage(input)
      try {
        const { inspection, directory } = await examine(staged, 'install')
        // What the user reviewed is what gets installed (and trusted): a moved npm tag or changed folder is refused.
        reviews.check(input, inspection.sha256)
        options.authorize(inspection)
        const detail = await commitLock(() => staged.source === 'link'
          ? commitLink(staged, directory, options)
          : commitStaged(staged, directory, options))
        reviews.forget(input)
        return detail
      }
      finally {
        await discard(staged)
      }
    },

    export: async (id) => {
      const detail = await deps.plugins.get(id)
      if (detail.builtin)
        throw new HarnessError({ code: 'forbidden', message: 'Builtin plugins cannot be exported.' })
      const dir = await deps.plugins.directory(id)
      if (dir === null)
        throw new HarnessError({ code: 'not_found', message: `The files of the plugin "${id}" are missing.` })
      return exportPluginDirectory(id, detail.version, dir, limits)
    },
  }
}

/** The production installer (`deps.installer`): npm over `fetch`, URL installs over the SSRF-guarded `safeFetch`. */
export function createPluginInstaller(deps: AppDeps): PluginInstaller {
  return createInstaller(deps)
}
