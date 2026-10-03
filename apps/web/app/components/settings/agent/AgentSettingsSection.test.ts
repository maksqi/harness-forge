import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AgentSettingsSection from './AgentSettingsSection.vue'

describe('agentSettingsSection (P9-0b stub)', () => {
  it('renders the Agent section', () => {
    const wrapper = mount(AgentSettingsSection)
    const section = wrapper.get('[data-slot="settings-section"]')
    expect(section.get('h2').text()).toBe('Agent')
    expect(section.text()).toContain('Long chats and sub-agents.')
  })
})
