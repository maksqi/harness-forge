// `mock:steer` (Phase 9, ADR-042, PROVIDERS.md 8 "Agent mocks (Phase 9)"): drives the steer queue. FROZEN after Gate
// P9-0b (C27). A turn whose user text is exactly `steps <N>` (trimmed; N 1-20) runs N steps; every step of such a turn
// (the final text included) waits 400 ms first (`stepDelayMs`), then calls `current_time` `{}` until the turn holds N
// `current_time` results; then the text `Finished <N> steps. Steers: <list>` (the texts of every steer of the turn, in
// order, joined with " | ", or `none`). When the prompt ends with steers (user messages after the turn's last tool
// message), the step first streams one line `Steered: <text>.` per steer, then goes on with the plan (the next call, or
// the final text). Without `current_time`: `Tools are disabled.`; a denied or failed result ends the turn (the shared
// rules of ./turn.ts). Any other turn: the text of the last user message, like `mock:echo` (no wait).
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type { MockPlan } from './models.ts'
import { MOCK_EMPTY_MESSAGE, MOCK_TOOLS_DISABLED } from './common.ts'
import { callStep, deniedOrFailedText, lines, offeredToolNames, textStep, turnOf, userMessageText } from './turn.ts'

/** The wait before each step of a `steps <N>` turn. */
export const MOCK_STEER_STEP_DELAY_MS = 400
/** The largest N of `steps <N>`. */
export const MOCK_STEER_STEPS_MAX = 20

const STEPS = /^steps (\d+)$/

/** The N of a `steps <N>` user text (N 1-20), or null. */
export function mockSteerSteps(userText: string): number | null {
  const match = userText.trim().match(STEPS)
  if (match === null)
    return null
  const steps = Number(match[1])
  return steps >= 1 && steps <= MOCK_STEER_STEPS_MAX ? steps : null
}

/** The answer of `mock:steer` to a call (see the module comment). */
export function mockSteerPlan(options: LanguageModelV4CallOptions): MockPlan {
  const { prompt } = options
  const turn = turnOf(prompt)
  const steps = mockSteerSteps(turn.userText)
  if (steps === null)
    return textStep(userMessageText(prompt.findLast(message => message.role === 'user')) || MOCK_EMPTY_MESSAGE)
  const delay = MOCK_STEER_STEP_DELAY_MS
  if (!offeredToolNames(options).includes('current_time'))
    return textStep(MOCK_TOOLS_DISABLED, delay)
  const ended = deniedOrFailedText(turn)
  if (ended !== null)
    return textStep(ended, delay)
  const steered = lines(...turn.trailingSteers.map(text => `Steered: ${text || MOCK_EMPTY_MESSAGE}.`))
  const done = turn.results.filter(result => result.toolName === 'current_time').length
  if (done < steps)
    return callStep(prompt, [{ toolName: 'current_time', input: {} }], steered === '' ? null : steered, delay)
  const list = turn.steers.length === 0 ? 'none' : turn.steers.map(text => text || MOCK_EMPTY_MESSAGE).join(' | ')
  return textStep(lines(steered, `Finished ${steps} steps. Steers: ${list}`), delay)
}
