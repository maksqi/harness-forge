// Plugin installer (PLUGINS.md 12-13, ARCHITECTURE.md 6.5, API.md 5.16). Owner: W3.2; Phase 12: W12.2.
//
// inspect / install share one pipeline:
//   1. stage   - zip upload, npm tarball (sha512-verified), URL download (SSRF-guarded, SRI-verified) or copied folder
//                -> `data/plugins/.staging/<uuid>` with every archive guard (archive.ts, zip.ts, tar.ts, folder.ts);
//                a linked folder is used in place (realpath outside the data directory). Phase 12 (ADR-053 / ADR-054):
//                the GitHub source (`github.ts`: the zip of the resolved commit, only the chosen folder) and the
//                marketplace source (`marketplaces/sources.ts`: the entry's subtree of the stored commit, its folder,
//                its GitHub repository, its archive or its npm package); the plugin's format and root come from
//                `layout.ts` (`detectPluginLayout`, or the request's `format`); a Claude Code plugin keeps its owner
//                exec bits (0755 / 0644), a harness plugin stays 0644.
//   2. examine - the host validates the directory (`PluginHost.inspectDirectory`: manifest, entry / icon inside the
//                directory, trust hash; Phase 12: `{ format: 'claude', overlay, nameHint, versionHint }` reads a Claude
//                Code plugin and hashes its whole tree) -> `PluginInspection` (inspection.ts). Reserved ids,
//                incompatible plugins and an id installed from another source, format or origin are refused at
//                install time (409 `exists`).
//   3. install only: the package must be the one the user reviewed (the request's `sha256`, else a recent inspection
//                of the same npm spec / folder / GitHub ref / marketplace entry; `409 conflict` `stale` otherwise,
//                reviews.ts), then `authorize(inspection)` (the route requires fresh auth when the plugin requires
//                trust), then an atomic swap under a mutex: the installed version moves to `.staging/<id>.prev-<uuid>`,
//                the staged directory is renamed to `plugins/<id>`, the row is saved (`trusted_hash` only with `trust`;
//                Phase 12: `format` and `origin`; a fresh Claude Code plugin with `defaultEnabled: false` is saved
//                disabled unless the request sets `enable`), the host loads it; a load that ends in `error` restores the
//                previous version (or forgets a fresh install).
// `HF_OFFLINE=1` refuses the GitHub source and marketplace entries that need the network (409 `offline`); a relative
// entry of a folder marketplace, npm and URL installs are unchanged. The staging directory is removed in every case;
// `recover()` cleans up after a crash (staging.ts). Logs carry the plugin id, the source, the version and the state.
import type { PluginDetail, PluginFormat, PluginInspection, PluginSource } from '@harness-forge/shared'
import type { SafeFetch } from '../../security/types.ts'
import type { AppDeps } from '../../types.ts'
import type { EntryStaging } from '../marketplaces/sources.ts'
import type {
  ClaudeEntryOverlay,
  InspectDirectoryOptions,
  PluginDirectoryInspection,
  PluginInstaller,
  PluginInstallInput,
  PluginInstallOptions,
  PluginRecord,
  PluginRecordInput,
  StoredPluginOrigin,
} from '../types.ts'
import type { ArchiveEntry } from './archive.ts'
import type { InstallLimits, IssuePath } from './errors.ts'
import type { ExistingPlugin, InstallSourceKind } from './inspection.ts'
import { createHash } from 'node:crypto'
import { lstat, readdir, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { PLUGIN_API_VERSION } from '@harness-forge/plugin-sdk'
import { HarnessError, isHarnessError } from '@harness-forge/shared'
import { safeFetch as defaultSafeFetch, testRemoteUrlFor } from '../../security/ssrf.ts'
import { sanitizeFileName } from '../../services/files/names.ts'
import { detectPluginLayout } from '../claude/detect.ts'
import { isInside, pathPin } from '../loader.ts'
import { resolveHostFolder } from '../marketplaces/fetch.ts'
import { githubBases, shortSha } from '../marketplaces/github.ts'
import { planEntryInstall } from '../marketplaces/sources.ts'
import { createMarketplaceStore } from '../marketplaces/store.ts'
import { EntryCollector, MANIFEST_NAME, verifyTree, writeEntries } from './archive.ts'
import { claudeDefaultEnabled } from './claude.ts'
import { INSTALL_LIMITS, invalid, megabytes, quoteName, tooLarge, upstreamError } from './errors.ts'
import { exportPluginDirectory } from './export.ts'
import { checkLinkableFolder, readFolder, resolveLocalFolder, SKIPPED_FOLDERS } from './folder.ts'
import { downloadGithubArchive, githubSourceRef } from './github.ts'
import { buildInspection, sourceLabel } from './inspection.ts'
import { layoutOf } from './layout.ts'
import { createMutex, createSemaphore } from './lock.ts'
import { downloadNpmPackage, NPM_REGISTRY_URL } from './npm.ts'
import { checkReviewedHash, createReviewLog, reviewedHashOf } from './reviews.ts'
import { createStagingArea } from './staging.ts'
import { looksLikeGzip, readTarGz } from './tar.ts'
import { downloadFromUrl } from './url.ts'
import { looksLikeZip, readZip } from './zip.ts'

/** Staging operations (downloads and extraction in memory) running at the same time. */
const MAX_CONCURRENT_STAGING = 2
/** Timeout and redirects of a marketplace archive download. */
const ARCHIVE_TIMEOUT_MS = 60_000
const ARCHIVE_MAX_REDIRECTS = 3
/** Entries listed (and folder levels walked) to detect the layout of a linked folder. */
const LINK_SCAN_ENTRIES = 2000
const LINK_SCAN_DEPTH = 3

export interface InstallerOptions {
  /** Fetch of the npm source (default `globalThis.fetch`; tests pass a fake registry). */
  fetch?: typeof globalThis.fetch
  /**
   * SSRF-guarded fetch of URL installs (default `security/ssrf.ts`); Phase 12: also of the `github` and `marketplace`
   * sources (production: the plugin-source fetch of `deps.ts`, `createPluginSourceFetch`; tests: `createFakeSafeFetch`).
   */
  safeFetch?: SafeFetch
  /**
   * npm registry base URL (default `https://registry.npmjs.org`; Phase 12: with the test-only `HF_TEST_REMOTE_URL`, the
   * registry behind the loopback test remote, `<base>/registry.npmjs.org`).
   */
  npmRegistry?: string
  /** Limit overrides (tests). */
  limits?: Partial<InstallLimits>
  /** Phase 12 (C43): base URL of the GitHub API (tests; default `GITHUB_API_BASE` of `plugins/marketplaces/types.ts`). */
  githubApi?: string
  /** Phase 12: base URL of raw GitHub files (tests; default `GITHUB_RAW_BASE`). */
  githubRaw?: string
  /** Phase 12: base URL of GitHub repository zips (tests; default `GITHUB_CODELOAD_BASE`). */
  githubCodeload?: string
  /** Phase 12: compressed bytes of a GitHub repository zip (tests; default `LIMITS.repoArchiveBytes`). */
  repoArchiveBytes?: number
}

/** `PluginInstallInput` with the `format` a multipart zip request may carry (local adapter; see the W12.2 CCR). */
export type PluginInstallRequestInput = PluginInstallInput & { format?: PluginFormat }

/** The `inspectDirectory` options of a staged Claude Code plugin. */
type ClaudeReadOptions = Pick<InspectDirectoryOptions, 'overlay' | 'nameHint' | 'versionHint'>

/** A plugin ready to be examined: a staging directory, or a linked folder used in place. */
interface StagedPlugin {
  source: InstallSourceKind
  /** The record's `sourceRef`: npm `name@version`, URL, folder realpath, zip file name; `owner/repo@<sha12>[/path]`, `<plugin>@<marketplace>`. */
  sourceRef: string
  /** What the review shows ("I trust <source>"; the resolved source of a marketplace entry). */
  displayRef: string
  /** The plugin directory (`.staging/<uuid>` or the linked folder's realpath). */
  dir: string
  /** Staging directory to delete afterwards; null for links and after the directory was moved into place. */
  staging: string | null
  /** Notes of the source for the inspection warnings. */
  notes: string[]
  /** The layout found (or requested). */
  format: PluginFormat
  /** Where a GitHub or marketplace install comes from (with the entry overlay for a Claude Code plugin). */
  origin: StoredPluginOrigin | null
  /** Compared with the installed record of the same id (`originKeyOf`). */
  originKey: string
  /** How a Claude Code plugin is read. */
  read: ClaudeReadOptions
}

/** What `materialize` needs besides the entries. */
interface StageInit {
  source: InstallSourceKind
  sourceRef: string
  displayRef?: string
  notes?: string[]
  issuePath: IssuePath
  /** The requested format (absent = detected). */
  format?: PluginFormat | undefined
  /** Only this archive prefix is the plugin's folder (a repository zip's subtree). */
  base?: string
  /** The plugin must sit at the root of `base` (copied folders). */
  rootOnly?: boolean
  origin?: StoredPluginOrigin | null
  /** The entry overlay (kept only for the Claude Code format). */
  overlay?: ClaudeEntryOverlay
  /** The name a Claude Code plugin's id is derived from when it has none (wins over the plugin folder's name). */
  nameHint?: string
  /** Used when neither `nameHint` nor a plugin folder name exists (a zip file's or URL's stem). */
  fallbackHint?: string
  versionHint?: string
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

/** `409 conflict` (`offline`): `HF_OFFLINE=1` refuses sources that need the network (ADR-054). */
function offlineError(what: string): HarnessError {
  return new HarnessError({
    code: 'conflict',
    message: `This server is offline (HF_OFFLINE=1): ${what} cannot be downloaded. Folder marketplaces, npm and URL installs still work.`,
    details: { reason: 'offline' },
  })
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
    format: record.format,
    origin: record.origin,
  }
}

/** The format a request asked for (`format?` of every source; a multipart zip carries it as a form field). */
export function requestedFormat(input: PluginInstallInput): PluginFormat | undefined {
  const format = (input as { format?: unknown }).format
  return format === 'harness' || format === 'claude' ? format : undefined
}

/**
 * The identity of where a plugin comes from, compared before an update: the source, plus the repository folder of a
 * GitHub install or the marketplace (by name: an origin keeps it after the marketplace was removed) and entry.
 */
export function originKeyOf(source: PluginSource, origin: StoredPluginOrigin | null): string {
  if (origin?.kind === 'marketplace')
    return `marketplace:${origin.marketplace.toLowerCase()}/${origin.plugin}`
  if (origin?.kind === 'github')
    return `github:${origin.repo.toLowerCase()}/${origin.path ?? ''}`
  return `source:${source}`
}

/** "the GitHub repository acme/tools (folder x)", "the marketplace entry x of y", "a zip upload". */
function originLabel(source: PluginSource, origin: StoredPluginOrigin | null): string {
  if (origin?.kind === 'marketplace')
    return `the entry "${origin.plugin}" of the marketplace "${origin.marketplace}"`
  if (origin?.kind === 'github')
    return `the GitHub repository ${origin.repo}${origin.path === null ? '' : ` (folder ${origin.path})`}`
  return sourceLabel(source)
}

function formatLabel(format: PluginFormat): string {
  return format === 'claude' ? 'Claude Code plugin' : 'harness-forge plugin'
}

/** Why the installed `record` blocks installing `staged` under the same id (null = an install updates it). */
function conflictOf(record: PluginRecord, staged: StagedPlugin, format: PluginFormat, id: string): string | null {
  if (record.source !== staged.source)
    return `The plugin "${id}" is installed from ${sourceLabel(record.source)}; uninstall it before installing it from ${sourceLabel(staged.source)}.`
  if (record.format !== format)
    return `The plugin "${id}" is installed as a ${formatLabel(record.format)}; uninstall it before installing this ${formatLabel(format)}.`
  if (originKeyOf(record.source, record.origin) !== staged.originKey)
    return `The plugin "${id}" is installed from ${originLabel(record.source, record.origin)}; uninstall it before installing it from ${originLabel(staged.source, staged.origin)}.`
  return null
}

/** The last segment of a POSIX path (`plugins/x` → `x`), or undefined. */
function lastSegment(path: string | undefined): string | undefined {
  if (path === undefined)
    return undefined
  const segment = path.replace(/\/+$/, '').split('/').pop()
  return segment === undefined || segment === '' || segment === '.' ? undefined : segment
}

/** A file name or URL path without its archive extension (`acme-1.0.0.zip` → `acme-1.0.0`). */
function stemOf(name: string): string | undefined {
  const stem = name.replace(/\.(?:zip|tgz|tar\.gz)$/i, '')
  return stem === '' ? undefined : stem
}

/** The unscoped name of an npm package (`@acme/x` → `x`). */
function npmHint(name: string): string {
  return name.split('/').pop() ?? name
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** The installer with injectable network access (tests). `createPluginInstaller` is the production factory. */
export function createInstaller(deps: AppDeps, options: InstallerOptions = {}): PluginInstaller {
  const limits: InstallLimits = { ...INSTALL_LIMITS, ...options.limits }
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const safeFetch = options.safeFetch ?? defaultSafeFetch
  // The test-only `HF_TEST_REMOTE_URL` (honored only with `HF_MOCK_PROVIDER=1`) also serves the npm registry.
  const testRemote = deps.env.testRemoteUrl ?? null
  const registry = options.npmRegistry ?? (testRemote === null ? NPM_REGISTRY_URL : testRemoteUrlFor(testRemote, NPM_REGISTRY_URL))
  const bases = githubBases(options)
  const paths = deps.env.paths
  const staging = createStagingArea({ pluginsDir: paths.plugins, stagingDir: paths.pluginStaging, logger: deps.logger })
  const commitLock = createMutex()
  const stagingSlots = createSemaphore(MAX_CONCURRENT_STAGING)
  const reviews = createReviewLog()
  const marketplaces = createMarketplaceStore(deps.db)

  // ---------- 1. stage ----------

  /**
   * Finds the plugin in the admitted entries (`layout.ts`), writes it into a fresh staging directory (exec bits kept for
   * the Claude Code format) and verifies the tree.
   */
  async function materialize(entries: ArchiveEntry[], init: StageInit): Promise<StagedPlugin> {
    const base = init.base ?? ''
    const layout = layoutOf(entries, { ...(init.format === undefined ? {} : { format: init.format }), base, issuePath: init.issuePath })
    if (init.rootOnly === true && layout.prefix !== base) {
      throw invalid(layout.format === 'claude'
        ? 'The folder holds its Claude Code plugin in a subfolder: choose that folder.'
        : `The folder has no ${MANIFEST_NAME} at its top level.`, init.issuePath)
    }
    const preserveExec = layout.format === 'claude'
    const dir = await staging.create()
    try {
      await writeEntries(dir, entries, layout.prefix, { preserveExec })
      await verifyTree(dir, limits, { preserveExec })
    }
    catch (error) {
      await staging.remove(dir).catch(() => {})
      throw error
    }
    const folder = lastSegment(layout.prefix.slice(base.length))
    const nameHint = init.nameHint ?? folder ?? init.fallbackHint
    const claude = layout.format === 'claude'
    let origin = init.origin ?? null
    if (claude && origin?.kind === 'marketplace' && init.overlay !== undefined)
      origin = { ...origin, overlay: init.overlay }
    return {
      source: init.source,
      sourceRef: init.sourceRef,
      displayRef: init.displayRef ?? init.sourceRef,
      dir,
      staging: dir,
      notes: init.notes ?? [],
      format: layout.format,
      origin,
      originKey: originKeyOf(init.source, origin),
      read: claude
        ? {
            ...(init.overlay === undefined ? {} : { overlay: init.overlay }),
            ...(nameHint === undefined ? {} : { nameHint }),
            ...(init.versionHint === undefined ? {} : { versionHint: init.versionHint }),
          }
        : {},
    }
  }

  async function stageZip(fileName: string, data: Uint8Array, format: PluginFormat | undefined): Promise<StagedPlugin> {
    if (data.byteLength > limits.compressedBytes)
      throw tooLarge(`The zip is larger than ${megabytes(limits.compressedBytes)}.`, limits.compressedBytes)
    const entries = await readZip(data, new EntryCollector(limits, ['file']))
    const name = sanitizeFileName(fileName, 'application/zip')
    const fallbackHint = stemOf(name)
    return materialize(entries, { source: 'zip', sourceRef: name, issuePath: ['file'], format, ...(fallbackHint === undefined ? {} : { fallbackHint }) })
  }

  async function downloadNpm(spec: string): Promise<{ entries: ArchiveEntry[], name: string, version: string, warnings: string[] }> {
    const { resolution, tarball } = await downloadNpmPackage(spec, { fetch: fetchImpl, registry, limits })
    const entries = await readTarGz(tarball, new EntryCollector(limits, ['spec']), limits, ['spec'])
    return { entries, name: resolution.name, version: resolution.version, warnings: resolution.warnings }
  }

  async function stageNpm(spec: string, format: PluginFormat | undefined): Promise<StagedPlugin> {
    const npm = await downloadNpm(spec)
    return materialize(npm.entries, {
      source: 'npm',
      sourceRef: `${npm.name}@${npm.version}`,
      notes: npm.warnings,
      issuePath: ['spec'],
      format,
      nameHint: npmHint(npm.name),
      versionHint: npm.version,
    })
  }

  async function stageUrl(url: string, integrity: string, format: PluginFormat | undefined): Promise<StagedPlugin> {
    const download = await downloadFromUrl(url, integrity, safeFetch, limits)
    const collector = new EntryCollector(limits, ['url'])
    const entries = download.format === 'zip'
      ? await readZip(download.data, collector)
      : await readTarGz(download.data, collector, limits, ['url'])
    const fallbackHint = stemOf(lastSegment(new URL(url).pathname) ?? '')
    return materialize(entries, { source: 'url', sourceRef: url, issuePath: ['url'], format, ...(fallbackHint === undefined ? {} : { fallbackHint }) })
  }

  /** The relative paths of a linked folder (bounded, without following links) for the layout detection. */
  async function linkedPaths(root: string): Promise<string[]> {
    const found: string[] = []
    const walk = async (dir: string, relative: string, depth: number): Promise<void> => {
      for (const name of (await readdir(dir)).sort()) {
        if (found.length >= LINK_SCAN_ENTRIES)
          return
        const info = await lstat(join(dir, name)).catch(() => null)
        if (info === null || info.isSymbolicLink())
          continue
        const path = relative === '' ? name : `${relative}/${name}`
        if (info.isDirectory()) {
          if (SKIPPED_FOLDERS.has(name))
            continue
          found.push(`${path}/`)
          if (depth < LINK_SCAN_DEPTH)
            await walk(join(dir, name), path, depth + 1)
        }
        else if (info.isFile()) {
          found.push(path)
        }
      }
    }
    await walk(root, '', 1)
    return found
  }

  async function stageFolder(path: string, mode: 'link' | 'copy', format: PluginFormat | undefined): Promise<StagedPlugin> {
    const real = await resolveLocalFolder(path, paths.root)
    if (mode === 'link') {
      await checkLinkableFolder(real)
      const detected = detectPluginLayout(await linkedPaths(real))
      const linkedFormat = format ?? detected?.format
      if (linkedFormat === undefined || (format === undefined && detected?.prefix !== ''))
        throw invalid(`The folder has no ${MANIFEST_NAME} (or Claude Code plugin layout) at its top level.`, ['path'])
      return {
        source: 'link',
        sourceRef: real,
        displayRef: real,
        dir: real,
        staging: null,
        notes: [],
        format: linkedFormat,
        origin: null,
        originKey: originKeyOf('link', null),
        read: linkedFormat === 'claude' ? { nameHint: basename(real) } : {},
      }
    }
    const entries = await readFolder(real, new EntryCollector(limits, ['path']))
    return materialize(entries, { source: 'copy', sourceRef: real, issuePath: ['path'], format, rootOnly: true, nameHint: basename(real) })
  }

  async function stageGithub(input: Extract<PluginInstallInput, { source: 'github' }>): Promise<StagedPlugin> {
    if (deps.env.offline)
      throw offlineError(`the GitHub repository ${input.repo}`)
    const archive = await downloadGithubArchive(
      { repo: input.repo, ...(input.ref === undefined ? {} : { ref: input.ref }), ...(input.path === undefined ? {} : { path: input.path }) },
      { safeFetch, bases, limits, ...(options.repoArchiveBytes === undefined ? {} : { archiveBytes: options.repoArchiveBytes }), issuePath: ['repo'] },
    )
    const sourceRef = githubSourceRef(input.repo, archive.sha, input.path)
    const repoName = input.repo.split('/')[1] ?? input.repo
    return materialize(archive.entries, {
      source: 'github',
      sourceRef,
      notes: archive.fallback ? [`GitHub's API limit was reached: the commit ${shortSha(archive.sha)} was read from the archive of ${input.ref ?? 'the default branch'}.`] : [],
      issuePath: ['repo'],
      format: requestedFormat(input),
      base: archive.subtree,
      origin: { kind: 'github', repo: input.repo, ref: input.ref ?? null, commit: archive.sha, path: input.path ?? null },
      nameHint: lastSegment(input.path) ?? repoName,
      versionHint: shortSha(archive.sha),
    })
  }

  /** Downloads a marketplace `archive` entry (https, SSRF-guarded) and checks its sha256 when the entry pins one. */
  async function downloadArchiveEntry(url: string, expected: string | undefined): Promise<{ entries: ArchiveEntry[], sha256: string }> {
    let response
    try {
      response = await safeFetch(url, {
        maxBytes: limits.compressedBytes,
        timeoutMs: ARCHIVE_TIMEOUT_MS,
        maxRedirects: ARCHIVE_MAX_REDIRECTS,
        protocols: ['https:'],
        method: 'GET',
        headers: { accept: 'application/zip, application/gzip, application/octet-stream;q=0.9, */*;q=0.5' },
      })
    }
    catch (error) {
      if (isHarnessError(error))
        throw error
      throw upstreamError('provider_unreachable', 'The archive download failed: network error.')
    }
    if (response.status === 404)
      throw upstreamError('not_found', 'The archive of the marketplace entry was not found.', 404)
    if (response.status !== 200)
      throw upstreamError('provider_error', `The archive download failed (HTTP ${response.status}).`, response.status)
    const sha256 = sha256Hex(response.body)
    if (expected !== undefined && expected !== sha256)
      throw invalid('The downloaded archive does not match the sha256 of the marketplace entry.', ['plugin'])
    const collector = new EntryCollector(limits, ['plugin'])
    if (looksLikeZip(response.body))
      return { entries: await readZip(response.body, collector), sha256 }
    if (looksLikeGzip(response.body))
      return { entries: await readTarGz(response.body, collector, limits, ['plugin']), sha256 }
    throw invalid('The archive of the marketplace entry is not a .zip or .tgz file.', ['plugin'])
  }

  /** A relative entry of a folder marketplace: its folder (inside the marketplace folder, no links on the way). */
  async function entryFolder(staging: Extract<EntryStaging, { kind: 'folder' }>): Promise<string> {
    const root = await resolveHostFolder(staging.root, paths.root)
    const folder = staging.path === '.' ? root : await resolveHostFolder(join(root, ...staging.path.split('/')), paths.root)
    if (folder !== root && !isInside(root, folder))
      throw invalid(`The plugin folder ${quoteName(staging.path)} leaves the marketplace folder.`, ['plugin'])
    return folder
  }

  async function stageMarketplace(input: Extract<PluginInstallInput, { source: 'marketplace' }>): Promise<StagedPlugin> {
    const plan = planEntryInstall(await marketplaces.get(input.marketplaceId), input.marketplaceId, input.plugin)
    const { marketplace, entry } = plan
    if (plan.needsNetwork && deps.env.offline)
      throw offlineError(`the plugin "${entry.name}" of the marketplace "${marketplace.name}"`)
    const origin: Extract<StoredPluginOrigin, { kind: 'marketplace' }> = {
      kind: 'marketplace',
      marketplaceId: marketplace.id,
      marketplace: marketplace.name,
      plugin: entry.name,
      sourceKind: entry.source.kind,
      version: entry.version ?? null,
    }
    const common = {
      source: 'marketplace' as const,
      sourceRef: `${entry.name}@${marketplace.name}`,
      issuePath: ['plugin'],
      format: requestedFormat(input),
      overlay: plan.overlay,
      nameHint: entry.name,
    }
    const staging = plan.staging
    switch (staging.kind) {
      case 'github': {
        const archive = await downloadGithubArchive(
          {
            repo: staging.repo,
            ...(staging.ref === undefined ? {} : { ref: staging.ref }),
            ...(staging.sha === undefined ? {} : { sha: staging.sha }),
            ...(staging.path === undefined ? {} : { path: staging.path }),
          },
          { safeFetch, bases, limits, ...(options.repoArchiveBytes === undefined ? {} : { archiveBytes: options.repoArchiveBytes }), issuePath: ['plugin'] },
        )
        return materialize(archive.entries, {
          ...common,
          displayRef: githubSourceRef(staging.repo, archive.sha, staging.path),
          base: archive.subtree,
          origin: { ...origin, commit: archive.sha, ...(staging.path === undefined ? {} : { path: staging.path }) },
          versionHint: shortSha(archive.sha),
        })
      }
      case 'folder': {
        const folder = await entryFolder(staging)
        const entries = await readFolder(folder, new EntryCollector(limits, ['plugin']))
        return materialize(entries, {
          ...common,
          displayRef: folder,
          origin: { ...origin, ...(staging.path === '.' ? {} : { path: staging.path }) },
        })
      }
      case 'archive': {
        const archive = await downloadArchiveEntry(staging.url, staging.sha256)
        return materialize(archive.entries, {
          ...common,
          displayRef: staging.url,
          origin: { ...origin, archiveSha256: archive.sha256 },
          versionHint: archive.sha256.slice(0, 12),
        })
      }
      case 'npm': {
        const npm = await downloadNpm(staging.spec)
        return materialize(npm.entries, {
          ...common,
          displayRef: `${npm.name}@${npm.version}`,
          notes: npm.warnings,
          origin: { ...origin, npmVersion: npm.version },
          versionHint: npm.version,
        })
      }
    }
  }

  function stage(input: PluginInstallInput): Promise<StagedPlugin> {
    return stagingSlots(async () => {
      const format = requestedFormat(input)
      switch (input.source) {
        case 'zip':
          return stageZip(input.fileName, input.data, format)
        case 'npm':
          return stageNpm(input.spec, format)
        case 'url':
          return stageUrl(input.url, input.integrity, format)
        case 'path':
          return stageFolder(input.path, input.mode, format)
        case 'github':
          return stageGithub(input)
        case 'marketplace':
          return stageMarketplace(input)
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

  interface Examined {
    inspection: PluginInspection
    directory: PluginDirectoryInspection
    /** A fresh Claude Code plugin with `defaultEnabled: false`. */
    installsDisabled: boolean
  }

  async function examine(staged: StagedPlugin, purpose: Purpose): Promise<Examined> {
    const directory = staged.format === 'claude'
      ? await deps.plugins.inspectDirectory(staged.dir, { format: 'claude', ...staged.read })
      : await deps.plugins.inspectDirectory(staged.dir)
    const { manifest } = directory
    if (directory.reserved) {
      const message = `The plugin id "${manifest.id}" is reserved (core-*, mock and builtin provider ids).`
      throw purpose === 'install' ? new HarnessError({ code: 'forbidden', message }) : invalid(message, ['manifest', 'id'])
    }
    if (staged.source === 'link' && basename(staged.dir) !== manifest.id)
      throw invalid(`A linked folder must be named after its plugin id: rename "${basename(staged.dir)}" to "${manifest.id}".`, ['path'])
    const record = await deps.plugins.record(manifest.id)
    const existing: ExistingPlugin | null = record === null ? null : { version: record.version, state: deps.plugins.state(manifest.id) ?? 'disabled', source: record.source }
    const blocked = record === null ? null : conflictOf(record, staged, directory.format, manifest.id)
    const installsDisabled = directory.format === 'claude' && !(await claudeDefaultEnabled(staged.dir, staged.read.overlay))
    const inspection = buildInspection({
      directory,
      source: staged.source,
      sourceRef: staged.displayRef,
      existing,
      notes: staged.notes,
      conflict: blocked,
      installsDisabled,
    })
    if (purpose === 'install') {
      if (!directory.compatible)
        throw invalid(`This plugin needs plugin API ${manifest.engines.harness}; this server provides ${PLUGIN_API_VERSION}.`, ['manifest', 'engines', 'harness'])
      if (blocked !== null)
        throw conflict(blocked)
    }
    return { inspection, directory, installsDisabled }
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

  function recordInput(staged: StagedPlugin, examined: Examined, previous: PluginRecord | null, options: PluginInstallOptions): PluginRecordInput {
    const { directory } = examined
    const pin = staged.source === 'link' ? pathPin(staged.dir) : directory.sha256
    const input: PluginRecordInput = {
      id: directory.manifest.id,
      source: staged.source,
      sourceRef: staged.sourceRef,
      version: directory.manifest.version,
      format: directory.format,
      origin: staged.origin,
    }
    // A fresh install is enabled unless asked otherwise (Phase 12: a Claude Code plugin with `defaultEnabled: false`
    // installs turned off); an update keeps the user's choice unless `enable` is given.
    const enabled = options.enable ?? (previous === null ? !examined.installsDisabled : undefined)
    if (enabled !== undefined)
      input.enabled = enabled
    // Without `trust` an update keeps the old pin: changed files then leave the plugin `untrusted` until trusted.
    if (options.trust === true && directory.requiresTrust)
      input.trustedHash = pin
    return input
  }

  async function finish(id: string, staged: StagedPlugin, detail: PluginDetail): Promise<PluginDetail> {
    deps.logger.info('plugin installed', { pluginId: id, source: staged.source, format: staged.format, version: detail.version, state: detail.state })
    deps.plugins.log(id, 'info', `Installed version ${detail.version} from ${sourceLabel(staged.source)} (${staged.sourceRef}).`)
    return detail
  }

  /** The existing row of `id` must be an update of the same source, format and origin (409 `exists` otherwise). */
  function checkPrevious(previous: PluginRecord | null, staged: StagedPlugin, examined: Examined, id: string): void {
    if (previous === null)
      return
    const blocked = conflictOf(previous, staged, examined.directory.format, id)
    if (blocked !== null)
      throw conflict(blocked)
  }

  async function commitStaged(staged: StagedPlugin, examined: Examined, options: PluginInstallOptions): Promise<PluginDetail> {
    const host = deps.plugins
    const id = examined.directory.manifest.id
    const target = join(paths.plugins, id)
    const previous = await host.record(id)
    checkPrevious(previous, staged, examined, id)
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
      await host.saveRecord(recordInput(staged, examined, previous, options))
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

  async function commitLink(staged: StagedPlugin, examined: Examined, options: PluginInstallOptions): Promise<PluginDetail> {
    const host = deps.plugins
    const id = examined.directory.manifest.id
    const previous = await host.record(id)
    checkPrevious(previous, staged, examined, id)
    if (previous === null && await exists(join(paths.plugins, id)))
      throw conflict(`A folder named "${id}" already exists in the plugins directory.`)
    await host.unload(id)
    try {
      await host.saveRecord(recordInput(staged, examined, previous, options))
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
        const examined = await examine(staged, 'install')
        const { inspection } = examined
        // What the user reviewed is what gets installed (and trusted): a moved npm tag, a changed folder or another
        // upload is refused. The hash sent with the request wins; the in-memory log covers clients that send none.
        const reviewed = reviewedHashOf(options)
        if (reviewed === undefined)
          reviews.check(input, inspection.sha256)
        else
          checkReviewedHash(reviewed, inspection.sha256)
        options.authorize(inspection)
        const detail = await commitLock(() => staged.source === 'link'
          ? commitLink(staged, examined, options)
          : commitStaged(staged, examined, options))
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
