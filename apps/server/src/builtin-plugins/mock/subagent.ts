// `mock:subagent` (Phase 9, ADR-043, PROVIDERS.md 8 "Agent mocks (Phase 9)"): plays both sides of a sub-agent run (the
// chat model and `subagentModelRef`). FROZEN after Gate P9-0b (C27).
//
// Child (checked first: the system text holds `SUBAGENT_INSTRUCTIONS_MARKER`); every step waits 300 ms first, so
// parallel children overlap. `<prompt>` = the text of the last user message; the probe = the first offered of
// `list_directory` (`{ path: '.' }`) and `current_time` (`{}`).
//   1. No result yet in the turn: the probe call.
//   2. The prompt holds the word `write`, `write_file` is offered and has no result yet: `write_file` `{ path:
//      'subagent.txt', content: 'Written by a sub-agent.\n' }`.
//   3. The prompt holds the word `loop` and a probe is offered: the probe call again (every step, until the finalize
//      step offers no tool).
//   4. Otherwise the report `Report: <prompt> | tools: <offered tools>` (`none` when the finalize step removed them).
// Parent (`task` offered): when the turn has no `task` result, one step of parallel `task` calls (two by default:
// `explore` "List the project files" and `general` "Check the time"; `parallel <N>` in the user text, N 1-10: N calls
// "Task <i>", `explore` for odd i, `general` for even i), each prompt followed by a space and the user text when that
// holds the word `write` or `loop`; after the results `Reports: <r1> || <r2> …` (each result's text for the model, in
// call order). Without `task` (and not a child): `Sub-agents are not available.`. Both sides end a turn with a denied or
// failed result (the shared rules of ./turn.ts).
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider'
import type { TaskType } from '@harness-forge/shared'
import type { MockPlan } from './models.ts'
import type { MockTurn, PlannedCall } from './turn.ts'
import { SUBAGENT_INSTRUCTIONS_MARKER } from '../../chat/markers.ts'
import { callStep, deniedOrFailedText, offeredToolNames, resultText, systemText, textStep, toolList, turnOf, userMessageText } from './turn.ts'

/** The wait before each step of a child. */
export const MOCK_SUBAGENT_CHILD_DELAY_MS = 300
export const MOCK_SUBAGENT_FILE = 'subagent.txt'
export const MOCK_SUBAGENT_CONTENT = 'Written by a sub-agent.\n'
export const MOCK_SUBAGENTS_UNAVAILABLE = 'Sub-agents are not available.'
/** The largest N of `parallel <N>`. */
export const MOCK_PARALLEL_MAX = 10

const WRITE = /\bwrite\b/i
const LOOP = /\bloop\b/i
const PARALLEL = /\bparallel (\d+)\b/

/** The `task` inputs of the parent's step for the user text `userText`. */
export function mockTaskInputs(userText: string): Array<{ description: string, prompt: string, type: TaskType }> {
  const extra = WRITE.test(userText) || LOOP.test(userText) ? ` ${userText}` : ''
  const match = userText.match(PARALLEL)
  const count = match === null ? 0 : Number(match[1])
  if (count >= 1 && count <= MOCK_PARALLEL_MAX) {
    return Array.from({ length: count }, (_, index) => ({
      description: `Task ${index + 1}`,
      prompt: `Task ${index + 1}.${extra}`,
      type: index % 2 === 0 ? 'explore' as const : 'general' as const,
    }))
  }
  return [
    { description: 'List the project files', prompt: `List the project files.${extra}`, type: 'explore' },
    { description: 'Check the time', prompt: `Check the time.${extra}`, type: 'general' },
  ]
}

function childPlan(options: LanguageModelV4CallOptions): MockPlan {
  const { prompt } = options
  const offered = offeredToolNames(options)
  const turn = turnOf(prompt)
  const task = userMessageText(prompt.findLast(message => message.role === 'user'))
  const ended = deniedOrFailedText(turn)
  if (ended !== null)
    return textStep(ended, MOCK_SUBAGENT_CHILD_DELAY_MS)
  const probe: PlannedCall | null = offered.includes('list_directory')
    ? { toolName: 'list_directory', input: { path: '.' } }
    : offered.includes('current_time') ? { toolName: 'current_time', input: {} } : null
  const call = (planned: PlannedCall): MockPlan => callStep(prompt, [planned], null, MOCK_SUBAGENT_CHILD_DELAY_MS)
  if (probe !== null && turn.results.length === 0)
    return call(probe)
  if (WRITE.test(task) && offered.includes('write_file') && !turn.results.some(result => result.toolName === 'write_file'))
    return call({ toolName: 'write_file', input: { path: MOCK_SUBAGENT_FILE, content: MOCK_SUBAGENT_CONTENT } })
  if (LOOP.test(task) && probe !== null)
    return call(probe)
  return textStep(`Report: ${task} | tools: ${toolList(offered)}`, MOCK_SUBAGENT_CHILD_DELAY_MS)
}

/** The texts of the turn's `task` results in call order. */
function reportsInCallOrder(turn: MockTurn): string[] {
  const results = turn.results.filter(result => result.toolName === 'task')
  const order = turn.calls.filter(call => call.toolName === 'task').map(call => call.toolCallId)
  const rank = (toolCallId: string): number => {
    const index = order.indexOf(toolCallId)
    return index === -1 ? order.length : index
  }
  return results
    .map((result, index) => ({ result, index }))
    .sort((a, b) => rank(a.result.toolCallId) - rank(b.result.toolCallId) || a.index - b.index)
    .map(({ result }) => resultText(result.output))
}

function parentPlan(prompt: LanguageModelV4Prompt, turn: MockTurn): MockPlan {
  if (!turn.results.some(result => result.toolName === 'task'))
    return callStep(prompt, mockTaskInputs(turn.userText).map(input => ({ toolName: 'task', input })))
  const ended = deniedOrFailedText(turn)
  if (ended !== null)
    return textStep(ended)
  return textStep(`Reports: ${reportsInCallOrder(turn).join(' || ')}`)
}

/** The answer of `mock:subagent` to a call (see the module comment). */
export function mockSubagentPlan(options: LanguageModelV4CallOptions): MockPlan {
  if (systemText(options.prompt).includes(SUBAGENT_INSTRUCTIONS_MARKER))
    return childPlan(options)
  if (!offeredToolNames(options).includes('task'))
    return textStep(MOCK_SUBAGENTS_UNAVAILABLE)
  return parentPlan(options.prompt, turnOf(options.prompt))
}
