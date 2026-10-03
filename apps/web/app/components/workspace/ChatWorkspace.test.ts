// ChatWorkspace (docs/UI.md 7.21, 10.5; C20 stub): accepts its frozen props and renders the chat view slot inside the
// `chat-workspace` frame, which does not change the page layout yet.
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { h } from 'vue'
import { chatId, projectId } from '~/utils/testing/fixtures'
import ChatWorkspace from './ChatWorkspace.vue'

describe('chatWorkspace (stub)', () => {
  it.each([projectId(1), null])('renders the slot inside the frame (project %s)', (project) => {
    const wrapper = mount(ChatWorkspace, {
      props: { chatId: chatId(1), projectId: project },
      slots: { default: () => h('div', { 'data-slot': 'chat-view' }, 'chat') },
    })
    const frame = wrapper.get('[data-slot="chat-workspace"]')
    expect(frame.classes()).toContain('contents')
    expect(frame.get('[data-slot="chat-view"]').text()).toBe('chat')
    expect(wrapper.props()).toEqual({ chatId: chatId(1), projectId: project })
  })
})
