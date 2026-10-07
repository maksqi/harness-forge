// The marketplaces store (Phase 12, ADR-054; docs/UI.md 11.9; W12.8-T1): getters, single flight per key, per-key
// versions (an answer older than the last event never wins), `maxAgeMs` and stale marks, mutations, events and the
// reconnect refresh.
import type { MarketplaceDetail, MarketplaceList } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  commitSha,
  marketplaceDetail,
  marketplaceEntry,
  marketplaceId,
  marketplaceList,
  marketplaceSummary,
  pluginSummary,
  pluginUpdate,
} from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { MarketplacesRefreshError, useMarketplacesStore } from './marketplaces'
import { usePluginsStore } from './plugins'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  vi.useRealTimers()
  disposePinia(pinia)
})

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

/** Lets the store's quiet refetches settle. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round++)
    await new Promise(resolve => setTimeout(resolve, 0))
}

describe('marketplaces store: getters', () => {
  it('starts empty and asks nothing by itself', () => {
    const store = useMarketplacesStore()
    expect(store.list).toBeNull()
    expect(store.details).toEqual({})
    expect(store.loadedAt).toBeNull()
    expect(store.busy).toEqual({})
    expect(store.items).toEqual([])
    expect(store.byId(marketplaceId(1))).toBeNull()
    expect(store.entries(null)).toEqual([])
    expect(store.updates).toEqual([])
    expect(store.updateOf('review-kit')).toBeNull()
    expect(store.updateCount).toBe(0)
    expect(api.marketplaces.list).not.toHaveBeenCalled()
  })

  it('counts the updates of GET /marketplaces and finds one per plugin', async () => {
    const store = useMarketplacesStore()
    api.marketplaces.list.mockResolvedValue(marketplaceList({ updates: [pluginUpdate(), pluginUpdate({ pluginId: 'db-mcp', plugin: 'db-mcp', availableVersion: null })] }))
    await store.fetchAll()
    expect(store.updateCount).toBe(2)
    expect(store.updateOf('review-kit')?.availableVersion).toBe('1.2.0')
    expect(store.updateOf('db-mcp')?.availableVersion).toBeNull()
    expect(store.updateOf('other')).toBeNull()
    expect(store.byId(marketplaceId(1))?.name).toBe('claude-plugins-official')
  })

  it('lists the entries of loaded details with their state, sorted by name, and All by marketplace order', async () => {
    const store = useMarketplacesStore()
    usePluginsStore().items = [pluginSummary({ id: 'review-kit', version: '1.1.0' })]
    api.marketplaces.list.mockResolvedValue(marketplaceList({
      items: [marketplaceSummary(), marketplaceSummary({ id: marketplaceId(2), name: 'acme' })],
      updates: [pluginUpdate()],
    }))
    api.marketplaces.get.mockImplementation(async ({ params }: { params: { id: string } }) => params.id === marketplaceId(1)
      ? marketplaceDetail({ entries: [marketplaceEntry({ installedPluginId: 'review-kit' }), marketplaceEntry({ name: 'a-tool' }), marketplaceEntry({ name: 'git-x', supported: false })] })
      : marketplaceDetail({ id: marketplaceId(2), name: 'acme', entries: [marketplaceEntry({ name: '0-first' })] }))
    await store.fetchAll()
    await store.fetch(marketplaceId(2))
    await store.fetch(marketplaceId(1))
    expect(api.marketplaces.get).toHaveBeenCalledWith({ params: { id: marketplaceId(1) } })
    const entries = store.entries(marketplaceId(1))
    expect(entries.map(entry => [entry.entry.name, entry.state, entry.installedVersion])).toEqual([
      ['a-tool', 'available', null],
      ['git-x', 'unsupported', null],
      ['review-kit', 'update', '1.1.0'],
    ])
    expect(entries[2]!.update?.availableVersion).toBe('1.2.0')
    expect(entries[2]!.marketplaceName).toBe('claude-plugins-official')
    // All: the list order of the marketplaces (not the order the details arrived in).
    expect(store.entries(null).map(entry => `${entry.marketplaceName}/${entry.entry.name}`)).toEqual([
      'claude-plugins-official/a-tool',
      'claude-plugins-official/git-x',
      'claude-plugins-official/review-kit',
      'acme/0-first',
    ])
    expect(store.entries(marketplaceId(9))).toEqual([])
  })
})

describe('marketplaces store: requests', () => {
  it('fetches the list once for concurrent callers and reuses a fresh answer', async () => {
    const store = useMarketplacesStore()
    api.marketplaces.list.mockResolvedValue(marketplaceList({ updates: [pluginUpdate()] }))
    const [a, b] = await Promise.all([store.fetchAll(), store.fetchAll()])
    expect(a).toBe(b)
    expect(api.marketplaces.list).toHaveBeenCalledTimes(1)
    await store.fetchAll({ maxAgeMs: 60_000 })
    expect(api.marketplaces.list).toHaveBeenCalledTimes(1)
    await store.fetchAll()
    expect(api.marketplaces.list).toHaveBeenCalledTimes(2)
  })

  it('refetches a cached list after maxAgeMs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const store = useMarketplacesStore()
    api.marketplaces.list.mockResolvedValue(marketplaceList())
    await store.fetchAll()
    vi.setSystemTime(Date.now() + 20_000)
    await store.fetchAll({ maxAgeMs: 15_000 })
    expect(api.marketplaces.list).toHaveBeenCalledTimes(2)
    await store.fetchAll({ maxAgeMs: 15_000 })
    expect(api.marketplaces.list).toHaveBeenCalledTimes(2)
  })

  it('fetches each detail once for concurrent callers (single flight per id) and reuses a fresh one', async () => {
    const store = useMarketplacesStore()
    const pending = deferred<MarketplaceDetail>()
    api.marketplaces.get.mockReturnValueOnce(pending.promise).mockResolvedValue(marketplaceDetail({ id: marketplaceId(2), name: 'acme' }))
    const first = store.fetch(marketplaceId(1))
    const second = store.fetch(marketplaceId(1))
    const other = store.fetch(marketplaceId(2))
    expect(api.marketplaces.get).toHaveBeenCalledTimes(2)
    pending.resolve(marketplaceDetail())
    expect(await first).toBe(await second)
    await other
    await store.fetch(marketplaceId(1), { maxAgeMs: 60_000 })
    expect(api.marketplaces.get).toHaveBeenCalledTimes(2)
    expect(Object.keys(store.details).sort()).toEqual([marketplaceId(1), marketplaceId(2)])
  })

  it('drops a marketplace whose detail answers 404', async () => {
    const store = useMarketplacesStore()
    api.marketplaces.list.mockResolvedValue(marketplaceList())
    await store.fetchAll()
    api.marketplaces.get.mockRejectedValue(new HarnessError({ code: 'not_found', message: 'Gone.' }))
    await expect(store.fetch(marketplaceId(1))).rejects.toMatchObject({ code: 'not_found' })
    expect(store.items).toEqual([])
  })

  it('never caches a list answer that started before a marketplace.changed event (one more request follows)', async () => {
    const store = useMarketplacesStore()
    const old = deferred<MarketplaceList>()
    api.marketplaces.list.mockReturnValueOnce(old.promise).mockResolvedValue(marketplaceList({ items: [marketplaceSummary({ description: 'Newest' })] }))
    const caller = store.fetchAll()
    store.applyEvent(createServerEvent('marketplace.changed', { id: marketplaceId(1), marketplace: marketplaceSummary({ description: 'From the event' }) }, 1))
    old.resolve(marketplaceList({ items: [marketplaceSummary({ description: 'Older' })] }))
    // The caller still gets its answer; the cache does not take it.
    expect((await caller).items[0]!.description).toBe('Older')
    await settle()
    expect(api.marketplaces.list).toHaveBeenCalledTimes(2)
    expect(store.byId(marketplaceId(1))?.description).toBe('Newest')
  })

  it('never caches a detail answer that started before an event about it', async () => {
    const store = useMarketplacesStore()
    api.marketplaces.list.mockResolvedValue(marketplaceList())
    await store.fetchAll()
    api.marketplaces.get.mockResolvedValueOnce(marketplaceDetail())
    await store.fetch(marketplaceId(1))
    const old = deferred<MarketplaceDetail>()
    api.marketplaces.get.mockReturnValueOnce(old.promise).mockResolvedValue(marketplaceDetail({ resolvedRef: commitSha(2), entries: [marketplaceEntry({ name: 'fresh' })] }))
    const caller = store.fetch(marketplaceId(1))
    store.applyEvent(createServerEvent('marketplace.changed', { id: marketplaceId(1), marketplace: marketplaceSummary({ resolvedRef: commitSha(2) }) }, 1))
    old.resolve(marketplaceDetail({ entries: [marketplaceEntry({ name: 'stale' })] }))
    await caller
    await settle()
    expect(store.details[marketplaceId(1)]?.entries.map(entry => entry.name)).toEqual(['fresh'])
    expect(api.marketplaces.get).toHaveBeenCalledTimes(3)
  })
})

describe('marketplaces store: mutations', () => {
  it('adds a marketplace, selects its detail and drops the matching suggestion', async () => {
    const store = useMarketplacesStore()
    api.marketplaces.list.mockResolvedValue(marketplaceList({ items: [], suggestions: [{ name: 'claude-plugins-official', title: 'x', description: 'y', source: { type: 'github', repo: 'anthropics/claude-plugins-official' } }] }))
    await store.fetchAll()
    api.marketplaces.add.mockResolvedValue(marketplaceDetail())
    const detail = await store.add({ type: 'github', repo: 'anthropics/claude-plugins-official' })
    expect(api.marketplaces.add).toHaveBeenCalledWith({ body: { source: { type: 'github', repo: 'anthropics/claude-plugins-official' } } })
    expect(detail.id).toBe(marketplaceId(1))
    expect(store.items.map(item => item.id)).toEqual([marketplaceId(1)])
    expect(store.details[marketplaceId(1)]?.entries).toHaveLength(2)
    expect(store.list?.suggestions).toEqual([])
  })

  it('throws the add errors with their codes and stores nothing', async () => {
    const store = useMarketplacesStore()
    api.marketplaces.list.mockResolvedValue(marketplaceList({ items: [] }))
    await store.fetchAll()
    api.marketplaces.add.mockRejectedValue(new HarnessError({ code: 'conflict', message: 'Offline.', details: { reason: 'offline' } }))
    await expect(store.add({ type: 'github', repo: 'acme/tools' })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'offline' } })
    expect(store.items).toEqual([])
  })

  it('refreshes (busy meanwhile) into the detail and the summary', async () => {
    const store = useMarketplacesStore()
    api.marketplaces.list.mockResolvedValue(marketplaceList())
    await store.fetchAll()
    const pending = deferred<MarketplaceDetail>()
    api.marketplaces.refresh.mockReturnValue(pending.promise)
    const refreshing = store.refresh(marketplaceId(1))
    expect(store.busy[marketplaceId(1)]).toBe(true)
    pending.resolve(marketplaceDetail({ plugins: 5, resolvedRef: commitSha(3) }))
    await refreshing
    expect(store.busy).toEqual({})
    expect(store.byId(marketplaceId(1))?.plugins).toBe(5)
    expect(store.details[marketplaceId(1)]?.resolvedRef).toBe(commitSha(3))
  })

  it('refetches the list quietly after a failed refresh (lastError) and drops a 404', async () => {
    const store = useMarketplacesStore()
    api.marketplaces.list.mockResolvedValueOnce(marketplaceList()).mockResolvedValue(marketplaceList({ items: [marketplaceSummary({ lastError: { code: 'provider_unreachable', message: 'Down' } })] }))
    await store.fetchAll()
    api.marketplaces.refresh.mockRejectedValueOnce(new HarnessError({ code: 'provider_unreachable', message: 'Down' }))
    await expect(store.refresh(marketplaceId(1))).rejects.toMatchObject({ code: 'provider_unreachable' })
    expect(store.busy).toEqual({})
    await settle()
    expect(store.byId(marketplaceId(1))?.lastError?.message).toBe('Down')

    api.marketplaces.refresh.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Gone' }))
    await expect(store.refresh(marketplaceId(1))).rejects.toMatchObject({ code: 'not_found' })
    expect(store.byId(marketplaceId(1))).toBeNull()
  })

  it('refreshes all one after the other and names the failures', async () => {
    const store = useMarketplacesStore()
    api.marketplaces.list.mockResolvedValue(marketplaceList({ items: [marketplaceSummary(), marketplaceSummary({ id: marketplaceId(2), name: 'acme' })] }))
    await store.fetchAll()
    const order: string[] = []
    api.marketplaces.refresh.mockImplementation(async ({ params }: { params: { id: string } }) => {
      order.push(params.id)
      if (params.id === marketplaceId(1))
        throw new HarnessError({ code: 'conflict', message: 'Offline.', details: { reason: 'offline' } })
      return marketplaceDetail({ id: marketplaceId(2), name: 'acme' })
    })
    const failure = await store.refreshAll().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure).toBeInstanceOf(MarketplacesRefreshError)
    expect((failure as MarketplacesRefreshError).failures.map(item => [item.id, item.name, item.error.message])).toEqual([[marketplaceId(1), 'claude-plugins-official', 'Offline.']])
    expect(order).toEqual([marketplaceId(1), marketplaceId(2)])
    api.marketplaces.refresh.mockResolvedValue(marketplaceDetail())
    await expect(store.refreshAll()).resolves.toBeUndefined()
  })

  it('removes a marketplace (a 404 counts as removed) and refetches the list for the suggestions', async () => {
    const store = useMarketplacesStore()
    api.marketplaces.list.mockResolvedValue(marketplaceList())
    api.marketplaces.get.mockResolvedValue(marketplaceDetail())
    await store.fetchAll()
    await store.fetch(marketplaceId(1))
    api.marketplaces.list.mockResolvedValue(marketplaceList({ items: [], suggestions: [{ name: 'claude-plugins-official', title: 'x', description: 'y', source: { type: 'github', repo: 'anthropics/claude-plugins-official' } }] }))
    api.marketplaces.remove.mockRejectedValue(new HarnessError({ code: 'not_found', message: 'Gone.' }))
    await store.remove(marketplaceId(1))
    expect(store.items).toEqual([])
    expect(store.details).toEqual({})
    expect(store.busy).toEqual({})
    await settle()
    expect(store.list?.suggestions).toHaveLength(1)

    api.marketplaces.remove.mockRejectedValue(new HarnessError({ code: 'internal_error', message: 'Disk.' }))
    await expect(store.remove(marketplaceId(2))).rejects.toMatchObject({ code: 'internal_error' })
  })
})

describe('marketplaces store: events', () => {
  it('replaces a summary from marketplace.changed and refetches the entries only for a new commit or fetch', async () => {
    const store = useMarketplacesStore()
    api.marketplaces.list.mockResolvedValue(marketplaceList())
    api.marketplaces.get.mockResolvedValue(marketplaceDetail())
    await store.fetchAll()
    await store.fetch(marketplaceId(1))
    api.marketplaces.get.mockClear()

    store.applyEvent(createServerEvent('marketplace.changed', { id: marketplaceId(1), marketplace: marketplaceSummary({ description: 'Changed', lastError: { code: 'provider_error', message: 'Bad' } }) }, 1))
    expect(store.byId(marketplaceId(1))?.description).toBe('Changed')
    expect(store.details[marketplaceId(1)]?.lastError?.message).toBe('Bad')
    await settle()
    expect(api.marketplaces.get).not.toHaveBeenCalled()

    store.applyEvent(createServerEvent('marketplace.changed', { id: marketplaceId(1), marketplace: marketplaceSummary({ resolvedRef: commitSha(4), fetchedAt: 1_759_000_100_000 }) }, 2))
    await settle()
    expect(api.marketplaces.get).toHaveBeenCalledTimes(1)
  })

  it('appends a marketplace added elsewhere and drops a removed one with its detail', async () => {
    const store = useMarketplacesStore()
    api.marketplaces.list.mockResolvedValue(marketplaceList())
    api.marketplaces.get.mockResolvedValue(marketplaceDetail())
    await store.fetchAll()
    await store.fetch(marketplaceId(1))
    store.applyEvent(createServerEvent('marketplace.changed', { id: marketplaceId(2), marketplace: marketplaceSummary({ id: marketplaceId(2), name: 'acme' }) }, 1))
    expect(store.items.map(item => item.name)).toEqual(['claude-plugins-official', 'acme'])
    store.applyEvent(createServerEvent('marketplace.changed', { id: marketplaceId(1), marketplace: null }, 2))
    expect(store.items.map(item => item.name)).toEqual(['acme'])
    expect(store.details).toEqual({})
  })

  it('marks the installed and update states stale on plugin.changed and refetches what is loaded, coalesced', async () => {
    const store = useMarketplacesStore()
    api.marketplaces.list.mockResolvedValue(marketplaceList())
    api.marketplaces.get.mockResolvedValue(marketplaceDetail())
    await store.fetchAll()
    await store.fetch(marketplaceId(1))
    api.marketplaces.list.mockClear()
    api.marketplaces.get.mockClear()

    const list = deferred<MarketplaceList>()
    api.marketplaces.list.mockReturnValueOnce(list.promise).mockResolvedValue(marketplaceList({ updates: [pluginUpdate()] }))
    api.marketplaces.get.mockResolvedValue(marketplaceDetail({ entries: [marketplaceEntry({ installedPluginId: 'review-kit' })] }))
    store.applyEvent(createServerEvent('plugin.changed', { id: 'review-kit', plugin: null }, 1))
    // A second event while the first refetch runs queues one more request (not one per event).
    store.applyEvent(createServerEvent('plugin.changed', { id: 'review-kit', plugin: null }, 2))
    store.applyEvent(createServerEvent('plugin.changed', { id: 'review-kit', plugin: null }, 3))
    expect(api.marketplaces.list).toHaveBeenCalledTimes(1)
    list.resolve(marketplaceList())
    await settle()
    expect(api.marketplaces.list).toHaveBeenCalledTimes(2)
    expect(store.updateCount).toBe(1)
    expect(store.details[marketplaceId(1)]?.entries[0]?.installedPluginId).toBe('review-kit')
    // A cached answer is not reused while stale.
    api.marketplaces.list.mockClear()
    store.applyEvent(createServerEvent('plugin.changed', { id: 'x', plugin: null }, 4))
    await store.fetchAll({ maxAgeMs: 60_000 })
    expect(api.marketplaces.list).toHaveBeenCalled()
  })

  it('ignores plugin.changed and marketplace.changed for a store that loaded nothing', async () => {
    const store = useMarketplacesStore()
    store.applyEvent(createServerEvent('plugin.changed', { id: 'review-kit', plugin: null }, 1))
    store.applyEvent(createServerEvent('marketplace.changed', { id: marketplaceId(1), marketplace: marketplaceSummary() }, 2))
    await settle()
    expect(api.marketplaces.list).not.toHaveBeenCalled()
    expect(api.marketplaces.get).not.toHaveBeenCalled()
    expect(store.list).toBeNull()
  })

  it('refetches the loaded list and details after a reconnect, replacing requests in flight', async () => {
    const store = useMarketplacesStore()
    api.marketplaces.list.mockResolvedValue(marketplaceList())
    api.marketplaces.get.mockResolvedValue(marketplaceDetail())
    await store.fetchAll()
    await store.fetch(marketplaceId(1))
    api.marketplaces.list.mockClear()
    api.marketplaces.get.mockClear()
    await store.refreshLoaded()
    expect(api.marketplaces.list).toHaveBeenCalledTimes(1)
    expect(api.marketplaces.get).toHaveBeenCalledTimes(1)

    const old = deferred<MarketplaceList>()
    api.marketplaces.list.mockReturnValueOnce(old.promise).mockResolvedValue(marketplaceList({ items: [marketplaceSummary({ description: 'After reconnect' })] }))
    void store.fetchAll()
    await store.refreshLoaded()
    old.resolve(marketplaceList({ items: [marketplaceSummary({ description: 'Before' })] }))
    await settle()
    expect(store.byId(marketplaceId(1))?.description).toBe('After reconnect')
  })
})
