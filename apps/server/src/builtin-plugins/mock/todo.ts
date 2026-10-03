// `mock:todo` (Phase 9, ADR-041, PROVIDERS.md 8 "Agent mocks (Phase 9)"): drives the todo list and its strip. FROZEN
// after Gate P9-0b (C27). Every step waits 400 ms first (`stepDelayMs`, so a test can see each state). Three
// `todo_write` calls, one per step, over the items `1` "Read the code", `2` "Change the code", `3` "Run the tests"
// (each with its `activeForm`): call 1 all `pending`; call 2 item 1 `completed`, item 2 `in_progress`, item 3
// `pending` (the strip reads "1/3 · Changing the code"); call 3 all `completed`; then the text `All 3 tasks done.`. The
// step is the number of `todo_write` results of the turn.
//
// With the word `invalid` in the turn's user text, the first call sends a list with duplicate ids (the input schema
// refuses it, so the model gets an error result) and the script then continues with the three calls: that first error
// does not end the turn. Without `todo_write`: `Tools are disabled.`; otherwise a denied result or an error as the last
// result end the turn (the shared rules of ./turn.ts).
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type { TodoStatus } from '@harness-forge/shared'
import type { MockPlan } from './models.ts'
import { MOCK_TOOLS_DISABLED } from './common.ts'
import { callStep, deniedOrFailedText, offeredToolNames, textStep, turnOf } from './turn.ts'

/** The wait before each step of `mock:todo`. */
export const MOCK_TODO_STEP_DELAY_MS = 400
export const MOCK_TODO_DONE = 'All 3 tasks done.'

const ITEMS = [
  { id: '1', content: 'Read the code', activeForm: 'Reading the code' },
  { id: '2', content: 'Change the code', activeForm: 'Changing the code' },
  { id: '3', content: 'Run the tests', activeForm: 'Running the tests' },
] as const

const STATES: ReadonlyArray<readonly [TodoStatus, TodoStatus, TodoStatus]> = [
  ['pending', 'pending', 'pending'],
  ['completed', 'in_progress', 'pending'],
  ['completed', 'completed', 'completed'],
]

/** The `todo_write` input of call `index` (0-2) of the script. */
export function mockTodoList(index: number): { todos: Array<{ id: string, content: string, status: TodoStatus, activeForm: string }> } {
  const states = STATES[index] ?? STATES[STATES.length - 1]!
  return { todos: ITEMS.map((item, position) => ({ ...item, status: states[position]! })) }
}

/** The `todo_write` input of the `invalid` call: the first two items share the id `1`. */
export function mockInvalidTodoList(): { todos: Array<{ id: string, content: string, status: TodoStatus, activeForm: string }> } {
  return { todos: ITEMS.map((item, position) => ({ ...item, id: position === 1 ? '1' : item.id, status: 'pending' as const })) }
}

/** The answer of `mock:todo` to a call (see the module comment). */
export function mockTodoPlan(options: LanguageModelV4CallOptions): MockPlan {
  const { prompt } = options
  if (!offeredToolNames(options).includes('todo_write'))
    return textStep(MOCK_TOOLS_DISABLED, MOCK_TODO_STEP_DELAY_MS)
  const turn = turnOf(prompt)
  const invalid = /\binvalid\b/i.test(turn.userText)
  const todoResults = turn.results.filter(result => result.toolName === 'todo_write')
  const expectedError = invalid ? todoResults[0] : undefined
  const ended = deniedOrFailedText(turn, result => result === expectedError && result.output.type !== 'execution-denied')
  if (ended !== null)
    return textStep(ended, MOCK_TODO_STEP_DELAY_MS)
  if (invalid && todoResults.length === 0)
    return callStep(prompt, [{ toolName: 'todo_write', input: mockInvalidTodoList() }], null, MOCK_TODO_STEP_DELAY_MS)
  const index = todoResults.length - (invalid ? 1 : 0)
  if (index < STATES.length)
    return callStep(prompt, [{ toolName: 'todo_write', input: mockTodoList(index) }], null, MOCK_TODO_STEP_DELAY_MS)
  return textStep(MOCK_TODO_DONE, MOCK_TODO_STEP_DELAY_MS)
}
