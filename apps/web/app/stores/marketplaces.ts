// Marketplaces store (Phase 12, ADR-054; docs/UI.md 5.4, 8.13, 11.9; docs/API.md 4.33): the added Claude Code
// marketplaces (`GET /marketplaces`: `{ items, suggestions, updates }`, answered from the stored catalogs, no network),
// their details with the entries (`GET /marketplaces/:id`), add, refresh and remove, and the updates of installed plugins
// (the nav badge, the card badge, the detail banner). The only reader of the marketplace routes; no request runs before a
// page or the nav asks. `marketplace.changed` replaces or drops a summary (and its detail), `plugin.changed` refetches the
// loaded list and details (installed and update states), a reconnect refetches what was loaded.
// Signature frozen from Gate P12-0b (C46); implementation W12.8 (P12-A). P12-0b: plain requests, `fetchAll` single-flight.
import type {
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
import { hasErrorCode, withHarnessErrors } from '~/utils/errors'
import { omitKey } from '~/utils/records'
import { usePluginsStore } from './plugins'

export interface FetchMarketplacesOptions {
  /** A cached answer younger than this is returned as is; omitted = always fetch. */
  maxAgeMs?: number
}

const NO_ITEMS: readonly MarketplaceSummary[] = Object.freeze([])
const NO_UPDATES: readonly PluginUpdate[] = Object.freeze([])

/** The summary part of a detail (without its entries and diagnostics). */
function summaryOf(detail: MarketplaceDetail): MarketplaceSummary {
  const { entries: _entries, diagnostics: _diagnostics, ...summary } = detail
  return summary
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

  // Not state: bookkeeping of the requests.
  let pendingList: Promise<MarketplaceList> | null = null
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

  // ---------- helpers ----------

  function setBusy(id: string, value: boolean): void {
    busy.value = value ? { ...busy.value, [id]: true } : omitKey(busy.value, id)
  }

  function upsertSummary(summary: MarketplaceSummary): void {
    const current = list.value
    if (!current)
      return
    const exists = current.items.some(item => item.id === summary.id)
    list.value = {
      ...current,
      items: exists ? current.items.map(item => (item.id === summary.id ? summary : item)) : [...current.items, summary],
    }
  }

  function setDetail(detail: MarketplaceDetail): MarketplaceDetail {
    details.value = { ...details.value, [detail.id]: detail }
    detailLoadedAt.set(detail.id, Date.now())
    upsertSummary(summaryOf(detail))
    return detail
  }

  function forget(id: string): void {
    if (list.value)
      list.value = { ...list.value, items: list.value.items.filter(item => item.id !== id) }
    if (id in details.value)
      details.value = omitKey(details.value, id)
    detailLoadedAt.delete(id)
  }

  // ---------- actions ----------

  /** `GET /marketplaces` (single-flight); a cached list younger than `maxAgeMs` is returned as is. Throws `HarnessError`. */
  function fetchAll(opts: FetchMarketplacesOptions = {}): Promise<MarketplaceList> {
    const cached = list.value
    if (cached && opts.maxAgeMs !== undefined && loadedAt.value !== null && Date.now() - loadedAt.value < opts.maxAgeMs)
      return Promise.resolve(cached)
    if (pendingList)
      return pendingList
    const request = withHarnessErrors(api.marketplaces.list())
      .then((next) => {
        list.value = next
        loadedAt.value = Date.now()
        return next
      })
      .finally(() => {
        pendingList = null
      })
    pendingList = request
    return request
  }

  /** `GET /marketplaces/:id` into `details[id]`; a cached detail younger than `maxAgeMs` is returned as is. */
  async function fetch(id: string, opts: FetchMarketplacesOptions = {}): Promise<MarketplaceDetail> {
    const cached = details.value[id]
    const at = detailLoadedAt.get(id)
    if (cached && opts.maxAgeMs !== undefined && at !== undefined && Date.now() - at < opts.maxAgeMs)
      return cached
    return setDetail(await withHarnessErrors(api.marketplaces.get({ params: { id } })))
  }

  /**
   * `POST /marketplaces { source }`: the server fetches the marketplace at once and stores nothing on failure. Throws
   * `HarnessError` (409 `exists` / `offline`, 404, 413, 429, 502, 400 with their codes).
   */
  async function add(source: MarketplaceSource): Promise<MarketplaceDetail> {
    const detail = setDetail(await withHarnessErrors(api.marketplaces.add({ body: { source } })))
    if (list.value)
      list.value = { ...list.value, suggestions: list.value.suggestions.filter(suggestion => suggestion.name !== detail.name) }
    return detail
  }

  /** `POST /marketplaces/:id/refresh` (busy while it runs). Throws `HarnessError`. */
  async function refresh(id: string): Promise<MarketplaceDetail> {
    setBusy(id, true)
    try {
      return setDetail(await withHarnessErrors(api.marketplaces.refresh({ params: { id } })))
    }
    finally {
      setBusy(id, false)
    }
  }

  /**
   * Refreshes every marketplace, one after the other. The failures are collected: after the last one it rejects with an
   * `AggregateError` of them (their summaries also carry `lastError` once the list is refetched).
   */
  async function refreshAll(): Promise<void> {
    const failures: unknown[] = []
    for (const item of [...items.value]) {
      try {
        await refresh(item.id)
      }
      catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, `${failures.length} marketplaces could not be refreshed.`)
  }

  /** `DELETE /marketplaces/:id` (a 404 counts as removed); the plugins installed from it stay. Throws `HarnessError`. */
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
  }

  /**
   * `marketplace.changed`: replaces the summary (and the summary part of a loaded detail) or drops both
   * (`marketplace: null`); `plugin.changed`: refetches the loaded list and details (installed and update states), quietly.
   */
  function applyEvent(event: ServerEvent): void {
    if (event.type === 'marketplace.changed') {
      const { id, marketplace } = event.data
      if (marketplace === null) {
        forget(id)
        return
      }
      upsertSummary(marketplace)
      const detail = details.value[id]
      if (detail) {
        details.value = { ...details.value, [id]: { ...detail, ...marketplace } }
        if (detail.resolvedRef !== marketplace.resolvedRef || detail.fetchedAt !== marketplace.fetchedAt)
          fetch(id).catch(() => {})
      }
    }
    else if (event.type === 'plugin.changed') {
      if (list.value)
        fetchAll().catch(() => {})
      for (const id of Object.keys(details.value))
        fetch(id).catch(() => {})
    }
  }

  /** Refetches the loaded list and details (after the event stream reconnects: missed events are not replayed). */
  async function refreshLoaded(): Promise<void> {
    const tasks: Array<Promise<unknown>> = []
    if (list.value)
      tasks.push(fetchAll())
    for (const id of Object.keys(details.value))
      tasks.push(fetch(id))
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
