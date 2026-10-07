// MarketplacesView (Phase 12, ADR-054; docs/UI.md 2.19, 6, 8.13, 14; W12.8-T2 / T3 / T5): loading the list and the
// shown details (All: at most 4 at a time), the query (`?m=`, `?q=`, `?category=`), the filters and the empty states, the
// refresh errors, the official suggestion (no request before its Add), refresh, remove and install.
import type { MarketplaceDetail } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { toast } from 'vue-sonner'
import { useMarketplacesStore } from '~/stores/marketplaces'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import {
  authStatus,
  claudePluginInfo,
  marketplaceDetail,
  marketplaceEntry,
  marketplaceId,
  marketplaceList,
  marketplaceSummary,
  pluginDetail,
  pluginSummary,
} from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { allByTestId, byTestId, mountInShell, openWithKeyboard, settle } from '../list/testing'
import { OFFICIAL_MARKETPLACE, SUGGESTION_DISMISSED_KEY } from './marketplaces'
import MarketplacesView from './MarketplacesView.vue'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  route: null as null | { path: string, fullPath: string, query: Record<string, unknown> },
  replace: null as null | ((to: { query?: Record<string, unknown> }) => Promise<void>),
  navigateTo: null as null | ((to: string) => unknown),
}))

vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('./nuxt-imports', () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ replace: (to: { query?: Record<string, unknown> }) => mocks.replace!(to) }),
  navigateTo: (to: string) => mocks.navigateTo!(to),
  useHead: vi.fn(),
}))

const OFFICIAL_SUGGESTION = { name: 'claude-plugins-official', title: 'Claude Code plugins', description: 'Official', source: { type: 'github' as const, repo: OFFICIAL_MARKETPLACE } }

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let unmount: (() => void) | null = null
let replace: ReturnType<typeof vi.fn>
let navigate: ReturnType<typeof vi.fn>

function setQuery(query: Record<string, unknown>): void {
  mocks.route!.query = query
  const search = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)])).toString()
  mocks.route!.fullPath = `/plugins/marketplaces${search ? `?${search}` : ''}`
}

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.route = reactive({ path: '/plugins/marketplaces', fullPath: '/plugins/marketplaces', query: {} })
  replace = vi.fn(async (to: { query?: Record<string, unknown> }) => {
    setQuery({ ...(to.query ?? {}) })
  })
  mocks.replace = replace as never
  navigate = vi.fn()
  mocks.navigateTo = navigate as never
  pinia = createPinia()
  setActivePinia(pinia)
  api.auth.status.mockResolvedValue(authStatus())
  api.plugins.list.mockResolvedValue({ items: [] })
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
  try {
    localStorage.removeItem(SUGGESTION_DISMISSED_KEY)
  }
  catch {}
})

afterEach(() => {
  unmount?.()
  unmount = null
  document.body.replaceChildren()
  disposePinia(pinia)
  vi.useRealTimers()
})

async function render() {
  const wrapper = mountInShell(MarketplacesView)
  unmount = () => wrapper.unmount()
  await settle()
  return wrapper
}

/** Two marketplaces: the official one (review-kit, gitlab-tools) and acme (db-mcp in category data). */
function twoMarketplaces(): void {
  api.marketplaces.list.mockResolvedValue(marketplaceList({
    items: [marketplaceSummary(), marketplaceSummary({ id: marketplaceId(2), name: 'acme', source: { type: 'url', url: 'https://example.com/acme/marketplace.json' }, resolvedRef: 'b'.repeat(64), plugins: 1 })],
  }))
  api.marketplaces.get.mockImplementation(async ({ params }: { params: { id: string } }): Promise<MarketplaceDetail> => params.id === marketplaceId(2)
    ? marketplaceDetail({ id: marketplaceId(2), name: 'acme', entries: [marketplaceEntry({ name: 'db-mcp', description: 'A Postgres MCP server', category: 'data', tags: ['database'], source: { kind: 'npm', text: '@acme/db-mcp' } })] })
    : marketplaceDetail())
}

function entryNames(): Array<string | undefined> {
  return allByTestId(testIds.marketplaceEntry).map(entry => entry.dataset.name)
}

function buttonByText(text: string, root: ParentNode = document.body): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.trim() === text)
}

describe('marketplacesView: loading', () => {
  it('loads the list and every marketplace on All, and lists the entries by marketplace with its name', async () => {
    twoMarketplaces()
    await render()
    expect(byTestId(testIds.marketplacesPage)).not.toBeNull()
    expect(document.querySelector('h1')?.textContent?.trim()).toBe('Marketplaces')
    expect(document.body.textContent).toContain('Browse plugins from Claude Code marketplaces.')
    expect(api.marketplaces.list).toHaveBeenCalledTimes(1)
    expect(api.marketplaces.get.mock.calls.map(([call]) => call.params.id).sort()).toEqual([marketplaceId(1), marketplaceId(2)])
    expect(allByTestId(testIds.marketplaceRow).map(row => row.dataset.marketplaceId)).toEqual(['', marketplaceId(1), marketplaceId(2)])
    expect(entryNames()).toEqual(['gitlab-tools', 'review-kit', 'db-mcp'])
    expect(byTestId(testIds.marketplaceEntry)!.textContent).toContain('claude-plugins-official')
    expect(byTestId<HTMLButtonElement>(testIds.marketplaceRefreshAll)!.disabled).toBe(false)
    expect(byTestId(testIds.marketplaceAdd)!.getAttribute('aria-label')).toBe('Add marketplace…')
  })

  it('loads the details of All at most 4 at a time', async () => {
    const ids = [1, 2, 3, 4, 5, 6].map(marketplaceId)
    api.marketplaces.list.mockResolvedValue(marketplaceList({ items: ids.map((id, index) => marketplaceSummary({ id, name: `m${index}` })) }))
    let running = 0
    let peak = 0
    api.marketplaces.get.mockImplementation(async ({ params }: { params: { id: string } }) => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise(resolve => setTimeout(resolve, 2))
      running -= 1
      return marketplaceDetail({ id: params.id, name: `m${ids.indexOf(params.id)}`, entries: [] })
    })
    await render()
    await vi.waitFor(() => expect(api.marketplaces.get).toHaveBeenCalledTimes(6))
    expect(peak).toBe(4)
  })

  it('shows a skeleton while loading and "Could not load the marketplaces" with Retry after a failure', async () => {
    let fail: (error: unknown) => void = () => {}
    api.marketplaces.list.mockReturnValueOnce(new Promise((_resolve, reject) => {
      fail = reject
    }))
    await render()
    expect(document.querySelector('[data-slot="marketplace-skeleton"]')?.textContent).toContain('Loading marketplaces…')
    fail(new HarnessError({ code: 'internal_error', message: 'Database locked.' }))
    await settle()
    expect(document.body.textContent).toContain('Could not load the marketplaces')
    expect(document.body.textContent).toContain('Database locked.')
    twoMarketplaces()
    buttonByText('Retry')!.click()
    await settle()
    expect(entryNames()).toHaveLength(3)
    expect(document.body.textContent).not.toContain('Could not load the marketplaces')
  })

  it('shows the empty state with Add marketplace… when nothing is added', async () => {
    api.marketplaces.list.mockResolvedValue(marketplaceList({ items: [] }))
    await render()
    const empty = byTestId(testIds.marketplaceEmpty)!
    expect(empty.dataset.value).toBe('none')
    expect(empty.textContent).toContain('No marketplaces yet. Add one from GitHub, a marketplace.json URL or a folder on this server.')
    expect(byTestId<HTMLButtonElement>(testIds.marketplaceRefreshAll)!.disabled).toBe(true)
    empty.querySelector<HTMLButtonElement>('[data-action="add"]')!.click()
    await settle()
    expect(byTestId(testIds.marketplaceAddDialog)).not.toBeNull()
  })

  it('says when a marketplace lists no plugins', async () => {
    api.marketplaces.list.mockResolvedValue(marketplaceList())
    api.marketplaces.get.mockResolvedValue(marketplaceDetail({ entries: [] }))
    setQuery({ m: marketplaceId(1) })
    await render()
    const empty = byTestId(testIds.marketplaceEmpty)!
    expect(empty.dataset.value).toBe('no-entries')
    expect(empty.textContent?.trim()).toBe('claude-plugins-official lists no plugins.')
  })
})

describe('marketplacesView: query and filters', () => {
  it('selects ?m= (its detail only), shows its source and refresh time, and writes a picked chip back', async () => {
    twoMarketplaces()
    setQuery({ m: marketplaceId(2) })
    await render()
    expect(api.marketplaces.get).toHaveBeenCalledTimes(1)
    expect(api.marketplaces.get).toHaveBeenCalledWith({ params: { id: marketplaceId(2) } })
    expect(entryNames()).toEqual(['db-mcp'])
    // One marketplace: no marketplace name in line 2.
    expect(byTestId(testIds.marketplaceEntry)!.textContent).not.toContain('acme ·')
    const source = document.querySelector('[data-slot="marketplace-source"]')!
    expect(source.textContent).toContain('example.com/acme/marketplace.json')
    expect(source.textContent).toContain('refreshed')
    expect(source.querySelector('time')).not.toBeNull()
    const rows = allByTestId(testIds.marketplaceRow)
    expect(rows.find(row => row.dataset.marketplaceId === marketplaceId(2))!.getAttribute('aria-pressed')).toBe('true')
    rows.find(row => row.dataset.marketplaceId === marketplaceId(1))!.click()
    await settle()
    expect(replace).toHaveBeenLastCalledWith({ query: { m: marketplaceId(1) } })
    expect(entryNames()).toEqual(['gitlab-tools', 'review-kit'])
    expect(document.querySelector('[data-slot="marketplace-source"]')!.textContent).toContain('github.com/anthropics/claude-plugins-official@1111111')
    rows[0]!.click()
    await settle()
    expect(replace).toHaveBeenLastCalledWith({ query: {} })
  })

  it('reads an unknown ?m= as All and drops it', async () => {
    twoMarketplaces()
    setQuery({ m: marketplaceId(9), q: 'db' })
    await render()
    expect(replace).toHaveBeenCalledWith({ query: { q: 'db' } })
    expect(allByTestId(testIds.marketplaceRow)[0]!.getAttribute('aria-pressed')).toBe('true')
    expect(entryNames()).toEqual(['db-mcp'])
  })

  it('filters by search at once and writes ?q= after 200 ms', async () => {
    twoMarketplaces()
    await render()
    vi.useFakeTimers()
    const search = byTestId<HTMLInputElement>(testIds.marketplaceSearch)!
    search.value = 'POSTGRES'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(entryNames()).toEqual(['db-mcp'])
    expect(replace).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(replace).toHaveBeenCalledWith({ query: { q: 'POSTGRES' } })
  })

  it('filters by category (?category=), reads an unknown one as All and clears the filters from the no-match state', async () => {
    twoMarketplaces()
    setQuery({ category: 'nope' })
    await render()
    const trigger = byTestId(testIds.marketplaceCategory)!
    expect(trigger.dataset.value).toBe('')
    expect(entryNames()).toHaveLength(3)
    await openWithKeyboard(trigger)
    const options = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="select-item"]'))
    expect(options.map(option => option.dataset.value)).toEqual(['', 'data', 'development'])
    options[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()
    expect(replace).toHaveBeenLastCalledWith({ query: { category: 'data' } })
    expect(entryNames()).toEqual(['db-mcp'])
    expect(byTestId(testIds.marketplaceCategory)!.dataset.value).toBe('data')

    setQuery({ category: 'data', q: 'review' })
    await settle()
    const empty = byTestId(testIds.marketplaceEmpty)!
    expect(empty.dataset.value).toBe('no-match')
    expect(empty.textContent).toContain('No plugins match')
    buttonByText('Clear filters', empty)!.click()
    await settle()
    expect(replace).toHaveBeenLastCalledWith({ query: {} })
    expect(entryNames()).toHaveLength(3)
  })

  it('shows the last refresh error of a shown marketplace above its entries', async () => {
    api.marketplaces.list.mockResolvedValue(marketplaceList({ items: [marketplaceSummary({ lastError: { code: 'not_found', message: 'GitHub answered 404.' } })] }))
    api.marketplaces.get.mockResolvedValue(marketplaceDetail())
    await render()
    const error = byTestId(testIds.marketplaceError)!
    expect(error.dataset.code).toBe('not_found')
    expect(error.textContent?.trim()).toBe('Could not refresh claude-plugins-official: GitHub answered 404.')
    expect(entryNames()).toHaveLength(2)
  })
})

describe('marketplacesView: the official suggestion', () => {
  it('sends no request before its Add, then adds the official repository and selects it', async () => {
    api.marketplaces.list.mockResolvedValue(marketplaceList({ items: [], suggestions: [OFFICIAL_SUGGESTION] }))
    await render()
    const card = byTestId(testIds.marketplaceSuggestion)!
    expect(card.textContent).toContain('Anthropic\'s official plugins')
    expect(card.textContent).toContain(OFFICIAL_MARKETPLACE)
    // Only the stored list was read: nothing was added, fetched or refreshed.
    expect(api.marketplaces.list).toHaveBeenCalledTimes(1)
    expect(api.marketplaces.add).not.toHaveBeenCalled()
    expect(api.marketplaces.get).not.toHaveBeenCalled()
    expect(api.marketplaces.refresh).not.toHaveBeenCalled()

    api.marketplaces.add.mockResolvedValue(marketplaceDetail())
    byTestId(testIds.marketplaceSuggestionAdd)!.click()
    await settle()
    expect(api.marketplaces.add).toHaveBeenCalledTimes(1)
    expect(api.marketplaces.add).toHaveBeenCalledWith({ body: { source: { type: 'github', repo: OFFICIAL_MARKETPLACE } } })
    expect(toast.success).toHaveBeenCalledWith('Added claude-plugins-official')
    expect(replace).toHaveBeenLastCalledWith({ query: { m: marketplaceId(1) } })
    // Added: the card is gone and the new chip has the focus.
    expect(byTestId(testIds.marketplaceSuggestion)).toBeNull()
    expect(document.activeElement).toBe(allByTestId(testIds.marketplaceRow).find(row => row.dataset.marketplaceId === marketplaceId(1)))
  })

  it('counts zero API calls until Add (the list already loaded), then exactly the add', async () => {
    const calls: string[] = []
    const detail = marketplaceDetail()
    mocks.api = new Proxy({}, {
      get: (_target, module) => new Proxy({}, {
        get: (_inner, action) => async () => {
          calls.push(`${String(module)}.${String(action)}`)
          if (module === 'marketplaces' && action === 'add')
            return detail
          if (module === 'marketplaces' && action === 'get')
            return detail
          throw new HarnessError({ code: 'not_implemented', message: 'Not here.' })
        },
      }),
    })
    const store = useMarketplacesStore()
    store.list = marketplaceList({ items: [], suggestions: [OFFICIAL_SUGGESTION] })
    store.loadedAt = Date.now()
    const plugins = usePluginsStore()
    plugins.loaded = true
    await render()
    expect(byTestId(testIds.marketplaceSuggestion)).not.toBeNull()
    expect(calls).toEqual([])
    byTestId(testIds.marketplaceSuggestionAdd)!.click()
    await settle()
    expect(calls[0]).toBe('marketplaces.add')
    expect(calls.filter(call => call !== 'marketplaces.get')).toEqual(['marketplaces.add'])
  })

  it('toasts a failed suggested add', async () => {
    api.marketplaces.list.mockResolvedValue(marketplaceList({ items: [], suggestions: [OFFICIAL_SUGGESTION] }))
    api.marketplaces.add.mockRejectedValue(new HarnessError({ code: 'conflict', message: 'harness-forge is offline (HF_OFFLINE=1).', details: { reason: 'offline' } }))
    await render()
    byTestId(testIds.marketplaceSuggestionAdd)!.click()
    await settle()
    expect(toast.error).toHaveBeenCalledWith('Could not complete the request', { description: 'harness-forge is offline (HF_OFFLINE=1).' })
    expect(byTestId(testIds.marketplaceSuggestion)).not.toBeNull()
  })

  it('stays dismissed (localStorage) and hides once the repository is added', async () => {
    api.marketplaces.list.mockResolvedValue(marketplaceList({ items: [], suggestions: [OFFICIAL_SUGGESTION] }))
    await render()
    byTestId(testIds.marketplaceSuggestionDismiss)!.click()
    await settle()
    expect(byTestId(testIds.marketplaceSuggestion)).toBeNull()
    expect(localStorage.getItem(SUGGESTION_DISMISSED_KEY)).toBe('1')
    unmount?.()
    await render()
    expect(byTestId(testIds.marketplaceSuggestion)).toBeNull()

    localStorage.removeItem(SUGGESTION_DISMISSED_KEY)
    unmount?.()
    disposePinia(pinia)
    pinia = createPinia()
    setActivePinia(pinia)
    api.marketplaces.list.mockResolvedValue(marketplaceList({ items: [marketplaceSummary()], suggestions: [OFFICIAL_SUGGESTION] }))
    api.marketplaces.get.mockResolvedValue(marketplaceDetail())
    await render()
    expect(byTestId(testIds.marketplaceSuggestion)).toBeNull()
  })
})

describe('marketplacesView: refresh, remove, install', () => {
  it('toasts a failed refresh from the row menu and every failure of Refresh all', async () => {
    twoMarketplaces()
    setQuery({ m: marketplaceId(2) })
    await render()
    api.marketplaces.refresh.mockRejectedValue(new HarnessError({ code: 'provider_unreachable', message: 'The host failed.' }))
    await openWithKeyboard(byTestId(testIds.marketplaceRowMenu)!)
    byTestId(testIds.marketplaceRefresh)!.click()
    await settle()
    expect(toast.error).toHaveBeenCalledWith('Could not refresh acme: The host failed.')

    vi.mocked(toast.error).mockClear()
    byTestId(testIds.marketplaceRefreshAll)!.click()
    await settle()
    expect(api.marketplaces.refresh.mock.calls.slice(-2).map(([call]) => call.params.id)).toEqual([marketplaceId(1), marketplaceId(2)])
    expect(vi.mocked(toast.error).mock.calls.map(([message]) => message)).toEqual([
      'Could not refresh claude-plugins-official: The host failed.',
      'Could not refresh acme: The host failed.',
    ])
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('removes the selected marketplace after the confirmation and falls back to All', async () => {
    twoMarketplaces()
    setQuery({ m: marketplaceId(2) })
    await render()
    await openWithKeyboard(byTestId(testIds.marketplaceRowMenu)!)
    byTestId(testIds.marketplaceRemove)!.click()
    await settle()
    expect(document.body.textContent).toContain('Remove acme?')
    expect(document.body.textContent).toContain('Removing a marketplace keeps the plugins you installed from it.')
    api.marketplaces.remove.mockResolvedValue(undefined)
    api.marketplaces.list.mockResolvedValue(marketplaceList())
    byTestId(testIds.marketplaceRemoveConfirm)!.click()
    await settle()
    expect(api.marketplaces.remove).toHaveBeenCalledWith({ params: { id: marketplaceId(2) } })
    expect(toast.success).toHaveBeenCalledWith('Removed acme')
    expect(replace).toHaveBeenLastCalledWith({ query: {} })
    expect(allByTestId(testIds.marketplaceRow).map(row => row.dataset.marketplaceId)).toEqual(['', marketplaceId(1)])
    expect(byTestId(testIds.marketplaceRemoveConfirm)).toBeNull()
    expect(document.activeElement).toBe(allByTestId(testIds.marketplaceRow)[0])
  })

  it('installs an entry through the install dialog and opens the plugin page', async () => {
    twoMarketplaces()
    setQuery({ m: marketplaceId(1) })
    usePluginsStore().items = [pluginSummary({ id: 'dice-roller' })]
    await render()
    api.pluginInstall.inspect.mockResolvedValue({
      manifest: { manifestVersion: 1, id: 'review-kit', name: 'Review kit', version: '1.2.0', engines: { harness: '^1.6.0' } },
      kind: 'declarative',
      format: 'claude',
      source: 'marketplace',
      sha256: 'c'.repeat(64),
      contributions: { providers: [], models: 0, tools: [], mcpServers: [], commands: ['review-kit:review'], hooks: [], agents: [], skills: [], commandHooks: 0, outputStyles: [] },
      networkHosts: [],
      secretsRequested: [],
      permissions: [],
      requiresTrust: false,
      compatible: true,
      existing: null,
      files: { count: 3, bytes: 900 },
      warnings: [],
      claude: claudePluginInfo({ executables: [] }),
    })
    api.pluginInstall.install.mockResolvedValue(pluginDetail({ id: 'review-kit', name: 'Review kit' }))
    api.plugins.get.mockResolvedValue(pluginDetail({ id: 'review-kit', name: 'Review kit' }))
    const row = allByTestId(testIds.marketplaceEntry).find(entry => entry.dataset.name === 'review-kit')!
    row.querySelector<HTMLButtonElement>(`[data-testid="${testIds.marketplaceEntryInstall}"]`)!.click()
    await settle()
    expect(byTestId(testIds.marketplaceInstallDialog)?.dataset.mode).toBe('install')
    expect(api.pluginInstall.inspect).toHaveBeenCalledWith({ body: { source: 'marketplace', marketplaceId: marketplaceId(1), plugin: 'review-kit' } })
    byTestId(testIds.installSubmit)!.click()
    await settle()
    expect(navigate).toHaveBeenCalledWith('/plugins/review-kit')
    expect(byTestId(testIds.marketplaceInstallDialog)).toBeNull()
  })
})
