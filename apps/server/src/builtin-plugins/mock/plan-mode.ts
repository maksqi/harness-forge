// `mock:plan` (Phase 9, ADR-041, PROVIDERS.md 8 "Agent mocks (Phase 9)"): drives plan mode and the plan approval card.
// FROZEN after Gate P9-0b (C27). Every call first streams the line `tools: <offered tools>`, then:
//
// 0. The shared ends of ./turn.ts: an error as the last result of the turn -> `The tool call failed: <error text>`; a
//    denied result other than `exit_plan_mode` -> `The tool call was denied.`.
// 1. The turn holds an approved `exit_plan_mode` result (a result that is neither denied nor an error) -> `write_file`
//    `{ path: 'notes.txt', content: 'Planned and done.\n' }` when it is offered and has no result yet in the turn, then
//    `Plan done in mode <mode>.` (the result's `mode`; a text result maps "Accept edits" to `edits` and "Ask" to `ask`;
//    `unknown` otherwise).
// 2. `exit_plan_mode` is offered: the last result of the turn is a denied `exit_plan_mode` -> `Revising: <reason>` (the
//    denial reason, `no reason` without one) and a new `exit_plan_mode` call with the revised plan; otherwise, by the
//    results of the turn: `todo_write` with two items (skipped when it is not offered), then `list_directory` `{ path:
//    '.' }` when it is offered, then `exit_plan_mode` with the plan.
// 3. Otherwise: `Plan mode is off.`
import type { LanguageModelV4CallOptions, LanguageModelV4ToolResultOutput } from '@ai-sdk/provider'
import type { MockPlan } from './models.ts'
import type { MockTurn, TurnResult } from './turn.ts'
import { callStep, deniedOrFailedText, isDeniedResult, isErrorResult, lines, offeredToolNames, textStep, toolList, turnOf } from './turn.ts'
import { textOf } from './workspace.ts'

export const MOCK_PLAN_NOTES_FILE = 'notes.txt'
export const MOCK_PLAN_NOTES_CONTENT = 'Planned and done.\n'
export const MOCK_PLAN_TEXT = '# Plan\n1. Create notes.txt.\n2. Report back.'
export const MOCK_PLAN_OFF = 'Plan mode is off.'
/** The two items of the plan's `todo_write` call. */
export const MOCK_PLAN_TODOS = [
  { id: '1', content: 'Explore the project', status: 'in_progress', activeForm: 'Exploring the project' },
  { id: '2', content: 'Write the plan', status: 'pending', activeForm: 'Writing the plan' },
] as const

const EXIT_PLAN_MODE = 'exit_plan_mode'

/** The revised plan after a denial with `reason`. */
export function mockRevisedPlan(reason: string): string {
  return `# Plan (revised)\n1. Create notes.txt.\n2. Address: ${reason}`
}

/** The first line of every `mock:plan` answer. */
export function mockPlanHeader(offered: readonly string[]): string {
  return `tools: ${toolList(offered)}`
}

/** The mode of an approved `exit_plan_mode` result (`edits`, `ask` or `unknown`). */
export function approvedPlanMode(output: LanguageModelV4ToolResultOutput): string {
  if (output.type === 'json') {
    const mode = (output.value as { mode?: unknown } | null)?.mode
    return typeof mode === 'string' ? mode : 'unknown'
  }
  const text = textOf(output)
  if (text.includes('Accept edits'))
    return 'edits'
  if (/\bAsk\b/.test(text))
    return 'ask'
  return 'unknown'
}

function hasResult(turn: MockTurn, toolName: string): boolean {
  return turn.results.some(result => result.toolName === toolName)
}

function isApproved(result: TurnResult): boolean {
  return result.toolName === EXIT_PLAN_MODE && !isDeniedResult(result) && !isErrorResult(result)
}

/** The answer of `mock:plan` to a call (see the module comment). */
export function mockPlanModePlan(options: LanguageModelV4CallOptions): MockPlan {
  const { prompt } = options
  const offered = offeredToolNames(options)
  const header = mockPlanHeader(offered)
  const turn = turnOf(prompt)
  const ended = deniedOrFailedText(turn, result => isDeniedResult(result) && result.toolName === EXIT_PLAN_MODE)
  if (ended !== null)
    return textStep(lines(header, ended))
  const approved = turn.results.findLast(isApproved)
  if (approved !== undefined) {
    if (offered.includes('write_file') && !hasResult(turn, 'write_file'))
      return callStep(prompt, [{ toolName: 'write_file', input: { path: MOCK_PLAN_NOTES_FILE, content: MOCK_PLAN_NOTES_CONTENT } }], header)
    return textStep(lines(header, `Plan done in mode ${approvedPlanMode(approved.output)}.`))
  }
  if (!offered.includes(EXIT_PLAN_MODE))
    return textStep(lines(header, MOCK_PLAN_OFF))
  const last = turn.results.at(-1)
  if (last !== undefined && last.toolName === EXIT_PLAN_MODE && last.output.type === 'execution-denied') {
    const reason = last.output.reason?.trim() || 'no reason'
    return callStep(prompt, [{ toolName: EXIT_PLAN_MODE, input: { plan: mockRevisedPlan(reason) } }], lines(header, `Revising: ${reason}`))
  }
  if (offered.includes('todo_write') && !hasResult(turn, 'todo_write'))
    return callStep(prompt, [{ toolName: 'todo_write', input: { todos: MOCK_PLAN_TODOS } }], header)
  if (offered.includes('list_directory') && !hasResult(turn, 'list_directory'))
    return callStep(prompt, [{ toolName: 'list_directory', input: { path: '.' } }], header)
  return callStep(prompt, [{ toolName: EXIT_PLAN_MODE, input: { plan: MOCK_PLAN_TEXT } }], header)
}
