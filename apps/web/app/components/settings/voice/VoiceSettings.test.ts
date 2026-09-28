import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import VoiceSettings from './VoiceSettings.vue'

describe('voiceSettings', () => {
  it('renders the Voice section with the privacy notice as its root', () => {
    const wrapper = mount(VoiceSettings)
    const root = wrapper.get(`[data-testid="${testIds.voiceSettings}"]`)
    expect(root.element).toBe(wrapper.element)
    expect(root.element.tagName).toBe('SECTION')
    expect(root.get('h2').text()).toBe('Voice')
    expect(root.text()).toContain('Audio and text go to the provider you choose; harness-forge doesn\'t store them.')
    wrapper.unmount()
  })
})
