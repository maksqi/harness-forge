import type { PluginDetail } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { rememberListRoute } from '~/components/plugins/list/list-route'
import { byTestId, hrefOf, mountInShell, openWithKeyboard, settle } from '~/components/plugins/list/testing'
import { useAuthStore } from '~/stores/auth'
import { useMarketplacesStore } from '~/stores/marketplaces'
import { testIds } from '~/utils/testids'
import { authStatus, claudePluginInfo, commitSha, logEntry, marketplaceList, pluginDetail, pluginOrigin, pluginUpdate, toolSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import PluginDetailView from './PluginDetailView.vue'

interface MockRoute { path: string, fullPath: string, query: Record<string, string> }

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  route: null as null | MockRoute,
  navigateTo: vi.fn(),
  replace: vi.fn(),
  download: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))

vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('~/components/plugins/list/nuxt-imports', () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ replace: mocks.replace }),
  navigateTo: mocks.navigateTo,
  useHead: vi.fn(),
}))
vi.mock('~/utils/download', () => ({ downloadResponse: mocks.download }))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))

const none = { providers: [], models: 0, tools: [], mcpServers: [], commands: [], hooks: [], agents: [], skills: [], commandHooks: 0, outputStyles: [] }
const settingsSchema = { type: 'object' as const, properties: { sides: { type: 'integer' as const, title: 'Sides', default: 6 } } }

const DETAILS: Record<string, PluginDetail> = {
  'dice-roller': pluginDetail({
    id: 'dice-roller',
    name: 'Dice roller',
    version: '1.2.0',
    kind: 'code',
    source: 'created',
    editable: true,
    hasSettings: true,
    contributions: { ...none, tools: ['roll_dice'] },
    manifest: { manifestVersion: 1, id: 'dice-roller', name: 'Dice roller', version: '1.2.0', engines: { harness: '^1.0.0' }, main: 'index.mjs', settings: settingsSchema },
  }),
  'npm-tool': pluginDetail({ id: 'npm-tool', name: 'Npm tool', kind: 'code', source: 'npm', editable: false, contributions: none }),
  'zip-provider': pluginDetail({ id: 'zip-provider', name: 'Zip provider', kind: 'declarative', source: 'zip', runsCode: false, editable: false, trust: { required: false, trusted: true, hash: 'b'.repeat(64), trustedHash: null }, contributions: none }),
  'core-mcp': pluginDetail({ id: 'core-mcp', name: 'MCP servers', kind: 'code', source: 'builtin', builtin: true, removable: false, runsCode: false, editable: false, trust: { required: false, trusted: true, hash: null, trustedHash: null }, contributions: none }),
  'broken': pluginDetail({ id: 'broken', name: 'Broken', state: 'error', lastError: { code: 'plugin_error', message: 'setup() threw: boom' }, contributions: none }),
  'shell': pluginDetail({ id: 'shell', name: 'Shell tools', state: 'untrusted', trust: { required: true, trusted: false, hash: 'c'.repeat(64), trustedHash: null }, contributions: none }),
  // Phase 12: a Claude Code plugin installed from a marketplace (its userConfig is its settings).
  'review-kit': pluginDetail({
    id: 'review-kit',
    name: 'review-kit',
    version: '1.2.0',
    kind: 'declarative',
    format: 'claude',
    source: 'marketplace',
    sourceRef: 'review-kit@claude-plugins-official',
    editable: false,
    hasSettings: true,
    contributions: { ...none, commands: ['review-kit:review'] },
    manifest: {
      manifestVersion: 1,
      id: 'review-kit',
      name: 'review-kit',
      version: '1.2.0',
      engines: { harness: '^1.6.0' },
      settings: { type: 'object', required: ['API_TOKEN'], properties: { API_TOKEN: { type: 'string', format: 'secret', title: 'API token' } } },
    },
    origin: pluginOrigin({ commit: commitSha(2) }),
    claude: claudePluginInfo({
      version: '1.2.0-beta+claude',
      diagnostics: [{ level: 'warning', code: 'unknown-field', message: 'plugin.json has a field that is not read: "lspServers".', path: '.claude-plugin/plugin.json' }],
    }),
  }),
  'gh-tools': pluginDetail({
    id: 'gh-tools',
    name: 'gh-tools',
    kind: 'declarative',
    format: 'claude',
    source: 'github',
    sourceRef: 'acme/gh-tools@3f2a9c1d0e4b',
    editable: false,
    runsCode: false,
    trust: { required: false, trusted: true, hash: 'd'.repeat(64), trustedHash: null },
    contributions: none,
    origin: { kind: 'github', repo: 'acme/gh-tools', ref: 'main', commit: `3f2a9c1${'0'.repeat(33)}`, path: null },
    claude: claudePluginInfo({ executables: [], unsupported: [], userConfig: [] }),
  }),
}

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper | null = null

function go(fullPath: string) {
  const [path, search = ''] = fullPath.split('?')
  Object.assign(mocks.route!, { path, fullPath, query: Object.fromEntries(new URLSearchParams(search)) })
}

async function mountDetail(id: string, query = '') {
  go(`/plugins/${id}${query}`)
  wrapper = mountInShell(PluginDetailView, { pluginId: id })
  await settle(5)
  return wrapper
}

function activeTab(): string | undefined {
  return [testIds.pluginTabOverview, testIds.pluginTabConfiguration, testIds.pluginTabSource, testIds.pluginTabLogs]
    .find(id => byTestId(id)?.getAttribute('data-state') === 'active')
}

function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.trim() === text)
  expect(found, text).toBeDefined()
  return found as HTMLButtonElement
}

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.route = reactive({ path: '/plugins/dice-roller', fullPath: '/plugins/dice-roller', query: {} })
  mocks.navigateTo.mockReset()
  mocks.download.mockReset()
  mocks.replace.mockReset()
  mocks.replace.mockImplementation(async (to: { path?: string, query?: Record<string, string> }) => {
    go(hrefOf({ path: to.path ?? mocks.route!.path, query: to.query ?? {} }))
  })
  mocks.toast.mockReset()
  mocks.toast.success.mockReset()
  mocks.toast.error.mockReset()
  api.plugins.get.mockImplementation(async ({ params }: { params: { id: string } }) => {
    const detail = DETAILS[params.id]
    if (!detail)
      throw new HarnessError({ code: 'not_found', message: `No plugin "${params.id}"` })
    return structuredClone(detail)
  })
  api.tools.list.mockResolvedValue({ items: [toolSummary()] })
  api.plugins.logs.mockResolvedValue({ items: [logEntry(1, { message: 'setup complete' })] })
  api.plugins.getSettings.mockResolvedValue({ schema: settingsSchema, values: { sides: 6 }, secrets: {} })
  api.auth.status.mockResolvedValue(authStatus())
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  disposePinia(pinia)
})

describe('pluginDetailView: header', () => {
  it('shows name, version, badges, state and the back link to the last list state', async () => {
    rememberListRoute('/plugins?filter=tools')
    await mountDetail('dice-roller')
    const root = byTestId(testIds.pluginDetail)!
    expect(root.dataset.pluginId).toBe('dice-roller')
    expect(root.dataset.state).toBe('active')
    expect(root.querySelector('h1')?.textContent?.trim()).toBe('Dice roller')
    expect(root.textContent).toContain('v1.2.0')
    expect(root.textContent).toContain('Runs code')
    expect(byTestId(testIds.pluginState)?.dataset.state).toBe('active')
    expect(byTestId(testIds.pluginState)?.textContent?.trim()).toBe('Active')
    expect(byTestId(testIds.pluginEnabled)?.getAttribute('aria-checked')).toBe('true')
    const back = Array.from(root.querySelectorAll('a')).find(link => link.textContent?.trim() === 'Plugins')
    expect(back?.getAttribute('href')).toBe('/plugins?filter=tools')
  })

  it('turns the plugin off and on with the switch', async () => {
    await mountDetail('dice-roller')
    api.plugins.disable.mockResolvedValue({ ...DETAILS['dice-roller']!, enabled: false, state: 'disabled' })
    byTestId<HTMLButtonElement>(testIds.pluginEnabled)!.click()
    await settle()
    expect(api.plugins.disable).toHaveBeenCalledWith({ params: { id: 'dice-roller' } })
    expect(byTestId(testIds.pluginState)?.dataset.state).toBe('disabled')
    expect(byTestId<HTMLButtonElement>(testIds.pluginReload)!.disabled).toBe(true)
  })

  it('uninstalls after confirmation, with "Keep settings and stored data"', async () => {
    rememberListRoute('/plugins?q=dice')
    await mountDetail('dice-roller')
    api.plugins.remove.mockResolvedValue(undefined)
    await openWithKeyboard(byTestId(testIds.pluginMenu)!)
    byTestId<HTMLElement>(testIds.pluginUninstall)!.click()
    await settle(5)
    const dialog = document.querySelector('[data-slot="confirm-dialog"]')!
    expect(dialog.textContent).toContain('Uninstall Dice roller?')
    expect(dialog.textContent).toContain('Its providers, tools and commands are removed.')
    const keepData = byTestId<HTMLButtonElement>(testIds.pluginUninstallKeepData)!
    expect(keepData.getAttribute('aria-checked')).toBe('false')
    keepData.click()
    await settle()
    expect(keepData.getAttribute('aria-checked')).toBe('true')
    byTestId<HTMLButtonElement>(testIds.pluginUninstallConfirm)!.click()
    await settle()
    expect(api.plugins.remove).toHaveBeenCalledWith({ params: { id: 'dice-roller' }, query: { keepData: true } })
    expect(mocks.toast.success).toHaveBeenCalledWith('Uninstalled Dice roller')
    expect(mocks.navigateTo).toHaveBeenCalledWith('/plugins?q=dice')
  })

  it('uninstalls without keeping data by default, and keeps the dialog open on failure', async () => {
    await mountDetail('npm-tool')
    api.plugins.remove.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Disk is full.' }))
    await openWithKeyboard(byTestId(testIds.pluginMenu)!)
    byTestId<HTMLElement>(testIds.pluginUninstall)!.click()
    await settle(5)
    byTestId<HTMLButtonElement>(testIds.pluginUninstallConfirm)!.click()
    await settle()
    expect(api.plugins.remove).toHaveBeenCalledWith({ params: { id: 'npm-tool' }, query: { keepData: false } })
    expect(mocks.toast.error).toHaveBeenCalledWith('Could not uninstall Npm tool', { description: 'Disk is full.' })
    expect(mocks.navigateTo).not.toHaveBeenCalled()
    expect(document.querySelector('[data-slot="confirm-dialog"]')).not.toBeNull()
  })

  it('never offers Uninstall or Export for builtins', async () => {
    await mountDetail('core-mcp')
    expect(byTestId(testIds.pluginMenu)).toBeNull()
    expect(byTestId(testIds.pluginUninstall)).toBeNull()
    expect(byTestId(testIds.pluginExport)).toBeNull()
    expect(byTestId(testIds.pluginDetail)!.textContent).toContain('Core')
    expect(byTestId(testIds.pluginReload)).not.toBeNull()
  })

  it('exports the plugin as a zip and offers the wizard only for wizard-made providers', async () => {
    await mountDetail('zip-provider')
    const response = new Response('PK')
    api.pluginInstall.export.mockResolvedValue(response)
    await openWithKeyboard(byTestId(testIds.pluginMenu)!)
    expect(byTestId(testIds.pluginEdit)).toBeNull()
    byTestId<HTMLElement>(testIds.pluginExport)!.click()
    await settle()
    expect(api.pluginInstall.export).toHaveBeenCalledWith({ params: { id: 'zip-provider' } })
    expect(mocks.download).toHaveBeenCalledWith(response, 'zip-provider-1.0.0.zip')
  })

  it('reloads a code plugin after the password prompt when fresh auth is needed', async () => {
    api.auth.login.mockImplementation(async ({ body }: { body: { password: string } }) => {
      if (body.password !== 'correct-horse')
        throw new HarnessError({ code: 'unauthorized', message: 'Invalid password' })
      return authStatus({ enabled: true, authenticated: true, source: 'settings', freshUntil: Date.now() + 600_000 })
    })
    api.plugins.reload
      .mockRejectedValueOnce(new HarnessError({ code: 'forbidden', message: 'Log in again to continue.', action: 'login' }))
      .mockResolvedValueOnce(structuredClone(DETAILS['dice-roller']!))
    await mountDetail('dice-roller')
    byTestId<HTMLButtonElement>(testIds.pluginReload)!.click()
    await settle(5)
    expect(byTestId(testIds.confirmPasswordDialog)).not.toBeNull()
    expect(api.plugins.reload).toHaveBeenCalledTimes(1)

    const input = byTestId<HTMLInputElement>(testIds.confirmPasswordInput)!
    input.value = 'wrong'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    byTestId<HTMLButtonElement>(testIds.confirmPasswordSubmit)!.click()
    await settle()
    expect(byTestId(testIds.confirmPasswordDialog)?.textContent).toContain('Wrong password')

    input.value = 'correct-horse'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    byTestId<HTMLButtonElement>(testIds.confirmPasswordSubmit)!.click()
    await settle(5)
    expect(api.auth.login).toHaveBeenLastCalledWith({ body: { password: 'correct-horse' } })
    expect(api.plugins.reload).toHaveBeenCalledTimes(2)
    expect(mocks.toast.success).toHaveBeenCalledWith('Reloaded Dice roller')
    expect(byTestId(testIds.confirmPasswordDialog)).toBeNull()
  })

  it('asks for the password before reloading a code plugin when the session is not fresh', async () => {
    useAuthStore().status = authStatus({ enabled: true, source: 'settings', freshUntil: null })
    api.auth.login.mockResolvedValue(authStatus({ enabled: true, source: 'settings', freshUntil: Date.now() + 600_000 }))
    api.plugins.reload.mockResolvedValue(structuredClone(DETAILS['dice-roller']!))
    await mountDetail('dice-roller')
    byTestId<HTMLButtonElement>(testIds.pluginReload)!.click()
    await settle(5)
    expect(byTestId(testIds.confirmPasswordDialog)).not.toBeNull()
    expect(api.plugins.reload).not.toHaveBeenCalled()

    const input = byTestId<HTMLInputElement>(testIds.confirmPasswordInput)!
    input.value = 'correct-horse'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    byTestId<HTMLButtonElement>(testIds.confirmPasswordSubmit)!.click()
    await settle(5)
    expect(api.plugins.reload).toHaveBeenCalledTimes(1)
    expect(mocks.toast.success).toHaveBeenCalledWith('Reloaded Dice roller')
  })

  it('reloads a declarative plugin without asking for the password first', async () => {
    useAuthStore().status = authStatus({ enabled: true, source: 'settings', freshUntil: null })
    api.plugins.reload.mockResolvedValue(structuredClone(DETAILS['zip-provider']!))
    await mountDetail('zip-provider')
    byTestId<HTMLButtonElement>(testIds.pluginReload)!.click()
    await settle(5)
    expect(byTestId(testIds.confirmPasswordDialog)).toBeNull()
    expect(api.plugins.reload).toHaveBeenCalledTimes(1)
    expect(mocks.toast.success).toHaveBeenCalledWith('Reloaded Zip provider')
  })

  it('does not retry the reload when the password prompt is cancelled', async () => {
    api.plugins.reload.mockRejectedValue(new HarnessError({ code: 'forbidden', message: 'Log in again to continue.', action: 'login' }))
    await mountDetail('dice-roller')
    byTestId<HTMLButtonElement>(testIds.pluginReload)!.click()
    await settle(5)
    buttonByText('Cancel').click()
    await settle(5)
    expect(api.plugins.reload).toHaveBeenCalledTimes(1)
    expect(mocks.toast.error).not.toHaveBeenCalled()
    expect(byTestId<HTMLButtonElement>(testIds.pluginReload)!.disabled).toBe(false)
  })
})

describe('pluginDetailView: banners', () => {
  it('shows the last error with View logs and Reload', async () => {
    await mountDetail('broken')
    const banner = document.querySelector('[data-slot="plugin-status-banner"][data-state="error"]')!
    expect(banner.textContent).toContain('setup() threw: boom')
    buttonByText('View logs').click()
    await settle()
    expect(mocks.replace).toHaveBeenLastCalledWith({ query: { tab: 'logs' } })
    expect(activeTab()).toBe(testIds.pluginTabLogs)
  })

  it('shows the trust warning of untrusted plugins and opens TrustDialog', async () => {
    await mountDetail('shell')
    const warning = document.querySelector<HTMLElement>('[data-stub="TrustWarning"]')!
    expect(JSON.parse(warning.dataset.plugin!)).toMatchObject({ id: 'shell', state: 'untrusted' })
    expect(document.querySelector('[data-stub="TrustDialog"]')).toBeNull()
    buttonByText('Review and trust').click()
    await settle()
    const dialog = document.querySelector<HTMLElement>('[data-stub="TrustDialog"]')!
    expect(dialog.dataset.open).toBe('true')
    expect(dialog.dataset.pluginId).toBe('"shell"')
    wrapper!.findComponent({ name: 'TrustDialog' }).vm.$emit('trusted', 'shell')
    await settle()
    expect(api.plugins.get).toHaveBeenLastCalledWith({ params: { id: 'shell' } })
  })
})

describe('pluginDetailView: tabs', () => {
  it('lists the tabs of the plugin and follows ?tab=', async () => {
    await mountDetail('dice-roller', '?tab=logs')
    expect([testIds.pluginTabOverview, testIds.pluginTabConfiguration, testIds.pluginTabSource, testIds.pluginTabLogs].map(id => !!byTestId(id)))
      .toEqual([true, true, true, true])
    expect(activeTab()).toBe(testIds.pluginTabLogs)
    expect(byTestId(testIds.pluginLogs)).not.toBeNull()
    expect(byTestId(testIds.pluginLogEntry)?.textContent).toContain('setup complete')

    go('/plugins/dice-roller?tab=configuration')
    await settle(5)
    expect(activeTab()).toBe(testIds.pluginTabConfiguration)
    expect(byTestId(testIds.schemaForm)).not.toBeNull()

    go('/plugins/dice-roller?tab=unknown')
    await settle()
    expect(activeTab()).toBe(testIds.pluginTabOverview)
  })

  it('writes the chosen tab to the URL (Overview drops the parameter)', async () => {
    await mountDetail('dice-roller')
    // reka-ui tabs activate on a left mouse button press.
    byTestId(testIds.pluginTabLogs)!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    await settle()
    expect(mocks.replace).toHaveBeenLastCalledWith({ query: { tab: 'logs' } })
    byTestId(testIds.pluginTabOverview)!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    await settle()
    expect(mocks.replace).toHaveBeenLastCalledWith({ query: {} })
  })

  it('hides Configuration and Source when the plugin has neither, falling back to Overview', async () => {
    await mountDetail('zip-provider', '?tab=source')
    expect(byTestId(testIds.pluginTabConfiguration)).toBeNull()
    expect(byTestId(testIds.pluginTabSource)).toBeNull()
    expect(activeTab()).toBe(testIds.pluginTabOverview)
  })

  it('renders PluginSourceTab, read-only unless the plugin is editable', async () => {
    await mountDetail('dice-roller', '?tab=source')
    let source = document.querySelector<HTMLElement>('[data-stub="PluginSourceTab"]')!
    expect([source.dataset.pluginId, source.dataset.readonly]).toEqual(['"dice-roller"', 'false'])
    wrapper!.unmount()
    wrapper = null
    await mountDetail('npm-tool', '?tab=source')
    source = document.querySelector<HTMLElement>('[data-stub="PluginSourceTab"]')!
    expect([source.dataset.pluginId, source.dataset.readonly]).toEqual(['"npm-tool"', 'true'])
  })

  it('renders McpServersPanel in the Overview of core-mcp', async () => {
    await mountDetail('core-mcp')
    const panel = document.querySelector<HTMLElement>('[data-stub="McpServersPanel"]')!
    expect(panel.dataset.pluginId).toBe('"core-mcp"')
  })

  it('says when the plugin does not exist', async () => {
    await mountDetail('missing')
    expect(document.body.textContent).toContain('Plugin not found')
    expect(byTestId(testIds.pluginTabOverview)).toBeNull()
  })
})

describe('pluginDetailView: marketplace update (Phase 12, C46-T7)', () => {
  it('shows the update banner of a plugin with an update and opens the update dialog', async () => {
    const marketplaces = useMarketplacesStore()
    api.marketplaces.list.mockResolvedValue(marketplaceList({ updates: [pluginUpdate({ pluginId: 'dice-roller', plugin: 'dice-roller' })] }))
    await marketplaces.fetchAll()
    api.pluginInstall.inspect.mockRejectedValue(new HarnessError({ code: 'not_implemented', message: 'Not yet.' }))
    await mountDetail('dice-roller')
    const banner = document.body.querySelector<HTMLElement>('[data-slot="plugin-update-banner"]')!
    expect(banner.textContent).toContain('Version 1.2.0 is available from claude-plugins-official.')
    byTestId(testIds.pluginUpdate)!.click()
    await settle()
    expect(byTestId(testIds.marketplaceInstallDialog)?.dataset.mode).toBe('update')
    expect(api.pluginInstall.inspect).toHaveBeenCalledWith({ body: { source: 'marketplace', marketplaceId: pluginUpdate().marketplaceId, plugin: 'dice-roller' } })
  })

  it('shows no banner without an update', async () => {
    await mountDetail('dice-roller')
    expect(document.body.querySelector('[data-slot="plugin-update-banner"]')).toBeNull()
  })
})

describe('pluginDetailView: Claude Code plugins (Phase 12, W12.9)', () => {
  it('shows the marketplace name, the "Claude Code" badge and the origin, without a Source tab or Edit in wizard', async () => {
    api.plugins.getSettings.mockResolvedValue({ schema: DETAILS['review-kit']!.manifest.settings!, values: {}, secrets: { API_TOKEN: { set: false, hint: null, source: null } } })
    await mountDetail('review-kit')
    const header = document.querySelector<HTMLElement>('[data-slot="plugin-header"]')!
    expect(header.querySelector('[data-slot="plugin-source-badge"]')?.textContent?.trim()).toBe('claude-plugins-official')
    expect(header.querySelector('[data-slot="plugin-format-badge"]')?.textContent?.trim()).toBe('Claude Code')
    const origin = header.querySelector<HTMLElement>('[data-slot="plugin-origin"]')!
    expect(origin.textContent?.trim()).toBe('From claude-plugins-official · 2222222')
    expect(origin.title).toBe(commitSha(2))
    expect(byTestId(testIds.pluginTabSource)).toBeNull()
    expect(byTestId(testIds.pluginTabConfiguration)).not.toBeNull()
    await openWithKeyboard(byTestId(testIds.pluginMenu)!)
    expect(byTestId(testIds.pluginEdit)).toBeNull()
    expect(byTestId(testIds.pluginExport)).not.toBeNull()
  })

  it('shows the Claude Code plugin section with the raw version, what it runs, the ignored parts and the diagnostics', async () => {
    await mountDetail('review-kit')
    const info = document.querySelector<HTMLElement>('[data-slot="plugin-claude-info"]')!
    expect(info.textContent).toContain('Claude Code plugin')
    expect(info.querySelector('[data-slot="plugin-claude-version"]')?.textContent?.trim()).toBe('1.2.0-beta+claude')
    expect(info.textContent).toContain('review-kit:')
    expect(info.textContent).toContain('3 commands · 1 agent · 1 skill · 1 output style · 1 hook · 1 MCP server')
    const executables = info.querySelector<HTMLElement>('[data-slot="plugin-claude-executables"]')!
    expect(Array.from(executables.querySelectorAll('li')).map(item => [item.querySelector('span')?.textContent, item.querySelector('code')?.textContent])).toEqual([
      ['PostToolUse hook', 'sh "$CLAUDE_PLUGIN_ROOT/hooks/format.sh"'],
      ['MCP server review-kit', 'node server.mjs'],
    ])
    expect(info.querySelector('[data-slot="plugin-claude-ignored"]')?.textContent).toContain('.lsp.json')
    const diagnostic = info.querySelector<HTMLElement>('[data-slot="plugin-claude-diagnostics"] li')!
    expect(diagnostic.dataset.level).toBe('warning')
    expect(diagnostic.textContent).toContain('plugin.json has a field that is not read')
    expect(diagnostic.textContent).toContain('.claude-plugin/plugin.json')
  })

  it('renders the userConfig options through the settings form (a sensitive option is a secret field)', async () => {
    api.plugins.getSettings.mockResolvedValue({ schema: DETAILS['review-kit']!.manifest.settings!, values: {}, secrets: { API_TOKEN: { set: false, hint: null, source: null } } })
    await mountDetail('review-kit', '?tab=configuration')
    expect(activeTab()).toBe(testIds.pluginTabConfiguration)
    const field = document.querySelector<HTMLElement>(`[data-testid="${testIds.schemaField}"][data-value="API_TOKEN"]`)!
    expect(field.textContent).toContain('API token')
    expect(field.querySelector('input[type="password"]')).not.toBeNull()
  })

  it('shows the GitHub origin with its short commit and no executables for a plugin that runs nothing', async () => {
    await mountDetail('gh-tools')
    const header = document.querySelector<HTMLElement>('[data-slot="plugin-header"]')!
    expect(header.querySelector('[data-slot="plugin-source-badge"]')?.textContent?.trim()).toBe('GitHub')
    expect(header.querySelector('[data-slot="plugin-origin"]')?.textContent?.trim()).toBe('GitHub · acme/gh-tools@3f2a9c1')
    const info = document.querySelector<HTMLElement>('[data-slot="plugin-claude-info"]')!
    expect(info.querySelector('[data-slot="plugin-claude-executables"]')).toBeNull()
    expect(info.querySelector('[data-slot="plugin-claude-ignored"]')).toBeNull()
  })

  it('loads the marketplace list for a marketplace plugin, so its update banner shows', async () => {
    api.marketplaces.list.mockResolvedValue(marketplaceList({ updates: [pluginUpdate({ pluginId: 'review-kit' })] }))
    await mountDetail('review-kit')
    expect(api.marketplaces.list).toHaveBeenCalledTimes(1)
    expect(document.body.querySelector('[data-slot="plugin-update-banner"]')?.textContent).toContain('Version 1.2.0 is available from claude-plugins-official.')
  })

  it('sends no marketplace request for a plugin from another source', async () => {
    await mountDetail('dice-roller')
    expect(api.marketplaces.list).not.toHaveBeenCalled()
  })
})
