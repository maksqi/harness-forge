import type { PluginSummary } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { usePluginsStore } from '~/stores/plugins'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'
import { pluginDetail, pluginSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { lastListRoute } from './list-route'
import PluginListView from './PluginListView.vue'
import { allByTestId, byTestId, hrefOf, mountInShell, openWithKeyboard, settle } from './testing'

interface MockRoute { path: string, fullPath: string, query: Record<string, string> }

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  route: null as null | MockRoute,
  navigateTo: vi.fn(),
  replace: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))

vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('./nuxt-imports', () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ replace: mocks.replace }),
  navigateTo: mocks.navigateTo,
  useHead: vi.fn(),
}))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))

const none = { providers: [], models: 0, tools: [], mcpServers: [], commands: [], hooks: [], agents: [], skills: [], commandHooks: 0, outputStyles: [] }
const PLUGINS: PluginSummary[] = [
  pluginSummary({ id: 'core-providers', name: 'Core providers', kind: 'code', source: 'builtin', builtin: true, removable: false, runsCode: false, description: 'Builtin LLM providers', contributions: { ...none, providers: ['anthropic'] } }),
  pluginSummary({ id: 'dice-roller', name: 'Dice roller', description: 'Rolls dice' }),
  pluginSummary({ id: 'acme', name: 'Acme docs', kind: 'declarative', source: 'npm', runsCode: false, description: 'Search the Acme docs', contributions: { ...none, mcpServers: ['acme'] } }),
  pluginSummary({ id: 'shell', name: 'Shell tools', state: 'untrusted', description: null, contributions: none }),
  pluginSummary({ id: 'off', name: 'Old plugin', description: 'Legacy', enabled: false, state: 'disabled', contributions: none }),
]

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper | null = null

function go(fullPath: string) {
  const [path, search = ''] = fullPath.split('?')
  Object.assign(mocks.route!, { path, fullPath, query: Object.fromEntries(new URLSearchParams(search)) })
}

async function mountList(path = '/plugins') {
  go(path)
  wrapper = mountInShell(PluginListView)
  await settle()
  return wrapper
}

function cardIds(): string[] {
  return allByTestId(testIds.pluginCard).map(card => card.dataset.pluginId!)
}

function card(id: string): HTMLElement {
  const found = allByTestId(testIds.pluginCard).find(element => element.dataset.pluginId === id)
  expect(found, id).toBeDefined()
  return found!
}

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.route = reactive({ path: '/plugins', fullPath: '/plugins', query: {} })
  mocks.navigateTo.mockReset()
  mocks.replace.mockReset()
  mocks.replace.mockImplementation(async (to: { path?: string, query?: Record<string, string> }) => {
    go(hrefOf({ path: to.path ?? mocks.route!.path, query: to.query ?? {} }))
  })
  mocks.toast.mockReset()
  mocks.toast.error.mockReset()
  api.plugins.list.mockResolvedValue({ items: PLUGINS })
  api.health.get.mockResolvedValue({ ok: true, version: '0.1.0', node: 'v26', uptimeSec: 1, safeMode: false, pluginApiVersion: '1.0.0', versions: { ai: '7', hono: '4' } })
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  disposePinia(pinia)
})

describe('pluginListView: list and filters', () => {
  it('shows six skeleton cards while loading, then one card per plugin', async () => {
    let release: (value: { items: PluginSummary[] }) => void = () => {}
    api.plugins.list.mockReturnValue(new Promise((resolve) => {
      release = resolve
    }))
    wrapper = mountInShell(PluginListView)
    await settle()
    expect(document.querySelectorAll('[aria-label="Loading plugins"] > div')).toHaveLength(6)
    release({ items: PLUGINS })
    await settle()
    // Builtins first, then by name (like the sidebar).
    expect(cardIds()).toEqual(['core-providers', 'acme', 'dice-roller', 'off', 'shell'])
    expect(document.body.textContent).toContain('5 plugins')
  })

  it('filters by ?filter= and ?q= and shows what is filtered', async () => {
    await mountList('/plugins?filter=disabled')
    expect(cardIds()).toEqual(['off'])
    expect(document.body.textContent).toContain('1 of 5 plugins')
    expect(document.body.textContent).toContain('Disabled')

    go('/plugins?filter=mcp')
    await settle()
    expect(cardIds()).toEqual(['acme'])

    go('/plugins?filter=kind&q=dice')
    await settle()
    expect(cardIds()).toEqual(['dice-roller'])
    expect(byTestId<HTMLInputElement>(testIds.pluginsSearch)!.value).toBe('dice')
  })

  it('searches name, id and description and syncs the search to ?q=', async () => {
    await mountList()
    const search = byTestId<HTMLInputElement>(testIds.pluginsSearch)!
    search.value = 'ACME'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect(cardIds()).toEqual(['acme'])
    await new Promise(resolve => setTimeout(resolve, 260))
    expect(mocks.replace).toHaveBeenLastCalledWith({ query: { q: 'ACME' } })
    expect(lastListRoute()).toBe('/plugins?q=ACME')

    search.value = 'llm'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect(cardIds()).toEqual(['core-providers'])
  })

  it('drops a pending search update when the page is left', async () => {
    await mountList()
    const search = byTestId<HTMLInputElement>(testIds.pluginsSearch)!
    search.value = 'dice'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    wrapper!.unmount()
    wrapper = null
    await new Promise(resolve => setTimeout(resolve, 260))
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it('shows "No plugins match" with Clear filters', async () => {
    await mountList('/plugins?filter=providers&q=zzz')
    expect(cardIds()).toEqual([])
    expect(document.body.textContent).toContain('No plugins match')
    const clear = Array.from(document.querySelectorAll('button')).filter(button => button.textContent?.trim() === 'Clear filters')
    expect(clear.length).toBeGreaterThan(0)
    clear.at(-1)!.click()
    await settle()
    expect(mocks.replace).toHaveBeenCalledWith({ path: '/plugins' })
    expect(cardIds()).toHaveLength(5)
  })

  it('shows a load error with Retry', async () => {
    api.plugins.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Database is locked.' }))
    await mountList()
    expect(document.body.textContent).toContain('Could not load plugins')
    expect(document.body.textContent).toContain('Database is locked.')
    Array.from(document.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Retry')!.click()
    await settle()
    expect(cardIds()).toHaveLength(5)
  })

  it('shows the safe-mode banner when the server loads builtins only', async () => {
    api.health.get.mockResolvedValue({ ok: true, version: '0.1.0', node: 'v26', uptimeSec: 1, safeMode: true, pluginApiVersion: '1.0.0', versions: { ai: '7', hono: '4' } })
    await mountList()
    expect(document.body.textContent).toContain('Safe mode')
  })
})

describe('pluginListView: actions', () => {
  it('enables and disables plugins from the card switch', async () => {
    await mountList()
    api.plugins.disable.mockResolvedValue(pluginDetail({ id: 'dice-roller', enabled: false, state: 'disabled' }))
    card('dice-roller').querySelector<HTMLButtonElement>(`[data-testid="${testIds.pluginCardSwitch}"]`)!.click()
    await settle()
    expect(api.plugins.disable).toHaveBeenCalledWith({ params: { id: 'dice-roller' } })
    expect(card('dice-roller').dataset.state).toBe('disabled')
    expect(card('dice-roller').dataset.enabled).toBe('false')

    api.plugins.enable.mockRejectedValue(new HarnessError({ code: 'internal_error', message: 'Boom' }))
    card('off').querySelector<HTMLButtonElement>(`[data-testid="${testIds.pluginCardSwitch}"]`)!.click()
    await settle()
    expect(api.plugins.enable).toHaveBeenCalledWith({ params: { id: 'off' } })
    expect(mocks.toast.error).toHaveBeenCalledWith('Something went wrong', { description: 'Boom' })
    // Rolled back by the store.
    expect(card('off').dataset.enabled).toBe('false')
  })

  it('says so when an enabled plugin needs trust', async () => {
    await mountList()
    api.plugins.enable.mockResolvedValue(pluginDetail({ id: 'off', name: 'Old plugin', enabled: true, state: 'untrusted' }))
    card('off').querySelector<HTMLButtonElement>(`[data-testid="${testIds.pluginCardSwitch}"]`)!.click()
    await settle()
    expect(mocks.toast).toHaveBeenCalledWith('Old plugin needs your trust', { description: 'Review and trust it to run its code.' })
  })

  it('opens the Logs tab from an error card and TrustDialog from Review', async () => {
    api.plugins.list.mockResolvedValue({ items: [...PLUGINS, pluginSummary({ id: 'broken', name: 'Broken', state: 'error', lastError: { code: 'plugin_error', message: 'boom' } })] })
    await mountList()
    card('broken').querySelector<HTMLButtonElement>(`[data-testid="${testIds.pluginCardLogs}"]`)!.click()
    expect(mocks.navigateTo).toHaveBeenCalledWith('/plugins/broken?tab=logs')

    expect(document.querySelector('[data-stub="TrustDialog"]')).toBeNull()
    card('shell').querySelector<HTMLButtonElement>(`[data-testid="${testIds.pluginCardReview}"]`)!.click()
    await settle()
    const dialog = document.querySelector<HTMLElement>('[data-stub="TrustDialog"]')!
    expect(dialog.dataset.pluginId).toBe('"shell"')
    expect(dialog.dataset.open).toBe('true')
    wrapper!.findComponent({ name: 'TrustDialog' }).vm.$emit('trusted', 'shell')
    await settle()
    expect(document.querySelector<HTMLElement>('[data-stub="TrustDialog"]')!.dataset.open).toBe('false')
  })

  it('opens the install dialog and the New plugin menu from the header', async () => {
    await mountList()
    const ui = useUiStore()
    byTestId<HTMLButtonElement>(testIds.pluginsInstall)!.click()
    expect(ui.installDialogOpen).toBe(true)
    await openWithKeyboard(byTestId(testIds.pluginsNew)!)
    expect(byTestId(testIds.pluginsNewProvider)?.getAttribute('href')).toBe('/plugins/new?type=provider')
    expect(byTestId(testIds.pluginsNewCode)?.getAttribute('href')).toBe('/plugins/new?type=code')
  })

  it('keeps builtins without a way to remove them from the list', async () => {
    await mountList()
    expect(usePluginsStore().byId('core-providers')?.removable).toBe(false)
    expect(card('core-providers').textContent).toContain('Core')
    expect(card('core-providers').querySelector('button:not([role="switch"])')).toBeNull()
  })
})
