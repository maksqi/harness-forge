// The Customize page's entry to the Import from Claude Code dialog (Phase 12, ADR-055; docs/UI.md 6, 9.14; W12.10-T3):
// the header action "Import from Claude Code…" (`customize-import-claude`, after Import…) and the query `?import=claude`
// open the dialog; closing it removes the query (other values kept); any other `import` value is dropped. The body
// (CustomizeSettings, W12.11) is a stand-in with its exposed `import()` / `create()`.
import type { MockApi } from '~/utils/testing/mock-api'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import CustomizePage from '~/pages/settings/customize.vue'
import { useAuthStore } from '~/stores/auth'
import { testIds } from '~/utils/testids'
import { authStatus, claudeImportHome } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  route: null as null | { path: string, query: Record<string, string | undefined> },
  router: { replace: vi.fn(async () => {}), push: vi.fn(async () => {}) },
  body: { import: vi.fn(), create: vi.fn() },
}))

vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('~/components/settings/nuxt-imports', () => ({
  useHead: vi.fn(),
  useRoute: () => mocks.route,
  useRouter: () => mocks.router,
}))
vi.mock('~/components/settings/customize/CustomizeSettings.vue', async () => {
  const vue = await import('vue')
  return {
    default: vue.defineComponent({
      name: 'CustomizeSettings',
      setup: (_props, { expose }) => {
        expose({ import: mocks.body.import, create: mocks.body.create })
        return () => vue.h('div', { 'data-slot': 'customize-body' })
      },
    }),
  }
})

let api: MockApi
let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.route = reactive({ path: '/settings/customize', query: {} })
  mocks.router.replace.mockClear()
  mocks.body.import.mockClear()
  pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.status = authStatus()
  auth.loaded = true
  api.claudeImport.home.mockResolvedValue(claudeImportHome({ available: false, reason: 'disabled', path: null }))
})

afterEach(() => {
  document.body.replaceChildren()
  disposePinia(pinia)
})

async function settle() {
  await flushPromises()
  await nextTick()
  await flushPromises()
}

async function renderPage() {
  mount(defineComponent({ setup: () => () => h(TooltipProvider, null, { default: () => h(CustomizePage) }) }), { attachTo: document.body, global: { plugins: [pinia] } })
  await settle()
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]`)
}

function closeDialog() {
  document.body.querySelector<HTMLElement>(`[data-testid="${testIds.claudeImportDialog}"] [data-slot="dialog-close"]`)!.click()
}

describe('customize page: Import from Claude Code', () => {
  it('opens the dialog from the header action after Import…', async () => {
    await renderPage()
    expect(byTestId(testIds.claudeImportDialog)).toBeNull()
    const action = byTestId(testIds.customizeImportClaude)!
    expect(action.textContent?.trim()).toBe('Import from Claude Code…')
    const order = [...document.body.querySelectorAll<HTMLElement>('[data-testid]')].map(element => element.dataset.testid)
    expect(order.indexOf(testIds.customizeImport)).toBeLessThan(order.indexOf(testIds.customizeImportClaude))
    expect(order.indexOf(testIds.customizeImportClaude)).toBeLessThan(order.indexOf(testIds.customizeNew))
    action.click()
    await settle()
    expect(byTestId(testIds.claudeImportDialog)?.dataset.step).toBe('source')
    expect(api.claudeImport.home).toHaveBeenCalledTimes(1)
    closeDialog()
    await settle()
    expect(byTestId(testIds.claudeImportDialog)).toBeNull()
    expect(mocks.router.replace).not.toHaveBeenCalled()
  })

  it('opens for ?import=claude and removes only that value when the dialog closes', async () => {
    mocks.route!.query = { import: 'claude', tab: 'hooks', project: 'prj_1' }
    await renderPage()
    expect(byTestId(testIds.claudeImportDialog)?.dataset.step).toBe('source')
    closeDialog()
    await settle()
    expect(byTestId(testIds.claudeImportDialog)).toBeNull()
    expect(mocks.router.replace).toHaveBeenLastCalledWith({ query: { tab: 'hooks', project: 'prj_1' } })
  })

  it('opens when the query arrives later and drops any other import value', async () => {
    await renderPage()
    mocks.route!.query = { import: 'claude' }
    await settle()
    expect(byTestId(testIds.claudeImportDialog)).not.toBeNull()
    closeDialog()
    await settle()

    mocks.route!.query = { import: 'other', tab: 'skills' }
    await settle()
    expect(byTestId(testIds.claudeImportDialog)).toBeNull()
    expect(mocks.router.replace).toHaveBeenLastCalledWith({ query: { tab: 'skills' } })
  })

  it('keeps the body actions of the header', async () => {
    await renderPage()
    byTestId(testIds.customizeImport)!.click()
    await settle()
    expect(mocks.body.import).toHaveBeenCalledTimes(1)
  })
})
