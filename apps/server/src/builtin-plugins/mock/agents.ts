// `mock:agents` (Phase 10, ADR-045, PROVIDERS.md 8 "Customization mocks (Phase 10)"): drives custom agents, skills and
// custom commands. FROZEN after Gate P10-0b (C32): the probes and the e2e specs depend on it. The shared rules of the
// agent mocks apply (./turn.ts: call ids, offered-tool lists, the Turn and steer rules, the markers, the denied and
// failed endings). No waits.
//
// 1. Child (the system text holds `SUBAGENT_INSTRUCTIONS_MARKER`): `<persona>` = the rest of the line after the first
//    `PERSONA:` of the system text, trimmed (`none` without one, or when it is empty); `<prompt>` = the text of the last
//    user message. (a) No result yet in the turn and `list_directory` offered: `list_directory` `{ path: '.' }`.
//    (b) `<prompt>` holds the word `write`, `write_file` is offered and has no result in the turn: `write_file`
//    `{ path: 'agent.txt', content: 'Written by a custom agent.\n' }`. (c) Otherwise `Report: persona=<persona> |
//    tools: <offered tools> | model=agents`.
// 2. Parent, by the trigger: the last non-empty line of the user text (the turn's user message after command
//    expansion, trimmed; for a one-line message the whole text, and for a command whose body has no placeholder the
//    appended input):
//    - `agents?` -> `Agent types: <names>` (the "Agent types" block of the system text, in listed order, `none`
//      without it); `skills?` -> `Skills: <names>` (the skills block, likewise); `tools?` -> `Tools: <offered tools>`;
//    - `agent <type>` / `agent <type> write` (the type as typed) -> after a `task` result `Agent report: <the result's
//      text for the model>`; else without `task` offered `Sub-agents are not available.`; else one `task` call
//      `{ type, description: 'Run <type>', prompt: 'Run the <type> agent.' }` (`… agent and write agent.txt.` with
//      `write`);
//    - `skill <name>` -> after a `skill` result `Skill loaded: <the first 80 characters of the content>` (the `content`
//      of a JSON output, else of the result's text for the model, which starts with the content); else without `skill`
//      offered `Skills are not available.`; else one `skill` call `{ name }`;
//    a denied or failed result of the turn ends as in the shared rules.
// 3. Any other turn: `Agents mock: <user text>` (`(empty message)` for none), so a command's expansion is visible.
//
// Instruction blocks: a block starts at a line whose text (after optional Markdown heading marks or `**`) starts with
// `Agent types` / `Skills` (case-insensitive; an `Available ` prefix is allowed); its entries are the list lines that
// follow (`- name: description`, `* name`, `1. name`, or `name: description`; blank lines before the first entry are
// skipped) up to the first other line; the name is the entry's first `[a-z][a-z0-9-]*` token (backticks and `**`
// around it allowed). The first such block with at least one entry wins.
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider'
import type { MockPlan } from './models.ts'
import type { MockTurn, TurnResult } from './turn.ts'
import { SUBAGENT_INSTRUCTIONS_MARKER } from '../../chat/markers.ts'
import { MOCK_EMPTY_MESSAGE } from './common.ts'
import { MOCK_SUBAGENTS_UNAVAILABLE } from './subagent.ts'
import { callStep, deniedOrFailedText, offeredToolNames, resultText, systemText, textStep, toolList, turnOf, userMessageText } from './turn.ts'
import { textOf } from './workspace.ts'

/** This mock's own model id (the child's report names it). */
export const MOCK_AGENTS_MODEL_ID = 'agents'
export const MOCK_AGENT_FILE = 'agent.txt'
export const MOCK_AGENT_CONTENT = 'Written by a custom agent.\n'
export const MOCK_SKILLS_UNAVAILABLE = 'Skills are not available.'
/** `Skill loaded: ` is followed by at most this many characters of the content. */
export const MOCK_SKILL_PREVIEW_CHARS = 80
/** The persona of a child whose system text has no `PERSONA:` line. */
export const MOCK_NO_PERSONA = 'none'

const PERSONA = 'PERSONA:'
const WRITE = /\bwrite\b/i
const AGENT_TYPES_HEADER = /^(?:#+\s*)?(?:\*\*)?(?:available\s+)?agent types\b/i
const SKILLS_HEADER = /^(?:#+\s*)?(?:\*\*)?(?:available\s+)?skills\b/i
const LIST_ENTRY = /^(?:[-*•]|\d+[.)])\s+(?:\*\*|`)?([a-z][\da-z-]*)/
const NAME_ENTRY = /^(?:\*\*|`)?([a-z][\da-z-]*)(?:\*\*|`)?\s*:/

/** `<persona>` of a child (see the module comment). */
export function mockPersona(system: string): string {
  const index = system.indexOf(PERSONA)
  if (index === -1)
    return MOCK_NO_PERSONA
  const rest = system.slice(index + PERSONA.length).split('\n', 1)[0]?.trim() ?? ''
  return rest === '' ? MOCK_NO_PERSONA : rest
}

function entryName(line: string): string | null {
  const trimmed = line.trim()
  return trimmed.match(LIST_ENTRY)?.[1] ?? trimmed.match(NAME_ENTRY)?.[1] ?? null
}

/** The entry names of the first block of `system` whose header matches `header` and that has an entry (see above). */
export function mockBlockNames(system: string, header: RegExp): string[] {
  const lines = system.replace(/\r\n?/g, '\n').split('\n')
  for (let index = 0; index < lines.length; index++) {
    if (!header.test(lines[index]!.trim()))
      continue
    const names: string[] = []
    let next = index + 1
    while (next < lines.length && lines[next]!.trim() === '')
      next++
    for (; next < lines.length; next++) {
      const name = entryName(lines[next]!)
      if (name === null)
        break
      names.push(name)
    }
    if (names.length > 0)
      return names
  }
  return []
}

/** The names of the "Agent types" block of the system text, in listed order. */
export function mockAgentTypeNames(system: string): string[] {
  return mockBlockNames(system, AGENT_TYPES_HEADER)
}

/** The names of the skills block of the system text, in listed order. */
export function mockSkillNames(system: string): string[] {
  return mockBlockNames(system, SKILLS_HEADER)
}

/** The trigger of the parent: the last non-empty line of the user text, its whitespace collapsed. */
export function mockAgentsTrigger(userText: string): string {
  const lines = userText.split('\n').map(line => line.trim()).filter(line => line !== '')
  return (lines.at(-1) ?? '').split(/\s+/).join(' ')
}

/** The `task` input of `agent <type> [write]`. */
export function mockAgentTaskInput(type: string, write: boolean): { type: string, description: string, prompt: string } {
  return { type, description: `Run ${type}`, prompt: write ? `Run the ${type} agent and write ${MOCK_AGENT_FILE}.` : `Run the ${type} agent.` }
}

/** The content a `skill` result gives the model: `content` of a JSON output, else the text for the model. */
export function mockSkillContent(result: TurnResult): string {
  const { output } = result
  if (output.type === 'json') {
    const content = (output.value as { content?: unknown } | null)?.content
    if (typeof content === 'string')
      return content
  }
  return textOf(output)
}

/** `Skill loaded: <the first 80 characters of the content>` (code points; trailing whitespace dropped). */
export function mockSkillLoadedText(content: string): string {
  return `Skill loaded: ${Array.from(content).slice(0, MOCK_SKILL_PREVIEW_CHARS).join('').trimEnd()}`
}

function childPlan(options: LanguageModelV4CallOptions): MockPlan {
  const { prompt } = options
  const offered = offeredToolNames(options)
  const turn = turnOf(prompt)
  const ended = deniedOrFailedText(turn)
  if (ended !== null)
    return textStep(ended)
  const task = userMessageText(prompt.findLast(message => message.role === 'user'))
  if (turn.results.length === 0 && offered.includes('list_directory'))
    return callStep(prompt, [{ toolName: 'list_directory', input: { path: '.' } }])
  if (WRITE.test(task) && offered.includes('write_file') && !turn.results.some(result => result.toolName === 'write_file'))
    return callStep(prompt, [{ toolName: 'write_file', input: { path: MOCK_AGENT_FILE, content: MOCK_AGENT_CONTENT } }])
  return textStep(`Report: persona=${mockPersona(systemText(prompt))} | tools: ${toolList(offered)} | model=${MOCK_AGENTS_MODEL_ID}`)
}

/** One tool of the parent: answer its result, else call it when offered, else `unavailable`. */
function toolTurn(prompt: LanguageModelV4Prompt, turn: MockTurn, offered: readonly string[], toolName: string, input: unknown, unavailable: string, answer: (result: TurnResult) => string): MockPlan {
  const result = turn.results.find(entry => entry.toolName === toolName)
  if (result !== undefined) {
    const ended = deniedOrFailedText(turn)
    return textStep(ended ?? answer(result))
  }
  if (!offered.includes(toolName))
    return textStep(unavailable)
  return callStep(prompt, [{ toolName, input }])
}

function parentPlan(options: LanguageModelV4CallOptions): MockPlan {
  const { prompt } = options
  const offered = offeredToolNames(options)
  const turn = turnOf(prompt)
  const trigger = mockAgentsTrigger(turn.userText)
  if (trigger === 'agents?')
    return textStep(`Agent types: ${toolList(mockAgentTypeNames(systemText(prompt)))}`)
  if (trigger === 'skills?')
    return textStep(`Skills: ${toolList(mockSkillNames(systemText(prompt)))}`)
  if (trigger === 'tools?')
    return textStep(`Tools: ${toolList(offered)}`)
  const agent = trigger.match(/^agent (\S+)( write)?$/)
  if (agent !== null) {
    const input = mockAgentTaskInput(agent[1]!, agent[2] !== undefined)
    return toolTurn(prompt, turn, offered, 'task', input, MOCK_SUBAGENTS_UNAVAILABLE, result => `Agent report: ${resultText(result.output)}`)
  }
  const skill = trigger.match(/^skill (\S+)$/)
  if (skill !== null)
    return toolTurn(prompt, turn, offered, 'skill', { name: skill[1]! }, MOCK_SKILLS_UNAVAILABLE, result => mockSkillLoadedText(mockSkillContent(result)))
  return textStep(`Agents mock: ${turn.userText || MOCK_EMPTY_MESSAGE}`)
}

/** The answer of `mock:agents` to a call (see the module comment). */
export function mockAgentsPlan(options: LanguageModelV4CallOptions): MockPlan {
  if (systemText(options.prompt).includes(SUBAGENT_INSTRUCTIONS_MARKER))
    return childPlan(options)
  return parentPlan(options)
}
