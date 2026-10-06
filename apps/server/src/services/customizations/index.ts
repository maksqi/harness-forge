// The customization service (Phase 10, ADR-044 / ADR-045; ARCHITECTURE.md 6.23, 10.11; API.md 4.28 / 5.28) behind
// `CustomizationService` (./types.ts). Owner: W10.1 (C30 landed the stub, `snapshot.ts` and `builtins.ts`).
//
// - `catalog(projectId | null)`: the merged snapshot (`catalog.ts`) of the builtin agents, the plugin agents, skills and
//   commands of the registry (`plugins.ts`), the personal rows (`store.ts`) and, with a project, its `.claude` and
//   `.harness` definition files (`discover.ts`; the root comes from `projects.openWorkspace`, because commands are
//   resolved before a run opens its workspace; an unavailable folder or an unknown project gives no project entries and
//   the folder diagnostic `project-unavailable`, never an error). Cached per project (`cache.ts`: 10 s, single-flight,
//   at most `CUSTOMIZATION_CACHE_PROJECTS_MAX` projects); a failed build answers the builtins (not cached).
// - Invalidation: a project's catalog is dropped on `workspace.changed` that touches its definition folders (or lists
//   200 paths, possibly cut), on `project.changed` and when a run of one of its chats finishes (`run.finished`: shell
//   commands write without `workspace.changed`); every catalog is dropped on a registry change of agents, skills,
//   commands or (Phase 11) output styles and on every personal create / update / delete / restore. The subscriptions start with the first build.
// - `customization.changed`: `{ kind, id }` after every personal change, `{}` (coalesced, at most one per second) after
//   a registry change and a restore, `{ projectId }` (coalesced, at most one per second per project) when a cached
//   project catalog is dropped or a rebuild finds other files.
// - `load(entry)`: the body read and validated again (a project file through the discovery guards, ≤ 64 KiB, its name
//   must still match; a plugin definition from the registry; a personal one from the table; a builtin from
//   `core-agent`). `source(query)`: the markdown of a project, plugin or builtin entry.
// - Phase 11 (ADR-051, ADR-052; W11.6): the fourth kind `style` (output styles): the builtins `default` /
//   `explanatory` / `learning` (`builtins.ts`), the plugin styles of `registry.styles` (`plugins.ts`), personal rows and
//   the top-level files of `.claude/output-styles` and `.harness/output-styles` (8 project folders); a registry change of
//   styles drops every catalog like one of agents, skills or commands. Skill entries list `userInvocable` /
//   `modelInvocable` (the run's skills block, `loadSkill` and the slash commands read them).
// - Logging: ids, names, kinds, sources, counts and durations only; never a body, a file's content or a description.
import type { Disposable } from '@harness-forge/plugin-sdk'
import type {
  CustomizationChangedData,
  CustomizationEntry,
  CustomizationKind,
  CustomizationSourceQuery,
  CustomizationSourceResult,
  ServerEvent,
} from '@harness-forge/shared'
import type { Logger } from '../../logger.ts'
import type { RegistryChange } from '../../registry/types.ts'
import type { AppDeps } from '../../types.ts'
import type { OpenWorkspaceResult } from '../projects/types.ts'
import type { CatalogProjectPart } from './catalog.ts'
import type { OpenDefinitionFile } from './discover.ts'
import type { CatalogCheckContext } from './entries.ts'
import type { CustomizationCatalog, CustomizationService, LoadedDefinition } from './types.ts'
import {
  DEFINITION_FOLDERS,
  DEFINITION_LIMITS,
  formatDefinition,
  HarnessError,
  isHarnessError,
  LIMITS,
  parseDefinition,
  safeParseModelRef,
  validationError,
} from '@harness-forge/shared'
import { rejectsNotImplemented } from '../../not-implemented.ts'
import { builtinCatalogEntries, loadBuiltin } from './builtins.ts'
import { createCatalogCache, CUSTOMIZATION_CACHE_PROJECTS_MAX } from './cache.ts'
import { mergeCatalog, projectFingerprint } from './catalog.ts'
import { DEFINITION_KIND_FOLDERS, discoverProject, parseOptionsOf, PROJECT_DEFINITION_FOLDERS, readDefinitionFile, readFailureDiagnostic } from './discover.ts'
import { DIAGNOSTICS_MAX } from './entries.ts'
import { createCoalescedNotifier } from './notifier.ts'
import { pluginCatalogEntries, pluginDefinition } from './plugins.ts'
import { catalogList, createCatalogSnapshot } from './snapshot.ts'
import { createCustomizationStore, invalidDefinition } from './store.ts'

export { CUSTOMIZATION_CACHE_PROJECTS_MAX } from './cache.ts'

/** Test options of the service (all optional). */
export interface CustomizationServiceOptions {
  /** The clock (epoch ms); default `Date.now` (read at every call, so fake timers apply). */
  readonly now?: () => number
  /** Lifetime of a cached catalog; default `LIMITS.customizationIndexTtlMs`. */
  readonly ttlMs?: number
  /** Project catalogs cached at most; default `CUSTOMIZATION_CACHE_PROJECTS_MAX`. */
  readonly maxProjects?: number
  /** The opener of definition files (default `openWorkspaceFile`; tests spy on it). */
  readonly openFile?: OpenDefinitionFile
  /** Interval of the coalesced `customization.changed` announcements; default 1 s. */
  readonly eventIntervalMs?: number
}

/** `issue` of an unavailable project folder (`customizationProjectScanSchema`). */
const PROJECT_ISSUE_MAX_CHARS = 500
const PROJECT_UNAVAILABLE_MESSAGE = 'The project folder is not available; its definitions are not listed.'
const DEFINITION_PREFIXES = PROJECT_DEFINITION_FOLDERS.map(folder => `${folder.folder}/`)
/** The registry kinds the catalog lists (a change of one drops every catalog). */
const CATALOG_REGISTRY_KINDS: ReadonlySet<RegistryChange['kind']> = new Set(['agent', 'skill', 'command', 'style'])

function gone(kind: CustomizationKind, name: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `The ${kind} "${name}" is no longer available.` })
}

function notFound(kind: CustomizationKind, name: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `The ${kind} "${name}" was not found.` })
}

function queryIssue(path: string, message: string): HarnessError {
  return validationError([{ path: [path], message, code: 'custom' }], message)
}

/** True when a `workspace.changed` may have touched a definition folder (a cut path list always may). */
export function touchesDefinitions(paths: readonly string[]): boolean {
  if (paths.length === 0 || paths.length >= LIMITS.workspaceEventPathsMax)
    return true
  return paths.some((path) => {
    const normalized = path.replace(/^(?:\.\/)+/, '').toLowerCase()
    return (DEFINITION_FOLDERS as readonly string[]).includes(normalized)
      || PROJECT_DEFINITION_FOLDERS.some(folder => normalized === folder.folder)
      || DEFINITION_PREFIXES.some(prefix => normalized.startsWith(prefix))
  })
}

/**
 * True for a path discovery can produce for `kind`: below `.claude/<kind folder>` or `.harness/<kind folder>`, a `.md`
 * file (a skill's `<dir>/SKILL.md`), no empty, `.` or `..` segment. `load` and `source` read nothing else.
 */
export function isDefinitionPath(kind: CustomizationKind, path: string): boolean {
  const segments = path.split('/')
  if (segments.length < 3 || segments.some(segment => segment === '' || segment === '.' || segment === '..'))
    return false
  if (!(DEFINITION_FOLDERS as readonly string[]).includes(segments[0]!) || segments[1] !== DEFINITION_KIND_FOLDERS[kind])
    return false
  const file = segments.at(-1)!
  switch (kind) {
    case 'agent':
      return segments.length === 3 && file.endsWith('.md')
    case 'command':
      return segments.length <= 6 && file.endsWith('.md')
    case 'skill':
      return segments.length === 4 && file === 'SKILL.md'
    case 'style':
      return segments.length === 3 && file.endsWith('.md')
  }
}

export function createCustomizationService(deps: AppDeps, options: CustomizationServiceOptions = {}): CustomizationService {
  const now = options.now ?? (() => Date.now())
  let logger: Logger | undefined
  const log = (): Logger => (logger ??= deps.logger.child({ component: 'customizations' }))
  const store = createCustomizationStore(deps, { now, logger: log })
  /** The project of every project entry a snapshot of this service listed (`load` re-opens that project). */
  const entryProjects = new WeakMap<CustomizationEntry, string>()
  let stopped = false
  let subscriptions: Disposable[] | null = null

  function emit(data: CustomizationChangedData): void {
    if (stopped)
      return
    try {
      deps.events.emit('customization.changed', data)
    }
    catch (error) {
      log().warn('customization.changed not sent', { err: error })
    }
  }

  const notifier = createCoalescedNotifier({
    now,
    ...(options.eventIntervalMs === undefined ? {} : { intervalMs: options.eventIntervalMs }),
    send: key => emit(key === '' ? {} : { projectId: key }),
  })

  const cache = createCatalogCache({
    ttlMs: options.ttlMs ?? LIMITS.customizationIndexTtlMs,
    maxProjects: options.maxProjects ?? CUSTOMIZATION_CACHE_PROJECTS_MAX,
    now,
    build,
    onRebuilt: (projectId, previous, next) => {
      if (projectId !== null && projectFingerprint(previous) !== projectFingerprint(next))
        notifier.request(projectId)
    },
  })

  // ---------- invalidation ----------

  function invalidateProject(projectId: string): void {
    if (cache.invalidate(projectId) && !stopped)
      notifier.request(projectId)
  }

  /** Drops every catalog (personal and plugin changes rebuild the global part). */
  function invalidateAll(): void {
    cache.clear()
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
      log().debug('customization catalog: chat lookup failed', { chatId, err: error })
    }
  }

  function onEvent(event: ServerEvent): void {
    if (event.type === 'workspace.changed') {
      if (touchesDefinitions(event.data.paths))
        invalidateProject(event.data.projectId)
    }
    else if (event.type === 'project.changed') {
      invalidateProject(event.data.id)
    }
    else if (event.type === 'run.finished') {
      void onRunFinished(event.data.chatId)
    }
  }

  function onRegistryChange(change: RegistryChange): void {
    if (!CATALOG_REGISTRY_KINDS.has(change.kind))
      return
    invalidateAll()
    notifier.request('')
  }

  function subscribe(): void {
    if (stopped || subscriptions !== null)
      return
    subscriptions = [deps.events.subscribe(onEvent), deps.registry.onChange(onRegistryChange)]
  }

  // ---------- builds ----------

  /**
   * The live state the entries are checked against: the registered tool names, and the configured providers among the
   * ones the entries reference (each read with `providers.get`, so a build never resolves every provider's credentials).
   */
  async function checkContext(entries: readonly CustomizationEntry[]): Promise<CatalogCheckContext> {
    const tools = new Set(deps.registry.tools.list().map(tool => tool.definition.name))
    const referenced = new Set<string>()
    for (const entry of entries) {
      const providerId = entry.modelRef === undefined || entry.modelRef === 'inherit' ? undefined : safeParseModelRef(entry.modelRef)?.providerId
      if (providerId !== undefined)
        referenced.add(providerId)
    }
    const providers = new Set<string>()
    for (const providerId of referenced) {
      try {
        const summary = await deps.providers.get(providerId)
        if (summary.enabled && summary.status !== 'not_configured')
          providers.add(providerId)
      }
      catch (error) {
        if (isHarnessError(error) && error.code === 'not_found')
          continue
        log().debug('customization catalog: providers not read', { err: error })
        return { tools, providers: null }
      }
    }
    return { tools, providers }
  }

  function unavailablePart(projectId: string, issue: string, scannedAt: number): CatalogProjectPart {
    return {
      scan: { id: projectId, available: false, issue: issue.slice(0, PROJECT_ISSUE_MAX_CHARS), folders: [], scannedAt },
      entries: [],
      diagnostics: [{ level: 'warning', code: 'project-unavailable', message: PROJECT_UNAVAILABLE_MESSAGE }],
    }
  }

  async function openProject(projectId: string): Promise<OpenWorkspaceResult> {
    try {
      return await deps.projects.openWorkspace(projectId)
    }
    catch (error) {
      log().warn('customization catalog: project not opened', { projectId, err: error })
      return { ok: false, name: null, message: 'The project folder could not be opened.' }
    }
  }

  async function projectPart(projectId: string): Promise<CatalogProjectPart> {
    const scannedAt = now()
    const opened = await openProject(projectId)
    if (!opened.ok)
      return unavailablePart(projectId, opened.message, scannedAt)
    const found = await discoverProject(opened.workspace.root, { openFile: options.openFile })
    return { scan: { id: projectId, available: true, folders: found.folders, scannedAt }, entries: found.entries, diagnostics: found.diagnostics }
  }

  async function build(projectId: string | null): Promise<CustomizationCatalog> {
    subscribe()
    const builtAt = now()
    const global = [...builtinCatalogEntries(), ...pluginCatalogEntries(deps.registry, deps.env.safeMode), ...await store.entries()]
    const project = projectId === null ? null : await projectPart(projectId)
    const checks = await checkContext([...global, ...(project?.entries ?? [])])
    const catalog = mergeCatalog({ projectId, global, project, checks, builtAt })
    if (projectId !== null) {
      for (const entry of catalog.entries) {
        if (entry.source === 'project')
          entryProjects.set(entry, projectId)
      }
    }
    log().debug('customization catalog built', {
      projectId,
      entries: catalog.entries.length,
      projectEntries: project?.entries.length ?? 0,
      diagnostics: catalog.diagnostics.length,
      ms: now() - builtAt,
    })
    return catalog
  }

  /** The answer of a build that failed (database): the builtins, with a diagnostic; never cached. */
  function fallbackCatalog(projectId: string | null): CustomizationCatalog {
    const builtAt = now()
    return createCatalogSnapshot({
      projectId,
      entries: builtinCatalogEntries(),
      diagnostics: [{ level: 'warning', code: 'read-failed', message: 'The catalog could not be read completely; only the built-in agents and output styles are listed.' }],
      project: projectId === null ? null : { id: projectId, available: false, issue: 'The catalog could not be read.', folders: [], scannedAt: builtAt },
      builtAt,
    })
  }

  async function catalog(projectId: string | null, catalogOptions: { refresh?: boolean, signal?: AbortSignal } = {}): Promise<CustomizationCatalog> {
    catalogOptions.signal?.throwIfAborted()
    try {
      return await cache.get(projectId, catalogOptions)
    }
    catch (error) {
      if (catalogOptions.signal?.aborted === true)
        throw error
      log().warn('customization catalog failed', { projectId, err: error })
      return fallbackCatalog(projectId)
    }
  }

  // ---------- bodies ----------

  /** The project of a project entry: the snapshot that listed it, else the one cached project that lists it. */
  function projectOf(entry: CustomizationEntry): string | null {
    const known = entryProjects.get(entry)
    if (known !== undefined)
      return known
    const matches = new Set<string>()
    for (const snapshot of cache.snapshots()) {
      if (snapshot.projectId !== null && snapshot.entries.some(item =>
        item.source === 'project' && item.kind === entry.kind && item.name === entry.name && item.path === entry.path)) {
        matches.add(snapshot.projectId)
      }
    }
    return matches.size === 1 ? [...matches][0]! : null
  }

  async function loadProjectEntry(entry: CustomizationEntry, signal: AbortSignal | undefined): Promise<LoadedDefinition> {
    const path = entry.path
    if (path === undefined || !isDefinitionPath(entry.kind, path))
      throw gone(entry.kind, entry.name)
    const projectId = projectOf(entry)
    if (projectId === null)
      throw gone(entry.kind, entry.name)
    const opened = await openProject(projectId)
    signal?.throwIfAborted()
    if (!opened.ok)
      throw gone(entry.kind, entry.name)
    const read = await readDefinitionFile(opened.workspace.root, path, { maxBytes: DEFINITION_LIMITS.contentBytes, openFile: options.openFile })
    signal?.throwIfAborted()
    if (!read.ok) {
      if (read.reason === 'missing' || read.reason === 'secret')
        throw gone(entry.kind, entry.name)
      throw invalidDefinition([readFailureDiagnostic(read.reason, path)], [])
    }
    const result = parseDefinition(entry.kind, read.text, parseOptionsOf(entry.kind, path))
    const diagnostics = result.diagnostics.slice(0, DIAGNOSTICS_MAX).map(item => ({ ...item, path }))
    const definition = result.definition
    if (definition === null || definition.kind !== entry.kind || diagnostics.some(item => item.level === 'error'))
      throw invalidDefinition(diagnostics, [])
    if (definition.fields.name !== entry.name)
      throw gone(entry.kind, entry.name)
    log().debug('customization loaded', { kind: entry.kind, name: entry.name, source: entry.source, projectId })
    return { entry, definition, diagnostics }
  }

  function findProjectEntry(snapshot: CustomizationCatalog, query: CustomizationSourceQuery): CustomizationEntry | null {
    const candidates = snapshot.entries.filter(entry =>
      entry.source === 'project' && entry.kind === query.kind && entry.name === query.name && entry.path !== undefined)
    if (query.path !== undefined)
      return candidates.find(entry => entry.path === query.path) ?? null
    return candidates.find(entry => entry.state === 'active') ?? candidates[0] ?? null
  }

  async function projectSource(query: CustomizationSourceQuery): Promise<CustomizationSourceResult> {
    const projectId = query.projectId
    if (projectId === undefined)
      throw queryIssue('projectId', 'Project definitions need "projectId".')
    // An unknown project is the project service's 404.
    await deps.projects.get(projectId)
    const opened = await openProject(projectId)
    if (!opened.ok)
      throw queryIssue('projectId', 'The project folder is not available.')
    let entry = findProjectEntry(await catalog(projectId), query)
    if (entry === null)
      entry = findProjectEntry(await catalog(projectId, { refresh: true }), query)
    const path = entry?.path
    if (entry === null || path === undefined || !isDefinitionPath(query.kind, path))
      throw notFound(query.kind, query.name)
    const read = await readDefinitionFile(opened.workspace.root, path, { maxBytes: DEFINITION_LIMITS.contentBytes, openFile: options.openFile })
    if (!read.ok) {
      if (read.reason === 'missing' || read.reason === 'secret')
        throw notFound(query.kind, query.name)
      throw queryIssue('path', readFailureDiagnostic(read.reason, path).message)
    }
    return { content: read.text, path }
  }

  // ---------- personal changes ----------

  function personalChanged(kind: CustomizationKind, id: string): void {
    invalidateAll()
    emit({ kind, id })
  }

  return {
    catalog,

    list: async (query) => {
      // An unknown project is the project service's 404.
      if (query.projectId !== undefined)
        await deps.projects.get(query.projectId)
      return catalogList(await catalog(query.projectId ?? null, { refresh: query.refresh === true }), query.kind)
    },

    source: async (query) => {
      switch (query.source) {
        case 'user':
          throw queryIssue('source', 'Read personal definitions with GET /customizations/:id.')
        case 'builtin': {
          const entry = builtinCatalogEntries().find(item => item.kind === query.kind && item.name === query.name)
          const loaded = entry === undefined ? null : loadBuiltin(entry)
          if (loaded === null)
            throw notFound(query.kind, query.name)
          return { content: formatDefinition(loaded.definition) }
        }
        case 'plugin': {
          const found = pluginDefinition(deps.registry, query.kind, query.name, undefined, deps.env.safeMode)
          if (found === null)
            throw notFound(query.kind, query.name)
          return { content: formatDefinition(found.definition) }
        }
        case 'project':
          return projectSource(query)
      }
    },

    load: async (entry, signal) => {
      signal?.throwIfAborted()
      switch (entry.source) {
        case 'builtin': {
          const loaded = loadBuiltin(entry)
          if (loaded === null)
            throw gone(entry.kind, entry.name)
          return loaded
        }
        case 'plugin': {
          const found = pluginDefinition(deps.registry, entry.kind, entry.name, entry.pluginId, deps.env.safeMode)
          if (found === null)
            throw gone(entry.kind, entry.name)
          return { entry, definition: found.definition, diagnostics: [] }
        }
        case 'user':
          return store.load(entry)
        case 'project':
          return loadProjectEntry(entry, signal)
      }
    },

    get: async id => store.get(id),

    create: async (body) => {
      const created = await store.create(body)
      personalChanged(created.kind, created.id)
      return created
    },

    update: async (id, body) => {
      const updated = await store.update(id, body)
      personalChanged(updated.kind, updated.id)
      return updated
    },

    remove: async (id) => {
      const removed = await store.remove(id)
      personalChanged(removed.kind, removed.id)
    },

    exportBackup: async () => store.exportBackup(),

    // Phase 12 (C43 compile fix): the import of personal definitions lands with W12.7.
    importDefinitions: rejectsNotImplemented('Importing personal definitions'),

    restoreBackup: async (items) => {
      const result = await store.restoreBackup(items)
      if (result.imported > 0) {
        invalidateAll()
        emit({})
      }
      return result
    },

    invalidate: (projectId) => {
      try {
        if (projectId !== null) {
          invalidateProject(projectId)
          return
        }
        const had = cache.projects().length > 0 || cache.snapshots().length > 0
        invalidateAll()
        if (had && !stopped)
          notifier.request('')
      }
      catch (error) {
        log().warn('customization catalog not dropped', { projectId, err: error })
      }
    },

    stop: () => {
      stopped = true
      for (const subscription of subscriptions ?? []) {
        try {
          subscription.dispose()
        }
        catch (error) {
          log().warn('customization catalog: unsubscribe failed', { err: error })
        }
      }
      subscriptions = null
      try {
        cache.clear()
        notifier.stop()
      }
      catch (error) {
        log().warn('customization catalog: stop failed', { err: error })
      }
    },
  }
}
