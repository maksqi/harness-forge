import type { TodoState } from './todos'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testIds } from '~/utils/testids'
import { todoItem } from '~/utils/testing/fixtures'
import TodoStrip from './TodoStrip.vue'

const todos = [
  todoItem({ id: 'a', content: 'Read the parser', status: 'completed' }),
  todoItem({ id: 'b', content: 'Write a test', status: 'completed' }),
  todoItem({ id: 'c', content: 'Run the parser tests', status: 'in_progress', activeForm: 'Running the parser tests' }),
  todoItem({ id: 'd', content: 'Fix the empty-input branch' }),
]

const state: TodoState = {
  todos,
  done: 2,
  total: 4,
  current: todos[2]!,
  messageId: 'msg_a000000000000001',
  live: true,
}

function strip(wrapper: ReturnType<typeof mount>) {
  return wrapper.get(`[data-testid="${testIds.todoStrip}"]`)
}

function toggle(wrapper: ReturnType<typeof mount>) {
  return wrapper.get(`[data-testid="${testIds.todoStripToggle}"]`)
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('todoStrip', () => {
  it('is collapsed by default: one line with the summary, the progress and the toggle', () => {
    const wrapper = mount(TodoStrip, { props: { state, running: true } })
    expect(strip(wrapper).attributes()).toMatchObject({ 'data-state': 'closed', 'data-count': '4', 'data-value': '2' })
    expect(toggle(wrapper).text()).toContain('2/4 · Running the parser tests')
    expect(toggle(wrapper).attributes()).toMatchObject({ 'aria-expanded': 'false', 'aria-label': 'Show tasks, 2 of 4 done' })
    expect(toggle(wrapper).attributes('aria-controls')).toBeUndefined()
    const progress = wrapper.get('[data-slot="todo-progress"]')
    expect(progress.attributes('aria-hidden')).toBe('true')
    expect(progress.classes()).toEqual(expect.arrayContaining(['hidden', 'w-16', 'sm:flex']))
    expect(wrapper.find(`[data-testid="${testIds.todoList}"]`).exists()).toBe(false)
    expect(strip(wrapper).attributes('aria-live')).toBeUndefined()
  })

  it('opens the list above the toggle, keeps focus on the toggle and remembers the state', async () => {
    const wrapper = mount(TodoStrip, { props: { state, running: true }, attachTo: document.body })
    ;(toggle(wrapper).element as HTMLElement).focus()
    await toggle(wrapper).trigger('click')
    expect(strip(wrapper).attributes('data-state')).toBe('open')
    expect(toggle(wrapper).attributes()).toMatchObject({ 'aria-expanded': 'true', 'aria-label': 'Hide tasks' })
    const list = wrapper.get(`[data-testid="${testIds.todoList}"]`)
    expect(list.attributes('data-variant')).toBe('strip')
    const region = wrapper.get(`#${toggle(wrapper).attributes('aria-controls')}`)
    expect(region.classes()).toContain('max-h-[40dvh]')
    expect(region.element.compareDocumentPosition(toggle(wrapper).element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(toggle(wrapper).text()).toContain('Tasks 2/4')
    expect(document.activeElement).toBe(toggle(wrapper).element)
    expect(localStorage.getItem('hf-todo-expanded')).toBe('1')
    wrapper.unmount()

    const again = mount(TodoStrip, { props: { state, running: false } })
    expect(strip(again).attributes('data-state')).toBe('open')
    await toggle(again).trigger('click')
    expect(localStorage.getItem('hf-todo-expanded')).toBe('0')
    expect(strip(again).attributes('data-state')).toBe('closed')
  })

  it('keeps the open state in memory when storage is blocked', async () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const wrapper = mount(TodoStrip, { props: { state, running: true } })
    expect(strip(wrapper).attributes('data-state')).toBe('closed')
    await toggle(wrapper).trigger('click')
    expect(strip(wrapper).attributes('data-state')).toBe('open')
  })

  it('reads "All tasks done" when finished', () => {
    const done = { ...state, todos: todos.map(todo => ({ ...todo, status: 'completed' as const })), done: 4, current: null }
    const wrapper = mount(TodoStrip, { props: { state: done, running: true } })
    expect(toggle(wrapper).text()).toContain('All tasks done')
    expect(toggle(wrapper).attributes('aria-label')).toBe('Show tasks, 4 of 4 done')
    expect(wrapper.get('[data-slot="todo-progress"]').attributes('aria-valuenow') ?? '100').toBe('100')
  })

  it('renders nothing without a visible list', () => {
    expect(mount(TodoStrip, { props: { state: null, running: true } }).find(`[data-testid="${testIds.todoStrip}"]`).exists()).toBe(false)
    expect(mount(TodoStrip, { props: { state: { ...state, live: false }, running: false } }).find(`[data-testid="${testIds.todoStrip}"]`).exists()).toBe(false)
    const finished = { ...state, done: 4, current: null }
    expect(mount(TodoStrip, { props: { state: finished, running: false } }).find(`[data-testid="${testIds.todoStrip}"]`).exists()).toBe(false)
  })
})
