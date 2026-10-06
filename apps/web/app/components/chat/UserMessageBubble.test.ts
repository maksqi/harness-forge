import type { HarnessUIMessage } from '@harness-forge/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { hookCarrier, hookData, taskResultCarrier } from '~/utils/testing/fixtures'
import UserMessageBubble from './UserMessageBubble.vue'

// The command badge imports the plugins store module (used only for plugin commands).
vi.mock('~/composables/useApi', () => ({ useApi: () => ({}), useApiFetch: () => vi.fn() }))

const message: HarnessUIMessage = { id: 'msg_user000000000001', role: 'user', parts: [{ type: 'text', text: 'Fix the build' }] }

describe('userMessageBubble', () => {
  it('renders the plain text in the bubble', () => {
    const wrapper = mount(UserMessageBubble, { props: { message } })
    expect(wrapper.get('[data-slot="user-message"]').text()).toBe('Fix the build')
  })

  it('never shows a hook record inside the bubble (ChatMessage renders the notes under it) (Phase 11)', () => {
    const context = hookData({ event: 'UserPromptSubmit', outcome: 'context', toolCallId: undefined, toolName: undefined, context: 'Branch: main' })
    const withHook: HarnessUIMessage = { ...message, parts: [...message.parts, { type: 'data-hook', id: context.id, data: context }] }
    const wrapper = mount(UserMessageBubble, { props: { message: withHook } })
    expect(wrapper.get('[data-slot="user-message"]').text()).toBe('Fix the build')
    expect(wrapper.text()).not.toContain('Branch: main')
  })

  it('renders nothing for a hook carrier or a background agent carrier', () => {
    expect(mount(UserMessageBubble, { props: { message: hookCarrier('msg_carrier000000001') } }).find('[data-slot="user-message"]').exists()).toBe(false)
    expect(mount(UserMessageBubble, { props: { message: taskResultCarrier('msg_carrier000000002') } }).find('[data-slot="user-message"]').exists()).toBe(false)
  })

  it('shows the badge of a skill the user ran (Phase 11)', () => {
    const skill: HarnessUIMessage = {
      ...message,
      metadata: { modelRef: 'mock:echo', startedAt: 1, command: { name: 'release-notes', input: 'v2', type: 'prompt', kind: 'skill', source: 'project' } },
      parts: [{ type: 'text', text: '/release-notes v2' }],
    }
    const wrapper = mount({ render: () => h(TooltipProvider, null, { default: () => h(UserMessageBubble, { message: skill }) }) })
    const badge = wrapper.get('[data-slot="command-badge"]')
    expect(badge.text()).toContain('Skill/release-notes')
    expect(badge.text()).toContain(', Project skill')
  })
})
