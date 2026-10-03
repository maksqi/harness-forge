import type { HarnessUIMessagePart } from '@harness-forge/shared'
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

describe('todoStripVisible / todoSummary', () => {
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
})

describe('todoState', () => {
  const first = [
    todoItem({ id: 'a', content: 'Read the parser', status: 'in_progress', activeForm: 'Reading the parser' }),
    todoItem({ id: 'b', content: 'Fix it' }),
  ]
  const second = [
    todoItem({ id: 'a', content: 'Read the parser', status: 'completed' }),
    todoItem({ id: 'b', content: 'Fix it', status: 'in_progress' }),
  ]

  it('finds no list on a path without a finished todo_write call', () => {
    expect(todoState([])).toBeNull()
    expect(todoState([userMessage('msg_u000000000000001', 'Hi'), assistantMessage('msg_a000000000000001', 'Hello')])).toBeNull()
    const running = { ...todoWritePart(first), state: 'input-available', output: undefined } as unknown as HarnessUIMessagePart
    expect(todoState([assistantMessage('msg_a000000000000001', '', { parts: [running] })])).toBeNull()
  })

  it('reads the last finished call with its counts, the current item and the message', () => {
    const messages = [
      userMessage('msg_u000000000000001', 'Fix the parser'),
      assistantMessage('msg_a000000000000001', '', { parts: [todoWritePart(first, 'call_1'), todoWritePart(second, 'call_2')] }),
    ]
    expect(todoState(messages)).toEqual({
      todos: second,
      done: 1,
      total: 2,
      current: second[1],
      messageId: 'msg_a000000000000001',
      live: true,
    })
  })

  it('keeps the list of an earlier reply, no longer live once a later reply exists', () => {
    const messages = [
      userMessage('msg_u000000000000001', 'Fix the parser'),
      assistantMessage('msg_a000000000000001', '', { parts: [todoWritePart(first)] }),
      userMessage('msg_u000000000000002', 'Thanks'),
    ]
    expect(todoState(messages)?.live).toBe(true)
    const later = [...messages, assistantMessage('msg_a000000000000002', 'You are welcome.')]
    expect(todoState(later)).toMatchObject({ messageId: 'msg_a000000000000001', live: false, done: 0, total: 2 })
  })

  it('ignores errored calls, so the previous list stays in force', () => {
    const failed = { type: 'tool-todo_write', toolCallId: 'call_x', state: 'output-error', input: { todos: [] }, errorText: 'Todo ids must be unique.' } as unknown as HarnessUIMessagePart
    const messages = [assistantMessage('msg_a000000000000001', '', { parts: [todoWritePart(first), failed] })]
    expect(todoState(messages)?.todos).toEqual(first)
  })
})
