// The P12-0b stubs of the Marketplaces page (Phase 12, ADR-054; docs/UI.md 8.13, 10.9; C46-T2 / T3): one mount per
// component (root test id, props accepted, emits), the route of the page (static over `[id].vue`) and the reserved id.
import type { MockApi } from '~/utils/testing/mock-api'
import { isReservedPluginId } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import MarketplacesPage from '~/pages/plugins/marketplaces.vue'
import { testIds } from '~/utils/testids'
import {
  authStatus,
  marketplaceDetail,
  marketplaceEntry,
  marketplaceId,
  marketplaceList,
  marketplaceSummary,
  pluginDetail,
} from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { allByTestId, byTestId, mountInShell, settle } from '../list/testing'
import MarketplaceAddDialog from './MarketplaceAddDialog.vue'
import MarketplaceEntryRow from './MarketplaceEntryRow.vue'
import MarketplaceInstallDialog from './MarketplaceInstallDialog.vue'
import MarketplaceStrip from './MarketplaceStrip.vue'
import MarketplaceSuggestion from './MarketplaceSuggestion.vue'
import MarketplacesView from './MarketplacesView.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let unmount: (() => void) | null = null

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  api.auth.status.mockResolvedValue(authStatus())
})

afterEach(() => {
  unmount?.()
  unmount = null
  document.body.replaceChildren()
  disposePinia(pinia)
})

function render(component: object, props: Record<string, unknown> = {}) {
  const wrapper = mountInShell(component, props)
  unmount = () => wrapper.unmount()
  return wrapper
}

describe('marketplace stubs (P12-0b)', () => {
  it('marketplacesView renders its root, loads the list and lists the loaded entries', async () => {
    api.marketplaces.list.mockResolvedValue(marketplaceList())
    render(MarketplacesView)
    await settle()
    expect(byTestId(testIds.marketplacesPage)).not.toBeNull()
    expect(api.marketplaces.list).toHaveBeenCalledTimes(1)
    expect(byTestId(testIds.marketplaceAdd)).not.toBeNull()
    expect(byTestId(testIds.marketplaceRefreshAll)).not.toBeNull()
    expect(allByTestId(testIds.marketplaceRow).map(row => row.dataset.marketplaceId)).toEqual(['', marketplaceId(1)])
  })

  it('the page mounts MarketplacesView, and the static route wins over the plugin page', async () => {
    api.marketplaces.list.mockResolvedValue(marketplaceList({ items: [] }))
    render(MarketplacesPage)
    await settle()
    expect(byTestId(testIds.marketplacesPage)).not.toBeNull()
    expect(byTestId(testIds.marketplaceEmpty)?.dataset.value).toBe('none')

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/plugins/:id', name: 'plugin', component: { render: () => h('div') } },
        { path: '/plugins/marketplaces', name: 'marketplaces', component: { render: () => h('div') } },
      ],
    })
    expect(router.resolve('/plugins/marketplaces').name).toBe('marketplaces')
    expect(router.resolve('/plugins/dice').name).toBe('plugin')
    expect(isReservedPluginId('marketplaces')).toBe(true)
  })

  it('marketplaceSuggestion emits add and dismiss', async () => {
    const add = vi.fn()
    const dismiss = vi.fn()
    render(MarketplaceSuggestion, { onAdd: add, onDismiss: dismiss })
    expect(byTestId(testIds.marketplaceSuggestion)?.textContent).toContain('anthropics/claude-plugins-official')
    byTestId(testIds.marketplaceSuggestionAdd)!.click()
    byTestId(testIds.marketplaceSuggestionDismiss)!.click()
    expect(add).toHaveBeenCalledTimes(1)
    expect(dismiss).toHaveBeenCalledTimes(1)
  })

  it('marketplaceStrip renders All and one chip per marketplace and emits select', async () => {
    const select = vi.fn()
    render(MarketplaceStrip, {
      items: [marketplaceSummary(), marketplaceSummary({ id: marketplaceId(2), name: 'acme', lastError: { code: 'provider_unreachable', message: 'Down' } })],
      selectedId: marketplaceId(1),
      busyIds: [marketplaceId(2)],
      onSelect: select,
    })
    const rows = allByTestId(testIds.marketplaceRow)
    expect(rows.map(row => [row.dataset.marketplaceId, row.dataset.state])).toEqual([['', 'ok'], [marketplaceId(1), 'ok'], [marketplaceId(2), 'error']])
    expect(byTestId(testIds.marketplaceRowMenu)?.getAttribute('aria-label')).toBe('Actions for claude-plugins-official')
    rows[0]!.click()
    expect(select).toHaveBeenCalledWith(null)
  })

  it('marketplaceAddDialog adds what the input names', async () => {
    const added = vi.fn()
    api.marketplaces.add.mockResolvedValue(marketplaceDetail())
    render(MarketplaceAddDialog, { open: true, onAdded: added })
    await settle()
    expect(byTestId(testIds.marketplaceAddDialog)).not.toBeNull()
    const input = byTestId<HTMLInputElement>(testIds.marketplaceAddInput)!
    input.value = 'anthropics/claude-plugins-official'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect(byTestId(testIds.marketplaceAddSource)?.dataset.value).toBe('github')
    byTestId(testIds.marketplaceAddSubmit)!.click()
    await settle()
    expect(api.marketplaces.add).toHaveBeenCalledWith({ body: { source: { type: 'github', repo: 'anthropics/claude-plugins-official' } } })
    expect(added).toHaveBeenCalledTimes(1)
  })

  it('marketplaceEntryRow renders the entry and emits install or update', async () => {
    const install = vi.fn()
    render(MarketplaceEntryRow, {
      entry: { marketplaceId: marketplaceId(1), marketplaceName: 'claude-plugins-official', entry: marketplaceEntry(), state: 'available', pluginId: null, installedVersion: null, update: null },
      onInstall: install,
    })
    const row = byTestId(testIds.marketplaceEntry)!
    expect(row.tagName).toBe('ARTICLE')
    expect(row.dataset).toMatchObject({ name: 'review-kit', state: 'available', marketplaceId: marketplaceId(1) })
    byTestId(testIds.marketplaceEntryInstall)!.click()
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('marketplaceInstallDialog inspects the entry and renders the review', async () => {
    api.pluginInstall.inspect.mockResolvedValue({
      manifest: { manifestVersion: 1, id: 'review-kit', name: 'Review kit', version: '1.2.0', engines: { harness: '^1.0.0' } },
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
      claude: null,
    })
    api.pluginInstall.install.mockResolvedValue(pluginDetail({ id: 'review-kit', name: 'Review kit' }))
    api.plugins.get.mockResolvedValue(pluginDetail({ id: 'review-kit', name: 'Review kit' }))
    const installed = vi.fn()
    render(MarketplaceInstallDialog, { open: true, marketplaceId: marketplaceId(1), entryName: 'review-kit', mode: 'update', onInstalled: installed })
    await settle()
    expect(byTestId(testIds.marketplaceInstallDialog)?.dataset.mode).toBe('update')
    expect(api.pluginInstall.inspect).toHaveBeenCalledWith({ body: { source: 'marketplace', marketplaceId: marketplaceId(1), plugin: 'review-kit' } })
    expect(document.body.querySelector('[data-slot="install-review"]')).not.toBeNull()
    byTestId(testIds.installSubmit)!.click()
    await settle()
    expect(installed).toHaveBeenCalledWith('review-kit')
  })
})
