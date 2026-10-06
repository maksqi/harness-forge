// The hook service (Phase 11, ADR-048; ARCHITECTURE.md 6.28; API.md 4.31 / 5.31) behind `HookService` (./types.ts).
// Owner: W11.1.
//
// - `snapshot(scope)`: the hooks of one run or prepare, merged once (`snapshot.ts`): personal rows (`personal.ts`, cached
//   in memory), plugin command hooks (`registry.hookCommands` of active plugins), the approved items of the project's
//   settings files (`projectConfig.snapshot` + `projectTrust.approved`, only when the run's folder opened; nothing of a
//   project is cached here: both services cache their own reads) and the plugin code hooks of the Phase 11 events
//   (`code-hooks.ts`). The kill switches (`hookSwitches`) leave only the code hooks. A source that cannot be read is
//   left out; only an abort rejects.
// - Runs: `runner.ts` (one process through `runShellCommand`), a server-wide semaphore of `LIMITS.hookProcessesMax`
//   processes (`semaphore.ts`), verify-before-run of project items, the combination and the record (`record.ts`), the
//   run log (`run-log.ts`, `GET /hooks/runs`).
// - `list` (`listing.ts`), the personal CRUD (fresh auth through `SensitiveOperationOptions`; `hooks.changed { projectId:
//   null }` after every change).
// - Events (subscribed on first use): `project-trust.changed`, `project.changed` and `workspace.changed` drop caches;
//   a `workspace.changed` of a `.claude` / `.harness` file and a registry change of plugin hooks (command hooks, the
//   listed code hook events) emit `hooks.changed` (coalesced per project). A project item that fails its
//   verify-before-run drops the project's config cache and emits `project-trust.changed { projectId, pending }` +
//   `hooks.changed { projectId }`.
// - The kill switch `hooksEnabled` (API.md section 7, Gate P11-A): a settings change of that key emits `hooks.changed
//   { projectId: null }` once (coalesced like the others). Subscribed at construction (`onSettingsChange`, an in-process
//   listener, not an event-bus subscription), so the event also comes before the service's first use. Nothing cached
//   here depends on the setting (every snapshot and listing reads the switches), so nothing is dropped.
// - `stop()`: kills every running hook process group (awaited), drops the caches and the subscriptions.
// Logging: `info` = the event, the source, a hash prefix of the label, the exit code, the duration, the outcome; the
// redacted command only at `debug`; payloads, stdout and stderr never.
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { HookEvent, HookList, HookSwitches, ServerEvent } from '@harness-forge/shared'
import type { RegistryChange } from '../../registry/types.ts'
import type { AppDeps } from '../../types.ts'
import type { CommandHookOptions } from './runner.ts'
import type { SnapshotHook, SnapshotSources } from './snapshot.ts'
import type { HookEventResult, HookRunInput, HookRunOptions, HookScope, HookService, HookSnapshot } from './types.ts'
import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { compileMatcher, HOOK_EVENTS, LIMITS } from '@harness-forge/shared'
import { onSettingsChange } from '../settings/index.ts'
import { codeHookOf, codeHookPlugins, isListedCodeHook } from './code-hooks.ts'
import { listHooks, pluginCodeEntries } from './listing.ts'
import { createPersonalHookStore } from './personal.ts'
import { createHookRunLog } from './run-log.ts'
import { createSemaphore } from './semaphore.ts'
import { commandLabel, createSnapshot } from './snapshot.ts'

export { personalHookEntry } from './listing.ts'

/** The result of an event for which no hook ran. */
export const NOTHING_RAN: HookEventResult = Object.freeze({
  ran: false,
  decision: null,
  reason: null,
  context: null,
  block: false,
  continue: true,
  stopReason: null,
  record: null,
})

/** Throws the signal's reason when it is aborted (`AbortSignal.throwIfAborted`, also for a missing signal). */
function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted()
}

/** A snapshot without any hook: `has()` is false for every event and `run()` answers `NOTHING_RAN`. */
export function emptyHookSnapshot(scope: HookScope): HookSnapshot {
  return Object.freeze({
    scope,
    has: (_event: HookEvent) => false,
    run: async (_event: HookEvent, _input: HookRunInput, options: HookRunOptions) => {
      throwIfAborted(options.signal)
      return NOTHING_RAN
    },
  })
}

/** The kill switches of command hooks: the setting, `HF_WORKSPACE_SHELL`, `HF_SAFE_MODE`. */
export async function hookSwitches(deps: Pick<AppDeps, 'settings' | 'env'>): Promise<HookSwitches> {
  const settings = await deps.settings.get()
  return { setting: settings.hooksEnabled, shell: deps.env.workspaceShell, safeMode: deps.env.safeMode }
}

/** Command hooks may run under these switches. */
export function commandHooksAllowed(switches: HookSwitches): boolean {
  return switches.setting && switches.shell && !switches.safeMode
}

/** The project files whose change can change the project's hooks (settings files and the scripts beside them). */
export function touchesProjectHooks(paths: readonly string[]): boolean {
  return paths.some(path => path.startsWith('.claude/') || path.startsWith('.harness/'))
}

/** Test seams of the hook service (production uses the defaults). */
export interface HookServiceOptions {
  /** The server-wide cap of hook processes (default `LIMITS.hookProcessesMax`). */
  readonly processesMax?: number
  /** The shell runner, the kill grace and a spawn observer of every hook process. */
  readonly runner?: CommandHookOptions
  /** Clock (epoch ms; default `Date.now`). */
  readonly now?: () => number
}

export function createHookService(deps: AppDeps, options: HookServiceOptions = {}): HookService {
  const logger = deps.logger.child({ component: 'hooks' })
  const now = options.now ?? (() => Date.now())
  const semaphore = createSemaphore(options.processesMax ?? LIMITS.hookProcessesMax)
  const runLog = createHookRunLog()
  const stopController = new AbortController()
  const inflight = new Set<Promise<unknown>>()
  const staleProjects = new Set<string>()
  const pendingChanges = new Set<string | null>()
  let subscriptions: Disposable[] | null = null
  let stopped = false
  let hooksDirChecked = false

  const personal = createPersonalHookStore(deps, {
    now,
    changed: () => {
      if (!stopped)
        deps.events.emit('hooks.changed', { projectId: null })
    },
  })

  // ---------- bookkeeping ----------

  function track<T>(promise: Promise<T>): Promise<T> {
    inflight.add(promise)
    const forget = (): void => {
      inflight.delete(promise)
    }
    promise.then(forget, forget)
    return promise
  }

  /** `hooks.changed` for a project (or null), coalesced until the current task ends. */
  function scheduleChanged(projectId: string | null): void {
    if (stopped)
      return
    const first = pendingChanges.size === 0
    pendingChanges.add(projectId)
    if (!first)
      return
    queueMicrotask(() => {
      const list = [...pendingChanges]
      pendingChanges.clear()
      if (stopped)
        return
      for (const id of list)
        deps.events.emit('hooks.changed', { projectId: id })
    })
  }

  function invalidate(projectId: string | null): void {
    // Nothing of a project is cached here (the project config reader and project trust cache their own reads).
    if (projectId === null)
      personal.invalidate()
  }

  function onEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'project-trust.changed':
        invalidate(event.data.projectId)
        break
      case 'project.changed':
        invalidate(event.data.id)
        break
      case 'workspace.changed':
        if (touchesProjectHooks(event.data.paths)) {
          invalidate(event.data.projectId)
          scheduleChanged(event.data.projectId)
        }
        break
      default:
        break
    }
  }

  function onRegistryChange(change: RegistryChange): void {
    if (change.kind === 'hookCommands' || (change.kind === 'hook' && isListedCodeHook(change.key)))
      scheduleChanged(null)
  }

  function ensureSubscribed(): void {
    if (stopped || subscriptions !== null)
      return
    subscriptions = [deps.events.subscribe(onEvent), deps.registry.onChange(onRegistryChange)]
  }

  // The kill switch: a change of `hooksEnabled` changes the state of every command hook (`active` / `blocked`).
  let settingsSubscription: Disposable | null = null
  try {
    settingsSubscription = onSettingsChange(deps.settings, (change) => {
      if (change.keys.includes('hooksEnabled'))
        scheduleChanged(null)
    })
  }
  catch (error) {
    logger.warn('hooks: the settings changes could not be subscribed; hooks.changed is not emitted for hooksEnabled', { err: error })
  }

  /** Verify-before-run failed: the project's scan is stale; announce that its review list changed (once at a time). */
  function onStale(projectId: string): void {
    try {
      deps.projectConfig.invalidate(projectId)
    }
    catch (error) {
      logger.debug('hooks: the project config cache could not be dropped', { err: error })
    }
    if (stopped || staleProjects.has(projectId))
      return
    staleProjects.add(projectId)
    void track((async () => {
      try {
        const pending = await deps.projectTrust.pending(projectId)
        if (!stopped) {
          deps.events.emit('project-trust.changed', { projectId, pending })
          deps.events.emit('hooks.changed', { projectId })
        }
      }
      catch (error) {
        logger.debug('hooks: the pending count of a project could not be read', { err: error })
      }
      finally {
        staleProjects.delete(projectId)
      }
    })())
  }

  /** `<dataDir>/hooks` (mode 0700): the working folder of hooks without a project folder. */
  async function hooksDir(): Promise<string> {
    const dir = join(deps.env.dataDir, 'hooks')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    if (!hooksDirChecked) {
      await chmod(dir, 0o700)
      hooksDirChecked = true
    }
    return dir
  }

  // ---------- sources ----------

  async function switchesOrOff(): Promise<HookSwitches> {
    try {
      return await hookSwitches(deps)
    }
    catch (error) {
      // Fail closed: without the setting no command hook runs.
      logger.warn('hooks: the settings could not be read; command hooks do not run', { err: error })
      return { setting: false, shell: deps.env.workspaceShell, safeMode: deps.env.safeMode }
    }
  }

  async function personalHooks(): Promise<SnapshotHook[]> {
    try {
      const rows = await personal.rows()
      const list: SnapshotHook[] = []
      for (const row of rows) {
        const compiled = compileMatcher(row.matcher)
        if (!row.enabled || !compiled.ok)
          continue
        list.push({
          source: 'personal',
          event: row.event,
          matcher: row.matcher,
          compiled,
          command: row.command,
          timeoutSec: row.timeout,
          label: commandLabel(deps.redactor, row.command),
        })
      }
      return list
    }
    catch (error) {
      logger.warn('hooks: the personal hooks could not be read; they do not run', { err: error })
      return []
    }
  }

  function pluginHooks(): SnapshotHook[] {
    const list: SnapshotHook[] = []
    try {
      for (const registration of deps.registry.hookCommands.list()) {
        if (!deps.plugins.isActive(registration.pluginId))
          continue
        for (const spec of registration.hooks) {
          const compiled = compileMatcher(spec.matcher)
          if (!compiled.ok)
            continue
          list.push({
            source: 'plugin',
            event: spec.event,
            matcher: spec.matcher,
            compiled,
            command: spec.command,
            timeoutSec: spec.timeoutSec,
            label: commandLabel(deps.redactor, spec.command),
            pluginId: registration.pluginId,
            pluginRoot: registration.root,
          })
        }
      }
    }
    catch (error) {
      logger.warn('hooks: the plugin command hooks could not be read; they do not run', { err: error })
      return []
    }
    return list
  }

  async function projectHooks(scope: HookScope, signal: AbortSignal | undefined): Promise<SnapshotHook[]> {
    const { projectId, workspace } = scope
    if (projectId === null || workspace === null)
      return []
    try {
      // Nothing approved, nothing to run: the folder is not read at all (no project config read per run).
      const approved = await deps.projectTrust.approved(projectId)
      if (approved.size === 0)
        return []
      // The scan is cached by the project config reader; the folder itself is never opened here (the run did).
      const scan = await deps.projectConfig.snapshot(projectId, signal === undefined ? {} : { signal })
      // Only a scan of the folder this run opened.
      if (!scan.available || scan.root !== workspace.root)
        return []
      const seen = new Set<string>()
      const list: SnapshotHook[] = []
      for (const item of scan.hooks) {
        // Identical items of several settings files run once.
        if (seen.has(item.sha256))
          continue
        seen.add(item.sha256)
        const compiled = compileMatcher(item.spec.matcher)
        if (!approved.has(item.sha256) || !compiled.ok)
          continue
        list.push({
          source: 'project',
          event: item.spec.event,
          matcher: item.spec.matcher,
          compiled,
          command: item.spec.command,
          timeoutSec: item.spec.timeoutSec,
          label: commandLabel(deps.redactor, item.spec.command, item.path),
          item,
        })
      }
      return list
    }
    catch (error) {
      if (signal?.aborted === true)
        throw error
      logger.warn('hooks: the project hooks could not be read; they do not run', { err: error })
      return []
    }
  }

  function codeEvents(): Set<HookEvent> {
    const events = new Set<HookEvent>()
    try {
      for (const event of HOOK_EVENTS) {
        const name = codeHookOf(event)
        if (name !== null && codeHookPlugins(deps.registry, name, id => deps.plugins.isActive(id)).length > 0)
          events.add(event)
      }
    }
    catch (error) {
      logger.warn('hooks: the plugin code hooks could not be read; they do not run', { err: error })
    }
    return events
  }

  async function sourcesOf(scope: HookScope, signal: AbortSignal | undefined): Promise<SnapshotSources> {
    const switches = await switchesOrOff()
    throwIfAborted(signal)
    const hooks: SnapshotHook[] = []
    if (commandHooksAllowed(switches)) {
      hooks.push(...await personalHooks())
      hooks.push(...pluginHooks())
      hooks.push(...await projectHooks(scope, signal))
    }
    throwIfAborted(signal)
    return { scope, hooks, codeEvents: codeEvents() }
  }

  const runtime = {
    deps,
    logger,
    semaphore,
    runLog,
    stopSignal: stopController.signal,
    hooksDir,
    onStale,
    track,
    runner: options.runner ?? {},
    now,
  }

  // ---------- the service ----------

  async function list(query: Parameters<HookService['list']>[0]): Promise<HookList> {
    ensureSubscribed()
    let project: { scan: Awaited<ReturnType<AppDeps['projectConfig']['snapshot']>>, approved: ReadonlySet<string> } | undefined
    if (query.projectId !== undefined) {
      // `not_found` for an unknown project (the route answers 404).
      await deps.projects.get(query.projectId)
      const scan = await deps.projectConfig.snapshot(query.projectId)
      const approved = await deps.projectTrust.approved(query.projectId)
      project = { scan, approved }
    }
    const switches = await hookSwitches(deps)
    const rows = await personal.rows()
    return listHooks({
      query,
      switches,
      personal: rows,
      plugins: deps.registry.hookCommands.list(),
      isActive: id => deps.plugins.isActive(id),
      code: pluginCodeEntries(deps),
      ...(project === undefined ? {} : { project }),
    })
  }

  return {
    snapshot: async (scope, snapshotOptions) => {
      ensureSubscribed()
      const signal = snapshotOptions?.signal
      throwIfAborted(signal)
      return createSnapshot(runtime, await sourcesOf(scope, signal))
    },
    list,
    create: async (body, sensitive) => {
      ensureSubscribed()
      return personal.create(body, sensitive)
    },
    update: async (id, body, sensitive) => {
      ensureSubscribed()
      return personal.update(id, body, sensitive)
    },
    remove: async (id) => {
      ensureSubscribed()
      await personal.remove(id)
    },
    runs: limit => runLog.list(limit),
    invalidate: (projectId) => {
      try {
        invalidate(projectId)
      }
      catch (error) {
        logger.debug('hooks: invalidate failed', { err: error })
      }
    },
    stop: async () => {
      if (!stopped) {
        stopped = true
        stopController.abort(new DOMException('The hook service stopped.', 'AbortError'))
        for (const subscription of subscriptions ?? []) {
          try {
            subscription.dispose()
          }
          catch {
            // Already gone.
          }
        }
        subscriptions = null
        try {
          settingsSubscription?.dispose()
        }
        catch {
          // Already gone.
        }
        settingsSubscription = null
        pendingChanges.clear()
      }
      await Promise.allSettled([...inflight])
      personal.invalidate()
    },
  }
}
