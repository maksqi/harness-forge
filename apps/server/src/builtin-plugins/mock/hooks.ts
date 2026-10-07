// `mock:hooks` (Phase 11, ADR-048 … ADR-052, PROVIDERS.md 8 "Hook mocks (Phase 11)"): drives the hooks, the project MCP
// servers, the output styles and the command extras. FROZEN after Gate P11-0b (C38): the gate probes and the e2e specs
// depend on it. The shared rules of the agent mocks apply (./turn.ts: call ids, offered-tool lists, the steer rule, the
// sub-agent marker, the denied and failed endings, `Tools are disabled.` / `Sub-agents are not available.`). No waits.
//
// Definitions:
// - Hook blocks: the model text of `data-hook` parts (`hookModelText` of `packages/shared/src/util/agent-state.ts`):
//   `<hook-context event="<Event>" …>…</hook-context>` and `<hook-feedback event="<Event>" …>…</hook-feedback>`, searched
//   in the text parts of the user and assistant messages (never the system text). A block's first line is the first
//   non-empty line between its tags, trimmed; its item is `<Event>:<first line>`.
// - The user text: the text parts of the turn's user message with every hook block removed, joined with a space,
//   trimmed (the text after command expansion); `(empty message)` when empty. The trigger is its last non-empty line,
//   trimmed.
// - The turn: from the last user message that is not made of hook blocks only (hook context injected at a step boundary
//   never opens a turn). Phase 12 (Gate P12-B, W12.20): a user message right after a tool message opens the turn too — a
//   turn ended by a hook (`continue: false`) or a superseded approval leaves the history ending in a tool result, so the
//   next request follows a tool message; steers are still recognized by `lastFeedback` (rules 1a / 2).
//
// Checked in this order:
// 1. Child (the system text holds `SUBAGENT_INSTRUCTIONS_MARKER`): (a) the last user message of the prompt holds
//    `<hook-feedback` (a SubagentStop round) -> `Child continued: <first line of its first hook-feedback block>`;
//    (b) the trigger of the child's user text is a `call …` / `run …` line and the turn has no result of that tool ->
//    that one call (`Tools are disabled.` when the tool is not offered); (c) otherwise `Child done` (also after (b)).
// 2. Hook continuation: the last user message of the prompt holds `<hook-feedback` (the carrier of a turn with
//    `origin: 'hook'`) -> `Hook continuation: <first line of its first hook-feedback block>`.
// 3. Triggers:
//    - `call <tool> <json>`: without `<tool>` offered `Tools are disabled.`; without a result of `<tool>` in the turn one
//      call with the parsed input (`{}` for a missing, invalid or non-object value); after the result `Called <tool>:
//      <ok|denied|failed> | <detail> | hooks: <hooks>` (`<detail>` = the denial reason or `none`, the error text, or the
//      result's text for the model, whitespace runs collapsed, trimmed, cut to 120 code points; `<hooks>` = the first
//      lines of the hook blocks of the messages after the result, joined with "; ", or `none`);
//    - `run <cmd>`: the same with `shell` `{ command: <cmd> }`;
//    - `agent <prompt>`: without `task` offered `Sub-agents are not available.`; without a `task` result one call
//      `task` `{ type: 'general', description: 'Hook child', prompt }`; after it `Agent report: <the result's text>`
//      (a denied or failed result ends as in the shared rules);
//    - `context?` -> `Context: <the items of every hook block of the prompt, "; "-joined, or none>`;
//    - `style?` -> `Style: <label after "Output style: " on the system text's first line, or none> | workspace-rules:
//      <yes|no> | todo-hint: <yes|no>`;
//    - `mcp?` -> `MCP tools: <offered mcp__ tools>`; `tools?` -> `Tools: <offered tools>`.
// 4. Anything else: `Hooks mock: <user text>`.
//
// Reading of the contract (reported by C38): rules 1a and 2 apply only when that last user message is not a steer.
// PostToolUse context or feedback delivered at a step boundary is a hook-only user message right after a tool message:
// it belongs to `<hooks>` of rule 3, while a Stop carrier and a SubagentStop round follow an assistant message.
import type { LanguageModelV4CallOptions, LanguageModelV4Message, LanguageModelV4Prompt, LanguageModelV4ToolResultOutput } from '@ai-sdk/provider'
import type { MockPlan } from './models.ts'
import type { MockTurn, TurnResult } from './turn.ts'
import { OUTPUT_STYLE_HEADER } from '@harness-forge/shared'
import { SUBAGENT_INSTRUCTIONS_MARKER } from '../../chat/markers.ts'
import { MOCK_EMPTY_MESSAGE, MOCK_TOOLS_DISABLED } from './common.ts'
import { MOCK_SUBAGENTS_UNAVAILABLE } from './subagent.ts'
import { callStep, deniedOrFailedText, isSteer, offeredToolNames, resultText, systemText, textStep, toolList } from './turn.ts'
import { textOf } from './workspace.ts'

/** This mock's model id (`mock:hooks`). */
export const MOCK_HOOKS_MODEL_ID = 'hooks'
/** The fallback answer: followed by the user text. */
export const MOCK_HOOKS_PREFIX = 'Hooks mock:'
/** The report of a child. */
export const MOCK_HOOKS_CHILD_DONE = 'Child done'
/** The answer of a child in a SubagentStop round: followed by the feedback's first line. */
export const MOCK_HOOKS_CHILD_CONTINUED_PREFIX = 'Child continued:'
/** The answer of a Stop-hook turn: followed by the feedback's first line. */
export const MOCK_HOOKS_CONTINUATION_PREFIX = 'Hook continuation:'
/** The `description` of the `task` call of `agent <prompt>`. */
export const MOCK_HOOKS_TASK_DESCRIPTION = 'Hook child'
/** `<detail>` of `Called …` keeps at most this many code points. */
export const MOCK_HOOKS_DETAIL_MAX_CHARS = 120
/** `style?`: the start of the first line of the style block (`OUTPUT_STYLE_HEADER`). */
export const MOCK_HOOKS_STYLE_HEADER = OUTPUT_STYLE_HEADER
/** `style?`: the first rule line of the workspace block (`workspaceBlock` of `chat/params.ts`). */
export const MOCK_HOOKS_WORKSPACE_RULE = '- Use paths relative to the project folder.'
/** `style?`: the start of the server's `TODO_HINT`. */
export const MOCK_HOOKS_TODO_HINT = 'Track multi-step work with todo_write'

const HOOK_BLOCK = /<(hook-context|hook-feedback)\b([^>]*)>([\s\S]*?)<\/\1>/g
const EVENT_ATTRIBUTE = /\bevent="([^"]*)"/
/** `call <tool>`: the tool word (the rest of the line follows the match). */
const CALL = /^call\s+(\S+)/
/** `run <cmd>` / `agent <prompt>`: the keyword, blanks and a first non-blank character. */
const RUN = /^run\s+\S/
const AGENT = /^agent\s+\S/

/** One hook block of the model's view. */
export interface MockHookBlock {
  readonly tag: 'hook-context' | 'hook-feedback'
  readonly event: string
  /** The first non-empty line between the tags, trimmed ('' when there is none). */
  readonly firstLine: string
}

/** The hook blocks of one text, in order. */
export function mockHookBlocksOf(text: string): MockHookBlock[] {
  const blocks: MockHookBlock[] = []
  for (const match of text.matchAll(HOOK_BLOCK)) {
    const event = match[2]?.match(EVENT_ATTRIBUTE)?.[1] ?? ''
    const firstLine = (match[3] ?? '').split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
    blocks.push({ tag: match[1] as MockHookBlock['tag'], event, firstLine })
  }
  return blocks
}

/** The text parts of a user or assistant message (other roles have none). */
function textParts(message: LanguageModelV4Message | undefined): string[] {
  if (message?.role !== 'user' && message?.role !== 'assistant')
    return []
  return message.content.flatMap(part => (part.type === 'text' ? [part.text] : []))
}

/** The hook blocks of the text parts of `messages` (user and assistant messages only), in order. */
export function mockHookBlocks(messages: readonly LanguageModelV4Message[]): MockHookBlock[] {
  return messages.flatMap(message => textParts(message).flatMap(mockHookBlocksOf))
}

/** The text of a user message without its hook blocks (parts joined with a space, trimmed). */
export function mockHooksUserText(message: LanguageModelV4Message | undefined): string {
  if (message?.role !== 'user')
    return ''
  return textParts(message).map(text => text.replace(HOOK_BLOCK, '').trim()).filter(text => text !== '').join(' ').trim()
}

/** A user message whose text is made of hook blocks only (it never opens a turn). */
function hookOnly(message: LanguageModelV4Message | undefined): boolean {
  return message?.role === 'user' && mockHookBlocks([message]).length > 0 && mockHooksUserText(message) === ''
}

/** The trigger: the last non-empty line of the user text, trimmed. */
export function mockHooksTrigger(userText: string): string {
  return userText.split('\n').map(line => line.trim()).filter(line => line !== '').at(-1) ?? ''
}

/** The turn of `mock:hooks` and the extras its rules need. */
interface HooksTurn extends MockTurn {
  /** Index in the prompt of the tool message that holds each result (same order as `results`). */
  resultMessages: number[]
  /** The reasons of denied approval responses of the turn (`null` for one without a reason). */
  deniedApprovals: Array<string | null>
}

/** The turn (see the module comment): its user message, results and denied approval responses. */
export function mockHooksTurn(prompt: LanguageModelV4Prompt): HooksTurn {
  let start = -1
  for (let index = prompt.length - 1; index >= 0; index--) {
    if (prompt[index]?.role === 'user' && !hookOnly(prompt[index])) {
      start = index
      break
    }
  }
  const turn: HooksTurn = { start, userText: mockHooksUserText(prompt[start]), results: [], calls: [], steers: [], trailingSteers: [], resultMessages: [], deniedApprovals: [] }
  for (let index = start + 1; index < prompt.length; index++) {
    const message = prompt[index]!
    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type === 'tool-call')
          turn.calls.push({ toolCallId: part.toolCallId, toolName: part.toolName })
      }
    }
    if (message.role !== 'tool')
      continue
    for (const part of message.content) {
      if (part.type === 'tool-result') {
        turn.results.push({ toolCallId: part.toolCallId, toolName: part.toolName, output: part.output })
        turn.resultMessages.push(index)
      }
      else if (part.type === 'tool-approval-response' && !part.approved) {
        turn.deniedApprovals.push(part.reason ?? null)
      }
    }
  }
  return turn
}

/** The first line of the first hook-feedback block of the prompt's last user message when it is not a steer, else null. */
function lastFeedback(prompt: LanguageModelV4Prompt): string | null {
  const index = prompt.findLastIndex(message => message.role === 'user')
  if (index < 0 || isSteer(prompt, index))
    return null
  const feedback = mockHookBlocks([prompt[index]!]).find(block => block.tag === 'hook-feedback')
  return feedback === undefined ? null : feedback.firstLine
}

/** `<detail>` of `Called …`: whitespace runs collapsed, trimmed, cut to `MOCK_HOOKS_DETAIL_MAX_CHARS` code points. */
export function mockHooksDetail(text: string): string {
  return Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, MOCK_HOOKS_DETAIL_MAX_CHARS).join('')
}

/** The status and the raw detail of a tool result. */
function resultStatus(output: LanguageModelV4ToolResultOutput): { status: 'ok' | 'denied' | 'failed', detail: string } {
  if (output.type === 'execution-denied')
    return { status: 'denied', detail: output.reason ?? 'none' }
  if (output.type === 'error-text' || output.type === 'error-json')
    return { status: 'failed', detail: textOf(output) }
  return { status: 'ok', detail: textOf(output) }
}

/** The input of `call <tool> <json>`: the parsed JSON when it is an object, else `{}`. */
export function mockHooksCallInput(json: string | undefined): Record<string, unknown> {
  if (json === undefined || json.trim() === '')
    return {}
  try {
    const value: unknown = JSON.parse(json)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

/** The tool call a `call …` / `run …` trigger asks for, or null for another trigger. */
export function mockHooksCall(trigger: string): { toolName: string, input: Record<string, unknown> } | null {
  const call = trigger.match(CALL)
  if (call !== null)
    return { toolName: call[1]!, input: mockHooksCallInput(trigger.slice(call[0].length)) }
  if (RUN.test(trigger))
    return { toolName: 'shell', input: { command: trigger.slice('run'.length).trim() } }
  return null
}

/** `call` / `run` (rule 3): the call, or after its result `Called <tool>: <status> | <detail> | hooks: <hooks>`. */
function callTurn(options: LanguageModelV4CallOptions, turn: HooksTurn, toolName: string, input: Record<string, unknown>): MockPlan {
  const { prompt } = options
  if (!offeredToolNames(options).includes(toolName))
    return textStep(MOCK_TOOLS_DISABLED)
  const index = turn.results.findIndex(result => result.toolName === toolName)
  if (index < 0) {
    // A denial that reached the prompt only as an approval response (no result part).
    if (turn.deniedApprovals.length > 0 && turn.calls.some(call => call.toolName === toolName))
      return textStep(`Called ${toolName}: denied | ${mockHooksDetail(turn.deniedApprovals[0] ?? 'none')} | hooks: none`)
    return callStep(prompt, [{ toolName, input }])
  }
  const { status, detail } = resultStatus(turn.results[index]!.output)
  const after = mockHookBlocks(prompt.slice(turn.resultMessages[index]! + 1)).map(block => block.firstLine)
  return textStep(`Called ${toolName}: ${status} | ${mockHooksDetail(detail)} | hooks: ${after.length === 0 ? 'none' : after.join('; ')}`)
}

/** `agent <prompt>` (rule 3). */
function agentTurn(options: LanguageModelV4CallOptions, turn: HooksTurn, task: string): MockPlan {
  if (!offeredToolNames(options).includes('task'))
    return textStep(MOCK_SUBAGENTS_UNAVAILABLE)
  const result: TurnResult | undefined = turn.results.find(entry => entry.toolName === 'task')
  if (result === undefined)
    return callStep(options.prompt, [{ toolName: 'task', input: mockHooksTaskInput(task) }])
  return textStep(deniedOrFailedText(turn) ?? `Agent report: ${resultText(result.output)}`)
}

/** The `task` input of `agent <prompt>`. */
export function mockHooksTaskInput(prompt: string): { type: 'general', description: string, prompt: string } {
  return { type: 'general', description: MOCK_HOOKS_TASK_DESCRIPTION, prompt }
}

/** `style?` (rule 3). */
export function mockHooksStyleText(system: string): string {
  const lines = system.split('\n')
  const first = lines[0] ?? ''
  const name = first.startsWith(MOCK_HOOKS_STYLE_HEADER) ? first.slice(MOCK_HOOKS_STYLE_HEADER.length).trim() : 'none'
  const rules = lines.some(line => line.trim() === MOCK_HOOKS_WORKSPACE_RULE) ? 'yes' : 'no'
  const todo = system.includes(MOCK_HOOKS_TODO_HINT) ? 'yes' : 'no'
  return `Style: ${name} | workspace-rules: ${rules} | todo-hint: ${todo}`
}

function childPlan(options: LanguageModelV4CallOptions): MockPlan {
  const feedback = lastFeedback(options.prompt)
  if (feedback !== null)
    return textStep(`${MOCK_HOOKS_CHILD_CONTINUED_PREFIX} ${feedback}`)
  const turn = mockHooksTurn(options.prompt)
  const call = mockHooksCall(mockHooksTrigger(turn.userText))
  if (call !== null && !turn.results.some(result => result.toolName === call.toolName)) {
    if (!offeredToolNames(options).includes(call.toolName))
      return textStep(MOCK_TOOLS_DISABLED)
    return callStep(options.prompt, [call])
  }
  return textStep(MOCK_HOOKS_CHILD_DONE)
}

function parentPlan(options: LanguageModelV4CallOptions): MockPlan {
  const { prompt } = options
  const feedback = lastFeedback(prompt)
  if (feedback !== null)
    return textStep(`${MOCK_HOOKS_CONTINUATION_PREFIX} ${feedback}`)
  const turn = mockHooksTurn(prompt)
  const trigger = mockHooksTrigger(turn.userText)
  const call = mockHooksCall(trigger)
  if (call !== null)
    return callTurn(options, turn, call.toolName, call.input)
  if (AGENT.test(trigger))
    return agentTurn(options, turn, trigger.slice('agent'.length).trim())
  switch (trigger) {
    case 'context?': {
      const items = mockHookBlocks(prompt).map(block => `${block.event}:${block.firstLine}`)
      return textStep(`Context: ${items.length === 0 ? 'none' : items.join('; ')}`)
    }
    case 'style?':
      return textStep(mockHooksStyleText(systemText(prompt)))
    case 'mcp?':
      return textStep(`MCP tools: ${toolList(offeredToolNames(options).filter(name => name.startsWith('mcp__')))}`)
    case 'tools?':
      return textStep(`Tools: ${toolList(offeredToolNames(options))}`)
    default:
      return textStep(`${MOCK_HOOKS_PREFIX} ${turn.userText || MOCK_EMPTY_MESSAGE}`)
  }
}

/** The answer of `mock:hooks` to a call (see the module comment). */
export function mockHooksPlan(options: LanguageModelV4CallOptions): MockPlan {
  if (systemText(options.prompt).includes(SUBAGENT_INSTRUCTIONS_MARKER))
    return childPlan(options)
  return parentPlan(options)
}
