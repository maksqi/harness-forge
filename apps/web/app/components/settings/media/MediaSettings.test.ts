import type { ComputedRef } from 'vue'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MediaPage from '~/pages/settings/media.vue'
import { testIds } from '~/utils/testids'
import ImageSettings from '../images/ImageSettings.vue'
import VoiceSettings from '../voice/VoiceSettings.vue'
import MediaSettings from './MediaSettings.vue'

const mocks = vi.hoisted(() => ({ useHead: vi.fn() }))
// SettingsPage sets the tab title through the settings nuxt-imports module ('#imports' does not resolve in Vitest).
vi.mock('~/components/settings/nuxt-imports', () => ({ useHead: mocks.useHead }))

beforeEach(() => {
  mocks.useHead.mockReset()
})

describe('mediaSettings', () => {
  it('renders its root test id with the Images section, then the Voice section', () => {
    const wrapper = mount(MediaSettings)
    const root = wrapper.get(`[data-testid="${testIds.mediaSettings}"]`)
    expect(root.element).toBe(wrapper.element)
    const sections = root.findAll('[data-slot="settings-section"]').map(section => section.attributes('data-testid'))
    expect(sections).toEqual([testIds.imageSettings, testIds.voiceSettings])
    expect(wrapper.findComponent(ImageSettings).exists()).toBe(true)
    expect(wrapper.findComponent(VoiceSettings).exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('settings media page', () => {
  it('renders MediaSettings in the settings page frame titled "Images and voice"', () => {
    const wrapper = mount(MediaPage)
    const header = wrapper.get(`[data-testid="${testIds.pageHeader}"]`)
    expect(header.get('h1').text()).toBe('Images and voice')
    expect(header.text()).toContain('Models for generated images, dictation and reading replies aloud.')
    expect(wrapper.find(`[data-testid="${testIds.mediaSettings}"]`).exists()).toBe(true)
    expect(wrapper.find(`[data-testid="${testIds.imageSettings}"]`).exists()).toBe(true)
    expect(wrapper.find(`[data-testid="${testIds.voiceSettings}"]`).exists()).toBe(true)
    const head = mocks.useHead.mock.calls[0]?.[0] as { title: ComputedRef<string> } | undefined
    expect(head?.title.value).toBe('Images and voice · harness-forge')
    wrapper.unmount()
  })
})
