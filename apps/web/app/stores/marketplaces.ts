// Marketplaces store (Phase 12, ADR-054; docs/UI.md 5.4, 8.13, 11.9; docs/API.md 4.33): the added Claude Code
// marketplaces (`GET /marketplaces`: `{ items, suggestions, updates }`, answered from the stored catalogs, no network),
// their details with the entries (`GET /marketplaces/:id`), add, refresh and remove, and the updates of installed plugins
// (the nav badge, the card badge, the detail banner). The only reader of the marketplace routes; no request runs before a
// page or the nav asks.
// Signature frozen from Gate P12-0b (C46); implementation W12.8 (P12-A):
// - single flight per key (the list, each detail): concurrent fetches share one request;
// - per-key versions: every fetch start, event and mutation bumps the key's version, and an answer is cached only when
//   nothing came after it (it still reaches its caller), so an answer older than the last event never wins; an event
//   that overtakes a request in flight queues one more request for that key (at most one in flight, one queued);
// - `maxAgeMs`: a cached answer younger than this and not marked stale by an event is returned as is;
// - `marketplace.changed` replaces or drops the summary (and the summary part of a loaded detail; a new commit or fetch
//   time refetches the detail's entries); `plugin.changed` marks the list and every loaded detail stale (installed and
//   update states) and refetches them quietly; a reconnect (`refreshLoaded`) refetches everything that was loaded;
// - `updateCount` is the length of `updates` of `GET /marketplaces`.
import type {
  HarnessError,
  MarketplaceDetail,
  MarketplaceList,
  MarketplaceSource,
  MarketplaceSummary,
  PluginUpdate,
  ServerEvent,
} from '@harness-forge/shared'
import type { MarketplaceEntryView } from '~/components/plugins/marketplaces/marketplaces'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { entryState } from '~/components/plugins/marketplaces/marketplaces'
import { useApi } from '~/composables/useApi'
import { hasErrorCode, toHarnessError, withHarnessErrors } from '~/utils/errors'
import { omitKey } from '~/utils/records'
import { usePluginsStore } from './plugins'

export interface FetchMarketplacesOptions {
  /** A cached answer younger than this (and not stale) is returned as is; omitted = always fetch. */
  maxAgeMs?: number
}

/** One failed marketplace of `refreshAll()`. */
export interface MarketplaceRefreshFailure {
  id: string
  /** The marketplace name when the refresh started. */
  name: string
  error: HarnessError
}

/** What `refreshAll()` rejects with: an `AggregateError` of the failed refreshes, with their marketplaces. */
export class MarketplacesRefreshError extends AggregateError {
  readonly failures: readonly MarketplaceRefreshFailure[]

  constructor(failures: readonly MarketplaceRefreshFailure[]) {
    super(failures.map(failure => failure.error), `${failures.length} ${failures.length === 1 ? 'marketplace' : 'marketplaces'} could not be refreshed.`)
    this.name = 'MarketplacesRefreshError'
    this.failures = failures
  }
}

const NO_ITEMS: readonly MarketplaceSummary[] = Object.freeze([])
const NO_UPDATES: readonly PluginUpdate[] = Object.freeze([])

/** The request key of the list; details use `detail:<id>`. */
const LIST_KEY = 'list'
const DETAIL_PREFIX = 'detail:'

function detailKey(id: string): string {
  return `${DETAIL_PREFIX}${id}`
}

/** The summary part of a detail (without its entries and diagnostics). */
function summaryOf(detail: MarketplaceDetail): MarketplaceSummary {
  const { entries: _entries, diagnostics: _diagnostics, ...summary } = detail
  return summary
}

/** The repository or location a source names (the suggestion of a source counts as added when this matches). */
function sameSource(a: MarketplaceSource, b: MarketplaceSource): boolean {
  if (a.type === 'github' && b.type === 'github')
    return a.repo.toLowerCase() === b.repo.toLowerCase()
  if (a.type === 'url' && b.type === 'url')
    return a.url === b.url
  if (a.type === 'path' && b.type === 'path')
    return a.path === b.path
  return false
}

export const useMarketplacesStore = defineStore('marketplaces', () => {
  const api = useApi()

  // ---------- state ----------

  /** `GET /marketplaces`; null before the first fetch. */
  const list = ref<MarketplaceList | null>(null)
  /** The fetched details by marketplace id. */
  const details = ref<Record<string, MarketplaceDetail>>({})
  /** When the list was cached. */
  const loadedAt = ref<number | null>(null)
  /** Marketplaces with a refresh or remove in flight. */
  const busy = ref<Record<string, true>>({})

  // Not state: bookkeeping of the requests, per key (`list`, `detail:<id>`).
  /** Bumped by every fetch start, event and mutation (an answer is cached only when nothing came after it). */
  const versions = new Map<string, number>()
  /** The request in flight. */
  const inFlight = new Map<string, Promise<unknown>>()
  /** Keys an event overtook while a request was in flight: one more request runs when it settles. */
  const rerun = new Set<string>()
  /** Keys an event made stale (fetched again on their next use, whatever `maxAgeMs` says). */
  const stale = new Set<string>()
  /** When each detail was cached. */
  const detailLoadedAt = new Map<string, number>()

  // ---------- getters ----------

  const items = computed<readonly MarketplaceSummary[]>(() => list.value?.items ?? NO_ITEMS)
  /** `byId(id)`: one marketplace, or null. */
  const byId = computed(() => (id: string): MarketplaceSummary | null => items.value.find(item => item.id === id) ?? null)
  const updates = computed<readonly PluginUpdate[]>(() => list.value?.updates ?? NO_UPDATES)
  /** `updateOf(pluginId)`: the update a marketplace offers for an installed plugin, or null. */
  const updateOf = computed(() => (pluginId: string): PluginUpdate | null => updates.value.find(update => update.pluginId === pluginId) ?? null)
  /** Installed plugins with an update (the nav badge). */
  const updateCount = computed(() => updates.value.length)
  /**
   * `entries(id)`: the entries of a loaded marketplace with their state; `entries(null)`: those of every loaded
   * marketplace (All), by marketplace order. Sorted by name within a marketplace.
   */
  const entries = computed(() => (id: string | null): MarketplaceEntryView[] => {
    const plugins = usePluginsStore().items
    const ids = id === null ? items.value.map(item => item.id).filter(key => key in details.value) : [id]
    return ids.flatMap((key) => {
      const detail = details.value[key]
      if (!detail)
        return []
      return [...detail.entries]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry): MarketplaceEntryView => {
          const pluginId = entry.installedPluginId
          const plugin = pluginId === null ? undefined : plugins.find(item => item.id === pluginId)
          return {
            marketplaceId: detail.id,
            marketplaceName: detail.name,
            entry,
            state: entryState(entry, detail.id, plugins, updates.value),
            pluginId,
            installedVersion: plugin?.version ?? null,
            update: pluginId === null ? null : updates.value.find(update => update.pluginId === pluginId && update.marketplaceId === detail.id) ?? null,
          }
        })
    })
  })

  // ---------- request bookkeeping ----------

  function bump(key: string): number {
    const next = (versions.get(key) ?? 0) + 1
    versions.set(key, next)
    return next
  }

  /** Something newer than the request in flight happened: its answer is not cached, and one more request follows it. */
  function touch(key: string): void {
    bump(key)
    if (inFlight.has(key))
      rerun.add(key)
  }

  /** The key is loaded (or loading): an event that changes it refetches it. */
  function tracked(key: string): boolean {
    if (inFlight.has(key))
      return true
    if (key === LIST_KEY)
      return list.value !== null
    return key.slice(DETAIL_PREFIX.length) in details.value
  }

  /** Marks a tracked key stale and fetches it again (quietly; coalesced with the request in flight). */
  function invalidate(key: string): void {
    if (!tracked(key))
      return
    stale.add(key)
    touch(key)
    if (!inFlight.has(key))
      void reload(key).catch(() => {})
  }

  function reload(key: string): Promise<unknown> {
    return key === LIST_KEY ? loadList() : loadDetail(key.slice(DETAIL_PREFIX.length))
  }

  /**
   * One request per key at a time. The answer is cached (`save`) only when no event or mutation came after it started;
   * a failure is handled (`fail`) under the same rule. Either way it reaches the caller.
   */
  function load<T>(key: string, request: () => Promise<T>, save: (value: T) => void, fail?: (error: unknown) => void): Promise<T> {
    const current = inFlight.get(key)
    if (current)
      return current as Promise<T>
    const version = bump(key)
    const promise: Promise<T> = (async () => {
      try {
        const value = await request()
        if (versions.get(key) === version) {
          stale.delete(key)
          save(value)
        }
        return value
      }
      catch (error) {
        if (versions.get(key) === version)
          fail?.(error)
        throw error
      }
    })().finally(() => {
      if (inFlight.get(key) !== promise)
        return
      inFlight.delete(key)
      // A rerun was queued for a tracked key; `forget` cancels the reruns of a dropped marketplace.
      if (rerun.delete(key))
        void reload(key).catch(() => {})
    })
    inFlight.set(key, promise)
    return promise
  }

  // ---------- cache helpers ----------

  function setBusy(id: string, value: boolean): void {
    busy.value = value ? { ...busy.value, [id]: true } : omitKey(busy.value, id)
  }

  /** Replaces or appends a summary in the loaded list (a list in flight is overtaken). */
  function upsertSummary(summary: MarketplaceSummary): void {
    touch(LIST_KEY)
    const current = list.value
    if (!current)
      return
    const exists = current.items.some(item => item.id === summary.id)
    list.value = {
      ...current,
      items: exists ? current.items.map(item => (item.id === summary.id ? summary : item)) : [...current.items, summary],
    }
  }

  function storeDetail(detail: MarketplaceDetail): void {
    details.value = { ...details.value, [detail.id]: detail }
    detailLoadedAt.set(detail.id, Date.now())
  }

  /** A detail from a mutation (add, refresh): newer than any detail request in flight, which it overtakes. */
  function applyDetail(detail: MarketplaceDetail): MarketplaceDetail {
    const key = detailKey(detail.id)
    bump(key)
    inFlight.delete(key)
    rerun.delete(key)
    stale.delete(key)
    storeDetail(detail)
    upsertSummary(summaryOf(detail))
    return detail
  }

  /** Drops a marketplace (removed, or a 404): its summary, its detail and its request bookkeeping. */
  function forget(id: string): void {
    const key = detailKey(id)
    bump(key)
    inFlight.delete(key)
    rerun.delete(key)
    stale.delete(key)
    detailLoadedAt.delete(id)
    if (id in details.value)
      details.value = omitKey(details.value, id)
    touch(LIST_KEY)
    if (list.value?.items.some(item => item.id === id))
      list.value = { ...list.value, items: list.value.items.filter(item => item.id !== id) }
  }

  function loadList(): Promise<MarketplaceList> {
    return load(LIST_KEY, () => withHarnessErrors(api.marketplaces.list()), (next) => {
      list.value = next
      loadedAt.value = Date.now()
    })
  }

  function loadDetail(id: string): Promise<MarketplaceDetail> {
    return load(
      detailKey(id),
      () => withHarnessErrors(api.marketplaces.get({ params: { id } })),
      // Only the detail: the list keeps its own answers and events (a detail fetched before them must not win there).
      storeDetail,
      (error) => {
        if (hasErrorCode(error, 'not_found'))
          forget(id)
      },
    )
  }

  // ---------- actions ----------

  /**
   * `GET /marketplaces` (single flight); a cached list younger than `maxAgeMs` and not stale is returned as is. Throws
   * `HarnessError`.
   */
  function fetchAll(opts: FetchMarketplacesOptions = {}): Promise<MarketplaceList> {
    const cached = list.value
    if (cached && opts.maxAgeMs !== undefined && loadedAt.value !== null && !stale.has(LIST_KEY) && Date.now() - loadedAt.value < opts.maxAgeMs)
      return Promise.resolve(cached)
    return loadList()
  }

  /**
   * `GET /marketplaces/:id` into `details[id]` (single flight per id); a cached detail younger than `maxAgeMs` and not
   * stale is returned as is. A 404 drops the marketplace. Throws `HarnessError`.
   */
  async function fetch(id: string, opts: FetchMarketplacesOptions = {}): Promise<MarketplaceDetail> {
    const cached = details.value[id]
    const at = detailLoadedAt.get(id)
    if (cached && opts.maxAgeMs !== undefined && at !== undefined && !stale.has(detailKey(id)) && Date.now() - at < opts.maxAgeMs)
      return cached
    return loadDetail(id)
  }

  /**
   * `POST /marketplaces { source }`: the server fetches the marketplace at once and stores nothing on failure. Throws
   * `HarnessError` (409 `exists` / `offline`, 404, 413, 429, 502, 400 with their codes).
   */
  async function add(source: MarketplaceSource): Promise<MarketplaceDetail> {
    const detail = applyDetail(await withHarnessErrors(api.marketplaces.add({ body: { source } })))
    if (list.value) {
      list.value = {
        ...list.value,
        suggestions: list.value.suggestions.filter(suggestion => suggestion.name !== detail.name && !sameSource(suggestion.source, detail.source)),
      }
    }
    return detail
  }

  /**
   * `POST /marketplaces/:id/refresh` (busy while it runs). A failure keeps the stored catalog (the server records it as
   * `lastError`: the list is fetched again quietly); a 404 drops the marketplace. Throws `HarnessError`.
   */
  async function refresh(id: string): Promise<MarketplaceDetail> {
    setBusy(id, true)
    try {
      return applyDetail(await withHarnessErrors(api.marketplaces.refresh({ params: { id } })))
    }
    catch (error) {
      if (hasErrorCode(error, 'not_found'))
        forget(id)
      else
        invalidate(LIST_KEY)
      throw error
    }
    finally {
      setBusy(id, false)
    }
  }

  /**
   * Refreshes every marketplace, one after the other. The failures are collected: after the last one it rejects with a
   * `MarketplacesRefreshError` (an `AggregateError` that also names each failed marketplace).
   */
  async function refreshAll(): Promise<void> {
    const failures: MarketplaceRefreshFailure[] = []
    for (const item of [...items.value]) {
      try {
        await refresh(item.id)
      }
      catch (error) {
        failures.push({ id: item.id, name: item.name, error: toHarnessError(error) })
      }
    }
    if (failures.length > 0)
      throw new MarketplacesRefreshError(failures)
  }

  /**
   * `DELETE /marketplaces/:id` (a 404 counts as removed); the plugins installed from it stay. The list is fetched again
   * quietly (a removed suggested marketplace is suggested again). Throws `HarnessError`.
   */
  async function remove(id: string): Promise<void> {
    setBusy(id, true)
    try {
      await withHarnessErrors(api.marketplaces.remove({ params: { id } }))
    }
    catch (error) {
      if (!hasErrorCode(error, 'not_found'))
        throw error
    }
    finally {
      setBusy(id, false)
    }
    forget(id)
    invalidate(LIST_KEY)
  }

  /**
   * `marketplace.changed`: replaces the summary (and the summary part of a loaded detail; a new commit or fetch time
   * refetches its entries) or drops both (`marketplace: null`); `plugin.changed`: the installed and update states of the
   * list and of every loaded detail are stale, so they are fetched again, quietly.
   */
  function applyEvent(event: ServerEvent): void {
    if (event.type === 'marketplace.changed') {
      const { id, marketplace } = event.data
      if (marketplace === null) {
        forget(id)
        return
      }
      if (list.value)
        upsertSummary(marketplace)
      else
        invalidate(LIST_KEY)
      const key = detailKey(id)
      const detail = details.value[id]
      if (detail) {
        details.value = { ...details.value, [id]: { ...detail, ...marketplace } }
        if (detail.resolvedRef !== marketplace.resolvedRef || detail.fetchedAt !== marketplace.fetchedAt)
          invalidate(key)
        else
          touch(key)
      }
      else if (inFlight.has(key)) {
        invalidate(key)
      }
    }
    else if (event.type === 'plugin.changed') {
      invalidate(LIST_KEY)
      for (const key of new Set([...Object.keys(details.value).map(detailKey), ...[...inFlight.keys()].filter(key => key.startsWith(DETAIL_PREFIX))]))
        invalidate(key)
    }
  }

  /** Refetches the loaded list and details (after the event stream reconnects: missed events are not replayed). */
  async function refreshLoaded(): Promise<void> {
    const keys = [LIST_KEY, ...Object.keys(details.value).map(detailKey)].filter(tracked)
    const tasks = keys.map((key) => {
      // A request in flight may predate the missed events: a new one replaces it.
      stale.add(key)
      bump(key)
      inFlight.delete(key)
      rerun.delete(key)
      return reload(key)
    })
    await Promise.allSettled(tasks)
  }

  return {
    list,
    details,
    loadedAt,
    busy,
    items,
    byId,
    entries,
    updates,
    updateOf,
    updateCount,
    fetchAll,
    fetch,
    add,
    refresh,
    refreshAll,
    remove,
    applyEvent,
    refreshLoaded,
  }
})
