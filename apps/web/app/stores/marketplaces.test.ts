// The marketplaces store (Phase 12, ADR-054; docs/UI.md 11.9): its P12-0b shape (C46) — getters, plain requests,
// single-flight `fetchAll`, events and the reconnect refresh.
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  marketplaceDetail,
  marketplaceEntry,
  marketplaceId,
  marketplaceList,
  marketplaceSummary,
  pluginSummary,
  pluginUpdate,
} from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { useMarketplacesStore } from './marketplaces'
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
  disposePinia(pinia)
})

describe('marketplaces store (P12-0b shape)', () => {
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

  it('fetches the list once for concurrent callers and reuses a fresh answer', async () => {
    const store = useMarketplacesStore()
    api.marketplaces.list.mockResolvedValue(marketplaceList({ updates: [pluginUpdate()] }))
    const [a, b] = await Promise.all([store.fetchAll(), store.fetchAll()])
    expect(a).toBe(b)
    expect(api.marketplaces.list).toHaveBeenCalledTimes(1)
    await store.fetchAll({ maxAgeMs: 60_000 })
    expect(api.marketplaces.list).toHaveBeenCalledTimes(1)
    expect(store.byId(marketplaceId(1))?.name).toBe('claude-plugins-official')
    expect(store.updateCount).toBe(1)
    expect(store.updateOf('review-kit')?.availableVersion).toBe('1.2.0')
  })

  it('lists the entries of loaded details with their state', async () => {
    const store = useMarketplacesStore()
    usePluginsStore().items = [pluginSummary({ id: 'review-kit', version: '1.1.0' })]
    api.marketplaces.list.mockResolvedValue(marketplaceList({ updates: [pluginUpdate()] }))
    api.marketplaces.get.mockResolvedValue(marketplaceDetail({ entries: [marketplaceEntry({ installedPluginId: 'review-kit' }), marketplaceEntry({ name: 'a-tool' })] }))
    await store.fetchAll()
    await store.fetch(marketplaceId(1))
    expect(api.marketplaces.get).toHaveBeenCalledWith({ params: { id: marketplaceId(1) } })
    const entries = store.entries(marketplaceId(1))
    expect(entries.map(entry => [entry.entry.name, entry.state, entry.installedVersion])).toEqual([
      ['a-tool', 'available', null],
      ['review-kit', 'update', '1.1.0'],
    ])
    expect(entries[1]!.update?.availableVersion).toBe('1.2.0')
    expect(store.entries(null)).toHaveLength(2)
  })

  it('adds, refreshes (busy meanwhile) and removes marketplaces', async () => {
    const store = useMarketplacesStore()
    api.marketplaces.list.mockResolvedValue(marketplaceList({ items: [], suggestions: [{ name: 'claude-plugins-official', title: 'x', description: 'y', source: { type: 'github', repo: 'anthropics/claude-plugins-official' } }] }))
    await store.fetchAll()
    api.marketplaces.add.mockResolvedValue(marketplaceDetail())
    await store.add({ type: 'github', repo: 'anthropics/claude-plugins-official' })
    expect(api.marketplaces.add).toHaveBeenCalledWith({ body: { source: { type: 'github', repo: 'anthropics/claude-plugins-official' } } })
    expect(store.items.map(item => item.id)).toEqual([marketplaceId(1)])
    expect(store.list?.suggestions).toEqual([])

    let release: (value: unknown) => void = () => {}
    api.marketplaces.refresh.mockReturnValue(new Promise((resolve) => {
      release = resolve
    }))
    const refreshing = store.refresh(marketplaceId(1))
    expect(store.busy[marketplaceId(1)]).toBe(true)
    release(marketplaceDetail({ plugins: 5 }))
    await refreshing
    expect(store.busy).toEqual({})
    expect(store.byId(marketplaceId(1))?.plugins).toBe(5)

    api.marketplaces.remove.mockRejectedValue(new HarnessError({ code: 'not_found', message: 'Gone.' }))
    await store.remove(marketplaceId(1))
    expect(store.items).toEqual([])
    expect(store.details).toEqual({})
  })

  it('collects the failures of Refresh all', async () => {
    const store = useMarketplacesStore()
    api.marketplaces.list.mockResolvedValue(marketplaceList({ items: [marketplaceSummary(), marketplaceSummary({ id: marketplaceId(2), name: 'acme' })] }))
    await store.fetchAll()
    api.marketplaces.refresh
      .mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'Offline.', details: { reason: 'offline' } }))
      .mockResolvedValueOnce(marketplaceDetail({ id: marketplaceId(2), name: 'acme' }))
    await expect(store.refreshAll()).rejects.toBeInstanceOf(AggregateError)
    expect(api.marketplaces.refresh).toHaveBeenCalledTimes(2)
  })

  it('applies marketplace.changed and plugin.changed and refreshes what was loaded', async () => {
    const store = useMarketplacesStore()
    api.marketplaces.list.mockResolvedValue(marketplaceList())
    api.marketplaces.get.mockResolvedValue(marketplaceDetail())
    await store.fetchAll()
    await store.fetch(marketplaceId(1))

    store.applyEvent(createServerEvent('marketplace.changed', { id: marketplaceId(1), marketplace: marketplaceSummary({ description: 'Changed' }) }, 1))
    expect(store.byId(marketplaceId(1))?.description).toBe('Changed')
    expect(store.details[marketplaceId(1)]?.description).toBe('Changed')

    api.marketplaces.list.mockClear()
    api.marketplaces.get.mockClear()
    store.applyEvent(createServerEvent('plugin.changed', { id: 'review-kit', plugin: null }, 2))
    await vi.waitFor(() => expect(api.marketplaces.list).toHaveBeenCalledTimes(1))
    expect(api.marketplaces.get).toHaveBeenCalledTimes(1)
    // Let the event's refetch settle (a reconnect while it runs joins it).
    await new Promise(resolve => setTimeout(resolve, 0))

    await store.refreshLoaded()
    expect(api.marketplaces.list).toHaveBeenCalledTimes(2)

    store.applyEvent(createServerEvent('marketplace.changed', { id: marketplaceId(1), marketplace: null }, 3))
    expect(store.items).toEqual([])
    expect(store.details).toEqual({})
  })
})
