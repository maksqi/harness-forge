import type { ComputedRef } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import CustomizePage from '~/pages/settings/customize.vue'
import { testIds } from '~/utils/testids'
import CustomizeSettings from './CustomizeSettings.vue'

const mocks = vi.hoisted(() => ({
  useHead: vi.fn(),
  route: null as null | { path: string, query: Record<string, string | undefined> },
}))

vi.mock('~/composables/useApi', () => ({ useApi: () => ({}) }))
vi.mock('~/components/settings/nuxt-imports', () => ({
  useHead: mocks.useHead,
  useRoute: () => mocks.route,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

beforeEach(() => {
  mocks.useHead.mockReset()
  mocks.route = reactive({ path: '/settings/customize', query: {} })
  setActivePinia(createPinia())
})

afterEach(() => {
  document.body.replaceChildren()
})

function byTestId(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)
}

describe('customizeSettings (P10-0b stub)', () => {
  it('renders its root and exposes create() and import()', () => {
    const wrapper = mount(CustomizeSettings)
    expect(wrapper.find(`[data-testid="${testIds.customizeSettings}"]`).exists()).toBe(true)
    const exposed = wrapper.vm as unknown as { create: () => void, import: () => void }
    expect(() => exposed.create()).not.toThrow()
    expect(() => exposed.import()).not.toThrow()
  })
})

describe('settings customize page', () => {
  it('renders CustomizeSettings in the settings page frame with Import… and New {kind} following ?tab', async () => {
    const wrapper = mount(CustomizePage, { attachTo: document.body, global: { stubs: { SidebarTrigger: true } } })
    await flushPromises()
    expect(byTestId(testIds.pageHeader)?.querySelector('h1')?.textContent).toBe('Customize')
    expect(byTestId(testIds.pageHeader)?.textContent).toContain('Sub-agents, slash commands and skills: yours, your projects\' and your plugins\'.')
    expect(byTestId(testIds.customizeSettings)).not.toBeNull()
    expect(byTestId(testIds.customizeImport)?.textContent?.trim()).toBe('Import…')
    const create = byTestId(testIds.customizeNew)!
    expect(create.textContent?.trim()).toBe('New agent')
    expect(create.dataset.kind).toBe('agent')
    const head = mocks.useHead.mock.calls[0]?.[0] as { title: ComputedRef<string> } | undefined
    expect(head?.title.value).toBe('Customize · harness-forge')

    mocks.route!.query = { tab: 'skills' }
    await flushPromises()
    expect(byTestId(testIds.customizeNew)?.textContent?.trim()).toBe('New skill')
    create.click()
    byTestId(testIds.customizeImport)!.click()
    wrapper.unmount()
  })
})
