// MarketplaceInstallDialog (Phase 12, ADR-054; docs/UI.md 8.13, 10.9, 14.1; W12.8-T5): inspects the entry with the
// marketplace source, renders InstallReview (one fresh-auth flow), toasts the install / update, reads an unchanged update
// as up to date, re-inspects once after a 409 `stale` and shows a failed inspection.
import type { PluginInspection } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'vue-sonner'
import { useAuthStore } from '~/stores/auth'
import { useMarketplacesStore } from '~/stores/marketplaces'
import { testIds } from '~/utils/testids'
import { authStatus, claudePluginInfo, marketplaceId, marketplaceList, pluginDetail, pluginUpdate } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { byTestId, mountInShell, settle } from '../list/testing'
import MarketplaceInstallDialog from './MarketplaceInstallDialog.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))

const HASH = 'c'.repeat(64)

function inspection(overrides: Partial<PluginInspection> = {}): PluginInspection {
  return {
    manifest: { manifestVersion: 1, id: 'review-kit', name: 'Review kit', version: '1.2.0', engines: { harness: '^1.6.0' } },
    kind: 'declarative',
    format: 'claude',
    source: 'marketplace',
    sourceRef: 'anthropics/claude-plugins-official@0123456789ab/plugins/review-kit',
    sha256: HASH,
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
    ...overrides,
  }
}

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let unmount: (() => void) | null = null

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.status = authStatus()
  auth.loaded = true
  api.auth.status.mockResolvedValue(authStatus())
  vi.mocked(toast.success).mockClear()
})

afterEach(() => {
  unmount?.()
  unmount = null
  document.body.replaceChildren()
  disposePinia(pinia)
})

async function render(props: Record<string, unknown> = {}) {
  const wrapper = mountInShell(MarketplaceInstallDialog, { open: true, marketplaceId: marketplaceId(1), entryName: 'review-kit', mode: 'install', ...props })
  unmount = () => wrapper.unmount()
  await settle()
  return wrapper
}

describe('marketplaceInstallDialog', () => {
  it('shows "Downloading {name}…" (focused) while it inspects the entry with the marketplace source', async () => {
    api.pluginInstall.inspect.mockReturnValue(new Promise(() => {}))
    await render()
    const dialog = byTestId(testIds.marketplaceInstallDialog)!
    expect(dialog.dataset.mode).toBe('install')
    expect(dialog.textContent).toContain('Install review-kit')
    const status = dialog.querySelector<HTMLElement>('[role="status"][tabindex="-1"]')!
    expect(status.textContent).toContain('Downloading review-kit…')
    expect(document.activeElement).toBe(status)
    expect(api.pluginInstall.inspect).toHaveBeenCalledWith({ body: { source: 'marketplace', marketplaceId: marketplaceId(1), plugin: 'review-kit' } })
  })

  it('renders the review, installs and toasts "Installed {name}", then emits installed', async () => {
    api.pluginInstall.inspect.mockResolvedValue(inspection())
    api.pluginInstall.install.mockResolvedValue(pluginDetail({ id: 'review-kit', name: 'Review kit', format: 'claude' }))
    api.plugins.get.mockResolvedValue(pluginDetail({ id: 'review-kit', name: 'Review kit' }))
    const installed = vi.fn()
    await render({ onInstalled: installed })
    expect(document.body.querySelector('[data-slot="install-review"]')).not.toBeNull()
    // No trust needed: the focus moves to Install.
    expect(document.activeElement).toBe(byTestId(testIds.installSubmit))
    byTestId(testIds.installSubmit)!.click()
    await settle()
    expect(api.pluginInstall.install).toHaveBeenCalledWith({ body: expect.objectContaining({ source: 'marketplace', marketplaceId: marketplaceId(1), plugin: 'review-kit', sha256: HASH }) })
    expect(toast.success).toHaveBeenCalledWith('Installed Review kit')
    expect(installed).toHaveBeenCalledWith('review-kit')
  })

  it('focuses the trust checkbox when the plugin runs anything', async () => {
    api.pluginInstall.inspect.mockResolvedValue(inspection({ requiresTrust: true, claude: claudePluginInfo() }))
    await render()
    expect(document.activeElement).toBe(byTestId(testIds.trustCheckbox))
  })

  it('says when a plugin installs turned off', async () => {
    api.pluginInstall.inspect.mockResolvedValue(inspection())
    api.pluginInstall.install.mockResolvedValue(pluginDetail({ id: 'review-kit', name: 'Review kit', enabled: false, state: 'disabled' }))
    api.plugins.get.mockResolvedValue(pluginDetail({ id: 'review-kit' }))
    await render()
    byTestId(testIds.installSubmit)!.click()
    await settle()
    expect(toast.success).toHaveBeenCalledWith('Installed Review kit. It\'s turned off until you turn it on.')
  })

  it('updates with "Updated {name} to {version}" when the file tree changed', async () => {
    useMarketplacesStore().list = marketplaceList({ updates: [pluginUpdate({ pluginId: 'review-kit' })] })
    api.pluginInstall.inspect.mockResolvedValue(inspection({ existing: { version: '1.1.0', state: 'active', source: 'marketplace' } }))
    api.plugins.get.mockResolvedValue(pluginDetail({ id: 'review-kit', trust: { required: false, trusted: true, hash: 'e'.repeat(64), trustedHash: null } }))
    api.pluginInstall.install.mockResolvedValue(pluginDetail({ id: 'review-kit', name: 'Review kit', version: '1.2.0', claude: claudePluginInfo({ version: '1.2.0-beta' }) }))
    const installed = vi.fn()
    await render({ mode: 'update', onInstalled: installed })
    const dialog = byTestId(testIds.marketplaceInstallDialog)!
    expect(dialog.dataset.mode).toBe('update')
    expect(dialog.textContent).toContain('Update review-kit')
    expect(api.plugins.get).toHaveBeenCalledWith({ params: { id: 'review-kit' } })
    byTestId(testIds.installSubmit)!.click()
    await settle()
    expect(toast.success).toHaveBeenCalledWith('Updated Review kit to 1.2.0-beta')
    expect(installed).toHaveBeenCalledWith('review-kit')
  })

  it('reads an update with an unchanged file tree as up to date (no install)', async () => {
    api.pluginInstall.inspect.mockResolvedValue(inspection({ existing: { version: '1.2.0', state: 'active', source: 'marketplace' } }))
    api.plugins.get.mockResolvedValue(pluginDetail({ id: 'review-kit', trust: { required: false, trusted: true, hash: HASH, trustedHash: null } }))
    const update = vi.fn()
    await render({ 'mode': 'update', 'onUpdate:open': update })
    expect(document.body.querySelector('[data-slot="install-review"]')).toBeNull()
    expect(document.body.querySelector('[data-slot="marketplace-up-to-date"]')?.textContent?.trim()).toBe('review-kit is up to date.')
    expect(byTestId(testIds.installSubmit)).toBeNull()
    Array.from(document.body.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Close')!.click()
    expect(update).toHaveBeenCalledWith(false)
  })

  it('re-inspects once after a 409 stale and hands the new inspection to the review', async () => {
    api.pluginInstall.inspect
      .mockResolvedValueOnce(inspection())
      .mockResolvedValueOnce(inspection({ sha256: 'f'.repeat(64) }))
    api.pluginInstall.install.mockRejectedValue(new HarnessError({ code: 'conflict', message: 'The plugin changed.', details: { reason: 'stale' } }))
    await render()
    byTestId(testIds.installSubmit)!.click()
    await settle()
    expect(api.pluginInstall.inspect).toHaveBeenCalledTimes(2)
    expect(byTestId(testIds.installStale)).not.toBeNull()
    api.pluginInstall.install.mockClear()
    byTestId(testIds.installSubmit)!.click()
    await settle()
    expect(api.pluginInstall.install).toHaveBeenCalledWith({ body: expect.objectContaining({ sha256: 'f'.repeat(64) }) })
  })

  it('shows a failed inspection with the server message and Close', async () => {
    api.pluginInstall.inspect.mockRejectedValue(new HarnessError({ code: 'conflict', message: 'harness-forge is offline (HF_OFFLINE=1).', details: { reason: 'offline' } }))
    await render()
    const dialog = byTestId(testIds.marketplaceInstallDialog)!
    expect(dialog.textContent).toContain('harness-forge is offline (HF_OFFLINE=1).')
    expect(dialog.textContent).not.toContain('Downloading')
    expect(document.body.querySelector('[data-slot="install-review"]')).toBeNull()
  })

  it('drops an inspection that answers after the dialog closed', async () => {
    let answer: (value: PluginInspection) => void = () => {}
    api.pluginInstall.inspect.mockReturnValue(new Promise((resolve) => {
      answer = resolve
    }))
    const wrapper = await render()
    await wrapper.unmount()
    unmount = null
    answer(inspection())
    await settle()
    expect(document.body.querySelector('[data-slot="install-review"]')).toBeNull()
  })
})
