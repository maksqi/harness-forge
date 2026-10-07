// Hooks store (Phase 11, ADR-048; docs/UI.md 9.13, 11.8; docs/API.md 4.31, 5.31): the hook listing per scope (`GET
// /hooks?projectId=`: personal, the project's when asked, and plugin hooks, with the kill switches and the project scan)
// and the personal hook mutations. The only reader of the hook routes: the Customize Hooks tab (HooksPanel, HookEditor,
// HookImportDialog) and the plugin detail page (`list(null)`) read it. Creating a hook and changing one (unless the
// change only turns it off) need fresh auth: `create` / `update` throw the 403 `login` for the component's
// `useFreshAuth().run(task, { required: true })` ("Saving a hook needs your password."). There is no `get(id)` (no `GET
// /hooks/:id`): the editor reads the personal entry of the list.
// Signature frozen from Gate P11-0b (C39); implementation W11.8: single-flight fetches per scope, per-scope versions (an
// answer of a fetch that a newer fetch, an event or a mutation overtook is returned to its caller but never cached),
// `maxAgeMs`, every mutation marks every scope stale (personal rows show in every scope), `{ enabled: false }` alone is
// optimistic (every cached list shows the hook off at once; a failure brings it back), and an event refetches the
// affected scopes used in the last minute (the others on their next use).
// Phase 12 (ADR-056, ADR-057; C46 CCR, W12.12 implements; frozen from Gate P12-0b): `saveProjectHook(projectId, target,
// draft)` edits a hook in a project's settings file (read the file, splice the handler into its `hooks` key, `PUT
// /projects/:id/definitions/file` with `expectedSha256`; no fresh auth, never approves). An edited handler must still be
// the one the cached listing shows at its position, else the save is refused like the server's stale answer (409
// `conflict`, reason `stale`): the file changed after the editor opened it. `workspace.changed` with a project settings
// file among its paths marks that project's scope stale (HooksPanel subscribes to the event while it is shown).
import type {
  HookCreate,
  HookEntry,
  HookList,
  HookRunList,
  HookUpdate,
  PersonalHook,
  ProjectDefinitionWriteResult,
  ServerEvent,
} from '@harness-forge/shared'
import type { HookDraft, ProjectHookTarget } from '~/components/settings/customize/hooks'
import { HarnessError, isHookTurnOff, LIMITS } from '@harness-forge/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { draftFromHook, isProjectHookFile, projectEntryAt, rawHandlerMatches, spliceProjectHook } from '~/components/settings/customize/hooks'
import { useApi } from '~/composables/useApi'
import { hasErrorCode, withHarnessErrors } from '~/utils/errors'

export interface FetchHooksOptions {
  /** A cached list younger than this (and not stale) is returned as is; omitted = always fetch. */
  maxAgeMs?: number
}

const NO_ENTRIES: readonly HookEntry[] = Object.freeze([])

/** An event refetches at once the scopes used (fetched or read through a fetch call) this recently. */
export const HOOKS_RECENT_MS = 60_000

/** The cache key of a scope: the project id, '' for none. */
export function hookScopeKey(projectId: string | null): string {
  return projectId ?? ''
}

/** The message of the stale answer (the server's text for 409 `stale`). */
export const PROJECT_HOOK_STALE_MESSAGE = 'The file changed on disk. Load it again or overwrite it.'

function staleError(): HarnessError {
  return new HarnessError({ code: 'conflict', status: 409, message: PROJECT_HOOK_STALE_MESSAGE, details: { reason: 'stale' } })
}

function invalidFile(path: string, problem: string): HarnessError {
  return new HarnessError({ code: 'validation_error', status: 400, message: `${path} can't be changed here: ${problem} Fix it in the project folder.` })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The `hooks` value of a settings file's text (`undefined` without the key). Throws a 400 for unreadable JSON. */
function settingsHooks(path: string, content: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(content.replace(/^\uFEFF/, ''))
  }
  catch {
    throw invalidFile(path, 'it isn\'t valid JSON.')
  }
  if (!isRecord(parsed))
    throw invalidFile(path, 'it must hold a JSON object.')
  return parsed.hooks
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record))
    return record
  const { [key]: _removed, ...rest } = record
  return rest
}

/**
 * `list` with the personal hooks of `overrides` turned on or off (state `off`, or `active` for a hook that was off); the
 * same object when none of them is in it.
 */
function withEnabled(list: HookList, overrides: Readonly<Record<string, boolean>>): HookList {
  const touched = (entry: HookEntry): boolean => entry.source === 'personal' && entry.id !== undefined && Object.hasOwn(overrides, entry.id)
  if (!list.items.some(touched))
    return list
  return {
    ...list,
    items: list.items.map((entry): HookEntry => {
      if (!touched(entry))
        return entry
      const enabled = overrides[entry.id!]!
      if (enabled)
        return entry.state === 'off' ? { ...entry, state: 'active' } : entry
      return entry.state === 'off' ? entry : { ...entry, state: 'off' }
    }),
  }
}

export const useHooksStore = defineStore('hooks', () => {
  const api = useApi()

  // ---------- state ----------

  /** The hook listing of each scope (key = projectId ?? ''). */
  const lists = ref<Record<string, HookList>>({})
  /** When each scope was cached. */
  const loadedAt = ref<Record<string, number>>({})
  /** Scopes an event or a mutation made stale (refetched on their next use). */
  const stale = ref<Record<string, true>>({})

  // Not state: bookkeeping of the requests.
  /** Per scope: bumped by every fetch start, event and mutation (an answer applies only when nothing came after it). */
  const versions = new Map<string, number>()
  /** Per scope: the fetch in flight. */
  const pending = new Map<string, Promise<HookList>>()
  /** Per scope: when a caller last asked for it (`fetch`, cached answers included). */
  const usedAt = new Map<string, number>()
  /**
   * Personal hooks with an optimistic `{ enabled: false }` in flight (not exposed): the getters show every cached list
   * with it, so an answer that arrives meanwhile cannot undo the optimistic state, and a failure only drops the entry.
   */
  const pendingEnabled = ref<Record<string, boolean>>({})

  // ---------- getters ----------

  /** The cached lists as the getters show them (the pending `{ enabled }` updates applied). */
  const shown = computed<Record<string, HookList>>(() => {
    const overrides = pendingEnabled.value
    if (Object.keys(overrides).length === 0)
      return lists.value
    const out: Record<string, HookList> = {}
    for (const [scope, list] of Object.entries(lists.value))
      out[scope] = withEnabled(list, overrides)
    return out
  })

  /** `list(projectId)`: the cached listing of the scope, or null before its first fetch. */
  const list = computed(() => (projectId: string | null): HookList | null => shown.value[hookScopeKey(projectId)] ?? null)
  /** The personal entries of the global listing (`list(null)`). */
  const personal = computed<readonly HookEntry[]>(() => shown.value['']?.items.filter(entry => entry.source === 'personal') ?? NO_ENTRIES)

  // ---------- helpers ----------

  function bump(scope: string): number {
    const next = (versions.get(scope) ?? 0) + 1
    versions.set(scope, next)
    return next
  }

  function isFresh(scope: string, maxAgeMs: number | undefined): boolean {
    if (maxAgeMs === undefined || stale.value[scope])
      return false
    const at = loadedAt.value[scope]
    return at !== undefined && Date.now() - at < maxAgeMs
  }

  /** Marks the scopes stale and overtakes their fetches in flight (their answers reach their callers, uncached). */
  function markStale(scopes: Iterable<string>): void {
    const next: Record<string, true> = { ...stale.value }
    for (const scope of scopes) {
      bump(scope)
      pending.delete(scope)
      if (scope in lists.value)
        next[scope] = true
    }
    stale.value = next
  }

  /** Every cached or loading scope (personal rows show in every scope). */
  function knownScopes(): string[] {
    return [...new Set([...Object.keys(lists.value), ...pending.keys(), ...usedAt.keys()])]
  }

  function markAllStale(): void {
    markStale(knownScopes())
  }

  function dropScope(scope: string): void {
    bump(scope)
    pending.delete(scope)
    usedAt.delete(scope)
    lists.value = omit(lists.value, scope)
    loadedAt.value = omit(loadedAt.value, scope)
    stale.value = omit(stale.value, scope)
  }

  // ---------- actions ----------

  /**
   * `GET /hooks?projectId=`: the listing of the scope (single-flight per scope). A cached list younger than `maxAgeMs`
   * and not stale is returned as is; a 404 (a deleted project) drops the scope and is thrown. Throws `HarnessError`.
   */
  function fetch(projectId: string | null, opts: FetchHooksOptions = {}): Promise<HookList> {
    usedAt.set(hookScopeKey(projectId), Date.now())
    return load(projectId, opts)
  }

  /** `fetch` without counting as a use (event and reconnect refetches). */
  function load(projectId: string | null, opts: FetchHooksOptions = {}): Promise<HookList> {
    const scope = hookScopeKey(projectId)
    const cached = lists.value[scope]
    if (cached && isFresh(scope, opts.maxAgeMs))
      return Promise.resolve(shown.value[scope] ?? cached)
    const current = pending.get(scope)
    if (current)
      return current
    const version = bump(scope)
    const request = (async () => {
      try {
        const listed = await withHarnessErrors(api.hooks.list({ query: projectId === null ? {} : { projectId } }))
        if (versions.get(scope) === version) {
          lists.value = { ...lists.value, [scope]: listed }
          loadedAt.value = { ...loadedAt.value, [scope]: Date.now() }
          stale.value = omit(stale.value, scope)
        }
        return listed
      }
      catch (error) {
        if (projectId !== null && hasErrorCode(error, 'not_found') && versions.get(scope) === version)
          dropScope(scope)
        throw error
      }
    })().finally(() => {
      if (pending.get(scope) === request)
        pending.delete(scope)
    })
    pending.set(scope, request)
    return request
  }

  /** `GET /hooks/runs`: the in-memory run log of the server (newest first). Throws `HarnessError`. */
  async function runs(): Promise<HookRunList> {
    return withHarnessErrors(api.hooks.runs())
  }

  /** `POST /hooks` (fresh auth: the 403 `login` is thrown). Marks every scope stale. Throws `HarnessError`. */
  async function create(body: HookCreate): Promise<PersonalHook> {
    const created = await withHarnessErrors(api.hooks.create({ body }))
    markAllStale()
    return created
  }

  /**
   * `PATCH /hooks/:id` (fresh auth unless the patch is exactly `{ enabled: false }`). `{ enabled: false }` alone is
   * optimistic: every cached list shows the hook off at once, answers arriving meanwhile included, and a failure brings
   * the previous state back. Marks every scope stale. Throws `HarnessError`.
   */
  async function update(id: string, patch: HookUpdate): Promise<PersonalHook> {
    const optimistic = isHookTurnOff(patch)
    if (optimistic)
      pendingEnabled.value = { ...pendingEnabled.value, [id]: false }
    try {
      const updated = await withHarnessErrors(api.hooks.update({ params: { id }, body: patch }))
      if (optimistic) {
        // Keep showing the new state until the refetch of the stale scopes answers.
        lists.value = Object.fromEntries(Object.entries(lists.value).map(([scope, item]) => [scope, withEnabled(item, { [id]: updated.enabled })]))
      }
      return updated
    }
    finally {
      if (optimistic)
        pendingEnabled.value = omit(pendingEnabled.value, id)
      markAllStale()
    }
  }

  /** `DELETE /hooks/:id`; a 404 counts as removed. Marks every scope stale. Throws `HarnessError`. */
  async function remove(id: string): Promise<void> {
    try {
      await withHarnessErrors(api.hooks.remove({ params: { id } }))
    }
    catch (error) {
      if (!hasErrorCode(error, 'not_found'))
        throw error
    }
    finally {
      markAllStale()
    }
  }

  /**
   * Writes a hook of a project's settings file (Phase 12, ADR-056): reads the file (`GET /projects/:id/definitions/file`),
   * splices the draft's handler into its `hooks` key at `target` (a new handler without indexes; null removes the
   * handler; `spliceProjectHook`), then `PUT`s the key with the sha256 it read (409 `conflict` reason `stale` when the
   * file changed meanwhile). An edited or removed handler must still be the one the cached listing of the project shows
   * at that position (else the same 409 `stale` is thrown before any write: the file changed after the editor opened
   * it). No fresh auth; saving never approves (the result counts the pending items). Marks the project's scope stale.
   * Throws `HarnessError` (a 400 for a file whose JSON or `hooks` value can't be read).
   */
  async function saveProjectHook(projectId: string, target: ProjectHookTarget, draft: HookDraft | null): Promise<ProjectDefinitionWriteResult> {
    const scope = hookScopeKey(projectId)
    try {
      const file = await withHarnessErrors(api.projectDefinitions.read({ params: { id: projectId }, query: { path: target.path } }))
      const current = file.exists && file.content !== null ? settingsHooks(target.path, file.content) : undefined
      const listed = projectEntryAt(lists.value[scope]?.items ?? [], target)
      if (listed && !rawHandlerMatches(current, target, draftFromHook(listed)))
        throw staleError()
      const spliced = spliceProjectHook(current, target, draft)
      if (!spliced.ok)
        throw spliced.reason === 'missing' ? staleError() : invalidFile(target.path, spliced.message)
      return await withHarnessErrors(api.projectDefinitions.write({
        params: { id: projectId },
        body: { path: target.path, expectedSha256: file.exists ? file.sha256 : null, hooks: spliced.hooks },
      }))
    }
    finally {
      markStale([scope])
    }
  }

  /** Refetches quietly the scopes among `scopes` that were used in the last minute. */
  function refetchRecent(scopes: Iterable<string>): void {
    const since = Date.now() - HOOKS_RECENT_MS
    for (const scope of scopes) {
      if ((usedAt.get(scope) ?? 0) >= since)
        load(scope === '' ? null : scope).catch(() => {})
    }
  }

  /**
   * `hooks.changed` (`projectId` null: every scope, since personal and plugin rows show in each; else that project's),
   * `project-trust.changed` (that project's scope: its rows change state), `plugin.changed` (every scope) and
   * `customization.changed` with a project (its files changed on disk): the affected scopes are stale and the ones used
   * in the last minute are refetched at once. `project.changed` with `project: null` drops the deleted project's scope.
   * + Phase 12: `workspace.changed` whose paths hold a project settings file (or were cut at the event's path cap) marks
   * that project's scope stale the same way.
   */
  function applyEvent(event: ServerEvent): void {
    let scopes: string[]
    switch (event.type) {
      case 'hooks.changed':
        scopes = event.data.projectId === null ? knownScopes() : [event.data.projectId]
        break
      case 'project-trust.changed':
        scopes = [event.data.projectId]
        break
      case 'plugin.changed':
        scopes = knownScopes()
        break
      case 'customization.changed':
        if (!event.data.projectId)
          return
        scopes = [event.data.projectId]
        break
      case 'project.changed':
        if (event.data.project === null)
          dropScope(event.data.id)
        return
      case 'workspace.changed':
        if (!event.data.paths.some(isProjectHookFile) && event.data.paths.length < LIMITS.workspaceEventPathsMax)
          return
        scopes = [event.data.projectId]
        break
      default:
        return
    }
    markStale(scopes)
    refetchRecent(scopes)
  }

  /** Refetches every loaded scope (after the event stream reconnects: missed events are not replayed). */
  async function refreshLoaded(): Promise<void> {
    const scopes = Object.keys(lists.value)
    markStale(scopes)
    await Promise.allSettled(scopes.map(scope => load(scope === '' ? null : scope)))
  }

  return {
    lists,
    loadedAt,
    stale,
    list,
    personal,
    fetch,
    runs,
    create,
    update,
    remove,
    saveProjectHook,
    applyEvent,
    refreshLoaded,
  }
})
