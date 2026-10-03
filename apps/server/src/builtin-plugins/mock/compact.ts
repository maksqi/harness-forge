// `mock:compact` (Phase 9, ADR-040, PROVIDERS.md 8 "Agent mocks (Phase 9)"): drives context compaction. Its listing has
// `contextWindow` 2000, so a few turns pass 80 % of it. FROZEN after Gate P9-0b (C27). Checked in this order:
//
// 1. Summarizer (the system text holds `COMPACT_INSTRUCTIONS_MARKER`): one line `MOCK-SUMMARY: <first words> |
//    steps-done=<K> | focus=<focus> | sentinels=<S>`: the first 8 words of the call's user text (the rendered
//    transcript); K = the `Step <k> done.` texts of the transcript plus the `steps-done=` value of the latest
//    `MOCK-SUMMARY:` line in it (0 without); the focus = the text after `Focus: ` on its own line of the system text
//    (`none`); S = the distinct sentinels (`OLD-<letters or digits>`) of the transcript in first-seen order, `,`-joined
//    (`none`). The transcript is the text parts of the call's user and assistant messages. `Step <k> done.` texts inside
//    a `MOCK-SUMMARY:` line (an older summary's first words) are not counted again.
// 2. Reporter (the last text part of the last user message, trimmed, is `seen?`): `summary:<yes|no> seen:<S>`; `yes`
//    when a `MOCK-SUMMARY:` line is anywhere in the prompt's text; S = the distinct sentinels of the prompt's text
//    outside `MOCK-SUMMARY:` lines (a summary's own `sentinels=` never counts).
// 3. Loop (`loop <N>` in the user messages of the prompt, merged summaries included: the first match of
//    `\bloop (\d+)\b`, N 1-50): done = the `steps-done=` value of the latest `MOCK-SUMMARY:` line plus the `Step <k>
//    done.` texts after it; while done < N one step `Step <done+1> done.` + 120 filler words with a `todo_write` call;
//    then `Loop finished after <N> steps.` (`todo_write` not offered: `Tools are disabled.`; a denied or failed call of
//    the turn ends it, the shared rules of ./turn.ts).
// 4. Otherwise: the last text part of the last user message followed by 150 filler words.
//
// "The prompt's text" is the text parts of the user and assistant messages (each part read line by line, so a merged
// summary part never swallows the user's own text).
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider'
import type { MockPlan } from './models.ts'
import { COMPACT_INSTRUCTIONS_MARKER } from '../../chat/markers.ts'
import { MOCK_EMPTY_MESSAGE, MOCK_TOOLS_DISABLED } from './common.ts'
import { callStep, deniedOrFailedText, offeredToolNames, systemText, textStep, turnOf } from './turn.ts'

/** The context window of `mock:compact` (its listing). */
export const MOCK_COMPACT_CONTEXT_WINDOW = 2000
/** Starts the summarizer's answer (and marks a summary line everywhere else). */
export const MOCK_SUMMARY_PREFIX = 'MOCK-SUMMARY:'
/** The reporter's trigger (the last text part of the last user message, trimmed). */
export const MOCK_SEEN_QUESTION = 'seen?'
export const MOCK_FILLER_WORD = 'filler'
/** Filler words after an echo (so every turn grows the context by about 160 words). */
export const MOCK_COMPACT_ECHO_FILLER = 150
/** Filler words after each `Step <k> done.` of a loop. */
export const MOCK_COMPACT_STEP_FILLER = 120
/** The largest N of `loop <N>`. */
export const MOCK_LOOP_MAX = 50
/** The todo id of a loop's `todo_write` calls. */
export const MOCK_LOOP_TODO_ID = 'loop'

const SENTINEL = /OLD-[A-Za-z0-9]+/g
const STEP_DONE = /\bStep \d+ done\./g
const STEPS_DONE_FIELD = /\bsteps-done=(\d+)/
const LOOP = /\bloop (\d+)\b/
const FOCUS_LINE = /^Focus: (.*)$/m

/** `count` filler words. */
export function mockFiller(count: number): string {
  return Array.from({ length: count }).fill(MOCK_FILLER_WORD).join(' ')
}

/** The text parts of the user and assistant messages, in prompt order. */
function conversationTexts(prompt: LanguageModelV4Prompt, roles: ReadonlySet<string> = new Set(['user', 'assistant'])): string[] {
  const texts: string[] = []
  for (const message of prompt) {
    if (message.role !== 'user' && message.role !== 'assistant')
      continue
    if (!roles.has(message.role))
      continue
    for (const part of message.content) {
      if (part.type === 'text')
        texts.push(part.text)
    }
  }
  return texts
}

/** Every line of `texts`, in order. */
function linesOf(texts: readonly string[]): string[] {
  return texts.flatMap(text => text.replace(/\r\n/g, '\n').split('\n'))
}

function isSummaryLine(line: string): boolean {
  return line.includes(MOCK_SUMMARY_PREFIX)
}

/** The `steps-done=` value of a summary line (0 without one). */
function stepsDoneOf(line: string): number {
  const match = line.slice(line.indexOf(MOCK_SUMMARY_PREFIX)).match(STEPS_DONE_FIELD)
  return match === null ? 0 : Number(match[1])
}

function countSteps(line: string): number {
  return line.match(STEP_DONE)?.length ?? 0
}

/** The distinct sentinels of `lines`, in first-seen order, `,`-joined (`none`). */
export function sentinelList(lines: readonly string[]): string {
  const seen = new Set<string>()
  for (const line of lines) {
    for (const token of line.match(SENTINEL) ?? [])
      seen.add(token)
  }
  return seen.size === 0 ? 'none' : [...seen].join(',')
}

/** The text parts of the last user message. */
function lastUserTextParts(prompt: LanguageModelV4Prompt): string[] {
  const message = prompt.findLast(entry => entry.role === 'user')
  return message?.role === 'user' ? message.content.flatMap(part => (part.type === 'text' ? [part.text] : [])) : []
}

/** K of the summarizer: the `Step <k> done.` texts outside summary lines plus the latest summary's `steps-done=`. */
export function summarizedSteps(lines: readonly string[]): number {
  let steps = 0
  let summarized = 0
  for (const line of lines) {
    if (isSummaryLine(line))
      summarized = stepsDoneOf(line)
    else
      steps += countSteps(line)
  }
  return steps + summarized
}

/** `done` of a loop: the latest summary's `steps-done=` plus the `Step <k> done.` texts after it. */
export function loopStepsDone(lines: readonly string[]): number {
  let done = 0
  for (const line of lines)
    done = isSummaryLine(line) ? stepsDoneOf(line) : done + countSteps(line)
  return done
}

/** The N of the first `loop <N>` in the user messages (N 1-50), or null. */
export function loopTarget(prompt: LanguageModelV4Prompt): number | null {
  for (const text of conversationTexts(prompt, new Set(['user']))) {
    const match = text.match(LOOP)
    if (match !== null) {
      const target = Number(match[1])
      return target >= 1 && target <= MOCK_LOOP_MAX ? target : null
    }
  }
  return null
}

/** The summarizer's answer (step 1). */
export function mockSummaryText(prompt: LanguageModelV4Prompt): string {
  const lastUser = lastUserTextParts(prompt).join(' ')
  const firstWords = lastUser.split(/\s+/).filter(word => word !== '').slice(0, 8).join(' ') || MOCK_EMPTY_MESSAGE
  const transcript = linesOf(conversationTexts(prompt))
  const focus = systemText(prompt).match(FOCUS_LINE)?.[1]?.trim() || 'none'
  return `${MOCK_SUMMARY_PREFIX} ${firstWords} | steps-done=${summarizedSteps(transcript)} | focus=${focus} | sentinels=${sentinelList(transcript)}`
}

/** The reporter's answer (step 2). */
export function mockSeenText(prompt: LanguageModelV4Prompt): string {
  const all = linesOf(conversationTexts(prompt))
  const summary = all.some(isSummaryLine) ? 'yes' : 'no'
  return `summary:${summary} seen:${sentinelList(all.filter(line => !isSummaryLine(line)))}`
}

/** The answer of `mock:compact` to a call (see the module comment). */
export function mockCompactPlan(options: LanguageModelV4CallOptions): MockPlan {
  const { prompt } = options
  if (systemText(prompt).includes(COMPACT_INSTRUCTIONS_MARKER))
    return textStep(mockSummaryText(prompt))
  const lastPart = (lastUserTextParts(prompt).at(-1) ?? '').trim()
  if (lastPart === MOCK_SEEN_QUESTION)
    return textStep(mockSeenText(prompt))
  const target = loopTarget(prompt)
  if (target !== null) {
    if (!offeredToolNames(options).includes('todo_write'))
      return textStep(MOCK_TOOLS_DISABLED)
    const ended = deniedOrFailedText(turnOf(prompt))
    if (ended !== null)
      return textStep(ended)
    const done = loopStepsDone(linesOf(conversationTexts(prompt)))
    if (done >= target)
      return textStep(`Loop finished after ${target} steps.`)
    const step = done + 1
    const todos = [{ id: MOCK_LOOP_TODO_ID, content: `Run ${target} steps`, status: 'in_progress', activeForm: `Running step ${step} of ${target}` }]
    return callStep(prompt, [{ toolName: 'todo_write', input: { todos } }], `Step ${step} done. ${mockFiller(MOCK_COMPACT_STEP_FILLER)}`)
  }
  return textStep(`${lastPart || MOCK_EMPTY_MESSAGE} ${mockFiller(MOCK_COMPACT_ECHO_FILLER)}`)
}
