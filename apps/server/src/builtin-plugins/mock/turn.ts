// Shared rules of the Phase 9 agent mocks (`mock:compact`, `mock:plan`, `mock:todo`, `mock:subagent`, `mock:steer`;
// PROVIDERS.md 8 "Agent mocks (Phase 9)"). FROZEN after Gate P9-0b (C27): the probes and the e2e specs depend on them.
//
// - Tool call ids: `mock_call_<n>` (n = the assistant messages of the prompt + 1); a step with two or more calls (run
//   in parallel by the SDK) uses `mock_call_<n>_<i>` (i from 1).
// - Offered tools: the function tools of the call (`options.tools`; the SDK passes only the active ones). A list of them
//   is the names sorted by code point and joined with ", ", or `none`.
// - Turn: the messages after the last user message that is not a steer. A steer is a user message right after a tool
//   message (a message the user queued during a run, delivered at a step boundary; ARCHITECTURE.md 6.20), and so is a
//   user message that follows a steer (two steers delivered at one boundary). Results count only the tool results of
//   the turn.
// - Markers: summarizer and sub-agent calls are recognized by their system text (the run's instructions) holding
//   `COMPACT_INSTRUCTIONS_MARKER` / `SUBAGENT_INSTRUCTIONS_MARKER` (`chat/markers.ts`).
// - A denied result of the turn ends with `The tool call was denied.`; an error result as the last result with `The
//   tool call failed: <error text>` (the models name their exceptions). Denials reach a model as `execution-denied`
//   results (the SDK drops approval responses of local tools from the prompt).
import type { LanguageModelV4CallOptions, LanguageModelV4Message, LanguageModelV4Prompt, LanguageModelV4ToolResultOutput } from '@ai-sdk/provider'
import type { MockPlan, MockToolCall } from './models.ts'
import { MOCK_TOOL_DENIED } from './common.ts'
import { MOCK_WORKSPACE_FAILED_PREFIX, textOf } from './workspace.ts'

/** A tool result of the current turn. */
export interface TurnResult {
  toolCallId: string
  toolName: string
  output: LanguageModelV4ToolResultOutput
}

/** The current turn of a prompt (see the module comment). */
export interface MockTurn {
  /** Index of the user message that opened the turn (-1 when the prompt has none). */
  start: number
  /** The text of that user message (text parts joined with a space, trimmed). */
  userText: string
  /** Every tool result of the turn, in prompt order (denied and failed ones included). */
  results: TurnResult[]
  /** The tool calls of the turn's assistant messages, in prompt order. */
  calls: Array<{ toolCallId: string, toolName: string }>
  /** The texts of the turn's steers, in order. */
  steers: string[]
  /** The texts of the steers that end the prompt (user messages after the turn's last tool message). */
  trailingSteers: string[]
}

/** The text parts of a user message, joined with a space and trimmed. */
export function userMessageText(message: LanguageModelV4Message | undefined): string {
  if (message?.role !== 'user')
    return ''
  return message.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join(' ').trim()
}

/** A user message right after a tool message, or after such a user message. */
export function isSteer(prompt: LanguageModelV4Prompt, index: number): boolean {
  if (prompt[index]?.role !== 'user')
    return false
  for (let previous = index - 1; previous >= 0; previous--) {
    const role = prompt[previous]?.role
    if (role === 'tool')
      return true
    if (role !== 'user')
      return false
  }
  return false
}

/** The current turn of `prompt`. */
export function turnOf(prompt: LanguageModelV4Prompt): MockTurn {
  let start = -1
  for (let index = prompt.length - 1; index >= 0; index--) {
    if (prompt[index]?.role === 'user' && !isSteer(prompt, index)) {
      start = index
      break
    }
  }
  const turn: MockTurn = { start, userText: userMessageText(prompt[start]), results: [], calls: [], steers: [], trailingSteers: [] }
  for (let index = start + 1; index < prompt.length; index++) {
    const message = prompt[index]!
    if (message.role === 'user') {
      turn.steers.push(userMessageText(message))
      continue
    }
    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type === 'tool-call')
          turn.calls.push({ toolCallId: part.toolCallId, toolName: part.toolName })
      }
      continue
    }
    if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type === 'tool-result')
          turn.results.push({ toolCallId: part.toolCallId, toolName: part.toolName, output: part.output })
      }
    }
  }
  let end = prompt.length
  while (end > start + 1 && prompt[end - 1]?.role === 'user')
    end--
  if (end < prompt.length && prompt[end - 1]?.role === 'tool')
    turn.trailingSteers = prompt.slice(end).map(message => userMessageText(message))
  return turn
}

/** The system text of the call (every system message, joined with a line break). */
export function systemText(prompt: LanguageModelV4Prompt): string {
  return prompt.flatMap(message => (message.role === 'system' ? [message.content] : [])).join('\n')
}

/** The names of the offered function tools, sorted by code point. */
export function offeredToolNames(options: LanguageModelV4CallOptions): string[] {
  const names = (options.tools ?? []).flatMap(tool => (tool.type === 'function' ? [tool.name] : []))
  return [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** A list of tool names for a mock text: joined with ", ", or `none`. */
export function toolList(names: readonly string[]): string {
  return names.length === 0 ? 'none' : names.join(', ')
}

/** Whether a result is an error (`error-text` / `error-json`). */
export function isErrorResult(result: TurnResult | undefined): boolean {
  return result !== undefined && (result.output.type === 'error-text' || result.output.type === 'error-json')
}

/** Whether a result is a denial (`execution-denied`). */
export function isDeniedResult(result: TurnResult | undefined): boolean {
  return result?.output.type === 'execution-denied'
}

/**
 * The shared end of a turn: `The tool call was denied.` when a result is denied (`skip` excludes results a model
 * handles itself), else `The tool call failed: <error text>` when the last result is an error (unless `skip` excludes
 * it); null otherwise.
 */
export function deniedOrFailedText(turn: MockTurn, skip: (result: TurnResult) => boolean = () => false): string | null {
  if (turn.results.some(result => isDeniedResult(result) && !skip(result)))
    return MOCK_TOOL_DENIED
  const last = turn.results.at(-1)
  if (last !== undefined && isErrorResult(last) && !skip(last))
    return `${MOCK_WORKSPACE_FAILED_PREFIX} ${textOf(last.output)}`.trimEnd()
  return null
}

/** The text a model reads for a tool result (JSON outputs serialized; `denied` for a denial). */
export function resultText(output: LanguageModelV4ToolResultOutput): string {
  return output.type === 'execution-denied' ? 'denied' : textOf(output)
}

/** A text-only step. */
export function textStep(text: string, stepDelayMs?: number): MockPlan {
  return { reasoning: null, text, toolCall: null, finishReason: 'stop', ...(stepDelayMs === undefined ? {} : { stepDelayMs }) }
}

/** One planned tool call of a step. */
export interface PlannedCall {
  toolName: string
  input: unknown
}

/**
 * A step that calls `calls` (optionally after `text`): one call gets the id `mock_call_<n>`, several calls (parallel)
 * get `mock_call_<n>_<i>`; `finishReason: 'tool-calls'`.
 */
export function callStep(prompt: LanguageModelV4Prompt, calls: readonly PlannedCall[], text: string | null = null, stepDelayMs?: number): MockPlan {
  const n = prompt.filter(message => message.role === 'assistant').length + 1
  const toolCalls: MockToolCall[] = calls.map((call, index) => ({
    toolCallId: calls.length === 1 ? `mock_call_${n}` : `mock_call_${n}_${index + 1}`,
    toolName: call.toolName,
    input: JSON.stringify(call.input),
  }))
  const delay = stepDelayMs === undefined ? {} : { stepDelayMs }
  if (toolCalls.length === 1)
    return { reasoning: null, text, toolCall: toolCalls[0]!, finishReason: 'tool-calls', ...delay }
  return { reasoning: null, text, toolCall: null, toolCalls, finishReason: 'tool-calls', ...delay }
}

/** `text` lines joined with a line break (empty lines dropped). */
export function lines(...texts: Array<string | null | undefined>): string {
  return texts.filter((text): text is string => typeof text === 'string' && text !== '').join('\n')
}
