import type { TodoState } from './todos'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { todoItem } from '~/utils/testing/fixtures'
import TodoStrip from './TodoStrip.vue'

const state: TodoState = {
  todos: [todoItem({ id: 'a', status: 'completed' }), todoItem({ id: 'b' })],
  done: 1,
  total: 2,
  current: null,
  messageId: 'msg_a000000000000001',
  live: true,
}

describe('todoStrip (P9-0b stub)', () => {
  it('renders its root with the counts while visible', () => {
    const wrapper = mount(TodoStrip, { props: { state, running: true } })
    expect(wrapper.get(`[data-testid="${testIds.todoStrip}"]`).attributes()).toMatchObject({ 'data-state': 'closed', 'data-count': '2', 'data-value': '1' })
  })

  it('renders nothing without a visible list', () => {
    expect(mount(TodoStrip, { props: { state: null, running: true } }).find(`[data-testid="${testIds.todoStrip}"]`).exists()).toBe(false)
    expect(mount(TodoStrip, { props: { state: { ...state, live: false }, running: false } }).find(`[data-testid="${testIds.todoStrip}"]`).exists()).toBe(false)
  })
})
