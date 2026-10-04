// `mock:background` (Phase 10, ADR-046, PROVIDERS.md 8 "Customization mocks (Phase 10)"): drives background
// sub-agents. FROZEN after Gate P10-0b (C32): the probes and the e2e specs depend on it. The shared rules of the agent
// mocks apply (./turn.ts: call ids, offered-tool lists, the Turn and steer rules, the markers, the denied and failed
// endings). Checked in this order:
//
// 1. Child (the system text holds `SUBAGENT_INSTRUCTIONS_MARKER`): `<prompt>` = the text of the last user message;
//    K = the number after the first `slow` (`slow <K>`, K 1-20; default 2); with the word `loop` no limit. While the
//    turn holds fewer than K `current_time` results (with `loop`: as long as `current_time` is offered, so the
//    finalize step of the step limit ends it), one step that waits 500 ms and calls `current_time` `{}`; then the text
//    `Report: background done` (at once when `current_time` is not offered).
// 2. Delivered result: the turn's user message holds `<background-task` (the carrier message of a server-started turn,
//    or a result delivered at step 0 of the next turn, which opens the turn) -> `Background result: <status> | <first
//    report line>` (`<status>` = the `status` attribute of its first `<background-task` tag, `<first report line>` =
//    the first non-empty line after that tag: the report's first line, `Error: <error>` or `(no report)`).
// 3. Launch: the user text starts with the word `bg` (`bg [type] [steps <N>] [slow <K> | loop]`): `<type>` = the
//    second word unless it is `steps`, `slow` or `loop` (default `explore`); `steps <N>` (N 1-20) anywhere asks for
//    in-run steps; the whole user text is the child's prompt. Without `task` offered: `Sub-agents are not available.`
//    Without a `task` result in the turn: one `task` call `{ type, description: 'Background <type>', prompt: <user
//    text>, background: true }`. After it: without `steps`, `Started in background: <taskId>` (the output's `taskId`,
//    else the first `bgt_` + 16 characters of the result's text, else `none`, e.g. a `failed` launch); with
//    `steps <N>`, steps that wait 400 ms and call `current_time` `{}` until the turn holds N `current_time` results,
//    ending early, as soon as a user message holding `<background-task` follows a tool message in the turn (a result
//    injected at a step boundary), with `Finished: in-run result <status>`; else `Finished <N> steps without a result`.
//    A denied or failed result of the turn ends it as in the shared rules; in-run steps without `current_time`
//    offered: `Tools are disabled.`.
// 4. Any other turn: `Background mock: <user text>` (`(empty message)` for none).
import type { LanguageModelV4CallOptions, LanguageModelV4Message, LanguageModelV4Prompt } from '@ai-sdk/provider'
import type { MockPlan } from './models.ts'
import type { MockTurn, TurnResult } from './turn.ts'
import { SUBAGENT_INSTRUCTIONS_MARKER } from '../../chat/markers.ts'
import { MOCK_EMPTY_MESSAGE, MOCK_TOOLS_DISABLED } from './common.ts'
import { MOCK_SUBAGENTS_UNAVAILABLE } from './subagent.ts'
import { callStep, deniedOrFailedText, isSteer, offeredToolNames, systemText, textStep, turnOf, userMessageText } from './turn.ts'
import { textOf } from './workspace.ts'

/** The wait before each `current_time` step of a child. */
export const MOCK_BACKGROUND_CHILD_DELAY_MS = 500
/** The wait before each in-run `current_time` step of a `bg … steps <N>` turn. */
export const MOCK_BACKGROUND_STEP_DELAY_MS = 400
/** The steps of a child without `slow <K>`. */
export const MOCK_BACKGROUND_DEFAULT_STEPS = 2
/** The largest K of `slow <K>` and N of `steps <N>`. */
export const MOCK_BACKGROUND_STEPS_MAX = 20
export const MOCK_BACKGROUND_REPORT = 'Report: background done'
/** The type of a `bg` launch without one. */
export const MOCK_BACKGROUND_DEFAULT_TYPE = 'explore'

const TAG = '<background-task'
const LOOP = /\bloop\b/i
const SLOW = /\bslow (\d+)\b/
const STEPS = /\bsteps (\d+)\b/
const TASK_ID = /bgt_[\dA-Za-z]{16}/
const LAUNCH_KEYWORDS: ReadonlySet<string> = new Set(['steps', 'slow', 'loop'])

/** The number of `<word> <N>` in `text` (the first match) when it is 1-20, else null. */
function countAfter(pattern: RegExp, text: string): number | null {
  const match = text.match(pattern)
  if (match === null)
    return null
  const value = Number(match[1])
  return value >= 1 && value <= MOCK_BACKGROUND_STEPS_MAX ? value : null
}

/** K of a child prompt: `slow <K>` (1-20), else 2; null with `loop` (no limit). */
export function mockBackgroundChildSteps(prompt: string): number | null {
  if (LOOP.test(prompt))
    return null
  return countAfter(SLOW, prompt) ?? MOCK_BACKGROUND_DEFAULT_STEPS
}

/** A `bg` launch: the agent type and the in-run steps (`steps <N>`, null without), or null for another text. */
export function mockBackgroundLaunch(userText: string): { type: string, steps: number | null } | null {
  const words = userText.trim().split(/\s+/)
  if (words[0] !== 'bg')
    return null
  const second = words[1]
  const type = second === undefined || LAUNCH_KEYWORDS.has(second) ? MOCK_BACKGROUND_DEFAULT_TYPE : second
  return { type, steps: countAfter(STEPS, userText) }
}

/** The `task` input of a `bg` launch. */
export function mockBackgroundTaskInput(type: string, userText: string): { type: string, description: string, prompt: string, background: true } {
  return { type, description: `Background ${type}`, prompt: userText, background: true }
}

/** All text parts of a user message, each on its own line (the tag's lines survive). */
function messageLines(message: LanguageModelV4Message | undefined): string {
  if (message?.role !== 'user')
    return ''
  return message.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n')
}

/**
 * The first `<background-task` tag of `text`: its `status` attribute (`unknown` without one) and the first non-empty
 * line after the tag; null without a tag.
 */
export function mockBackgroundTag(text: string): { status: string, firstLine: string } | null {
  const start = text.indexOf(TAG)
  if (start === -1)
    return null
  const end = text.indexOf('>', start)
  const tag = end === -1 ? text.slice(start) : text.slice(start, end + 1)
  const status = tag.match(/\sstatus="([^"]*)"/)?.[1] ?? 'unknown'
  const after = end === -1 ? '' : text.slice(end + 1)
  const firstLine = after.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
  return { status, firstLine }
}

/** The `<taskId>` of a launch result: the output's `taskId`, else the first id in its text, else `none`. */
export function mockLaunchedTaskId(result: TurnResult): string {
  const { output } = result
  if (output.type === 'json') {
    const taskId = (output.value as { taskId?: unknown } | null)?.taskId
    if (typeof taskId === 'string' && taskId !== '')
      return taskId
  }
  return textOf(output).match(TASK_ID)?.[0] ?? 'none'
}

/** The status of the first result injected at a step boundary of the turn (a steer holding a tag), or null. */
function injectedResultStatus(prompt: LanguageModelV4Prompt, turn: MockTurn): string | null {
  for (let index = turn.start + 1; index < prompt.length; index++) {
    if (!isSteer(prompt, index))
      continue
    const tag = mockBackgroundTag(messageLines(prompt[index]))
    if (tag !== null)
      return tag.status
  }
  return null
}

function childPlan(options: LanguageModelV4CallOptions): MockPlan {
  const { prompt } = options
  const turn = turnOf(prompt)
  const ended = deniedOrFailedText(turn)
  if (ended !== null)
    return textStep(ended)
  const steps = mockBackgroundChildSteps(userMessageText(prompt.findLast(message => message.role === 'user')))
  const done = turn.results.filter(result => result.toolName === 'current_time').length
  if (offeredToolNames(options).includes('current_time') && (steps === null || done < steps))
    return callStep(prompt, [{ toolName: 'current_time', input: {} }], null, MOCK_BACKGROUND_CHILD_DELAY_MS)
  return textStep(MOCK_BACKGROUND_REPORT)
}

function launchPlan(options: LanguageModelV4CallOptions, turn: MockTurn, launch: { type: string, steps: number | null }): MockPlan {
  const { prompt } = options
  const offered = offeredToolNames(options)
  const launched = turn.results.find(result => result.toolName === 'task')
  if (launched === undefined) {
    if (!offered.includes('task'))
      return textStep(MOCK_SUBAGENTS_UNAVAILABLE)
    return callStep(prompt, [{ toolName: 'task', input: mockBackgroundTaskInput(launch.type, turn.userText) }])
  }
  const ended = deniedOrFailedText(turn)
  if (ended !== null)
    return textStep(ended)
  if (launch.steps === null)
    return textStep(`Started in background: ${mockLaunchedTaskId(launched)}`)
  const injected = injectedResultStatus(prompt, turn)
  if (injected !== null)
    return textStep(`Finished: in-run result ${injected}`)
  const done = turn.results.filter(result => result.toolName === 'current_time').length
  if (done >= launch.steps)
    return textStep(`Finished ${launch.steps} steps without a result`)
  if (!offered.includes('current_time'))
    return textStep(MOCK_TOOLS_DISABLED)
  return callStep(prompt, [{ toolName: 'current_time', input: {} }], null, MOCK_BACKGROUND_STEP_DELAY_MS)
}

/** The answer of `mock:background` to a call (see the module comment). */
export function mockBackgroundPlan(options: LanguageModelV4CallOptions): MockPlan {
  const { prompt } = options
  if (systemText(prompt).includes(SUBAGENT_INSTRUCTIONS_MARKER))
    return childPlan(options)
  const turn = turnOf(prompt)
  const delivered = mockBackgroundTag(messageLines(prompt[turn.start]))
  if (delivered !== null)
    return textStep(`Background result: ${delivered.status} | ${delivered.firstLine}`)
  const launch = mockBackgroundLaunch(turn.userText)
  if (launch !== null)
    return launchPlan(options, turn, launch)
  return textStep(`Background mock: ${turn.userText || MOCK_EMPTY_MESSAGE}`)
}
