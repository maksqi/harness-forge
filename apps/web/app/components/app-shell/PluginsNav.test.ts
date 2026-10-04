import type { PluginSummary } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { allByTestId, byTestId, mountInShell, openWithKeyboard, settle } from '~/components/plugins/list/testing'
import { usePluginsStore } from '~/stores/plugins'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'
import { pluginSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import PluginsNav from './PluginsNav.vue'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  route: null as null | { path: string, fullPath: string, query: Record<string, string> },
}))

vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('./nuxt-imports', () => ({
  useRoute: () => mocks.route,
  navigateTo: vi.fn(),
  useColorMode: () => ({ preference: 'dark', value: 'dark' }),
}))

const builtin = { kind: 'code', source: 'builtin', builtin: true, removable: false, runsCode: false } as const
const noContributions = { providers: [], models: 0, tools: [], mcpServers: [], commands: [], hooks: [], agents: [], skills: [] }

const PLUGINS: PluginSummary[] = [
  pluginSummary({ id: 'core-providers', name: 'Core providers', ...builtin, contributions: { ...noContributions, providers: ['anthropic', 'openai'] } }),
  pluginSummary({ id: 'core-tools', name: 'Core tools', ...builtin, contributions: { ...noContributions, tools: ['current_time', 'web_fetch'] } }),
  pluginSummary({ id: 'zeta-search', name: 'zeta search', kind: 'declarative', source: 'zip', runsCode: false, contributions: { ...noContributions, tools: ['zeta'] } }),
  pluginSummary({ id: 'acme', name: 'Acme docs', kind: 'declarative', source: 'npm', runsCode: false, state: 'error', contributions: { ...noContributions, mcpServers: ['acme'], commands: ['acme'] } }),
  pluginSummary({ id: 'broken', name: 'Beta tools', state: 'untrusted' }),
  pluginSummary({ id: 'off', name: 'Mid plugin', enabled: false, state: 'disabled', contributions: noContributions }),
  pluginSummary({ id: 'busy', name: 'Loading one', state: 'loading', contributions: noContributions }),
]

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper | null = null

function go(fullPath: string) {
  const [path, search = ''] = fullPath.split('?')
  mocks.route!.path = path!
  mocks.route!.fullPath = fullPath
  mocks.route!.query = Object.fromEntries(new URLSearchParams(search))
}

async function mountNav(items: PluginSummary[] = PLUGINS) {
  api.plugins.list.mockResolvedValue({ items })
  wrapper = mountInShell(PluginsNav)
  await settle()
  return wrapper
}

function filterRow(value: string): HTMLElement {
  const row = allByTestId(testIds.pluginsFilter).find(element => element.dataset.value === value)
  expect(row, value).toBeDefined()
  return row!
}

function countOf(value: string): string | undefined {
  return document.querySelector(`[data-slot="plugins-filter-count"][data-value="${value}"]`)?.textContent?.trim()
}

function navRows() {
  return allByTestId(testIds.pluginNavRow)
}

/** The visible name of a row (the icon's monogram letters are decorative). */
function rowName(row: HTMLElement): string | undefined {
  return row.querySelector(':scope > span:last-child')?.textContent?.trim()
}

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.route = reactive({ path: '/plugins', fullPath: '/plugins', query: {} })
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  disposePinia(pinia)
})

describe('pluginsNav: actions', () => {
  it('offers Provider and Code plugin under "New plugin"', async () => {
    await mountNav()
    await openWithKeyboard(byTestId(testIds.pluginsNew)!)
    expect(byTestId(testIds.pluginsNewProvider)?.getAttribute('href')).toBe('/plugins/new?type=provider')
    expect(byTestId(testIds.pluginsNewCode)?.getAttribute('href')).toBe('/plugins/new?type=code')
    expect(byTestId(testIds.pluginsNewProvider)?.textContent).toContain('Provider')
    expect(byTestId(testIds.pluginsNewCode)?.textContent).toContain('Code plugin')
  })

  it('opens the install dialog through the ui store', async () => {
    await mountNav()
    const ui = useUiStore()
    expect(ui.installDialogOpen).toBe(false)
    byTestId<HTMLButtonElement>(testIds.pluginsInstall)!.click()
    await settle()
    expect(ui.installDialogOpen).toBe(true)
    expect(ui.installSource).toBe('zip')
    // The row is a button, not a link: it does not leave the page.
    expect(byTestId(testIds.pluginsInstall)!.tagName).toBe('BUTTON')
  })
})

describe('pluginsNav: browse filters', () => {
  it('links every filter to /plugins?filter= and shows the counts of the store', async () => {
    await mountNav()
    expect(allByTestId(testIds.pluginsFilter).map(row => [row.dataset.value, row.textContent?.trim(), row.getAttribute('href')])).toEqual([
      ['all', 'All', '/plugins'],
      ['providers', 'Providers', '/plugins?filter=providers'],
      ['tools', 'Tools', '/plugins?filter=tools'],
      ['mcp', 'MCP servers', '/plugins?filter=mcp'],
      ['commands', 'Commands', '/plugins?filter=commands'],
      ['disabled', 'Disabled', '/plugins?filter=disabled'],
    ])
    expect(['all', 'providers', 'tools', 'mcp', 'commands', 'disabled'].map(countOf)).toEqual(['7', '1', '3', '1', '1', '1'])
  })

  it('highlights the filter of the list page and none on other plugin pages', async () => {
    await mountNav()
    expect(filterRow('all').dataset.active).toBe('true')
    go('/plugins?filter=tools')
    await settle()
    expect(filterRow('tools').dataset.active).toBe('true')
    expect(filterRow('all').dataset.active).toBeUndefined()
    go('/plugins?filter=kind')
    await settle()
    expect(filterRow('all').dataset.active).toBe('true')
    go('/plugins/acme')
    await settle()
    expect(allByTestId(testIds.pluginsFilter).some(row => row.dataset.active)).toBe(false)
  })

  it('updates the counts and the list live from plugin.changed events', async () => {
    await mountNav()
    const plugins = usePluginsStore()
    plugins.applyEvent(createServerEvent('plugin.changed', {
      id: 'new-one',
      plugin: pluginSummary({ id: 'new-one', name: 'Alpha plugin', contributions: { ...noContributions, commands: ['alpha'] } }),
    }))
    await settle()
    expect(countOf('all')).toBe('8')
    expect(countOf('commands')).toBe('2')
    expect(navRows().map(row => row.dataset.pluginId)).toContain('new-one')

    plugins.applyEvent(createServerEvent('plugin.changed', { id: 'acme', plugin: null }))
    await settle()
    expect(countOf('all')).toBe('7')
    expect(navRows().map(row => row.dataset.pluginId)).not.toContain('acme')
  })
})

describe('pluginsNav: installed list', () => {
  it('lists builtins first, then every plugin by name, with icon, link and state dot', async () => {
    await mountNav()
    expect(navRows().map(rowName)).toEqual([
      'Core providers',
      'Core tools',
      'Acme docs',
      'Beta tools',
      'Loading one',
      'Mid plugin',
      'zeta search',
    ])
    expect(navRows()[2]!.getAttribute('href')).toBe('/plugins/acme')
    expect(navRows().every(row => row.querySelector('[role="img"]'))).toBe(true)
    const dots = navRows().map(row => row.closest('li')!.querySelector<HTMLElement>('[data-slot="status-dot"]')?.dataset.status)
    expect(dots).toEqual(['ok', 'ok', 'error', 'warning', 'running', 'off', 'ok'])
    expect(navRows()[3]!.closest('li')!.textContent).toContain('Untrusted')
  })

  it('marks the plugin of the detail page as active', async () => {
    go('/plugins/acme')
    await mountNav()
    const active = navRows().filter(row => row.dataset.active === 'true')
    expect(active.map(row => row.dataset.pluginId)).toEqual(['acme'])
    go('/plugins/new')
    await settle()
    expect(navRows().some(row => row.dataset.active)).toBe(false)
  })

  it('shows skeleton rows while loading and Retry after a failure', async () => {
    let fail = true
    api.plugins.list.mockImplementation(async () => {
      if (fail)
        throw new HarnessError({ code: 'internal_error', message: 'Boom' })
      return { items: PLUGINS }
    })
    wrapper = mountInShell(PluginsNav)
    expect(document.querySelectorAll('[data-sidebar="menu-skeleton"]').length).toBeGreaterThan(0)
    await settle()
    expect(document.body.textContent).toContain('Couldn\'t load plugins')
    expect(countOf('all')).toBeUndefined()

    fail = false
    Array.from(document.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Retry')!.click()
    await settle()
    expect(navRows()).toHaveLength(7)
    expect(countOf('all')).toBe('7')
  })

  it('reuses a list the store already has', async () => {
    api.plugins.list.mockResolvedValue({ items: PLUGINS })
    await usePluginsStore().fetchAll()
    api.plugins.list.mockClear()
    wrapper = mountInShell(PluginsNav)
    await settle()
    expect(api.plugins.list).not.toHaveBeenCalled()
    expect(navRows()).toHaveLength(7)
  })
})
