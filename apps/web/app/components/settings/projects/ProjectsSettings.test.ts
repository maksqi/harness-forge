// Settings -> Projects skeleton (docs/UI.md 9.10, 10.4; C15, P7-0b): the ProjectsSettings root and the page frame.
// W7.9 adds the rows, the menus, the empty state and the Add project action.
import type { ComputedRef } from 'vue'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectsPage from '~/pages/settings/projects.vue'
import { testIds } from '~/utils/testids'
import ProjectsSettings from './ProjectsSettings.vue'

const mocks = vi.hoisted(() => ({ useHead: vi.fn() }))
// SettingsPage sets the tab title through the settings nuxt-imports module ('#imports' does not resolve in Vitest).
vi.mock('~/components/settings/nuxt-imports', () => ({ useHead: mocks.useHead }))

beforeEach(() => {
  mocks.useHead.mockReset()
})

describe('projectsSettings', () => {
  it('renders its root test id', () => {
    const wrapper = mount(ProjectsSettings)
    const root = wrapper.get(`[data-testid="${testIds.projectsSettings}"]`)
    expect(root.element).toBe(wrapper.element)
    wrapper.unmount()
  })
})

describe('settings projects page', () => {
  it('renders ProjectsSettings in the settings page frame titled "Projects"', () => {
    const wrapper = mount(ProjectsPage)
    const header = wrapper.get(`[data-testid="${testIds.pageHeader}"]`)
    expect(header.get('h1').text()).toBe('Projects')
    expect(header.text()).toContain('Folders on the server that chats can read and edit.')
    expect(wrapper.find(`[data-testid="${testIds.projectsSettings}"]`).exists()).toBe(true)
    const head = mocks.useHead.mock.calls[0]?.[0] as { title: ComputedRef<string> } | undefined
    expect(head?.title.value).toBe('Projects · harness-forge')
    wrapper.unmount()
  })
})
