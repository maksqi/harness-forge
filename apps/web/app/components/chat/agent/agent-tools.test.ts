import type { ToolPartLike } from '../chat-format'
import { describe, expect, it } from 'vitest'
import { taskInput, taskOutput, taskPart, taskStep, todoItem } from '~/utils/testing/fixtures'
import {
  currentTodo,
  doneTodos,
  firstSentence,
  planApprovedText,
  planModeOf,
  planOf,
  planTitle,
  taskBlockState,
  taskDescriptionOf,
  taskMetaLine,
  taskStepLine,
  taskToolCalls,
  taskTriggerLabel,
  taskTypeOf,
  todoLabel,
  todoListOf,
  todoRowArgument,
  toolCallsText,
} from './agent-tools'

const todos = [
  todoItem({ id: 'a', content: 'Read the parser', status: 'completed' }),
  todoItem({ id: 'b', content: 'Run the parser tests', status: 'in_progress', activeForm: 'Running the parser tests' }),
  todoItem({ id: 'c', content: 'Fix the empty-input branch' }),
]

describe('todos', () => {
  it('finds the current item, its label and the done count', () => {
    expect(currentTodo(todos)?.id).toBe('b')
    expect(currentTodo([todos[0]!])).toBeNull()
    expect(todoLabel(todos[1]!)).toBe('Running the parser tests')
    expect(todoLabel(todoItem({ status: 'in_progress', content: 'Fix it' }))).toBe('Fix it')
    expect(todoLabel(todoItem({ status: 'pending', content: 'Later', activeForm: 'Doing later' }))).toBe('Later')
    expect(doneTodos(todos)).toBe(1)
  })

  it('reads the stored list, else the sent one, and nothing that fails the schemas', () => {
    const counts = { pending: 1, inProgress: 1, completed: 1, total: 3 }
    expect(todoListOf({ todos: [] }, { todos, counts })).toEqual(todos)
    expect(todoListOf({ todos }, undefined)).toEqual(todos)
    expect(todoListOf({ todos }, { nope: true })).toBeNull()
    expect(todoListOf({ todos: [todos[0], todos[0]] }, undefined)).toBeNull()
    expect(todoListOf('[truncated]', undefined)).toBeNull()
  })

  it('takes the row argument from the item in progress', () => {
    expect(todoRowArgument({ todos })).toBe('Running the parser tests')
    expect(todoRowArgument({ todos: [todoItem({ status: 'in_progress', content: 'Fix it' })] })).toBe('Fix it')
    expect(todoRowArgument({ todos: [todos[0]] })).toBeNull()
    expect(todoRowArgument({ nope: 1 })).toBeNull()
  })
})

describe('plans', () => {
  it('titles a plan by its first heading, else its first line', () => {
    expect(planTitle('Intro text\n\n## Move auth to server sessions ##\n1. Add it')).toBe('Move auth to server sessions')
    expect(planTitle('\n\n- Add createSession() in src/auth/session.ts\n- Test it')).toBe('Add createSession() in src/auth/session.ts')
    expect(planTitle(`# ${'x'.repeat(80)}`)).toMatch(/^x+…$/)
    expect(planTitle('  \n ')).toBeNull()
  })

  it('parses the plan and the chosen mode', () => {
    expect(planOf({ plan: '# Plan' })).toBe('# Plan')
    expect(planOf({ plan: '' })).toBeNull()
    expect(planOf(null)).toBeNull()
    expect(planModeOf({ approved: true, mode: 'edits' })).toBe('edits')
    expect(planModeOf({ approved: false })).toBeNull()
    expect(planApprovedText('edits')).toBe('Approved · Accept edits')
    expect(planApprovedText('ask')).toBe('Approved · Ask')
  })
})

describe('sub-agents', () => {
  const part = (overrides: Partial<ToolPartLike> & Pick<ToolPartLike, 'state'>) =>
    ({ type: 'tool-task', toolCallId: 'call_task_1', input: taskInput(), ...overrides }) as ToolPartLike
  const live = { streaming: true, superseded: false }
  const ended = { streaming: false, superseded: false }

  it('derives the block state from the part, the stream and the output', () => {
    expect(taskBlockState(taskPart({ preliminary: true }) as ToolPartLike, live)).toBe('running')
    expect(taskBlockState(taskPart({ preliminary: true }) as ToolPartLike, ended)).toBe('aborted')
    expect(taskBlockState(taskPart({ preliminary: true, output: taskOutput({ status: 'queued' }) }) as ToolPartLike, live)).toBe('queued')
    for (const status of ['completed', 'failed', 'aborted', 'limit'] as const)
      expect(taskBlockState(taskPart({ output: taskOutput({ status }) }) as ToolPartLike, ended)).toBe(status)
    expect(taskBlockState(part({ state: 'input-available' }), live)).toBe('running')
    expect(taskBlockState(part({ state: 'input-available' }), ended)).toBe('aborted')
    expect(taskBlockState(part({ state: 'output-error', errorText: 'The run was stopped before the tool finished.' }), ended)).toBe('aborted')
    expect(taskBlockState(part({ state: 'output-error', errorText: 'boom' }), ended)).toBe('failed')
    expect(taskBlockState(part({ state: 'approval-requested', approval: { id: 'a' } }), ended)).toBe('approval')
    expect(taskBlockState(part({ state: 'approval-requested', approval: { id: 'a' } }), { streaming: false, superseded: true })).toBe('denied')
    expect(taskBlockState(part({ state: 'approval-responded', approval: { id: 'a', approved: false } }), live)).toBe('denied')
    expect(taskBlockState(part({ state: 'approval-responded', approval: { id: 'a', approved: true } }), live)).toBe('running')
    expect(taskBlockState(part({ state: 'output-denied', approval: { id: 'a', approved: false } }), ended)).toBe('denied')
  })

  it('reads a streaming input leniently', () => {
    expect(taskTypeOf({ type: 'general' })).toBe('general')
    expect(taskTypeOf({ type: 'gen' })).toBeNull()
    expect(taskTypeOf(undefined)).toBeNull()
    expect(taskDescriptionOf({ description: ' Find\n the code ' })).toBe('Find the code')
    expect(taskDescriptionOf({})).toBe('')
  })

  it('names the trigger, counts tool calls and words a step', () => {
    const output = taskOutput({ steps: [taskStep(), taskStep({ toolCallId: 'c2' })], stepsOmitted: 3 })
    expect(taskToolCalls(output)).toBe(5)
    expect(taskToolCalls(null)).toBe(0)
    expect(toolCallsText(1)).toBe('1 tool call')
    expect(taskTriggerLabel('explore', 'Find the session code', 'running', 4)).toBe('Explore sub-agent: Find the session code, running, 4 tool calls')
    expect(taskTriggerLabel('general', 'Draft it', 'limit', 1)).toBe('Sub-agent: Draft it, step limit reached, 1 tool call')
    expect(taskTriggerLabel(null, 'x', 'aborted', 0)).toBe('Sub-agent: x, stopped, 0 tool calls')
    expect(taskStepLine(taskStep())).toBe('read_file "src/auth/session.ts"')
    expect(taskStepLine(taskStep({ toolName: 'list_directory', summary: '' }))).toBe('list_directory')
  })

  it('takes the first sentence of a Markdown report', () => {
    expect(firstSentence('## Result\n\nSessions are created in `src/auth/session.ts`. They expire after 1.5 days.')).toBe('Result')
    expect(firstSentence('Sessions are created in `src/auth/session.ts`. They expire.')).toBe('Sessions are created in src/auth/session.ts.')
    expect(firstSentence('- **Done** with v1.5 now')).toBe('Done with v1.5 now')
    expect(firstSentence('')).toBe('')
  })

  it('writes the meta line from what the output holds', () => {
    const output = taskOutput({ modelRef: 'anthropic:claude-haiku-5', usage: { totalTokens: 18_200 }, costUsd: 0.004 })
    expect(taskMetaLine(output)).toBe('claude-haiku-5 · 18K tokens · $0.004 · 41s')
    expect(taskMetaLine(taskOutput({ usage: { inputTokens: 900, outputTokens: 100 } }))).toBe('subagent · 1K tokens · 41s')
    expect(taskMetaLine(taskOutput({ finishedAt: undefined }))).toBe('subagent')
  })
})
