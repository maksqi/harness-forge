// Settings → Web search (Phase 14, ADR-062, ADR-063; docs/UI.md 9.15, 10.10): the page frame and the C54 stub's root test
// id; W14.10 implements the page.
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import SearchPage from '~/pages/settings/search.vue'
import { testIds } from '~/utils/testids'
import WebSearchSettings from './WebSearchSettings.vue'

const mocks = vi.hoisted(() => ({ useHead: vi.fn() }))
// SettingsPage sets the tab title through the settings nuxt-imports module ('#imports' does not resolve in Vitest).
vi.mock('~/components/settings/nuxt-imports', () => ({ useHead: mocks.useHead }))

describe('webSearchSettings (stub)', () => {
  it('renders its root test id', () => {
    const wrapper = mount(WebSearchSettings)
    expect(wrapper.find(`[data-testid="${testIds.webSearchSettings}"]`).exists()).toBe(true)
    wrapper.unmount()
  })

  it('the page is titled "Web search" with its description', () => {
    const wrapper = mount(SearchPage)
    expect(wrapper.text()).toContain('Web search')
    expect(wrapper.text()).toContain('Search the web from the chat, with the model\'s own search or a search API.')
    expect(wrapper.findComponent(WebSearchSettings).exists()).toBe(true)
    wrapper.unmount()
  })
})
