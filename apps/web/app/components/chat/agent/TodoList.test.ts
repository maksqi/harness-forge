import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { todoItem } from '~/utils/testing/fixtures'
import TodoList from './TodoList.vue'

const todos = [
  todoItem({ id: 'a', content: 'Read the parser', status: 'completed' }),
  todoItem({ id: 'b', content: 'Run the parser tests', status: 'in_progress', activeForm: 'Running the parser tests' }),
  todoItem({ id: 'c', content: 'Fix the empty-input branch', activeForm: 'Fixing it' }),
]

describe('todoList', () => {
  it('renders a list with one item per todo, its status and index', () => {
    const wrapper = mount(TodoList, { props: { todos, variant: 'strip' } })
    const root = wrapper.get(`[data-testid="${testIds.todoList}"]`)
    expect(root.element.tagName).toBe('UL')
    expect(root.attributes()).toMatchObject({ 'role': 'list', 'data-variant': 'strip' })
    const items = wrapper.findAll(`[data-testid="${testIds.todoItem}"]`)
    expect(items.map(item => [item.attributes('data-status'), item.attributes('data-index')])).toEqual([
      ['completed', '0'],
      ['in_progress', '1'],
      ['pending', '2'],
    ])
    expect(mount(TodoList, { props: { todos } }).get(`[data-testid="${testIds.todoList}"]`).attributes('data-variant')).toBe('row')
  })

  it('shows the activeForm of the item in progress, the content otherwise, with spoken prefixes', () => {
    const items = mount(TodoList, { props: { todos } }).findAll(`[data-testid="${testIds.todoItem}"]`)
    expect(items.map(item => item.text())).toEqual([
      'Done: Read the parser',
      'In progress: Running the parser tests',
      'To do: Fix the empty-input branch',
    ])
    expect(items.map(item => item.get('.sr-only').text())).toEqual(['Done:', 'In progress:', 'To do:'])
  })

  it('marks each status with its icon tone; done items are struck through, the current one is bold', () => {
    const items = mount(TodoList, { props: { todos } }).findAll(`[data-testid="${testIds.todoItem}"]`)
    expect(items[0]!.get('svg').classes()).toContain('text-success')
    expect(items[0]!.find('.line-through').exists()).toBe(true)
    expect(items[1]!.get('svg').classes()).toContain('text-primary')
    expect(items[1]!.find('.font-medium').exists()).toBe(true)
    expect(items[2]!.get('svg').classes()).toContain('text-muted-foreground')
    for (const item of items)
      expect(item.get('svg').attributes('aria-hidden')).toBe('true')
  })
})
