import type { ToolPartLike } from '../chat-format'
import { describe, expect, it } from 'vitest'
import { backgroundTask, taskInput, taskOutput, taskPart, taskResultData, taskStep, todoItem } from '~/utils/testing/fixtures'
import {
  backgroundTaskState,
  currentTodo,
  doneTodos,
  firstSentence,
  planApprovedText,
  planFileOf,
  planModeOf,
  planOf,
  planTitle,
  skillNameOf,
  skillSourceText,
  TASK_TYPE_LABEL_MAX_CHARS,
  taskAgentSourceText,
  taskAgentTypeName,
  taskAgentTypeOf,
  taskBlockState,
  taskDescriptionOf,
  taskIsBackground,
  taskKindOf,
  taskMetaLine,
  taskResultHeading,
  taskResultSummary,
  taskStepLine,
  taskToolCalls,
  taskTriggerLabel,
  taskTypeLabel,
  taskTypeLabelShort,
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

describe('agent types and plan files (Phase 10)', () => {
  it('sorts types into explore, general (alias general-purpose) and custom, with their labels', () => {
    expect(['explore', 'general', 'general-purpose', 'reviewer'].map(taskKindOf)).toEqual(['explore', 'general', 'general', 'custom'])
    expect(['explore', 'general', 'reviewer'].map(taskTypeLabel)).toEqual(['Explore', 'Agent', 'reviewer'])
    expect(taskAgentTypeOf({ type: ' Reviewer ' })).toBe('reviewer')
    expect(taskAgentTypeOf({ type: '' })).toBeNull()
    expect(taskAgentTypeOf(null)).toBeNull()
  })

  it('reads the plan file of an approved plan', () => {
    expect(planFileOf({ approved: true, mode: 'edits', planPath: '.harness/plans/x.md' })).toEqual({ planPath: '.harness/plans/x.md', planError: null })
    expect(planFileOf({ approved: true, mode: 'ask', planError: 'The plan folder is a link.' })).toEqual({ planPath: null, planError: 'The plan folder is a link.' })
    expect(planFileOf({ approved: true, mode: 'ask' })).toEqual({ planPath: null, planError: null })
    expect(planFileOf({ nope: true })).toEqual({ planPath: null, planError: null })
  })
})

describe('custom agents, background calls, skills and results (Phase 10)', () => {
  it('names the type of a call: the output\'s first, else the input\'s; general-purpose reads as general', () => {
    expect(taskAgentTypeName({ type: 'Reviewer' }, null)).toBe('reviewer')
    expect(taskAgentTypeName({ type: 'general-purpose' }, null)).toBe('general')
    expect(taskAgentTypeName({ type: 'general-purpose' }, { type: 'general' })).toBe('general')
    expect(taskAgentTypeName({ type: 'rev' }, { type: 'reviewer' })).toBe('reviewer')
    expect(taskAgentTypeName({}, null)).toBeNull()
  })

  it('cuts a long custom name at 24 characters and keeps the builtin labels', () => {
    const long = 'a-very-long-custom-agent-name-indeed'
    expect(taskTypeLabelShort(long)).toHaveLength(TASK_TYPE_LABEL_MAX_CHARS)
    expect(taskTypeLabelShort(long)).toBe(`${long.slice(0, 23)}…`)
    expect(taskTypeLabelShort('reviewer')).toBe('reviewer')
    expect(taskTypeLabelShort('general-purpose')).toBe('Agent')
  })

  it('words the source of an agent snapshot', () => {
    expect(taskAgentSourceText({ source: 'builtin' })).toBe('Built-in agent')
    expect(taskAgentSourceText({ source: 'user' })).toBe('Personal agent')
    expect(taskAgentSourceText({ source: 'plugin' }, 'DB tools')).toBe('From DB tools')
    expect(taskAgentSourceText({ source: 'plugin' })).toBe('From a plugin')
    expect(taskAgentSourceText({ source: 'project', path: '.harness/agents/x.md' })).toBe('Project: .harness/agents/x.md')
    expect(taskAgentSourceText({ source: 'project' })).toBe('Project agent')
  })

  it('names a custom trigger and adds ", running in the background" while a background agent runs', () => {
    expect(taskTriggerLabel('reviewer', 'Review the diff', 'running', 4)).toBe('Sub-agent reviewer: Review the diff, running, 4 tool calls')
    expect(taskTriggerLabel('general-purpose', 'Draft it', 'completed', 1)).toBe('Sub-agent: Draft it, completed, 1 tool call')
    expect(taskTriggerLabel('general', 'Find flaky tests', 'running', 2, { background: true }))
      .toBe('Sub-agent: Find flaky tests, running, 2 tool calls, running in the background')
    expect(taskTriggerLabel('explore', 'Look', 'queued', 0, { background: true }))
      .toBe('Explore sub-agent: Look, waiting, 0 tool calls, running in the background')
    expect(taskTriggerLabel('general', 'Find flaky tests', 'completed', 2, { background: true }))
      .toBe('Sub-agent: Find flaky tests, completed, 2 tool calls')
    expect(taskTriggerLabel('general', 'Find flaky tests', 'background', 0, { background: true }))
      .toBe('Sub-agent: Find flaky tests, started in the background, 0 tool calls')
  })

  it('recognizes a background call by its input or its launch output', () => {
    expect(taskIsBackground({ background: true })).toBe(true)
    expect(taskIsBackground({ background: false })).toBe(false)
    expect(taskIsBackground(taskInput())).toBe(false)
    expect(taskIsBackground({}, { status: 'background' })).toBe(true)
    expect(taskIsBackground(null)).toBe(false)
  })

  it('reads the live state of a background agent: the task, else the delivered result, else unknown', () => {
    const running = backgroundTask({ status: 'running', output: taskOutput({ status: 'running', finishedAt: undefined }) })
    expect(backgroundTaskState(running, null)).toEqual({ state: 'running', output: running.output })
    const queued = backgroundTask({ status: 'running', output: taskOutput({ status: 'queued', steps: [] }) })
    expect(backgroundTaskState(queued, null).state).toBe('queued')
    const stopped = backgroundTask({ status: 'aborted', output: taskOutput({ status: 'aborted', error: 'The server restarted before the task finished.' }) })
    expect(backgroundTaskState(stopped, taskResultData()).state).toBe('aborted')
    const result = taskResultData({ output: taskOutput({ status: 'limit' }) })
    expect(backgroundTaskState(null, result)).toEqual({ state: 'limit', output: result.output })
    expect(backgroundTaskState(null, taskResultData({ output: taskOutput({ status: 'running' }) })).state).toBe('completed')
    expect(backgroundTaskState(null, null)).toEqual({ state: 'background', output: null })
  })

  it('words the source of a skill and reads its name', () => {
    expect(skillSourceText('project')).toBe('Project')
    expect(skillSourceText('user')).toBe('Personal')
    expect(skillSourceText('plugin', 'Docs kit')).toBe('Docs kit')
    expect(skillSourceText('plugin')).toBe('Plugin')
    expect(skillSourceText('builtin')).toBe('Built-in')
    expect(skillNameOf({ name: ' Release-Notes ' })).toBe('release-notes')
    expect(skillNameOf({ name: '' })).toBeNull()
    expect(skillNameOf('x')).toBeNull()
  })

  it('words the lines of a result note', () => {
    expect(['completed', 'failed', 'aborted', 'limit'].map(status => taskResultHeading(status as 'completed'))).toEqual([
      'Background agent finished',
      'Background agent failed',
      'Background agent stopped',
      'Background agent reached its step limit',
    ])
    expect(taskResultSummary({ report: 'Two tests depend on time. More below.', error: undefined })).toBe('Two tests depend on time.')
    expect(taskResultSummary({ report: '', error: 'The model refused. Try again.' })).toBe('The model refused.')
    expect(taskResultSummary({ report: ' ', error: undefined })).toBe('No report.')
  })
})
