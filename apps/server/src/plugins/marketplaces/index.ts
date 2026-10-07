// The marketplace service (Phase 12, ADR-054; API.md 5.34, ARCHITECTURE.md 6.34) behind `MarketplaceService`
// (./types.ts). Owner: W12.2.
//
// - `list`: the stored rows (no network), the suggestions not added yet (matched by name or source) and the installed
//   plugins with an update available (`updates.ts`, from the stored catalogs and the `plugins` rows).
// - `add`: `HF_OFFLINE=1` refuses `github` / `url` sources (409 `offline`); at most `LIMITS.marketplacesMax` (409
//   `exists`); the source is fetched at once (`fetch.ts`: a GitHub ref resolved to its commit, a hosted JSON, a server
//   folder) and parsed (`catalog.ts`); a reserved name (`isOfficialMarketplaceName`) is accepted only from a repository of
//   `anthropics` (400); a taken name is 409 `exists`; nothing is stored when any of this fails.
// - `refresh`: fetches again; a failure keeps the stored catalog, stores `lastError` (and emits) and throws; a
//   `marketplace.json` that now has another name is refused like a failure (installed plugins name the marketplace).
//   Plugins whose update state changed get `plugin.changed`.
// - `remove`: the row only; installed plugins keep their (now dangling) origin.
// - `stop`: aborts the fetches in flight; an add whose fetch was aborted stores nothing.
// Writes are serialized (one mutex) so the name and count checks hold. Every add, refresh and remove emits
// `marketplace.changed`. Logs carry the marketplace id, its name, the repository and a 12-character sha only.
import type { MarketplaceDetail, MarketplaceList, MarketplaceSource, MarketplaceSummary } from '@harness-forge/shared'
import type { SafeFetch } from '../../security/types.ts'
import type { AppDeps } from '../../types.ts'
import type { PluginRecord } from '../types.ts'
import type { MarketplaceFetchResult, StoredMarketplace } from './store.ts'
import type { MarketplaceService, MarketplaceServiceOptions } from './types.ts'
import {
  HarnessError,
  isOfficialMarketplaceName,
  LIMITS,
  MARKETPLACE_SUGGESTIONS,
  OFFICIAL_MARKETPLACE_OWNER,
} from '@harness-forge/shared'
import { createPluginSourceFetch } from '../../security/ssrf.ts'
import { createMutex } from '../install/lock.ts'
import { createPluginRecordStore } from '../state.ts'
import { diagnosticDtos, entryDto, readCatalog } from './catalog.ts'
import { fetchMarketplaceSource } from './fetch.ts'
import { githubBases, isRepoOfOwner, shortSha } from './github.ts'
import { createMarketplaceStore } from './store.ts'
import { hasUpdate, installedEntries, updatesOf } from './updates.ts'

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

/** Two sources name the same marketplace (GitHub repositories compare without case and ref). */
export function sameMarketplaceSource(a: MarketplaceSource, b: MarketplaceSource): boolean {
  if (a.type === 'github' && b.type === 'github')
    return a.repo.toLowerCase() === b.repo.toLowerCase()
  if (a.type === 'url' && b.type === 'url')
    return a.url === b.url
  if (a.type === 'path' && b.type === 'path')
    return a.path === b.path
  return false
}

/** The detail DTO of a stored marketplace with the install state of its entries. */
export function marketplaceDetail(row: StoredMarketplace, records: readonly PluginRecord[]): MarketplaceDetail {
  const installed = installedEntries(records, row)
  const plugins = row.catalog?.marketplace.plugins ?? []
  const entries = plugins.slice(0, LIMITS.marketplaceEntriesMax).map((entry) => {
    const plugin = installed.get(entry.name)
    return entryDto(entry, row.source, {
      installedPluginId: plugin?.pluginId ?? null,
      updateAvailable: plugin !== undefined && hasUpdate(entry, plugin, row),
    })
  })
  const marketplace = row.catalog?.marketplace
  const owner = marketplace?.owner.name.trim() ?? ''
  return {
    id: row.id,
    name: row.name,
    description: marketplace?.description === undefined ? null : clip(marketplace.description, 1000),
    owner: owner === '' ? null : clip(owner, 200),
    source: row.source,
    resolvedRef: row.resolvedRef,
    plugins: entries.length,
    updates: entries.filter(entry => entry.updateAvailable).length,
    fetchedAt: row.fetchedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    entries,
    diagnostics: diagnosticDtos(row.catalog?.diagnostics ?? []),
  }
}

/** The summary part of a detail (`marketplace.changed`, list items). */
export function summaryOf(detail: MarketplaceDetail): MarketplaceSummary {
  const { entries: _entries, diagnostics: _diagnostics, ...summary } = detail
  return summary
}

function offlineError(): HarnessError {
  return new HarnessError({
    code: 'conflict',
    message: 'This server is offline (HF_OFFLINE=1): GitHub and URL marketplaces cannot be fetched. Folder marketplaces still work.',
    details: { reason: 'offline' },
  })
}

function reservedNameError(name: string): HarnessError {
  const message = `The marketplace name "${name}" is reserved for the official marketplaces of ${OFFICIAL_MARKETPLACE_OWNER}; only repositories of ${OFFICIAL_MARKETPLACE_OWNER} can use it.`
  return new HarnessError({ code: 'validation_error', message, details: { issues: [{ path: ['source'], message, code: 'custom' }] } })
}

function stoppedError(): HarnessError {
  return new HarnessError({ code: 'provider_unreachable', message: 'The server is shutting down: the marketplace was not fetched.' })
}

/** Log fields of a marketplace: the id, the name, the repository and a 12-character sha (never the JSON). */
function logFields(row: Pick<StoredMarketplace, 'id' | 'name' | 'source' | 'resolvedRef'>): Record<string, unknown> {
  return {
    marketplaceId: row.id,
    name: row.name,
    type: row.source.type,
    ...(row.source.type === 'github' ? { repo: row.source.repo } : {}),
    ...(row.source.type === 'github' && row.resolvedRef !== null ? { sha: shortSha(row.resolvedRef) } : {}),
  }
}

export function createMarketplaceService(deps: AppDeps, options: MarketplaceServiceOptions = {}): MarketplaceService {
  const store = createMarketplaceStore(deps.db)
  const records = createPluginRecordStore(deps.db)
  const bases = githubBases(options)
  const lock = createMutex()
  const inflight = new Set<AbortController>()
  let fetcher: SafeFetch | null = options.safeFetch ?? null
  let stopped = false

  /** The guarded fetch: the option (tests), else the plugin-source fetch (`HF_TEST_REMOTE_URL` routing, https only). */
  function safeFetch(): SafeFetch {
    fetcher ??= createPluginSourceFetch({ testRemoteUrl: deps.env.testRemoteUrl })
    return fetcher
  }

  async function withAbort<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (stopped)
      throw stoppedError()
    const controller = new AbortController()
    inflight.add(controller)
    try {
      const result = await fn(controller.signal)
      if (controller.signal.aborted)
        throw stoppedError()
      return result
    }
    catch (error) {
      if (controller.signal.aborted)
        throw stoppedError()
      throw error
    }
    finally {
      inflight.delete(controller)
    }
  }

  /** Fetches and parses a source; refuses `HF_OFFLINE` and reserved names. */
  async function fetchCatalog(source: MarketplaceSource): Promise<MarketplaceFetchResult> {
    if (deps.env.offline && source.type !== 'path')
      throw offlineError()
    const fetched = await withAbort(signal => fetchMarketplaceSource(source, { safeFetch: safeFetch(), bases, dataRoot: deps.env.paths.root, signal }))
    const catalog = readCatalog(fetched.bytes)
    const name = catalog.marketplace.name
    if (isOfficialMarketplaceName(name) && !(source.type === 'github' && isRepoOfOwner(source.repo, OFFICIAL_MARKETPLACE_OWNER)))
      throw reservedNameError(name)
    return { name, resolvedRef: fetched.resolvedRef, catalog }
  }

  async function detailOf(row: StoredMarketplace): Promise<MarketplaceDetail> {
    return marketplaceDetail(row, await records.list())
  }

  function emitChanged(id: string, detail: MarketplaceDetail | null): void {
    try {
      deps.events.emit('marketplace.changed', { id, marketplace: detail === null ? null : summaryOf(detail) })
    }
    catch (error) {
      deps.logger.warn('cannot emit marketplace.changed', { marketplaceId: id, err: error })
    }
  }

  async function storedOrThrow(id: string): Promise<StoredMarketplace> {
    const row = await store.get(id)
    if (row === null)
      throw new HarnessError({ code: 'not_found', message: `Marketplace ${id} not found.` })
    return row
  }

  /** `plugin.changed` for the plugins whose update state differs between `before` and `after`. */
  async function emitUpdateChanges(before: ReadonlySet<string>, after: ReadonlySet<string>): Promise<void> {
    const changed = [...before].filter(id => !after.has(id)).concat([...after].filter(id => !before.has(id)))
    for (const id of changed.sort()) {
      try {
        deps.events.emit('plugin.changed', { id, plugin: await deps.plugins.summary(id) })
      }
      catch {
        // The plugin was removed meanwhile: nothing to update.
      }
    }
  }

  const service: MarketplaceService = {
    list: async (): Promise<MarketplaceList> => {
      const rows = await store.list()
      const pluginRecords = await records.list()
      const items = rows.map(row => summaryOf(marketplaceDetail(row, pluginRecords)))
      const suggestions = MARKETPLACE_SUGGESTIONS.filter(suggestion => !rows.some(row => row.name === suggestion.name || sameMarketplaceSource(row.source, suggestion.source)))
      const updates = rows.flatMap(row => updatesOf(row, pluginRecords)).slice(0, 1000)
      return { items, suggestions: [...suggestions], updates }
    },

    add: async ({ source }) => {
      if (deps.env.offline && source.type !== 'path')
        throw offlineError()
      if (await store.count() >= LIMITS.marketplacesMax)
        throw new HarnessError({ code: 'conflict', message: `At most ${LIMITS.marketplacesMax} marketplaces can be added; remove one first.`, details: { reason: 'exists' } })
      const fetched = await fetchCatalog(source)
      const row = await lock(async () => {
        if (stopped)
          throw stoppedError()
        const rows = await store.list()
        if (rows.some(existing => existing.name === fetched.name))
          throw new HarnessError({ code: 'conflict', message: `A marketplace named "${fetched.name}" is already added.`, details: { reason: 'exists' } })
        if (rows.length >= LIMITS.marketplacesMax)
          throw new HarnessError({ code: 'conflict', message: `At most ${LIMITS.marketplacesMax} marketplaces can be added; remove one first.`, details: { reason: 'exists' } })
        return store.insert(source, fetched)
      })
      const detail = await detailOf(row)
      deps.logger.info('marketplace added', logFields(row))
      emitChanged(row.id, detail)
      return detail
    },

    get: async id => detailOf(await storedOrThrow(id)),

    refresh: async (id) => {
      const current = await storedOrThrow(id)
      const before = new Set(updatesOf(current, await records.list()).map(update => update.pluginId))
      let fetched: MarketplaceFetchResult
      try {
        fetched = await fetchCatalog(current.source)
        if (fetched.name !== current.name)
          throw new HarnessError({ code: 'validation_error', message: `The marketplace is now named "${fetched.name}" instead of "${current.name}": remove it and add it again.` })
      }
      catch (error) {
        const failure = HarnessError.from(error)
        const failed = await lock(() => store.saveError(id, failure.toJSON().error))
        if (failed !== null) {
          emitChanged(id, await detailOf(failed))
          deps.logger.warn('marketplace refresh failed', { ...logFields(failed), code: failure.code })
        }
        throw failure
      }
      const row = await lock(() => store.saveFetch(id, fetched))
      if (row === null)
        throw new HarnessError({ code: 'not_found', message: `Marketplace ${id} not found.` })
      const pluginRecords = await records.list()
      const detail = marketplaceDetail(row, pluginRecords)
      deps.logger.info('marketplace refreshed', logFields(row))
      emitChanged(id, detail)
      await emitUpdateChanges(before, new Set(updatesOf(row, pluginRecords).map(update => update.pluginId)))
      return detail
    },

    remove: async (id) => {
      const row = await storedOrThrow(id)
      const removed = await lock(() => store.remove(id))
      if (!removed)
        throw new HarnessError({ code: 'not_found', message: `Marketplace ${id} not found.` })
      deps.logger.info('marketplace removed', logFields(row))
      emitChanged(id, null)
    },

    stop: async () => {
      stopped = true
      for (const controller of inflight)
        controller.abort()
      inflight.clear()
    },
  }
  return Object.freeze(service)
}
