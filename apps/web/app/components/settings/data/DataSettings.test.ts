import type { ComputedRef } from 'vue'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SharesSettingsSection from '~/components/share/SharesSettingsSection.vue'
import DataPage from '~/pages/settings/data.vue'
import { testIds } from '~/utils/testids'
import DataSettings from './DataSettings.vue'

const mocks = vi.hoisted(() => ({ useHead: vi.fn() }))
// SettingsPage sets the tab title through the settings nuxt-imports module ('#imports' does not resolve in Vitest).
vi.mock('~/components/settings/nuxt-imports', () => ({ useHead: mocks.useHead }))

beforeEach(() => {
  mocks.useHead.mockReset()
})

describe('dataSettings', () => {
  it('renders its root test id with the Shared links section inside', () => {
    const wrapper = mount(DataSettings)
    const root = wrapper.get(`[data-testid="${testIds.dataSettings}"]`)
    expect(root.element).toBe(wrapper.element)
    expect(root.find(`[data-testid="${testIds.sharesSection}"]`).exists()).toBe(true)
    expect(wrapper.findComponent(SharesSettingsSection).exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('settings data page', () => {
  it('renders DataSettings in the settings page frame titled "Data"', () => {
    const wrapper = mount(DataPage)
    const header = wrapper.get(`[data-testid="${testIds.pageHeader}"]`)
    expect(header.get('h1').text()).toBe('Data')
    expect(header.text()).toContain('Back up and restore your chats, or delete them all.')
    expect(wrapper.find(`[data-testid="${testIds.dataSettings}"]`).exists()).toBe(true)
    const head = mocks.useHead.mock.calls[0]?.[0] as { title: ComputedRef<string> } | undefined
    expect(head?.title.value).toBe('Data · harness-forge')
    wrapper.unmount()
  })
})
