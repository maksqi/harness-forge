// The Phase 9 agent mocks (PROVIDERS.md 8 "Agent mocks (Phase 9)"): a plan per branch of every model, the shared turn
// rules, and the scripts end to end through `streamText` (fake timers: the step delays never sleep for real).
import type { LanguageModelV4CallOptions, LanguageModelV4Message, LanguageModelV4Prompt, LanguageModelV4ToolResultOutput } from '@ai-sdk/provider'
import type { MockPlan } from './models.ts'
import { taskInputSchema, todoWriteInputSchema } from '@harness-forge/shared'
import { isStepCount, streamText, tool } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { COMPACT_INSTRUCTIONS_MARKER, SUBAGENT_INSTRUCTIONS_MARKER } from '../../chat/markers.ts'
import { mockFiller } from './compact.ts'
import { createMockLanguageModel, mockPlan } from './models.ts'
import { MOCK_PLAN_TEXT, MOCK_PLAN_TODOS, mockRevisedPlan } from './plan-mode.ts'
import { mockInvalidTodoList, mockTodoList } from './todo.ts'
import { isSteer, offeredToolNames, toolList, turnOf } from './turn.ts'

// ---------- prompt builders ----------

function system(text: string): LanguageModelV4Message {
  return { role: 'system', content: text }
}

function user(...texts: string[]): LanguageModelV4Message {
  return { role: 'user', content: texts.map(text => ({ type: 'text' as const, text })) }
}

function assistant(text: string): LanguageModelV4Message {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

interface Call { id: string, name: string, input?: unknown }

function calls(list: Call[], text?: string): LanguageModelV4Message {
  return {
    role: 'assistant',
    content: [
      ...(text === undefined ? [] : [{ type: 'text' as const, text }]),
      ...list.map(call => ({ type: 'tool-call' as const, toolCallId: call.id, toolName: call.name, input: call.input ?? {} })),
    ],
  }
}

function results(list: Array<{ id: string, name: string, output: LanguageModelV4ToolResultOutput }>): LanguageModelV4Message {
  return { role: 'tool', content: list.map(entry => ({ type: 'tool-result' as const, toolCallId: entry.id, toolName: entry.name, output: entry.output })) }
}

/** One call and its result. */
function step(id: string, name: string, output: LanguageModelV4ToolResultOutput, text?: string): LanguageModelV4Message[] {
  return [calls([{ id, name }], text), results([{ id, name, output }])]
}

const OK: LanguageModelV4ToolResultOutput = { type: 'text', value: 'ok' }
const ERROR: LanguageModelV4ToolResultOutput = { type: 'error-text', value: 'The todo_write tool is not implemented yet.' }

function functionTools(names: readonly string[]): LanguageModelV4CallOptions['tools'] {
  return names.map(name => ({ type: 'function' as const, name, inputSchema: { type: 'object', properties: {} } }))
}

function planOf(modelId: Parameters<typeof mockPlan>[0], prompt: LanguageModelV4Prompt, tools?: readonly string[]): MockPlan {
  return mockPlan(modelId, { prompt, ...(tools === undefined ? {} : { tools: functionTools(tools) }) })
}

function callsOf(plan: MockPlan): Array<{ id: string, name: string, input: unknown }> {
  return [...(plan.toolCall === null ? [] : [plan.toolCall]), ...(plan.toolCalls ?? [])].map(call => ({ id: call.toolCallId, name: call.toolName, input: JSON.parse(call.input) as unknown }))
}

// ---------- shared rules ----------

describe('turn rules (./turn.ts)', () => {
  it('a steer is a user message right after a tool message, or after such a steer', () => {
    const prompt: LanguageModelV4Prompt = [
      user('steps 3'),
      ...step('mock_call_1', 'current_time', OK),
      user('first steer'),
      user('second steer'),
      ...step('mock_call_2', 'current_time', OK, 'Steered: first steer.'),
    ]
    expect(prompt.map((_, index) => isSteer(prompt, index))).toEqual([false, false, false, true, true, false, false])
    const turn = turnOf(prompt)
    expect(turn).toMatchObject({ start: 0, userText: 'steps 3', steers: ['first steer', 'second steer'], trailingSteers: [] })
    expect(turn.results.map(result => result.toolCallId)).toEqual(['mock_call_1', 'mock_call_2'])
    expect(turn.calls.map(call => call.toolCallId)).toEqual(['mock_call_1', 'mock_call_2'])
  })

  it('a user message after an assistant text starts a new turn; trailing steers end the prompt', () => {
    const prompt: LanguageModelV4Prompt = [user('one'), assistant('answer'), user('two'), ...step('mock_call_2', 'current_time', OK), user('late')]
    expect(turnOf(prompt)).toMatchObject({ start: 2, userText: 'two', steers: ['late'], trailingSteers: ['late'] })
    expect(turnOf([user('only')])).toMatchObject({ start: 0, userText: 'only', results: [], steers: [], trailingSteers: [] })
    expect(turnOf([])).toMatchObject({ start: -1, userText: '' })
  })

  it('offered tools are sorted by code point and listed with ", " (or none)', () => {
    const options = { prompt: [], tools: functionTools(['write_file', 'Zeta', 'current_time', 'task']) }
    expect(offeredToolNames(options)).toEqual(['Zeta', 'current_time', 'task', 'write_file'])
    expect(toolList([])).toBe('none')
    expect(toolList(['a', 'b'])).toBe('a, b')
  })
})

// ---------- mock:compact ----------

describe('mock:compact', () => {
  const TODO = ['todo_write']

  it('summarizer: first 8 words, steps done, focus and sentinels on one line', () => {
    const transcript = 'User: hello OLD-1 there\nAssistant: Step 1 done. filler\nAssistant: Step 2 done. OLD-2 and OLD-1 again'
    const prompt = [system(`Summarize.\n${COMPACT_INSTRUCTIONS_MARKER}\nFocus: keep numbers`), user(transcript)]
    expect(planOf('compact', prompt, TODO)).toEqual({
      reasoning: null,
      text: 'MOCK-SUMMARY: User: hello OLD-1 there Assistant: Step 1 done. | steps-done=2 | focus=keep numbers | sentinels=OLD-1,OLD-2',
      toolCall: null,
      finishReason: 'stop',
    })
  })

  it('summarizer: no focus, an earlier summary in the transcript (its steps-done plus the steps after it, its own first words not counted)', () => {
    const transcript = 'User: MOCK-SUMMARY: User: loop 6 Assistant: Step 1 done. filler | steps-done=3 | focus=none | sentinels=OLD-9\nAssistant: Step 4 done. filler'
    const prompt = [system(COMPACT_INSTRUCTIONS_MARKER), user(transcript)]
    expect(planOf('compact', prompt).text).toBe('MOCK-SUMMARY: User: MOCK-SUMMARY: User: loop 6 Assistant: Step 1 | steps-done=4 | focus=none | sentinels=OLD-9')
    expect(planOf('compact', [system(COMPACT_INSTRUCTIONS_MARKER), user('nothing here')]).text).toBe('MOCK-SUMMARY: nothing here | steps-done=0 | focus=none | sentinels=none')
  })

  it('reporter without a summary: summary:no and the sentinels of the prompt', () => {
    const prompt = [user('OLD-1 hello'), assistant(`OLD-1 hello ${mockFiller(150)}`), user('more OLD-2'), assistant('more OLD-2'), user('  seen?  ')]
    expect(planOf('compact', prompt, TODO)).toMatchObject({ text: 'summary:no seen:OLD-1,OLD-2', toolCall: null })
  })

  it('reporter with a merged summary: summary:yes; the summary line\'s own sentinels never count', () => {
    const summary = 'This conversation was compacted. Summary:\nMOCK-SUMMARY: OLD-1 hello | steps-done=0 | focus=keep numbers | sentinels=OLD-1'
    expect(planOf('compact', [user(summary, 'seen?')]).text).toBe('summary:yes seen:none')
    expect(planOf('compact', [user(summary, 'after OLD-3'), assistant('after OLD-3'), user('seen?')]).text).toBe('summary:yes seen:OLD-3')
    // `seen?` must be the whole last text part.
    expect(planOf('compact', [user('seen? please')]).text).toBe(`seen? please ${mockFiller(150)}`)
  })

  it('loop: a step per Step <k> done. with a todo_write call, then "Loop finished after N steps."', () => {
    const first = planOf('compact', [user('loop 3')], TODO)
    expect(first.text).toBe(`Step 1 done. ${mockFiller(120)}`)
    expect(first.text?.split(' ')).toHaveLength(3 + 120)
    expect(callsOf(first)).toEqual([{
      id: 'mock_call_1',
      name: 'todo_write',
      input: { todos: [{ id: 'loop', content: 'Run 3 steps', status: 'in_progress', activeForm: 'Running step 1 of 3' }] },
    }])
    expect(todoWriteInputSchema.safeParse(callsOf(first)[0]!.input).success).toBe(true)
    expect(first.finishReason).toBe('tool-calls')
    const second = planOf('compact', [user('loop 3'), ...step('mock_call_1', 'todo_write', OK, first.text!)], TODO)
    expect(second.text).toMatch(/^Step 2 done\. filler/)
    expect(callsOf(second)[0]).toMatchObject({ id: 'mock_call_2', input: { todos: [{ activeForm: 'Running step 2 of 3' }] } })
    const done = planOf('compact', [
      user('loop 3'),
      ...step('mock_call_1', 'todo_write', OK, 'Step 1 done. filler'),
      ...step('mock_call_2', 'todo_write', OK, 'Step 2 done. filler'),
      ...step('mock_call_3', 'todo_write', OK, 'Step 3 done. filler'),
    ], TODO)
    expect(done).toMatchObject({ text: 'Loop finished after 3 steps.', toolCall: null, finishReason: 'stop' })
  })

  it('loop across a summary: done = the latest summary\'s steps-done plus the Step texts after it', () => {
    const summary = 'MOCK-SUMMARY: User: loop 4 Assistant: Step 1 done. filler | steps-done=2 | focus=none | sentinels=none'
    const prompt = [user(summary), ...step('mock_call_1', 'todo_write', OK, 'Step 3 done. filler')]
    expect(planOf('compact', prompt, TODO).text).toMatch(/^Step 4 done\./)
    const finished = [user(summary), ...step('mock_call_1', 'todo_write', OK, 'Step 3 done. filler'), ...step('mock_call_2', 'todo_write', OK, 'Step 4 done. filler')]
    expect(planOf('compact', finished, TODO).text).toBe('Loop finished after 4 steps.')
  })

  it('loop: without todo_write "Tools are disabled.", a failed or denied call ends it, N above 50 is no loop', () => {
    expect(planOf('compact', [user('loop 3')]).text).toBe('Tools are disabled.')
    expect(planOf('compact', [user('loop 3'), ...step('mock_call_1', 'todo_write', ERROR, 'Step 1 done.')], TODO).text).toBe('The tool call failed: The todo_write tool is not implemented yet.')
    expect(planOf('compact', [user('loop 3'), ...step('mock_call_1', 'todo_write', { type: 'execution-denied' }, 'Step 1 done.')], TODO).text).toBe('The tool call was denied.')
    expect(planOf('compact', [user('loop 51')], TODO).text).toBe(`loop 51 ${mockFiller(150)}`)
  })

  it('otherwise: the last text part followed by 150 filler words', () => {
    const plan = planOf('compact', [user('summary part', 'hello OLD-1')], TODO)
    expect(plan).toMatchObject({ text: `hello OLD-1 ${mockFiller(150)}`, toolCall: null, finishReason: 'stop' })
    expect(plan.text?.split(' ')).toHaveLength(152)
    expect(planOf('compact', [user('  ')]).text).toBe(`(empty message) ${mockFiller(150)}`)
  })
})

// ---------- mock:plan ----------

describe('mock:plan', () => {
  const PLAN_TOOLS = ['todo_write', 'exit_plan_mode', 'list_directory', 'read_file', 'current_time']
  const HEADER = 'tools: current_time, exit_plan_mode, list_directory, read_file, todo_write'
  const EDITS_TOOLS = ['todo_write', 'write_file', 'edit_file', 'list_directory', 'read_file']
  const EDITS_HEADER = 'tools: edit_file, list_directory, read_file, todo_write, write_file'
  const approvedText: LanguageModelV4ToolResultOutput = { type: 'text', value: 'The user approved the plan. Mode is now Accept edits. Implement it now; track progress with todo_write.' }

  it('plan: todo_write (two items), list_directory, then exit_plan_mode, each after the tools line', () => {
    const first = planOf('plan', [user('Add notes')], PLAN_TOOLS)
    expect(first).toMatchObject({ text: HEADER, finishReason: 'tool-calls' })
    expect(callsOf(first)).toEqual([{ id: 'mock_call_1', name: 'todo_write', input: { todos: MOCK_PLAN_TODOS } }])
    expect(todoWriteInputSchema.safeParse(callsOf(first)[0]!.input).success).toBe(true)
    const second = planOf('plan', [user('Add notes'), ...step('mock_call_1', 'todo_write', OK)], PLAN_TOOLS)
    expect(callsOf(second)).toEqual([{ id: 'mock_call_2', name: 'list_directory', input: { path: '.' } }])
    const third = planOf('plan', [user('Add notes'), ...step('mock_call_1', 'todo_write', OK), ...step('mock_call_2', 'list_directory', OK)], PLAN_TOOLS)
    expect(third).toMatchObject({ text: HEADER, finishReason: 'tool-calls' })
    expect(callsOf(third)).toEqual([{ id: 'mock_call_3', name: 'exit_plan_mode', input: { plan: MOCK_PLAN_TEXT } }])
    expect(MOCK_PLAN_TEXT).toBe('# Plan\n1. Create notes.txt.\n2. Report back.')
  })

  it('plan without list_directory (a chat without a project) or todo_write (disabled)', () => {
    const noList = ['todo_write', 'exit_plan_mode']
    expect(callsOf(planOf('plan', [user('x'), ...step('mock_call_1', 'todo_write', OK)], noList))[0]?.name).toBe('exit_plan_mode')
    expect(callsOf(planOf('plan', [user('x')], ['exit_plan_mode', 'list_directory']))[0]?.name).toBe('list_directory')
  })

  it('deny: "Revising: <reason>" and a revised exit_plan_mode call ("no reason" without one)', () => {
    const base = [user('Add notes'), ...step('mock_call_1', 'todo_write', OK), ...step('mock_call_2', 'list_directory', OK)]
    const denied = planOf('plan', [...base, ...step('mock_call_3', 'exit_plan_mode', { type: 'execution-denied', reason: 'Use TypeScript' })], PLAN_TOOLS)
    expect(denied).toMatchObject({ text: `${HEADER}\nRevising: Use TypeScript`, finishReason: 'tool-calls' })
    expect(callsOf(denied)).toEqual([{ id: 'mock_call_4', name: 'exit_plan_mode', input: { plan: '# Plan (revised)\n1. Create notes.txt.\n2. Address: Use TypeScript' } }])
    expect(mockRevisedPlan('x')).toBe('# Plan (revised)\n1. Create notes.txt.\n2. Address: x')
    const noReason = planOf('plan', [...base, ...step('mock_call_3', 'exit_plan_mode', { type: 'execution-denied' })], PLAN_TOOLS)
    expect(noReason.text).toBe(`${HEADER}\nRevising: no reason`)
  })

  it('approve: write_file notes.txt when offered, then "Plan done in mode <mode>."', () => {
    const base = [user('Add notes'), ...step('mock_call_1', 'todo_write', OK), ...step('mock_call_2', 'exit_plan_mode', approvedText)]
    const write = planOf('plan', base, EDITS_TOOLS)
    expect(write).toMatchObject({ text: EDITS_HEADER, finishReason: 'tool-calls' })
    expect(callsOf(write)).toEqual([{ id: 'mock_call_3', name: 'write_file', input: { path: 'notes.txt', content: 'Planned and done.\n' } }])
    expect(planOf('plan', [...base, ...step('mock_call_3', 'write_file', OK)], EDITS_TOOLS)).toMatchObject({ text: `${EDITS_HEADER}\nPlan done in mode edits.`, finishReason: 'stop' })
    // A JSON output names the mode directly; without write_file the text comes at once.
    const json = [user('Add notes'), ...step('mock_call_1', 'exit_plan_mode', { type: 'json', value: { approved: true, mode: 'ask' } })]
    expect(planOf('plan', json, ['read_file']).text).toBe('tools: read_file\nPlan done in mode ask.')
    const askText = [user('Add notes'), ...step('mock_call_1', 'exit_plan_mode', { type: 'text', value: 'The user approved the plan. Mode is now Ask. Implement it now.' })]
    expect(planOf('plan', askText, ['read_file']).text).toBe('tools: read_file\nPlan done in mode ask.')
  })

  it('off: "Plan mode is off." without exit_plan_mode and an approved result', () => {
    expect(planOf('plan', [user('hi')], EDITS_TOOLS).text).toBe(`${EDITS_HEADER}\nPlan mode is off.`)
    expect(planOf('plan', [user('hi')]).text).toBe('tools: none\nPlan mode is off.')
  })

  it('a denied call other than exit_plan_mode, or a failed call, ends the turn', () => {
    const approved = [user('Add notes'), ...step('mock_call_1', 'exit_plan_mode', approvedText)]
    expect(planOf('plan', [...approved, ...step('mock_call_2', 'write_file', { type: 'execution-denied' })], EDITS_TOOLS).text).toBe(`${EDITS_HEADER}\nThe tool call was denied.`)
    expect(planOf('plan', [user('Add notes'), ...step('mock_call_1', 'todo_write', ERROR)], PLAN_TOOLS).text).toBe(`${HEADER}\nThe tool call failed: The todo_write tool is not implemented yet.`)
  })
})

// ---------- mock:todo ----------

describe('mock:todo', () => {
  it('three todo_write states, then "All 3 tasks done.", each step after 400 ms', () => {
    const states: string[][] = []
    const prompt: LanguageModelV4Prompt = [user('Do the three things')]
    for (let index = 0; index < 3; index++) {
      const plan = planOf('todo', prompt, ['todo_write'])
      expect(plan).toMatchObject({ text: null, stepDelayMs: 400, finishReason: 'tool-calls' })
      const [call] = callsOf(plan)
      expect(call).toMatchObject({ id: `mock_call_${index + 1}`, name: 'todo_write' })
      const input = todoWriteInputSchema.parse(call!.input)
      states.push(input.todos.map(todo => todo.status))
      prompt.push(...step(call!.id, 'todo_write', OK))
    }
    expect(states).toEqual([['pending', 'pending', 'pending'], ['completed', 'in_progress', 'pending'], ['completed', 'completed', 'completed']])
    expect(mockTodoList(1).todos.map(todo => [todo.id, todo.content, todo.activeForm])).toEqual([
      ['1', 'Read the code', 'Reading the code'],
      ['2', 'Change the code', 'Changing the code'],
      ['3', 'Run the tests', 'Running the tests'],
    ])
    expect(planOf('todo', prompt, ['todo_write'])).toEqual({ reasoning: null, text: 'All 3 tasks done.', toolCall: null, finishReason: 'stop', stepDelayMs: 400 })
  })

  it('invalid: a list with duplicate ids first (its error does not end the turn), then the three calls', () => {
    const first = planOf('todo', [user('an invalid list please')], ['todo_write'])
    expect(callsOf(first)[0]?.input).toEqual(mockInvalidTodoList())
    expect(todoWriteInputSchema.safeParse(callsOf(first)[0]!.input).success).toBe(false)
    const afterError = [user('an invalid list please'), ...step('mock_call_1', 'todo_write', { type: 'error-text', value: 'Invalid input: Todo ids must be unique.' })]
    expect(callsOf(planOf('todo', afterError, ['todo_write']))[0]?.input).toEqual(mockTodoList(0))
    const later = [...afterError, ...step('mock_call_2', 'todo_write', OK), ...step('mock_call_3', 'todo_write', OK), ...step('mock_call_4', 'todo_write', OK)]
    expect(planOf('todo', later, ['todo_write']).text).toBe('All 3 tasks done.')
    // A later error ends the turn.
    expect(planOf('todo', [...afterError, ...step('mock_call_2', 'todo_write', ERROR)], ['todo_write']).text).toBe('The tool call failed: The todo_write tool is not implemented yet.')
  })

  it('without todo_write "Tools are disabled."; a failed or denied call ends the turn', () => {
    expect(planOf('todo', [user('go')]).text).toBe('Tools are disabled.')
    expect(planOf('todo', [user('go'), ...step('mock_call_1', 'todo_write', ERROR)], ['todo_write']).text).toBe('The tool call failed: The todo_write tool is not implemented yet.')
    expect(planOf('todo', [user('go'), ...step('mock_call_1', 'todo_write', { type: 'execution-denied' })], ['todo_write']).text).toBe('The tool call was denied.')
  })
})

// ---------- mock:subagent ----------

describe('mock:subagent', () => {
  const CHILD = system(`You are a sub-agent.\n${SUBAGENT_INSTRUCTIONS_MARKER}`)

  it('parent: one step with two parallel task calls (ids mock_call_<n>_<i>)', () => {
    const plan = planOf('subagent', [user('Look around')], ['task', 'todo_write'])
    expect(plan).toMatchObject({ text: null, toolCall: null, finishReason: 'tool-calls' })
    expect(callsOf(plan)).toEqual([
      { id: 'mock_call_1_1', name: 'task', input: { description: 'List the project files', prompt: 'List the project files.', type: 'explore' } },
      { id: 'mock_call_1_2', name: 'task', input: { description: 'Check the time', prompt: 'Check the time.', type: 'general' } },
    ])
    for (const call of callsOf(plan))
      expect(taskInputSchema.safeParse(call.input).success).toBe(true)
  })

  it('parent: parallel N calls (odd explore, even general), a single call keeps mock_call_<n>, write / loop are copied', () => {
    const five = callsOf(planOf('subagent', [user('parallel 5')], ['task']))
    expect(five.map(call => call.id)).toEqual(['mock_call_1_1', 'mock_call_1_2', 'mock_call_1_3', 'mock_call_1_4', 'mock_call_1_5'])
    expect(five.map(call => call.input)).toEqual([1, 2, 3, 4, 5].map(i => ({ description: `Task ${i}`, prompt: `Task ${i}.`, type: i % 2 === 1 ? 'explore' : 'general' })))
    expect(callsOf(planOf('subagent', [user('parallel 1')], ['task']))).toEqual([{ id: 'mock_call_1', name: 'task', input: { description: 'Task 1', prompt: 'Task 1.', type: 'explore' } }])
    expect(callsOf(planOf('subagent', [user('parallel 11')], ['task']))).toHaveLength(2)
    expect(callsOf(planOf('subagent', [user('please write notes')], ['task'])).map(call => (call.input as { prompt: string }).prompt)).toEqual([
      'List the project files. please write notes',
      'Check the time. please write notes',
    ])
    expect((callsOf(planOf('subagent', [user('parallel 2 loop')], ['task']))[1]!.input as { prompt: string }).prompt).toBe('Task 2. parallel 2 loop')
  })

  it('parent: after the results "Reports: <r1> || <r2>" in call order', () => {
    const prompt: LanguageModelV4Prompt = [
      user('Look around'),
      calls([{ id: 'mock_call_1_1', name: 'task' }, { id: 'mock_call_1_2', name: 'task' }]),
      results([
        { id: 'mock_call_1_2', name: 'task', output: { type: 'text', value: 'Report: Check the time. | tools: current_time' } },
        { id: 'mock_call_1_1', name: 'task', output: { type: 'text', value: 'Report: List the project files. | tools: list_directory' } },
      ]),
    ]
    expect(planOf('subagent', prompt, ['task'])).toMatchObject({
      text: 'Reports: Report: List the project files. | tools: list_directory || Report: Check the time. | tools: current_time',
      toolCall: null,
      finishReason: 'stop',
    })
  })

  it('parent without task: "Sub-agents are not available."', () => {
    expect(planOf('subagent', [user('Look around')], ['current_time']).text).toBe('Sub-agents are not available.')
    expect(planOf('subagent', [user('Look around')]).text).toBe('Sub-agents are not available.')
  })

  it('child: the probe (list_directory before current_time), then the report with the offered tools; 300 ms per step', () => {
    const tools = ['read_file', 'list_directory', 'current_time']
    const first = planOf('subagent', [CHILD, user('List the project files.')], tools)
    expect(first).toMatchObject({ stepDelayMs: 300, finishReason: 'tool-calls' })
    expect(callsOf(first)).toEqual([{ id: 'mock_call_1', name: 'list_directory', input: { path: '.' } }])
    expect(callsOf(planOf('subagent', [CHILD, user('Check the time.')], ['current_time']))).toEqual([{ id: 'mock_call_1', name: 'current_time', input: {} }])
    const report = planOf('subagent', [CHILD, user('List the project files.'), ...step('mock_call_1', 'list_directory', OK)], tools)
    expect(report).toEqual({ reasoning: null, text: 'Report: List the project files. | tools: current_time, list_directory, read_file', toolCall: null, finishReason: 'stop', stepDelayMs: 300 })
    // A child with `task` offered still plays the child (the marker wins).
    expect(callsOf(planOf('subagent', [CHILD, user('x')], ['task', 'current_time']))[0]?.name).toBe('current_time')
  })

  it('child: write -> write_file after the probe; loop -> the probe on every step until the finalize step offers no tool', () => {
    const tools = ['current_time', 'write_file']
    const write = [CHILD, user('Check the time. write it down'), ...step('mock_call_1', 'current_time', OK)]
    expect(callsOf(planOf('subagent', write, tools))).toEqual([{ id: 'mock_call_2', name: 'write_file', input: { path: 'subagent.txt', content: 'Written by a sub-agent.\n' } }])
    expect(planOf('subagent', [...write, ...step('mock_call_2', 'write_file', OK)], tools).text).toBe('Report: Check the time. write it down | tools: current_time, write_file')
    const loop = [CHILD, user('Task 1. loop'), ...step('mock_call_1', 'current_time', OK), ...step('mock_call_2', 'current_time', OK)]
    expect(callsOf(planOf('subagent', loop, ['current_time']))[0]).toMatchObject({ id: 'mock_call_3', name: 'current_time' })
    expect(planOf('subagent', loop).text).toBe('Report: Task 1. loop | tools: none')
    expect(planOf('subagent', [CHILD, user('Nothing offered')]).text).toBe('Report: Nothing offered | tools: none')
  })

  it('child: a denied call ends with "The tool call was denied."', () => {
    expect(planOf('subagent', [CHILD, user('x'), ...step('mock_call_1', 'current_time', { type: 'execution-denied', reason: 'Sub-agents cannot ask the user.' })], ['current_time']).text).toBe('The tool call was denied.')
  })
})

// ---------- mock:steer ----------

describe('mock:steer', () => {
  it('steps N: a current_time call per step after 400 ms, then "Finished N steps. Steers: none"', () => {
    const first = planOf('steer', [user(' steps 2 ')], ['current_time'])
    expect(first).toMatchObject({ text: null, stepDelayMs: 400, finishReason: 'tool-calls' })
    expect(callsOf(first)).toEqual([{ id: 'mock_call_1', name: 'current_time', input: {} }])
    const second = planOf('steer', [user('steps 2'), ...step('mock_call_1', 'current_time', OK)], ['current_time'])
    expect(callsOf(second)[0]?.id).toBe('mock_call_2')
    const done = planOf('steer', [user('steps 2'), ...step('mock_call_1', 'current_time', OK), ...step('mock_call_2', 'current_time', OK)], ['current_time'])
    expect(done).toEqual({ reasoning: null, text: 'Finished 2 steps. Steers: none', toolCall: null, finishReason: 'stop', stepDelayMs: 400 })
  })

  it('a steer at a step boundary: "Steered: <text>." first, then the plan; the final text lists every steer', () => {
    const steered: LanguageModelV4Prompt = [user('steps 2'), ...step('mock_call_1', 'current_time', OK), user('go faster')]
    const plan = planOf('steer', steered, ['current_time'])
    expect(plan).toMatchObject({ text: 'Steered: go faster.', finishReason: 'tool-calls' })
    expect(callsOf(plan)).toEqual([{ id: 'mock_call_2', name: 'current_time', input: {} }])
    const done = planOf('steer', [...steered, ...step('mock_call_2', 'current_time', OK, 'Steered: go faster.')], ['current_time'])
    expect(done.text).toBe('Finished 2 steps. Steers: go faster')
    // Two steers at one boundary, delivered before the final text.
    const two = planOf('steer', [user('steps 1'), ...step('mock_call_1', 'current_time', OK), user('a'), user('b')], ['current_time'])
    expect(two.text).toBe('Steered: a.\nSteered: b.\nFinished 1 steps. Steers: a | b')
  })

  it('any other turn echoes the last user message without a wait; without current_time "Tools are disabled."', () => {
    expect(planOf('steer', [user('hello there')], ['current_time'])).toEqual({ reasoning: null, text: 'hello there', toolCall: null, finishReason: 'stop' })
    expect(planOf('steer', [user('steps 21')], ['current_time']).text).toBe('steps 21')
    expect(planOf('steer', [user('steps 0')], ['current_time']).text).toBe('steps 0')
    expect(planOf('steer', [user('steps 3')]).text).toBe('Tools are disabled.')
    expect(planOf('steer', [user('steps 2'), ...step('mock_call_1', 'current_time', { type: 'execution-denied' })], ['current_time']).text).toBe('The tool call was denied.')
  })
})

// ---------- end to end through streamText ----------

/** Advances fake timers until `promise` settles. */
async function settle<T>(promise: PromiseLike<T>): Promise<T> {
  const state = { done: false }
  const tracked = Promise.resolve(promise).finally(() => {
    state.done = true
  })
  for (let round = 0; round < 10_000; round++) {
    if (state.done)
      break
    await vi.advanceTimersByTimeAsync(50)
  }
  return tracked
}

describe('agent mocks end to end through streamText', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('mock:todo with "invalid": the schema refuses the first list, the script goes on to "All 3 tasks done."', async () => {
    vi.useFakeTimers()
    const seen: string[][] = []
    const todoWrite = tool({
      description: 'Writes todos.',
      inputSchema: todoWriteInputSchema,
      execute: async (input) => {
        seen.push(input.todos.map(todo => todo.status))
        return { ok: true }
      },
    })
    const result = streamText({ model: createMockLanguageModel('todo'), prompt: 'an invalid list', tools: { todo_write: todoWrite }, stopWhen: isStepCount(8) })
    expect(await settle(result.text)).toBe('All 3 tasks done.')
    const steps = await result.steps
    expect(steps).toHaveLength(5)
    expect(steps[0]?.content.some(part => part.type === 'tool-error')).toBe(true)
    expect(seen).toEqual([['pending', 'pending', 'pending'], ['completed', 'in_progress', 'pending'], ['completed', 'completed', 'completed']])
  })

  it('mock:subagent parent: both task calls run in one step, then the reports in call order', async () => {
    vi.useFakeTimers()
    const task = tool({
      description: 'Runs a sub-agent.',
      inputSchema: taskInputSchema,
      execute: async input => ({ report: `Did: ${input.prompt}` }),
      toModelOutput: ({ output }) => ({ type: 'text', value: output.report }),
    })
    const result = streamText({ model: createMockLanguageModel('subagent'), prompt: 'Look around', tools: { task }, stopWhen: isStepCount(4) })
    expect(await settle(result.text)).toBe('Reports: Did: List the project files. || Did: Check the time.')
    const steps = await result.steps
    expect(steps[0]?.toolCalls.map(call => call.toolCallId)).toEqual(['mock_call_1_1', 'mock_call_1_2'])
  })

  it('mock:steer: a user message injected by prepareStep at a step boundary is a steer', async () => {
    vi.useFakeTimers()
    const currentTime = tool({ description: 'Time.', inputSchema: z.object({}), execute: async () => ({ now: 0 }) })
    const result = streamText({
      model: createMockLanguageModel('steer'),
      prompt: 'steps 2',
      tools: { current_time: currentTime },
      stopWhen: isStepCount(5),
      prepareStep: ({ stepNumber, messages }) => (stepNumber === 1 ? { messages: [...messages, { role: 'user', content: 'also check this' }] } : undefined),
    })
    await settle(result.text)
    const texts = (await result.steps).map(entry => entry.text)
    expect(texts).toEqual(['', 'Steered: also check this.', 'Finished 2 steps. Steers: also check this'])
  })

  it('mock:compact loop: each step writes Step <k> done. and calls todo_write until the loop finishes', async () => {
    vi.useFakeTimers()
    const todoWrite = tool({ description: 'Writes todos.', inputSchema: todoWriteInputSchema, execute: async () => ({ ok: true }) })
    const result = streamText({ model: createMockLanguageModel('compact'), prompt: 'loop 2', tools: { todo_write: todoWrite }, stopWhen: isStepCount(5) })
    await settle(result.text)
    const texts = (await result.steps).map(entry => entry.text.split(' ').slice(0, 3).join(' '))
    expect(texts).toEqual(['Step 1 done.', 'Step 2 done.', 'Loop finished after'])
  })
})
