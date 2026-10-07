// The project config reader (Phase 11, ADR-049 / ADR-050; ARCHITECTURE.md 6.29) behind `ProjectConfigService`
// (./types.ts). Owner: W11.3 (C36 landed the stub with the final factory signature).
//
// - `snapshot(projectId)`: resolves the project folder (`projectRoot`, below), then reads, lowest precedence first,
//   `.claude/settings.json`, `.claude/settings.local.json`, `.harness/settings.json`, `.harness/settings.local.json`
//   (only their `hooks` key, `readSettingsHooks`) and `.mcp.json` (`parseMcpJson`) at the project root, each through
//   the workspace guard (`refs.ts`: no link anywhere on the path, a regular file, at most 256 KiB before `JSON.parse`).
//   Every item gets its referenced script files hashed (`hashTrustRefs`, at most 8 files of at most 1 MiB; one read per
//   file and build) and its trust hash `sha256(trustHashInput(item))`, plus its review warnings (`warnings.ts`).
//   Identical hook items (the same hash) are listed once, in the first file; at most `LIMITS.projectHookItemsMax`.
//   Read problems are diagnostics with project-relative paths, never contents; nothing outside the folder is read.
// - Cache (`cache.ts`): 10 s, single flight, at most 50 projects. A project's snapshot is dropped on a
//   `workspace.changed` that touches a config file, `.claude/`, `.harness/` or a referenced file (or lists 200 paths),
//   on `project.changed` and on `run.finished` of one of its chats (shell writes emit no `workspace.changed`); a
//   dropped snapshot is rebuilt after `recheckDelayMs` (1 s) so a change is noticed without a consumer. The
//   subscriptions start with the first call. Phase 12: a file saved from the UI (`source: 'user'`) always announces the
//   new pending count (`onUserSave`; a save before the first read is announced by the `invalidate` W12.4 calls).
// - Phase 12 (ADR-057, W12.5): prompt handlers and the command fields `args` / `async` / `if` (`hook-items.ts`: trust
//   item v2, the script files of exec-form arguments as references; v1 items keep their bytes).
// - Changes: every build compares the item hashes with the previous build of the project; when they differ it emits
//   `project-trust.changed { projectId, pending }` (`projectTrust.pending`) and, when hook items changed,
//   `hooks.changed { projectId }` (coalesced per project). The project MCP manager and the hook service react to them.
// - `verify(projectId, item)`: verify-before-run. Resolves the project folder again, re-derives the referenced paths
//   from the item's own fields (a subject can never drop a file), re-hashes them and compares the trust hash; a
//   mismatch drops the snapshot and schedules a recheck (so the change is announced). False for an unknown or
//   unavailable project.
// - The project folder: the canonical root of the project row is kept per project after the first lookup
//   (`projects.get`: the same folder checks as `openWorkspace`, without reading `AGENTS.md` and without counting as a
//   workspace open of a run) and dropped on `project.changed`; every later use re-checks `realpath(root) === root` and
//   that it is a folder (a moved or deleted folder is looked up again), and every file read goes through
//   `resolveWorkspacePath`, which checks the root again. So a run's snapshot never opens the workspace: 0 opens warm,
//   0 opens cold (one `projects.get` per project until its `project.changed`).
// - Logging: ids, counts and durations only (never a command, a URL, a variable name or a file's content).
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { HookDiagnostic, McpConfigDiagnostic, ServerEvent } from '@harness-forge/shared'
import type { Logger } from '../../logger.ts'
import type { AppDeps } from '../../types.ts'
import type { OpenProjectFile, ProjectFileReadFailure } from './refs.ts'
import type { ProjectConfigItem, ProjectConfigService, ProjectConfigSnapshot, ProjectHookItem, ProjectMcpServerItem, TrustSubject } from './types.ts'
import { realpath, stat } from 'node:fs/promises'
import { isHarnessError, LIMITS, parseMcpJson, readSettingsHooks } from '@harness-forge/shared'
import { folderUnavailableMessage } from '../projects/index.ts'
import { createSnapshotCache } from './cache.ts'
import { hookHashItem, hookItemLabel, hookWarningCommands, itemSpec, mergeHookSpecs, settingsHookRefPaths } from './hook-items.ts'
import { hashTrustRefs, mcpRefPaths, readProjectConfigFile, refPathsOf, trustSha256 } from './refs.ts'
import { commandWarnings, mcpServerWarnings } from './warnings.ts'

export { hookItemRefPaths, mergeHookSpecs, projectPromptSpec } from './hook-items.ts'
export type { ProjectPromptHookSpec, SettingsHookSpec } from './hook-items.ts'
export {
  commandTrustRefPaths,
  commandTrustSubject,
  hashTrustRefs,
  hookRefPaths,
  mcpRefPaths,
  readProjectConfigFile,
  refPathsOf,
  trustSha256,
} from './refs.ts'
export type { HashTrustRefsOptions, OpenProjectFile } from './refs.ts'
export { commandRunsRepositoryCode, commandWarnings, mcpServerWarnings, urlIsPrivateNetwork } from './warnings.ts'

/** The settings files whose `hooks` key is read, lowest precedence first. */
export const PROJECT_SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json', '.harness/settings.json', '.harness/settings.local.json'] as const
/** The project's MCP server file (at the root only). */
export const PROJECT_MCP_FILE = '.mcp.json'
/** Lifetime of a cached snapshot (from the start of its build). */
export const PROJECT_CONFIG_TTL_MS = 10_000
/** Project snapshots cached at most. */
export const PROJECT_CONFIG_CACHE_PROJECTS_MAX = 50
/** Delay of the rebuild after a snapshot was dropped (coalesces bursts of events). */
export const PROJECT_CONFIG_RECHECK_DELAY_MS = 1000
/** Diagnostics kept per file kind (the hook list answers at most 100). */
const DIAGNOSTICS_MAX = 100
/** Projects whose last item hashes are remembered (to notice a change). */
const KNOWN_PROJECTS_MAX = 500
/** `issue` of an unavailable folder. */
const ISSUE_MAX_CHARS = 500
const LABEL_MAX_CHARS = 200
/** `issue` of a project that no longer exists (the `openWorkspace` text). */
const PROJECT_MISSING_MESSAGE = 'The project no longer exists.'
const CONFIG_PATHS: ReadonlySet<string> = new Set([...PROJECT_SETTINGS_FILES, PROJECT_MCP_FILE, '.claude', '.harness'])

/** A snapshot without items (a folder that opened but holds nothing executable, or one that did not open). */
export function emptyProjectConfigSnapshot(projectId: string, fields: Pick<ProjectConfigSnapshot, 'available' | 'issue' | 'root'>, scannedAt: number): ProjectConfigSnapshot {
  return Object.freeze({
    projectId,
    available: fields.available,
    issue: fields.issue,
    root: fields.root,
    settingsFiles: [],
    mcpFile: false,
    hooks: [],
    mcpServers: [],
    hookDiagnostics: [],
    mcpDiagnostics: [],
    scannedAt,
  })
}

/** Test options of the service (all optional). */
export interface ProjectConfigServiceOptions {
  /** The clock (epoch ms); default `Date.now` (read at every call, so fake timers apply). */
  readonly now?: () => number
  /** Lifetime of a cached snapshot; default `PROJECT_CONFIG_TTL_MS`. */
  readonly ttlMs?: number
  /** Projects cached at most; default `PROJECT_CONFIG_CACHE_PROJECTS_MAX`. */
  readonly maxProjects?: number
  /** Delay of the rebuild after a dropped snapshot; default `PROJECT_CONFIG_RECHECK_DELAY_MS`. */
  readonly recheckDelayMs?: number
  /** The opener of project files (default `openWorkspaceFile`; tests spy on it). */
  readonly openFile?: OpenProjectFile
}

const READ_FAILURE_TEXT: Readonly<Record<Exclude<ProjectFileReadFailure, 'missing' | 'too-large'>, string>> = {
  'link': 'is a symbolic link or inside a linked folder; it is not read',
  'not-file': 'is not a regular file; it is not read',
  'failed': 'could not be read',
}

function settingsReadDiagnostic(file: string, reason: Exclude<ProjectFileReadFailure, 'missing'>): HookDiagnostic {
  if (reason === 'too-large')
    return { level: 'error', code: 'too-large', message: `The settings file is larger than ${LIMITS.projectSettingsFileBytes / 1024} KB; its hooks are not read.`, file }
  return { level: 'error', code: 'not-an-object', message: `The settings file ${READ_FAILURE_TEXT[reason]}.`, file }
}

function mcpReadDiagnostic(reason: Exclude<ProjectFileReadFailure, 'missing'>): McpConfigDiagnostic {
  if (reason === 'too-large')
    return { level: 'error', code: 'too-large', message: `The file is larger than ${LIMITS.projectMcpFileBytes / 1024} KB; its servers are not read.` }
  return { level: 'error', code: 'not-an-object', message: `The file ${READ_FAILURE_TEXT[reason]}.` }
}

function pushCapped<T>(target: T[], entries: readonly T[]): void {
  for (const entry of entries) {
    if (target.length >= DIAGNOSTICS_MAX)
      return
    target.push(entry)
  }
}

/** The order-independent identity of a set of item hashes (and the folder state). */
function fingerprintOf(available: boolean, items: readonly ProjectConfigItem[]): string {
  return `${available ? 1 : 0}:${items.map(item => item.sha256).sort().join(',')}`
}

interface KnownState {
  readonly all: string
  readonly hooks: string
}

/** The project folder of a read. */
type ProjectRoot
  = | { readonly ok: true, readonly root: string }
    | { readonly ok: false, readonly message: string }

interface Announcement {
  hooks: boolean
  again: boolean
}

export function createProjectConfigService(deps: AppDeps, options: ProjectConfigServiceOptions = {}): ProjectConfigService {
  const now = options.now ?? (() => Date.now())
  const recheckDelayMs = options.recheckDelayMs ?? PROJECT_CONFIG_RECHECK_DELAY_MS
  let logger: Logger | undefined
  const log = (): Logger => (logger ??= deps.logger.child({ component: 'project-config' }))
  let stopped = false
  let subscription: Disposable | null = null
  /** The item hashes of the latest build per project (least recently built first). */
  const known = new Map<string, KnownState>()
  const rechecks = new Map<string, ReturnType<typeof setTimeout>>()
  const announcing = new Map<string, Announcement>()
  /** The canonical root of each project after its first lookup (dropped on `project.changed`). */
  const roots = new Map<string, string>()
  /** Phase 12: projects whose next build announces its pending count (a UI save, `announceSave`). */
  const saved = new Set<string>()

  // ---------- reads ----------

  /** True while `root` is still a canonical folder (not moved, not replaced by a link, not deleted). */
  async function stillThere(root: string): Promise<boolean> {
    try {
      return (await realpath(root)) === root && (await stat(root)).isDirectory()
    }
    catch {
      return false
    }
  }

  /** The project folder: the cached canonical root, else the project row checked by `projects.get`. */
  async function openProject(projectId: string): Promise<ProjectRoot> {
    const cached = roots.get(projectId)
    if (cached !== undefined) {
      if (await stillThere(cached))
        return { ok: true, root: cached }
      roots.delete(projectId)
    }
    try {
      const project = await deps.projects.get(projectId)
      if (!project.available)
        return { ok: false, message: folderUnavailableMessage(project.path, project.issue ?? 'it cannot be opened.') }
      if (!stopped) {
        roots.set(projectId, project.path)
        for (const key of roots.keys()) {
          if (roots.size <= KNOWN_PROJECTS_MAX)
            break
          roots.delete(key)
        }
      }
      return { ok: true, root: project.path }
    }
    catch (error) {
      if (isHarnessError(error) && error.code === 'not_found')
        return { ok: false, message: PROJECT_MISSING_MESSAGE }
      log().warn('project config: project not opened', { projectId, err: error })
      return { ok: false, message: 'The project folder could not be opened.' }
    }
  }

  async function readHooks(root: string, memo: Map<string, Promise<string | null>>): Promise<{ files: string[], items: ProjectHookItem[], diagnostics: HookDiagnostic[] }> {
    const files: string[] = []
    const items: ProjectHookItem[] = []
    const diagnostics: HookDiagnostic[] = []
    const seen = new Set<string>()
    let capped = false
    for (const file of PROJECT_SETTINGS_FILES) {
      const read = await readProjectConfigFile(root, file, LIMITS.projectSettingsFileBytes, options.openFile)
      if (!read.ok) {
        if (read.reason !== 'missing')
          pushCapped(diagnostics, [settingsReadDiagnostic(file, read.reason)])
        continue
      }
      files.push(file)
      // Phase 12 (ADR-057): prompt handlers too (trust item v2); every v1.7 command item keeps its hash and its order.
      const result = readSettingsHooks(read.text, { file, maxBytes: LIMITS.projectSettingsFileBytes, prompts: true })
      pushCapped(diagnostics, result.diagnostics)
      for (const entry of mergeHookSpecs(result.items, result.prompts)) {
        if (items.length >= LIMITS.projectHookItemsMax) {
          if (!capped) {
            capped = true
            pushCapped(diagnostics, [{ level: 'warning', code: 'too-many', message: `Only the first ${LIMITS.projectHookItemsMax} hooks of the project are used.`, file }])
          }
          break
        }
        const refs = await hashTrustRefs(root, settingsHookRefPaths(entry), { memo, openFile: options.openFile })
        const hashItem = hookHashItem(entry, refs)
        const sha256 = trustSha256(hashItem)
        if (seen.has(sha256))
          continue
        seen.add(sha256)
        items.push(Object.freeze({
          kind: 'hook',
          sha256,
          hashItem,
          spec: itemSpec(entry),
          path: file,
          label: hookItemLabel(entry, LABEL_MAX_CHARS),
          warnings: commandWarnings(hookWarningCommands(entry), refs),
        }))
      }
    }
    return { files, items, diagnostics }
  }

  async function readMcp(root: string, memo: Map<string, Promise<string | null>>): Promise<{ read: boolean, items: ProjectMcpServerItem[], diagnostics: McpConfigDiagnostic[] }> {
    const read = await readProjectConfigFile(root, PROJECT_MCP_FILE, LIMITS.projectMcpFileBytes, options.openFile)
    if (!read.ok)
      return { read: false, items: [], diagnostics: read.reason === 'missing' ? [] : [mcpReadDiagnostic(read.reason)] }
    const parsed = parseMcpJson(read.text, { maxBytes: LIMITS.projectMcpFileBytes })
    const diagnostics: McpConfigDiagnostic[] = []
    pushCapped(diagnostics, parsed.diagnostics)
    const items: ProjectMcpServerItem[] = []
    for (const server of parsed.servers.slice(0, LIMITS.projectMcpServersMax)) {
      const refs = await hashTrustRefs(root, mcpRefPaths(server.raw), { memo, openFile: options.openFile })
      const hashItem: ProjectMcpServerItem['hashItem'] = { kind: 'mcp', name: server.name, server: server.raw, refs }
      items.push(Object.freeze({
        kind: 'mcp',
        sha256: trustSha256(hashItem),
        hashItem,
        server,
        path: PROJECT_MCP_FILE,
        label: server.name.slice(0, LABEL_MAX_CHARS),
        warnings: mcpServerWarnings(server, refs),
      }))
    }
    return { read: true, items, diagnostics }
  }

  async function build(projectId: string): Promise<ProjectConfigSnapshot> {
    const scannedAt = now()
    const opened = await openProject(projectId)
    if (!opened.ok) {
      const snapshot = emptyProjectConfigSnapshot(projectId, { available: false, issue: opened.message.slice(0, ISSUE_MAX_CHARS), root: null }, scannedAt)
      remember(snapshot)
      return snapshot
    }
    const root = opened.root
    // One read per referenced file and build (hooks of several files often run the same script).
    const memo = new Map<string, Promise<string | null>>()
    const hooks = await readHooks(root, memo)
    const mcp = await readMcp(root, memo)
    const snapshot: ProjectConfigSnapshot = Object.freeze({
      projectId,
      available: true,
      issue: null,
      root,
      settingsFiles: Object.freeze(hooks.files),
      mcpFile: mcp.read,
      hooks: Object.freeze(hooks.items),
      mcpServers: Object.freeze(mcp.items),
      hookDiagnostics: Object.freeze(hooks.diagnostics),
      mcpDiagnostics: Object.freeze(mcp.diagnostics),
      scannedAt,
    })
    log().debug('project config read', {
      projectId,
      settingsFiles: snapshot.settingsFiles.length,
      hooks: snapshot.hooks.length,
      mcpServers: snapshot.mcpServers.length,
      diagnostics: snapshot.hookDiagnostics.length + snapshot.mcpDiagnostics.length,
      ms: now() - scannedAt,
    })
    remember(snapshot)
    return snapshot
  }

  const cache = createSnapshotCache<ProjectConfigSnapshot>({
    build,
    builtAt: snapshot => snapshot.scannedAt,
    ttlMs: options.ttlMs ?? PROJECT_CONFIG_TTL_MS,
    maxProjects: options.maxProjects ?? PROJECT_CONFIG_CACHE_PROJECTS_MAX,
    now,
  })

  // ---------- change announcements ----------

  function emit(event: 'project-trust.changed' | 'hooks.changed', data: { projectId: string, pending?: number }): void {
    if (stopped)
      return
    try {
      if (event === 'project-trust.changed')
        deps.events.emit(event, { projectId: data.projectId, pending: data.pending ?? 0 })
      else
        deps.events.emit(event, { projectId: data.projectId })
    }
    catch (error) {
      log().warn(`${event} not sent`, { projectId: data.projectId, err: error })
    }
  }

  /** Emits `project-trust.changed` (+ `hooks.changed`) for a project, coalescing calls while one is in flight. */
  function announce(projectId: string, hooksChanged: boolean): void {
    const running = announcing.get(projectId)
    if (running !== undefined) {
      running.hooks ||= hooksChanged
      running.again = true
      return
    }
    const state: Announcement = { hooks: hooksChanged, again: false }
    announcing.set(projectId, state)
    void (async () => {
      try {
        for (;;) {
          state.again = false
          const hooks = state.hooks
          state.hooks = false
          let pending = 0
          try {
            pending = await deps.projectTrust.pending(projectId)
          }
          catch (error) {
            log().debug('project config: pending count failed', { projectId, err: error })
          }
          emit('project-trust.changed', { projectId, pending })
          if (hooks)
            emit('hooks.changed', { projectId })
          // A change noticed while the count was computed is announced once more.
          if (!state.again || stopped)
            break
        }
      }
      finally {
        announcing.delete(projectId)
      }
    })()
  }

  /** Records the item hashes of a build; announces a change against the previous build of the project. */
  function remember(snapshot: ProjectConfigSnapshot): void {
    if (stopped)
      return
    const items: readonly ProjectConfigItem[] = [...snapshot.hooks, ...snapshot.mcpServers]
    const next: KnownState = { all: fingerprintOf(snapshot.available, items), hooks: fingerprintOf(snapshot.available, snapshot.hooks) }
    const previous = known.get(snapshot.projectId)
    known.delete(snapshot.projectId)
    known.set(snapshot.projectId, next)
    for (const key of known.keys()) {
      if (known.size <= KNOWN_PROJECTS_MAX)
        break
      known.delete(key)
    }
    // Phase 12: a UI save asked for an announcement of this build whatever it finds (`announceSave`).
    const forced = saved.delete(snapshot.projectId)
    if (forced || (previous !== undefined && previous.all !== next.all)) {
      const hooksChanged = previous === undefined || previous.hooks !== next.hooks
      log().debug('project config changed', { projectId: snapshot.projectId, hooks: hooksChanged, saved: forced })
      announce(snapshot.projectId, hooksChanged)
    }
  }

  /**
   * Phase 12 (ADR-056): a project file was saved from the UI. The next build of the project announces its pending count
   * (once, whether or not it differs from a build before); the build starts a microtask later (after the saving request
   * dropped the cache), joined by the request's own read of the pending count.
   */
  function announceSave(projectId: string): void {
    if (stopped)
      return
    saved.add(projectId)
    queueMicrotask(() => {
      if (stopped)
        return
      cache.get(projectId).catch((error: unknown) => {
        saved.delete(projectId)
        log().debug('project config: the read after a save failed', { projectId, err: error })
      })
    })
  }

  // ---------- invalidation ----------

  function scheduleRecheck(projectId: string): void {
    if (stopped || rechecks.has(projectId) || !known.has(projectId))
      return
    const timer = setTimeout(() => {
      rechecks.delete(projectId)
      if (stopped)
        return
      cache.get(projectId).catch((error: unknown) => log().debug('project config recheck failed', { projectId, err: error }))
    }, recheckDelayMs)
    timer.unref?.()
    rechecks.set(projectId, timer)
  }

  function invalidateProject(projectId: string): void {
    if (cache.invalidate(projectId))
      scheduleRecheck(projectId)
  }

  /** True when a `workspace.changed` may have touched a config file or a referenced file of the cached snapshot. */
  function touchesConfig(projectId: string, paths: readonly string[]): boolean {
    if (paths.length === 0 || paths.length >= LIMITS.workspaceEventPathsMax)
      return true
    const cached = cache.peek(projectId)
    const refs = new Set<string>()
    for (const item of [...(cached?.hooks ?? []), ...(cached?.mcpServers ?? [])]) {
      for (const ref of item.hashItem.refs)
        refs.add(ref.path)
    }
    return paths.some((path) => {
      const normalized = path.replace(/^(?:\.\/)+/, '')
      const lower = normalized.toLowerCase()
      return CONFIG_PATHS.has(lower) || lower.startsWith('.claude/') || lower.startsWith('.harness/') || refs.has(normalized)
    })
  }

  async function onRunFinished(chatId: string): Promise<void> {
    if (cache.projects().length === 0)
      return
    try {
      const chat = await deps.chats.find(chatId)
      if (chat !== null && chat.projectId !== null)
        invalidateProject(chat.projectId)
    }
    catch (error) {
      log().debug('project config: chat lookup failed', { chatId, err: error })
    }
  }

  function forget(projectId: string): void {
    cache.invalidate(projectId)
    known.delete(projectId)
    saved.delete(projectId)
    const timer = rechecks.get(projectId)
    if (timer !== undefined)
      clearTimeout(timer)
    rechecks.delete(projectId)
  }

  /**
   * Phase 12 (ADR-056): a project file saved from the UI (`workspace.changed { source: 'user' }`, W12.4) under
   * `.claude/`, `.harness/` or `.mcp.json`: the cached snapshot is dropped (also when there is none yet) and, once the
   * saving request went on (a microtask later), the new pending count is announced (`project-trust.changed`), whether
   * or not the project was read before: the trust chip and the review offer follow every save.
   */
  function onUserSave(projectId: string, paths: readonly string[]): void {
    // Only the config files and the folders of executable items (the referenced files of a cached snapshot too).
    if (!touchesConfig(projectId, paths))
      return
    cache.invalidate(projectId)
    announceSave(projectId)
  }

  function onEvent(event: ServerEvent): void {
    if (event.type === 'workspace.changed') {
      if (event.data.source === 'user')
        onUserSave(event.data.projectId, event.data.paths)
      else if (cache.peek(event.data.projectId) !== null && touchesConfig(event.data.projectId, event.data.paths))
        invalidateProject(event.data.projectId)
    }
    else if (event.type === 'project.changed') {
      // A moved or edited project: its folder is looked up again.
      roots.delete(event.data.id)
      if (event.data.project === null)
        forget(event.data.id)
      else
        invalidateProject(event.data.id)
    }
    else if (event.type === 'run.finished') {
      void onRunFinished(event.data.chatId)
    }
  }

  function subscribe(): void {
    if (stopped || subscription !== null)
      return
    subscription = deps.events.subscribe(onEvent)
  }

  // ---------- the service ----------

  return {
    snapshot: async (projectId, snapshotOptions = {}) => {
      snapshotOptions.signal?.throwIfAborted()
      if (stopped)
        return build(projectId)
      subscribe()
      return cache.get(projectId, snapshotOptions)
    },
    verify: async (projectId, item: TrustSubject, signal) => {
      signal?.throwIfAborted()
      subscribe()
      try {
        const opened = await openProject(projectId)
        signal?.throwIfAborted()
        if (!opened.ok || item.hashItem.kind !== item.kind)
          return false
        const refs = await hashTrustRefs(opened.root, refPathsOf(item.hashItem), { signal, openFile: options.openFile })
        const current = trustSha256({ ...item.hashItem, refs } as typeof item.hashItem)
        if (current === item.sha256)
          return true
        log().debug('project item changed since its scan', { projectId, kind: item.kind, sha256: item.sha256.slice(0, 12) })
        cache.invalidate(projectId)
        scheduleRecheck(projectId)
        return false
      }
      catch (error) {
        if (signal?.aborted === true)
          throw signal.reason
        log().debug('project item not verified', { projectId, err: error })
        return false
      }
    },
    invalidate: (projectId) => {
      // Phase 12: the first call before any read subscribes too. When it names a project, the change that caused it
      // (a UI save right after a start, W12.4: its `workspace.changed` came before the subscription) is announced.
      const first = subscription === null && !stopped
      subscribe()
      if (projectId === null) {
        cache.clear()
        return
      }
      if (first) {
        cache.invalidate(projectId)
        announceSave(projectId)
        return
      }
      invalidateProject(projectId)
    },
    stop: () => {
      if (stopped)
        return
      stopped = true
      cache.clear()
      known.clear()
      saved.clear()
      roots.clear()
      for (const timer of rechecks.values())
        clearTimeout(timer)
      rechecks.clear()
      subscription?.dispose()
      subscription = null
    },
  }
}
