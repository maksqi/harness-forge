import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { todoItem } from '~/utils/testing/fixtures'
import TodoList from './TodoList.vue'

describe('todoList (P9-0b stub)', () => {
  it('renders a list with one item per todo', () => {
    const todos = [todoItem({ id: 'a', status: 'completed' }), todoItem({ id: 'b', content: 'Write a test', status: 'in_progress' })]
    const wrapper = mount(TodoList, { props: { todos, variant: 'strip' } })
    const root = wrapper.get(`[data-testid="${testIds.todoList}"]`)
    expect(root.element.tagName).toBe('UL')
    expect(root.attributes('role')).toBe('list')
    const items = wrapper.findAll(`[data-testid="${testIds.todoItem}"]`)
    expect(items.map(item => [item.attributes('data-status'), item.attributes('data-index')])).toEqual([['completed', '0'], ['in_progress', '1']])
  })
})
