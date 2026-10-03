import type { TodoState } from './todos'
import { describe, expect, it } from 'vitest'
import { assistantMessage, todoItem, todoWritePart, userMessage } from '~/utils/testing/fixtures'
import { todoState, todoStripVisible, todoSummary } from './todos'

function state(overrides: Partial<TodoState> = {}): TodoState {
  const todos = [
    todoItem({ id: 'a', content: 'Read the parser', status: 'completed' }),
    todoItem({ id: 'b', content: 'Run the parser tests', status: 'in_progress', activeForm: 'Running the parser tests' }),
    todoItem({ id: 'c', content: 'Fix the empty-input branch' }),
  ]
  return { todos, done: 1, total: 3, current: todos[1]!, messageId: 'msg_a000000000000001', live: true, ...overrides }
}

describe('todos (P9-0b signatures)', () => {
  it('shows the strip while a run is active, or while the latest list is unfinished', () => {
    expect(todoStripVisible(null, true)).toBe(false)
    expect(todoStripVisible(state({ todos: [], total: 0, done: 0, current: null }), true)).toBe(false)
    expect(todoStripVisible(state(), true)).toBe(true)
    expect(todoStripVisible(state(), false)).toBe(true)
    expect(todoStripVisible(state({ live: false }), false)).toBe(false)
    expect(todoStripVisible(state({ done: 3, current: null }), false)).toBe(false)
    expect(todoStripVisible(state({ done: 3, current: null }), true)).toBe(true)
  })

  it('summarizes the list', () => {
    expect(todoSummary(state())).toBe('1/3 · Running the parser tests')
    expect(todoSummary(state({ current: todoItem({ content: 'Fix it', status: 'in_progress' }) }))).toBe('1/3 · Fix it')
    expect(todoSummary(state({ current: null }))).toBe('1/3')
    expect(todoSummary(state({ done: 3, current: null }))).toBe('All tasks done')
  })

  it('finds no list until W9.10 implements todoState', () => {
    const messages = [
      userMessage('msg_u000000000000001', 'Fix the parser'),
      assistantMessage('msg_a000000000000001', '', { parts: [todoWritePart([todoItem()])] }),
    ]
    expect(todoState(messages)).toBeNull()
  })
})
