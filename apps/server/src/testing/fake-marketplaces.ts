// Test double of `MarketplaceService` (Phase 12, C43-T9), so the marketplace routes, the web contract and the installer's
// marketplace source can be tested without a network or a store:
//
//   const t = await createTestApp({ marketplaces: 'fake' })      // or overrides: { marketplaces: createFakeMarketplaceService() }
//   const fake = t.deps.marketplaces as FakeMarketplaceService
//   fake.remotes.set(marketplaceSourceKey({ type: 'github', repo: 'acme/tools' }), { name: 'acme', entries: [fakeMarketplaceEntry('lint')] })
//   await fake.add({ source: { type: 'github', repo: 'acme/tools' } })   // stored; `marketplace.changed`
//
// A source is "fetched" from `remotes` (key `marketplaceSourceKey(source)`): a remote catalog, or a `HarnessError` the
// fetch fails with; an unknown source is `not_found`. The contract is followed in memory: `HF_OFFLINE` (`offline`)
// refuses `github` / `url` sources with 409 `offline`; a taken name or `LIMITS.marketplacesMax` marketplaces is 409
// `exists`; a reserved name (`isReservedMarketplaceName`) from outside `anthropics/*` is 400; a failed refresh keeps the
// catalog and stores `lastError`; remove keeps nothing else. Every change emits `marketplace.changed` on
// `options.events`. `list` answers the suggestions not added yet and `updates` (tests set them). Every call is counted.
import type {
  ClaudeDiagnostic,
  MarketplaceDetail,
  MarketplaceEntry,
  MarketplaceList,
  MarketplaceSource,
  MarketplaceSummary,
  PluginUpdate,
} from '@harness-forge/shared'
import type { MarketplaceService } from '../plugins/marketplaces/types.ts'
import type { EventBus } from '../services/events/types.ts'
import {
  createMarketplaceId,
  HarnessError,
  isReservedMarketplaceName,
  LIMITS,
  MARKETPLACE_SUGGESTIONS,
  OFFICIAL_MARKETPLACE_OWNER,
} from '@harness-forge/shared'

/** What a fake remote serves for a marketplace source. */
export interface FakeMarketplaceRemote {
  /** The `marketplace.json` name. */
  readonly name: string
  readonly description?: string | null
  readonly owner?: string | null
  /** The resolved ref (a 40-hex commit for GitHub, a sha256 for a URL); default by source type (`path`: null). */
  readonly resolvedRef?: string | null
  readonly entries?: readonly MarketplaceEntry[]
  readonly diagnostics?: readonly ClaudeDiagnostic[]
}

export interface FakeMarketplaceServiceOptions {
  /** Remote catalogs (or the error a fetch fails with) by `marketplaceSourceKey(source)`. */
  remotes?: Readonly<Record<string, FakeMarketplaceRemote | HarnessError>>
  /** `HF_OFFLINE=1` (default false). */
  offline?: boolean
  /** Receives `marketplace.changed` (default: no events). */
  events?: Pick<EventBus, 'emit'>
  /** Clock (epoch ms; default `Date.now`). */
  now?: () => number
}

export interface FakeMarketplaceService extends MarketplaceService {
  /** Remote catalogs (or errors) by `marketplaceSourceKey(source)`; tests may edit them (a refresh reads them again). */
  readonly remotes: Map<string, FakeMarketplaceRemote | HarnessError>
  /** Stored marketplaces by id. */
  readonly stored: Map<string, MarketplaceDetail>
  /** The plugin updates `list` answers (also counted per marketplace); tests may edit them. */
  readonly updates: PluginUpdate[]
  /** `HF_OFFLINE=1`; tests may flip it. */
  offline: boolean
  /** Number of calls of each member. */
  readonly calls: Record<keyof MarketplaceService, number>
}

/** The key of a source in `FakeMarketplaceService.remotes`: `github:<repo>[#<ref>]`, `url:<url>` or `path:<path>`. */
export function marketplaceSourceKey(source: MarketplaceSource): string {
  switch (source.type) {
    case 'github':
      return `github:${source.repo.toLowerCase()}${source.ref === undefined ? '' : `#${source.ref}`}`
    case 'url':
      return `url:${source.url}`
    case 'path':
      return `path:${source.path}`
  }
}

/** A supported, not installed marketplace entry (a relative source), then `fields`. */
export function fakeMarketplaceEntry(name: string, fields: Partial<MarketplaceEntry> = {}): MarketplaceEntry {
  return {
    name,
    description: `The ${name} plugin.`,
    version: '1.0.0',
    category: null,
    tags: [],
    author: null,
    source: { kind: 'relative', text: `./plugins/${name}` },
    supported: true,
    installedPluginId: null,
    updateAvailable: false,
    ...fields,
  }
}

function notFound(id: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `Marketplace ${id} not found.` })
}

function conflict(message: string, reason: 'exists' | 'offline'): HarnessError {
  return new HarnessError({ code: 'conflict', message, details: { reason } })
}

function sameSource(a: MarketplaceSource, b: MarketplaceSource): boolean {
  return marketplaceSourceKey(a) === marketplaceSourceKey(b)
}

function defaultResolvedRef(source: MarketplaceSource): string | null {
  return source.type === 'github' ? 'a'.repeat(40) : source.type === 'url' ? 'b'.repeat(64) : null
}

function summaryOf(detail: MarketplaceDetail): MarketplaceSummary {
  const { entries: _entries, diagnostics: _diagnostics, ...summary } = detail
  return summary
}

export function createFakeMarketplaceService(options: FakeMarketplaceServiceOptions = {}): FakeMarketplaceService {
  const now = options.now ?? Date.now
  const remotes = new Map(Object.entries(options.remotes ?? {}))
  const stored = new Map<string, MarketplaceDetail>()
  const updates: PluginUpdate[] = []
  const calls: Record<keyof MarketplaceService, number> = { list: 0, add: 0, get: 0, refresh: 0, remove: 0, stop: 0 }
  let offline = options.offline ?? false

  function changed(id: string, detail: MarketplaceDetail | null): void {
    options.events?.emit('marketplace.changed', { id, marketplace: detail === null ? null : summaryOf(detail) })
  }

  function withUpdates(detail: MarketplaceDetail): MarketplaceDetail {
    return { ...detail, updates: updates.filter(update => update.marketplaceId === detail.id).length }
  }

  function storedOrThrow(id: string): MarketplaceDetail {
    const detail = stored.get(id)
    if (detail === undefined)
      throw notFound(id)
    return detail
  }

  /** "Fetches" a source: the remote catalog, or the scripted error; `not_found` for an unknown source. */
  function fetchRemote(source: MarketplaceSource): FakeMarketplaceRemote {
    if (offline && source.type !== 'path')
      throw conflict('The server is offline (HF_OFFLINE=1), so marketplaces cannot be fetched.', 'offline')
    const remote = remotes.get(marketplaceSourceKey(source))
    if (remote === undefined)
      throw new HarnessError({ code: 'not_found', message: 'The marketplace was not found.' })
    if (remote instanceof HarnessError)
      throw remote
    return remote
  }

  return {
    remotes,
    stored,
    updates,
    get offline() {
      return offline
    },
    set offline(value: boolean) {
      offline = value
    },
    calls,
    list: async (): Promise<MarketplaceList> => {
      calls.list += 1
      const items = [...stored.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)).map(detail => summaryOf(withUpdates(detail)))
      const suggestions = MARKETPLACE_SUGGESTIONS.filter(suggestion => !items.some(item => item.name === suggestion.name || sameSource(item.source, suggestion.source)))
      return { items, suggestions: [...suggestions], updates: [...updates] }
    },
    add: async ({ source }) => {
      calls.add += 1
      const remote = fetchRemote(source)
      if (isReservedMarketplaceName(remote.name) && !(source.type === 'github' && source.repo.toLowerCase().startsWith(`${OFFICIAL_MARKETPLACE_OWNER}/`)))
        throw new HarnessError({ code: 'validation_error', message: `The name "${remote.name}" is reserved for the official marketplaces.`, details: { issues: [{ path: ['source'], message: 'Reserved marketplace name.', code: 'custom' }] } })
      if ([...stored.values()].some(detail => detail.name === remote.name))
        throw conflict(`A marketplace named "${remote.name}" is already added.`, 'exists')
      if (stored.size >= LIMITS.marketplacesMax)
        throw conflict(`At most ${LIMITS.marketplacesMax} marketplaces can be added.`, 'exists')
      const at = now()
      const entries = [...(remote.entries ?? [])]
      const detail: MarketplaceDetail = {
        id: createMarketplaceId(),
        name: remote.name,
        description: remote.description ?? null,
        owner: remote.owner ?? null,
        source,
        resolvedRef: remote.resolvedRef === undefined ? defaultResolvedRef(source) : remote.resolvedRef,
        plugins: entries.length,
        updates: 0,
        fetchedAt: at,
        lastError: null,
        createdAt: at,
        updatedAt: at,
        entries,
        diagnostics: [...(remote.diagnostics ?? [])],
      }
      stored.set(detail.id, detail)
      changed(detail.id, detail)
      return withUpdates(detail)
    },
    get: async (id) => {
      calls.get += 1
      return withUpdates(storedOrThrow(id))
    },
    refresh: async (id) => {
      calls.refresh += 1
      const current = storedOrThrow(id)
      let remote: FakeMarketplaceRemote
      try {
        remote = fetchRemote(current.source)
      }
      catch (error) {
        const failed: MarketplaceDetail = { ...current, lastError: HarnessError.from(error).toJSON().error, updatedAt: now() }
        stored.set(id, failed)
        changed(id, failed)
        throw error
      }
      const at = now()
      const entries = [...(remote.entries ?? [])]
      const next: MarketplaceDetail = {
        ...current,
        description: remote.description ?? null,
        owner: remote.owner ?? null,
        resolvedRef: remote.resolvedRef === undefined ? defaultResolvedRef(current.source) : remote.resolvedRef,
        plugins: entries.length,
        fetchedAt: at,
        lastError: null,
        updatedAt: at,
        entries,
        diagnostics: [...(remote.diagnostics ?? [])],
      }
      stored.set(id, next)
      changed(id, next)
      return withUpdates(next)
    },
    remove: async (id) => {
      calls.remove += 1
      storedOrThrow(id)
      stored.delete(id)
      changed(id, null)
    },
    stop: async () => {
      calls.stop += 1
    },
  }
}
