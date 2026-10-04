// Customizations store (docs/UI.md 9.12, 7.8, 11.7; docs/API.md 4.28, 5.28; ADR-044, ADR-045): the merged catalog of
// agents, commands and skills per scope (a project, or none), the slash commands per scope, the bodies of catalog
// entries and the personal definitions. It is the only reader of the customization routes: the Customize page reads
// everything, the composer its command lists (`fetchCommands` / `slashCommands`), the plugin detail page the global
// catalog (`catalog(null)`).
// Signature frozen from Gate P10-0b (C33); implementation W10.8: per-scope caches with `loadedAt` and a stale flag,
// single-flight fetches per scope, per-list versions (an answer of a fetch that a newer fetch, an event or a mutation
// overtook is returned to its caller but never cached), every mutation marks every scope stale, `update(id,
// { enabled })` alone is optimistic (rolled back on a failure), and an event refetches the lists used in the last
// minute (the others are refetched on their next use). Errors are thrown as `HarnessError` (409 `exists`, 400 with the
// diagnostics in `details`); the editor maps them to its fields.
import type {
  CommandSummary,
  Customization,
  CustomizationCreate,
  CustomizationEntry,
  CustomizationKind,
  CustomizationList,
  CustomizationUpdate,
  ServerEvent,
} from '@harness-forge/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useApi } from '~/composables/useApi'
import { hasErrorCode, withHarnessErrors } from '~/utils/errors'

export interface FetchCatalogOptions {
  /** A cached list younger than this (and not stale) is returned as is; omitted = always fetch. */
  maxAgeMs?: number
  /** Ask the server to rebuild the project's catalog now (`refresh=1`, files edited on disk show at once). */
  refresh?: boolean
}

export interface FetchCommandsOptions {
  /** A cached list younger than this (and not stale) is returned as is; omitted = always fetch. */
  maxAgeMs?: number
}

const NO_ENTRIES: readonly CustomizationEntry[] = Object.freeze([])
const NO_COMMANDS: readonly CommandSummary[] = Object.freeze([])

/** An event refetches at once the lists used (fetched or read through a fetch call) this recently. */
export const CUSTOMIZATIONS_RECENT_MS = 60_000

/**
 * `list` with the personal entries of `overrides` turned on or off (state 'off', or 'active' for an entry that was off);
 * the same object when none of them is in it.
 */
function withEnabled(list: CustomizationList, overrides: Readonly<Record<string, boolean>>): CustomizationList {
  const touched = (entry: CustomizationEntry): boolean => entry.source === 'user' && entry.id !== undefined && Object.hasOwn(overrides, entry.id)
  if (!list.items.some(touched))
    return list
  return {
    ...list,
    items: list.items.map((entry): CustomizationEntry => {
      if (!touched(entry))
        return entry
      const enabled = overrides[entry.id!]!
      if (entry.enabled === enabled)
        return entry
      return { ...entry, enabled, state: enabled ? (entry.state === 'off' ? 'active' : entry.state) : 'off' }
    }),
  }
}

/** The cache key of a scope: the project id, '' for none. */
export function customizationScopeKey(projectId: string | null): string {
  return projectId ?? ''
}

function catalogKey(scope: string): string {
  return `catalog:${scope}`
}

function commandsKey(scope: string): string {
  return `commands:${scope}`
}

export const useCustomizationsStore = defineStore('customizations', () => {
  const api = useApi()

  // ---------- state ----------

  /** The merged catalog per scope (key = projectId ?? ''). */
  const catalogs = ref<Record<string, CustomizationList>>({})
  /** The slash commands of `GET /commands?projectId=` per scope (key = projectId ?? ''). */
  const commands = ref<Record<string, CommandSummary[]>>({})
  /** When each list was cached, per 'catalog:<key>' / 'commands:<key>'. */
  const loadedAt = ref<Record<string, number>>({})
  /** Lists an event or a mutation made stale (refetched on their next use), per 'catalog:<key>' / 'commands:<key>'. */
  const stale = ref<Record<string, true>>({})

  // Not state: bookkeeping of the requests.
  /** Per list key: bumped by every fetch start, event and mutation (an answer applies only when nothing came after it). */
  const versions = new Map<string, number>()
  /** Per list key (+ ':refresh'): the fetch in flight. */
  const pending = new Map<string, Promise<unknown>>()
  /** Per list key: when a caller last asked for it (`fetchCatalog` / `fetchCommands`, cached answers included). */
  const usedAt = new Map<string, number>()
  /**
   * Personal definitions with a `{ enabled }` update in flight and the value they get (not exposed): the getters show
   * every cached catalog with it, so an answer that arrives meanwhile cannot undo the optimistic state, and a failure
   * only has to drop the entry.
   */
  const pendingEnabled = ref<Record<string, boolean>>({})

  // ---------- getters ----------

  /** The cached catalogs as the getters show them (the pending `{ enabled }` updates applied). */
  const shown = computed<Record<string, CustomizationList>>(() => {
    const overrides = pendingEnabled.value
    if (Object.keys(overrides).length === 0)
      return catalogs.value
    const out: Record<string, CustomizationList> = {}
    for (const [scope, list] of Object.entries(catalogs.value))
      out[scope] = withEnabled(list, overrides)
    return out
  })

  /** `catalog(projectId)`: the cached catalog of the scope, or null before its first fetch. */
  const catalog = computed(() => (projectId: string | null): CustomizationList | null =>
    shown.value[customizationScopeKey(projectId)] ?? null)
  /** `personal(kind)`: the personal (`source: 'user'`) entries of a kind in the global catalog. */
  const personal = computed(() => (kind: CustomizationKind): readonly CustomizationEntry[] =>
    shown.value['']?.items.filter(entry => entry.kind === kind && entry.source === 'user') ?? NO_ENTRIES)
  /** `entriesOf(projectId, kind)`: every entry of that kind in the scope (with its project-relative state). */
  const entriesOf = computed(() => (projectId: string | null, kind: CustomizationKind): readonly CustomizationEntry[] =>
    shown.value[customizationScopeKey(projectId)]?.items.filter(entry => entry.kind === kind) ?? NO_ENTRIES)
  /** `slashCommands(projectId)`: the slash commands of the scope; [] until loaded. */
  const slashCommands = computed(() => (projectId: string | null): readonly CommandSummary[] =>
    commands.value[customizationScopeKey(projectId)] ?? NO_COMMANDS)

  // ---------- helpers ----------

  function bump(key: string): number {
    const next = (versions.get(key) ?? 0) + 1
    versions.set(key, next)
    return next
  }

  function isFresh(key: string, maxAgeMs: number | undefined): boolean {
    if (maxAgeMs === undefined || stale.value[key])
      return false
    const at = loadedAt.value[key]
    return at !== undefined && Date.now() - at < maxAgeMs
  }

  function markLoaded(key: string): void {
    loadedAt.value = { ...loadedAt.value, [key]: Date.now() }
    if (stale.value[key]) {
      const { [key]: _stale, ...rest } = stale.value
      stale.value = rest
    }
  }

  /**
   * Marks every cached list stale and overtakes the fetches in flight (a mutation or an event changed the catalog): their
   * answers still reach their callers but are never cached, and the next call starts a new request.
   */
  function markAllStale(): void {
    const next: Record<string, true> = { ...stale.value }
    for (const key of Object.keys(loadedAt.value)) {
      next[key] = true
      bump(key)
    }
    for (const key of pending.keys())
      bump(key.replace(/:refresh$/, ''))
    pending.clear()
    stale.value = next
  }

  /** Runs one fetch per key at a time; callers of the same key share it. */
  function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
    const current = pending.get(key) as Promise<T> | undefined
    if (current)
      return current
    const request = run().finally(() => {
      if (pending.get(key) === request)
        pending.delete(key)
    })
    pending.set(key, request)
    return request
  }

  // ---------- actions: catalog and commands ----------

  /**
   * `GET /customizations?projectId=&refresh=1`: the merged catalog of the scope (single-flight per scope). A cached list
   * younger than `maxAgeMs` and not stale is returned as is. Throws `HarnessError` (404 for an unknown project).
   */
  function fetchCatalog(projectId: string | null, opts: FetchCatalogOptions = {}): Promise<CustomizationList> {
    usedAt.set(catalogKey(customizationScopeKey(projectId)), Date.now())
    return loadCatalog(projectId, opts)
  }

  /** `fetchCatalog` without counting as a use (event and reconnect refetches). */
  function loadCatalog(projectId: string | null, opts: FetchCatalogOptions = {}): Promise<CustomizationList> {
    const scope = customizationScopeKey(projectId)
    const key = catalogKey(scope)
    const cached = catalogs.value[scope]
    if (cached && !opts.refresh && isFresh(key, opts.maxAgeMs))
      return Promise.resolve(cached)
    return singleFlight(opts.refresh ? `${key}:refresh` : key, async () => {
      const version = bump(key)
      const query = {
        ...(projectId === null ? {} : { projectId }),
        ...(opts.refresh ? { refresh: '1' as const } : {}),
      }
      const list = await withHarnessErrors(api.customizations.list({ query }))
      if (versions.get(key) === version) {
        catalogs.value = { ...catalogs.value, [scope]: list }
        markLoaded(key)
      }
      return list
    })
  }

  /**
   * `GET /commands?projectId=`: the slash commands of the scope (the same caching rules). A 404 (a deleted project)
   * caches []. Throws `HarnessError` for other failures.
   */
  function fetchCommands(projectId: string | null, opts: FetchCommandsOptions = {}): Promise<readonly CommandSummary[]> {
    usedAt.set(commandsKey(customizationScopeKey(projectId)), Date.now())
    return loadCommands(projectId, opts)
  }

  /** `fetchCommands` without counting as a use (event and reconnect refetches). */
  function loadCommands(projectId: string | null, opts: FetchCommandsOptions = {}): Promise<readonly CommandSummary[]> {
    const scope = customizationScopeKey(projectId)
    const key = commandsKey(scope)
    const cached = commands.value[scope]
    if (cached && isFresh(key, opts.maxAgeMs))
      return Promise.resolve(cached)
    return singleFlight(key, async () => {
      const version = bump(key)
      let items: CommandSummary[]
      try {
        const query = projectId === null ? {} : { projectId }
        items = (await withHarnessErrors(api.commands.list({ query }))).items
      }
      catch (error) {
        if (!hasErrorCode(error, 'not_found'))
          throw error
        items = []
      }
      if (versions.get(key) === version) {
        commands.value = { ...commands.value, [scope]: items }
        markLoaded(key)
      }
      return items
    })
  }

  // ---------- actions: bodies and personal definitions ----------

  /** `GET /customizations/:id`: a personal definition with its content (the editor). Throws `HarnessError`. */
  function get(id: string): Promise<Customization> {
    return withHarnessErrors(api.customizations.get({ params: { id } }))
  }

  /**
   * The markdown of a catalog entry: personal entries through `get(entry.id)`, the others through
   * `GET /customizations/source?projectId&kind&name&source&path` (`path` = the entry's own file, so a shadowed project
   * file shows its own content). Throws `HarnessError` (404 when the file is gone).
   */
  async function sourceOf(entry: CustomizationEntry, projectId: string | null): Promise<string> {
    if (entry.source === 'user' && entry.id)
      return (await get(entry.id)).content
    const query = {
      ...(projectId === null ? {} : { projectId }),
      kind: entry.kind,
      name: entry.name,
      source: entry.source,
      ...(entry.path === undefined ? {} : { path: entry.path }),
    }
    const result = await withHarnessErrors(api.customizations.source({ query }))
    return result.content
  }

  /**
   * `POST /customizations`: a new personal definition. Marks every scope stale (a personal command changes every
   * scope's command list). Throws `HarnessError` (409 `exists`, 400 with the diagnostics in `details`).
   */
  async function create(body: CustomizationCreate): Promise<Customization> {
    const created = await withHarnessErrors(api.customizations.create({ body }))
    markAllStale()
    return created
  }

  /**
   * `PATCH /customizations/:id` (`content` and / or `enabled`). `{ enabled }` alone is optimistic: every cached catalog
   * shows the new state at once (state 'off', or 'active' until the next fetch says otherwise), answers arriving
   * meanwhile included, and a failure brings the previous state back. Marks every scope stale. Throws `HarnessError`.
   */
  async function update(id: string, patch: CustomizationUpdate): Promise<Customization> {
    const optimistic = patch.enabled !== undefined && patch.content === undefined
    if (optimistic)
      pendingEnabled.value = { ...pendingEnabled.value, [id]: patch.enabled! }
    try {
      const updated = await withHarnessErrors(api.customizations.update({ params: { id }, body: patch }))
      if (optimistic) {
        // Keep showing the new state until the refetch of the stale scopes answers.
        catalogs.value = Object.fromEntries(Object.entries(catalogs.value).map(([scope, list]) => [scope, withEnabled(list, { [id]: updated.enabled })]))
      }
      return updated
    }
    finally {
      if (optimistic) {
        const { [id]: _done, ...rest } = pendingEnabled.value
        pendingEnabled.value = rest
      }
      markAllStale()
    }
  }

  /** `DELETE /customizations/:id`; a 404 counts as removed. Marks every scope stale. Throws `HarnessError`. */
  async function remove(id: string): Promise<void> {
    try {
      await withHarnessErrors(api.customizations.remove({ params: { id } }))
    }
    catch (error) {
      if (!hasErrorCode(error, 'not_found'))
        throw error
    }
    finally {
      markAllStale()
    }
  }

  // ---------- events and reconnects ----------

  /**
   * `customization.changed` and `plugin.changed`: every cached list is stale (refetched on its next use), and the lists
   * used in the last minute are refetched at once (the open Customize page, the composer's slash menu), quietly.
   */
  function applyEvent(event: ServerEvent): void {
    if (event.type !== 'customization.changed' && event.type !== 'plugin.changed')
      return
    markAllStale()
    // Every recently used list, cached or not: a fetch in flight was just overtaken and will not be cached.
    const since = Date.now() - CUSTOMIZATIONS_RECENT_MS
    for (const [key, at] of usedAt) {
      if (at < since)
        continue
      const scope = key.slice(key.indexOf(':') + 1)
      const projectId = scope === '' ? null : scope
      if (key === catalogKey(scope))
        loadCatalog(projectId).catch(() => {})
      else
        loadCommands(projectId).catch(() => {})
    }
  }

  /** Refetches every loaded list (after the event stream reconnects: missed events are not replayed). */
  async function refreshLoaded(): Promise<void> {
    const tasks: Array<Promise<unknown>> = []
    for (const scope of Object.keys(catalogs.value))
      tasks.push(loadCatalog(scope === '' ? null : scope))
    for (const scope of Object.keys(commands.value))
      tasks.push(loadCommands(scope === '' ? null : scope))
    await Promise.allSettled(tasks)
  }

  return {
    catalogs,
    commands,
    loadedAt,
    stale,
    catalog,
    personal,
    entriesOf,
    slashCommands,
    fetchCatalog,
    fetchCommands,
    get,
    sourceOf,
    create,
    update,
    remove,
    applyEvent,
    refreshLoaded,
  }
})
