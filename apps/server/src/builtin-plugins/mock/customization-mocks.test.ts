// The Phase 10 customization mocks (PROVIDERS.md 8 "Customization mocks (Phase 10)"): a plan per branch of
// `mock:agents` and `mock:background`, and the scripts end to end through `streamText` (fake timers: the step delays
// never sleep for real).
import type { LanguageModelV4CallOptions, LanguageModelV4Message, LanguageModelV4Prompt, LanguageModelV4ToolResultOutput } from '@ai-sdk/provider'
import type { SkillOutput, TaskOutput } from '@harness-forge/shared'
import type { MockPlan } from './models.ts'
import { skillInputSchema, skillOutputSchema, taskInputSchema, taskOutputSchema, taskResultText } from '@harness-forge/shared'
import { isStepCount, streamText, tool } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SUBAGENT_INSTRUCTIONS_MARKER } from '../../chat/markers.ts'
import { skillModelText } from '../core-agent/skill.ts'
import { taskModelText } from '../core-agent/task.ts'
import { mockAgentsTrigger, mockAgentTypeNames, mockPersona, mockSkillLoadedText, mockSkillNames } from './agents.ts'
import { mockBackgroundChildSteps, mockBackgroundLaunch, mockBackgroundTag } from './background.ts'
import { createMockLanguageModel, mockPlan } from './models.ts'

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

/** One call and its result. */
function step(id: string, name: string, output: LanguageModelV4ToolResultOutput): LanguageModelV4Message[] {
  return [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: name, input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: name, output }] },
  ]
}

const OK: LanguageModelV4ToolResultOutput = { type: 'text', value: 'ok' }
const DENIED: LanguageModelV4ToolResultOutput = { type: 'execution-denied', reason: 'Sub-agents cannot ask the user.' }

function functionTools(names: readonly string[]): LanguageModelV4CallOptions['tools'] {
  return names.map(name => ({ type: 'function' as const, name, inputSchema: { type: 'object', properties: {} } }))
}

function planOf(modelId: 'agents' | 'background', prompt: LanguageModelV4Prompt, tools?: readonly string[]): MockPlan {
  return mockPlan(modelId, { prompt, ...(tools === undefined ? {} : { tools: functionTools(tools) }) })
}

function callsOf(plan: MockPlan): Array<{ id: string, name: string, input: unknown }> {
  return [...(plan.toolCall === null ? [] : [plan.toolCall]), ...(plan.toolCalls ?? [])].map(call => ({ id: call.toolCallId, name: call.toolName, input: JSON.parse(call.input) as unknown }))
}

function text(value: string, extra: Partial<MockPlan> = {}): MockPlan {
  return { reasoning: null, text: value, toolCall: null, finishReason: 'stop', ...extra }
}

function taskOutput(extra: Partial<TaskOutput> = {}): TaskOutput {
  return { status: 'completed', type: 'explore', description: 'Background explore', modelRef: 'mock:background', steps: [], stepsOmitted: 0, report: 'Report: background done', startedAt: 1, finishedAt: 2, ...extra }
}

/** The model text of a delivered background result (`taskResultText`). */
function delivered(output: Partial<TaskOutput> = {}, taskId = 'bgt_0123456789abcdef'): string {
  return taskResultText({ taskId, output: taskOutput(output) })
}

const CHILD = system(`You are a sub-agent.\n${SUBAGENT_INSTRUCTIONS_MARKER}`)

/** Instructions with an "Agent types" block and a skills block, the way `params.ts` lists them (W10.3). */
const BLOCKS = [
  'You are helpful.',
  'Delegate with task: a sub-agent works in its own context.',
  'Agent types (the type of a task call):',
  '- explore: Searches and reads the project with read-only tools.',
  '- general: A general-purpose agent.',
  '- reviewer: Reviews diffs strictly.',
  '',
  'Skills (load one with the skill tool when a task matches it):',
  '- pdf: Work with PDF files.',
  '- release-notes: Write release notes.',
  '',
  'Project notes follow.',
].join('\n')

// ---------- mock:agents ----------

describe('mock:agents: instruction blocks and helpers', () => {
  it('reads the names of the "Agent types" and skills blocks in listed order (none without a block)', () => {
    expect(mockAgentTypeNames(BLOCKS)).toEqual(['explore', 'general', 'reviewer'])
    expect(mockSkillNames(BLOCKS)).toEqual(['pdf', 'release-notes'])
    expect(mockAgentTypeNames('Delegate with task.')).toEqual([])
    expect(mockSkillNames('')).toEqual([])
  })

  it('accepts headings, bold headers, "Available", blank lines before the entries and several entry styles', () => {
    expect(mockAgentTypeNames('## Agent types\n\n1. `explore` — read-only\n2. **general**: all tools\nAfter.')).toEqual(['explore', 'general'])
    expect(mockAgentTypeNames('**Available agent types:**\nexplore: read-only\nreviewer (project): strict\n')).toEqual(['explore'])
    expect(mockSkillNames('Available skills:\n* pdf - PDFs\n• notes\n\n- not-listed: after a blank line')).toEqual(['pdf', 'notes'])
    // A header without entries does not hide a later block.
    expect(mockSkillNames('Skills are loaded on demand.\nSkills:\n- pdf: PDFs')).toEqual(['pdf'])
    // The entries end at the first other line.
    expect(mockAgentTypeNames('Agent types:\n- explore: x\nUse them well.\n- general: y')).toEqual(['explore'])
  })

  it('persona: the rest of the first PERSONA: line, trimmed; none without one or when empty', () => {
    expect(mockPersona(`${SUBAGENT_INSTRUCTIONS_MARKER}\nPERSONA:  strict reviewer \nPERSONA: second`)).toBe('strict reviewer')
    expect(mockPersona('Be kind. PERSONA: inline one\nnext')).toBe('inline one')
    expect(mockPersona('no persona here')).toBe('none')
    expect(mockPersona('PERSONA:   \nnext')).toBe('none')
  })

  it('the trigger is the last non-empty line of the user text, whitespace collapsed', () => {
    expect(mockAgentsTrigger('tools?')).toBe('tools?')
    expect(mockAgentsTrigger('Review the changes.\n\n  tools?  \n')).toBe('tools?')
    expect(mockAgentsTrigger('agent   reviewer   write')).toBe('agent reviewer write')
    expect(mockAgentsTrigger('')).toBe('')
  })

  it('skill loaded: the first 80 characters (code points) of the content, trailing whitespace dropped', () => {
    expect(mockSkillLoadedText('# PDF\nUse pdftotext.')).toBe('Skill loaded: # PDF\nUse pdftotext.')
    expect(mockSkillLoadedText('x'.repeat(100))).toBe(`Skill loaded: ${'x'.repeat(80)}`)
    expect(mockSkillLoadedText(`${'é'.repeat(79)} tail`)).toBe(`Skill loaded: ${'é'.repeat(79)}`)
  })
})

describe('mock:agents child', () => {
  const TOOLS = ['read_file', 'list_directory', 'write_file']

  it('list_directory first when offered, then the report with the persona, the sorted tools and model=agents (no waits)', () => {
    const persona = system(`${SUBAGENT_INSTRUCTIONS_MARKER}\nYou review code.\nPERSONA: strict reviewer`)
    const first = planOf('agents', [persona, user('Run the reviewer agent.')], TOOLS)
    expect(first.stepDelayMs).toBeUndefined()
    expect(callsOf(first)).toEqual([{ id: 'mock_call_1', name: 'list_directory', input: { path: '.' } }])
    const report = planOf('agents', [persona, user('Run the reviewer agent.'), ...step('mock_call_1', 'list_directory', OK)], TOOLS)
    expect(report).toEqual(text('Report: persona=strict reviewer | tools: list_directory, read_file, write_file | model=agents'))
  })

  it('no persona -> none; without list_directory the report comes at once; nothing offered -> tools: none', () => {
    expect(planOf('agents', [CHILD, user('Run the explore agent.')], ['read_file']).text).toBe('Report: persona=none | tools: read_file | model=agents')
    expect(planOf('agents', [CHILD, user('Run the explore agent.')]).text).toBe('Report: persona=none | tools: none | model=agents')
  })

  it('write: write_file agent.txt after the probe (once), then the report; without write_file the report', () => {
    const prompt = [CHILD, user('Run the escalate agent and write agent.txt.'), ...step('mock_call_1', 'list_directory', OK)]
    expect(callsOf(planOf('agents', prompt, TOOLS))).toEqual([{ id: 'mock_call_2', name: 'write_file', input: { path: 'agent.txt', content: 'Written by a custom agent.\n' } }])
    expect(planOf('agents', [...prompt, ...step('mock_call_2', 'write_file', OK)], TOOLS).text).toBe('Report: persona=none | tools: list_directory, read_file, write_file | model=agents')
    expect(planOf('agents', prompt, ['list_directory']).text).toBe('Report: persona=none | tools: list_directory | model=agents')
    // Without list_directory the write is the first call.
    expect(callsOf(planOf('agents', [CHILD, user('please WRITE it')], ['write_file']))[0]).toMatchObject({ id: 'mock_call_1', name: 'write_file' })
  })

  it('a denied or failed call ends the child (the shared rules)', () => {
    expect(planOf('agents', [CHILD, user('write'), ...step('mock_call_1', 'write_file', DENIED)], TOOLS).text).toBe('The tool call was denied.')
    expect(planOf('agents', [CHILD, user('x'), ...step('mock_call_1', 'list_directory', { type: 'error-text', value: 'No folder.' })], TOOLS).text).toBe('The tool call failed: No folder.')
  })

  it('the marker wins over every parent trigger', () => {
    expect(planOf('agents', [CHILD, user('agents?')], ['task']).text).toBe('Report: persona=none | tools: task | model=agents')
  })
})

describe('mock:agents parent', () => {
  it('agents? / skills? list the block names; tools? the offered tools; none without them', () => {
    const tools = ['task', 'skill', 'read_file']
    expect(planOf('agents', [system(BLOCKS), user('agents?')], tools)).toEqual(text('Agent types: explore, general, reviewer'))
    expect(planOf('agents', [system(BLOCKS), user(' skills? ')], tools).text).toBe('Skills: pdf, release-notes')
    expect(planOf('agents', [system(BLOCKS), user('tools?')], tools).text).toBe('Tools: read_file, skill, task')
    expect(planOf('agents', [user('agents?')]).text).toBe('Agent types: none')
    expect(planOf('agents', [user('skills?')]).text).toBe('Skills: none')
    expect(planOf('agents', [user('tools?')]).text).toBe('Tools: none')
  })

  it('a command expansion whose last line is a trigger (input appended after the body) runs that trigger', () => {
    expect(planOf('agents', [user('Review the staged changes.\n\ntools?')], ['read_file']).text).toBe('Tools: read_file')
  })

  it('agent <type>: one task call with the type as typed, then "Agent report: <text>"', () => {
    const plan = planOf('agents', [user('agent reviewer')], ['task'])
    expect(plan).toMatchObject({ text: null, finishReason: 'tool-calls' })
    expect(callsOf(plan)).toEqual([{ id: 'mock_call_1', name: 'task', input: { type: 'reviewer', description: 'Run reviewer', prompt: 'Run the reviewer agent.' } }])
    expect(JSON.parse(plan.toolCall!.input)).toEqual({ type: 'reviewer', description: 'Run reviewer', prompt: 'Run the reviewer agent.' })
    expect(Object.keys(JSON.parse(plan.toolCall!.input) as object)).toEqual(['type', 'description', 'prompt'])
    expect(taskInputSchema.safeParse(callsOf(plan)[0]!.input).success).toBe(true)
    const done = planOf('agents', [user('agent reviewer'), ...step('mock_call_1', 'task', { type: 'text', value: 'Report: persona=strict reviewer | tools: read_file | model=agents' })], ['task'])
    expect(done).toEqual(text('Agent report: Report: persona=strict reviewer | tools: read_file | model=agents'))
  })

  it('agent <type> write; General-Purpose stays as typed (the server normalizes it)', () => {
    expect(callsOf(planOf('agents', [user('agent escalate write')], ['task']))[0]!.input).toEqual({ type: 'escalate', description: 'Run escalate', prompt: 'Run the escalate agent and write agent.txt.' })
    const typed = callsOf(planOf('agents', [user('agent General-Purpose')], ['task']))[0]!.input
    expect(typed).toEqual({ type: 'General-Purpose', description: 'Run General-Purpose', prompt: 'Run the General-Purpose agent.' })
    expect(taskInputSchema.parse(typed).type).toBe('general-purpose')
    // Other shapes are no agent trigger.
    expect(planOf('agents', [user('agent')], ['task']).text).toBe('Agents mock: agent')
    expect(planOf('agents', [user('agent reviewer please')], ['task']).text).toBe('Agents mock: agent reviewer please')
  })

  it('agent: a failed child reads "Agent report: Sub-agent failed: …"; without task "Sub-agents are not available."', () => {
    const failed = taskModelText(taskOutput({ status: 'failed', report: '', error: 'Unknown agent type "nope". Available types: explore, general.' }))
    expect(planOf('agents', [user('agent nope'), ...step('mock_call_1', 'task', { type: 'text', value: failed })], ['task']).text)
      .toBe('Agent report: Sub-agent failed: Unknown agent type "nope". Available types: explore, general; partial report: (none)')
    expect(planOf('agents', [user('agent reviewer')], ['skill']).text).toBe('Sub-agents are not available.')
    expect(planOf('agents', [user('agent reviewer'), ...step('mock_call_1', 'task', { type: 'error-text', value: 'Boom.' })], ['task']).text).toBe('The tool call failed: Boom.')
    expect(planOf('agents', [user('agent reviewer'), ...step('mock_call_1', 'task', DENIED)], ['task']).text).toBe('The tool call was denied.')
  })

  it('skill <name>: one skill call, then "Skill loaded: <first 80 characters>" (JSON content or the text for the model)', () => {
    const plan = planOf('agents', [user('skill pdf')], ['skill', 'task'])
    expect(callsOf(plan)).toEqual([{ id: 'mock_call_1', name: 'skill', input: { name: 'pdf' } }])
    expect(skillInputSchema.safeParse(callsOf(plan)[0]!.input).success).toBe(true)
    const content = `# PDF skill\nUse pdftotext for text. ${'More words here. '.repeat(10)}`
    const json: LanguageModelV4ToolResultOutput = { type: 'json', value: { name: 'pdf', description: 'PDFs.', source: 'project', content, truncated: false } }
    expect(planOf('agents', [user('skill pdf'), ...step('mock_call_1', 'skill', json)], ['skill']).text).toBe(`Skill loaded: ${content.slice(0, 80).trimEnd()}`)
    const output: SkillOutput = { name: 'pdf', description: 'PDFs.', source: 'project', content, truncated: false, baseDir: '.harness/skills/pdf', files: ['ref.md'] }
    const modelText: LanguageModelV4ToolResultOutput = { type: 'text', value: skillModelText(output) }
    expect(planOf('agents', [user('skill pdf'), ...step('mock_call_1', 'skill', modelText)], ['skill']).text).toBe(`Skill loaded: ${content.slice(0, 80).trimEnd()}`)
  })

  it('skill: without the tool "Skills are not available."; an error result fails the turn', () => {
    expect(planOf('agents', [user('skill pdf')], ['task']).text).toBe('Skills are not available.')
    expect(planOf('agents', [user('skill pdf')]).text).toBe('Skills are not available.')
    const unknown: LanguageModelV4ToolResultOutput = { type: 'error-text', value: 'Unknown skill "nope". Available skills: pdf.' }
    expect(planOf('agents', [user('skill nope'), ...step('mock_call_1', 'skill', unknown)], ['skill']).text).toBe('The tool call failed: Unknown skill "nope". Available skills: pdf.')
    expect(planOf('agents', [user('skill')], ['skill']).text).toBe('Agents mock: skill')
  })

  it('any other turn: "Agents mock: <user text>" (a command expansion shows), "(empty message)" for none', () => {
    expect(planOf('agents', [user('Say hello to Ada.')], ['task'])).toEqual(text('Agents mock: Say hello to Ada.'))
    expect(planOf('agents', [user('first'), assistant('Agents mock: first'), user('second')]).text).toBe('Agents mock: second')
    expect(planOf('agents', [user('  ')]).text).toBe('Agents mock: (empty message)')
    expect(planOf('agents', []).text).toBe('Agents mock: (empty message)')
  })

  it('a steer during an agent turn does not change the trigger (the turn\'s user message)', () => {
    const prompt = [user('agent reviewer'), ...step('mock_call_1', 'task', { type: 'text', value: 'Found it.' }), user('also this')]
    expect(planOf('agents', prompt, ['task']).text).toBe('Agent report: Found it.')
  })
})

// ---------- mock:background ----------

describe('mock:background: helpers', () => {
  it('child steps: slow K (1-20), default 2; loop -> no limit', () => {
    expect(mockBackgroundChildSteps('bg explore')).toBe(2)
    expect(mockBackgroundChildSteps('bg explore slow 5')).toBe(5)
    expect(mockBackgroundChildSteps('bg slow 20 slow 3')).toBe(20)
    expect(mockBackgroundChildSteps('bg slow 0')).toBe(2)
    expect(mockBackgroundChildSteps('bg slow 21')).toBe(2)
    expect(mockBackgroundChildSteps('bg explore loop')).toBeNull()
  })

  it('launch: the type is the second word unless it is steps / slow / loop; steps N (1-20) anywhere', () => {
    expect(mockBackgroundLaunch('bg')).toEqual({ type: 'explore', steps: null })
    expect(mockBackgroundLaunch('  bg general ')).toEqual({ type: 'general', steps: null })
    expect(mockBackgroundLaunch('bg reviewer steps 3')).toEqual({ type: 'reviewer', steps: 3 })
    expect(mockBackgroundLaunch('bg steps 10')).toEqual({ type: 'explore', steps: 10 })
    expect(mockBackgroundLaunch('bg slow 20')).toEqual({ type: 'explore', steps: null })
    expect(mockBackgroundLaunch('bg loop')).toEqual({ type: 'explore', steps: null })
    expect(mockBackgroundLaunch('bg explore steps 21')).toEqual({ type: 'explore', steps: null })
    expect(mockBackgroundLaunch('bgx')).toBeNull()
    expect(mockBackgroundLaunch('run bg')).toBeNull()
  })

  it('the tag: the status attribute and the first non-empty line after it', () => {
    expect(mockBackgroundTag(delivered())).toEqual({ status: 'completed', firstLine: 'Report: background done' })
    expect(mockBackgroundTag(delivered({ status: 'failed', report: '', error: 'Boom.' }))).toEqual({ status: 'failed', firstLine: 'Error: Boom.' })
    expect(mockBackgroundTag(delivered({ status: 'aborted', report: '' }))).toEqual({ status: 'aborted', firstLine: '(no report)' })
    expect(mockBackgroundTag(delivered({ report: '\n\nFirst line.\nSecond line.' }))).toEqual({ status: 'completed', firstLine: 'First line.' })
    expect(mockBackgroundTag('<background-task id="x">\nbody')).toEqual({ status: 'unknown', firstLine: 'body' })
    expect(mockBackgroundTag('no tag')).toBeNull()
  })
})

describe('mock:background child', () => {
  it('two current_time steps of 500 ms by default, then "Report: background done" (no wait)', () => {
    const first = planOf('background', [CHILD, user('bg explore')], ['current_time', 'read_file'])
    expect(first).toMatchObject({ text: null, stepDelayMs: 500, finishReason: 'tool-calls' })
    expect(callsOf(first)).toEqual([{ id: 'mock_call_1', name: 'current_time', input: {} }])
    const one = [CHILD, user('bg explore'), ...step('mock_call_1', 'current_time', OK)]
    expect(callsOf(planOf('background', one, ['current_time']))).toEqual([{ id: 'mock_call_2', name: 'current_time', input: {} }])
    const two = [...one, ...step('mock_call_2', 'current_time', OK)]
    expect(planOf('background', two, ['current_time'])).toEqual(text('Report: background done'))
  })

  it('slow K: K steps; loop: until current_time is no longer offered (the finalize step); none offered: the report at once', () => {
    let prompt: LanguageModelV4Prompt = [CHILD, user('bg explore slow 3')]
    for (let index = 1; index <= 3; index++) {
      expect(callsOf(planOf('background', prompt, ['current_time']))[0]?.id).toBe(`mock_call_${index}`)
      prompt = [...prompt, ...step(`mock_call_${index}`, 'current_time', OK)]
    }
    expect(planOf('background', prompt, ['current_time']).text).toBe('Report: background done')
    let loop: LanguageModelV4Prompt = [CHILD, user('bg explore loop')]
    for (let index = 1; index <= 25; index++)
      loop = [...loop, ...step(`mock_call_${index}`, 'current_time', OK)]
    expect(callsOf(planOf('background', loop, ['current_time']))[0]?.name).toBe('current_time')
    expect(planOf('background', loop, []).text).toBe('Report: background done')
    expect(planOf('background', [CHILD, user('bg explore')]).text).toBe('Report: background done')
  })

  it('a denied or failed call ends the child', () => {
    expect(planOf('background', [CHILD, user('bg'), ...step('mock_call_1', 'current_time', DENIED)], ['current_time']).text).toBe('The tool call was denied.')
    expect(planOf('background', [CHILD, user('bg'), ...step('mock_call_1', 'current_time', { type: 'error-text', value: 'Clock broke.' })], ['current_time']).text).toBe('The tool call failed: Clock broke.')
  })
})

describe('mock:background parent', () => {
  it('bg: one background task call (type explore, the user text as prompt), then "Started in background: <taskId>"', () => {
    const plan = planOf('background', [user('bg')], ['task'])
    expect(plan).toMatchObject({ text: null, finishReason: 'tool-calls' })
    expect(plan.stepDelayMs).toBeUndefined()
    expect(callsOf(plan)).toEqual([{ id: 'mock_call_1', name: 'task', input: { type: 'explore', description: 'Background explore', prompt: 'bg', background: true } }])
    expect(taskInputSchema.parse(callsOf(plan)[0]!.input)).toMatchObject({ background: true })
    expect(callsOf(planOf('background', [user('bg general slow 20')], ['task']))[0]!.input).toEqual({ type: 'general', description: 'Background general', prompt: 'bg general slow 20', background: true })
    const json: LanguageModelV4ToolResultOutput = { type: 'json', value: taskOutput({ status: 'background', report: '', taskId: 'bgt_ABCDEFGHIJKLMNOP' }) }
    expect(planOf('background', [user('bg'), ...step('mock_call_1', 'task', json)], ['task'])).toEqual(text('Started in background: bgt_ABCDEFGHIJKLMNOP'))
  })

  it('the task id from the text for the model, else none (a failed launch)', () => {
    const started: LanguageModelV4ToolResultOutput = { type: 'text', value: taskModelText(taskOutput({ status: 'background', report: '', taskId: 'bgt_0123456789abcdef' })) }
    expect(planOf('background', [user('bg'), ...step('mock_call_1', 'task', started)], ['task']).text).toBe('Started in background: bgt_0123456789abcdef')
    const capped: LanguageModelV4ToolResultOutput = { type: 'text', value: taskModelText(taskOutput({ status: 'failed', report: '', error: 'At most 3 background agents run per chat.' })) }
    expect(planOf('background', [user('bg'), ...step('mock_call_1', 'task', capped)], ['task']).text).toBe('Started in background: none')
    expect(planOf('background', [user('bg'), ...step('mock_call_1', 'task', { type: 'json', value: { status: 'failed' } })], ['task']).text).toBe('Started in background: none')
  })

  it('without task: "Sub-agents are not available."; a denied or failed launch ends as in the shared rules', () => {
    expect(planOf('background', [user('bg')], ['current_time']).text).toBe('Sub-agents are not available.')
    expect(planOf('background', [user('bg'), ...step('mock_call_1', 'task', DENIED)], ['task']).text).toBe('The tool call was denied.')
    expect(planOf('background', [user('bg'), ...step('mock_call_1', 'task', { type: 'error-text', value: 'Guard timeout.' })], ['task']).text).toBe('The tool call failed: Guard timeout.')
  })

  it('steps N without an in-run result: N current_time steps of 400 ms, then "Finished N steps without a result"', () => {
    const tools = ['task', 'current_time']
    const launched = [user('bg explore steps 2'), ...step('mock_call_1', 'task', OK)]
    const first = planOf('background', launched, tools)
    expect(first).toMatchObject({ stepDelayMs: 400, finishReason: 'tool-calls' })
    expect(callsOf(first)).toEqual([{ id: 'mock_call_2', name: 'current_time', input: {} }])
    const one = [...launched, ...step('mock_call_2', 'current_time', OK)]
    expect(callsOf(planOf('background', one, tools))[0]?.id).toBe('mock_call_3')
    const two = [...one, ...step('mock_call_3', 'current_time', OK)]
    expect(planOf('background', two, tools)).toEqual(text('Finished 2 steps without a result'))
    expect(planOf('background', launched, ['task']).text).toBe('Tools are disabled.')
  })

  it('steps N with a result injected at a step boundary: "Finished: in-run result <status>" at once', () => {
    const tools = ['task', 'current_time']
    const launched = [user('bg explore steps 10'), ...step('mock_call_1', 'task', OK), ...step('mock_call_2', 'current_time', OK)]
    expect(planOf('background', [...launched, user(delivered())], tools)).toEqual(text('Finished: in-run result completed'))
    expect(planOf('background', [...launched, user('a steer'), user(delivered({ status: 'limit' }))], tools).text).toBe('Finished: in-run result limit')
    // An ordinary steer is no result; the steps go on.
    expect(callsOf(planOf('background', [...launched, user('a steer')], tools))[0]?.name).toBe('current_time')
  })

  it('a delivered result opens the turn: "Background result: <status> | <first report line>"', () => {
    const history = [user('bg'), ...step('mock_call_1', 'task', OK), assistant('Started in background: bgt_0123456789abcdef')]
    // The carrier message of a server-started turn (origin task).
    expect(planOf('background', [...history, user(delivered())], ['task'])).toEqual(text('Background result: completed | Report: background done'))
    expect(planOf('background', [...history, user(delivered({ status: 'failed', report: '', error: 'Boom.' }))]).text).toBe('Background result: failed | Error: Boom.')
    // Delivered at step 0 of the user's next turn: it follows the user's own message and opens the turn.
    expect(planOf('background', [...history, user('hello'), user(delivered({ status: 'aborted', report: '' }))]).text).toBe('Background result: aborted | (no report)')
    // Two results at once (each its own user message): the turn opens at the last one.
    expect(planOf('background', [...history, user(delivered()), user(delivered({ status: 'limit', report: 'Partial.' }))]).text).toBe('Background result: limit | Partial.')
  })

  it('any other turn: "Background mock: <user text>"', () => {
    expect(planOf('background', [user('hello there')], ['task'])).toEqual(text('Background mock: hello there'))
    expect(planOf('background', [user('bgx')], ['task']).text).toBe('Background mock: bgx')
    expect(planOf('background', [user('')]).text).toBe('Background mock: (empty message)')
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

describe('customization mocks end to end through streamText', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('mock:agents parent and child: agent reviewer runs a child on mock:agents and relays its report', async () => {
    const childTools = { list_directory: tool({ description: 'List.', inputSchema: z.object({ path: z.string() }), execute: async () => ({ entries: [] }) }) }
    const task = tool({
      description: 'Runs a sub-agent.',
      inputSchema: taskInputSchema,
      outputSchema: taskOutputSchema,
      execute: async (input): Promise<TaskOutput> => {
        const child = streamText({
          model: createMockLanguageModel('agents'),
          instructions: `${SUBAGENT_INSTRUCTIONS_MARKER}\nPERSONA: strict reviewer`,
          prompt: input.prompt,
          tools: childTools,
          stopWhen: isStepCount(4),
        })
        return taskOutput({ type: input.type, description: input.description, report: await child.text })
      },
      toModelOutput: ({ output }) => ({ type: 'text', value: taskModelText(output) }),
    })
    const result = streamText({ model: createMockLanguageModel('agents'), prompt: 'agent reviewer', tools: { task }, stopWhen: isStepCount(4) })
    expect(await result.text).toBe('Agent report: Report: persona=strict reviewer | tools: list_directory | model=agents')
  })

  it('mock:agents skill: the skill tool\'s text for the model gives the preview', async () => {
    const content = '# Release notes\nGroup the changes by area.'
    const skill = tool({
      description: 'Loads a skill.',
      inputSchema: skillInputSchema,
      outputSchema: skillOutputSchema,
      execute: async (input): Promise<SkillOutput> => ({ name: input.name, description: 'Notes.', source: 'user', content, truncated: false }),
      toModelOutput: ({ output }) => ({ type: 'text', value: skillModelText(output) }),
    })
    const result = streamText({ model: createMockLanguageModel('agents'), prompt: 'skill release-notes', tools: { skill }, stopWhen: isStepCount(3) })
    expect(await result.text).toBe(`Skill loaded: ${content}`)
  })

  it('mock:background child: two current_time steps 500 ms apart, then the report', async () => {
    vi.useFakeTimers()
    const currentTime = tool({ description: 'Time.', inputSchema: z.object({}), execute: async () => ({ now: 0 }) })
    const result = streamText({
      model: createMockLanguageModel('background'),
      instructions: SUBAGENT_INSTRUCTIONS_MARKER,
      prompt: 'bg explore',
      tools: { current_time: currentTime },
      stopWhen: isStepCount(6),
    })
    expect(await settle(result.text)).toBe('Report: background done')
    expect(await result.steps).toHaveLength(3)
  })

  it('mock:background steps N: a result injected by prepareStep ends the in-run steps early', async () => {
    vi.useFakeTimers()
    const currentTime = tool({ description: 'Time.', inputSchema: z.object({}), execute: async () => ({ now: 0 }) })
    const task = tool({
      description: 'Runs a sub-agent.',
      inputSchema: taskInputSchema,
      execute: async () => taskOutput({ status: 'background', report: '', taskId: 'bgt_0123456789abcdef' }),
      toModelOutput: ({ output }) => ({ type: 'text', value: taskModelText(output) }),
    })
    const result = streamText({
      model: createMockLanguageModel('background'),
      prompt: 'bg explore steps 10',
      tools: { task, current_time: currentTime },
      stopWhen: isStepCount(12),
      prepareStep: ({ stepNumber, messages }) => (stepNumber === 3 ? { messages: [...messages, { role: 'user', content: delivered() }] } : undefined),
    })
    expect(await settle(result.text)).toBe('Finished: in-run result completed')
    const steps = await result.steps
    expect(steps.map(entry => entry.toolCalls.map(call => call.toolName).join(','))).toEqual(['task', 'current_time', 'current_time', ''])
  })
})
