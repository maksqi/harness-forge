// The Phase 11 hook mock (PROVIDERS.md 8 "Hook mocks (Phase 11)", C38-T7): a plan per branch of `mock:hooks`, with hook
// blocks built by the shared `hookModelText`, and the scripts end to end through `streamText` (a PostToolUse context
// injected by `prepareStep` the way the hooks composer piece does, a sub-agent child, a SubagentStop round).
import type { LanguageModelV4CallOptions, LanguageModelV4Message, LanguageModelV4Prompt, LanguageModelV4ToolResultOutput } from '@ai-sdk/provider'
import type { HookModelTextInput, TaskOutput } from '@harness-forge/shared'
import type { MockPlan } from './models.ts'
import { hookModelText, taskInputSchema, taskOutputSchema } from '@harness-forge/shared'
import { isStepCount, streamText, tool } from 'ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SUBAGENT_INSTRUCTIONS_MARKER } from '../../chat/markers.ts'
import { TODO_HINT, workspaceBlock } from '../../chat/params.ts'
import { taskModelText } from '../core-agent/task.ts'
import {
  MOCK_HOOKS_DETAIL_MAX_CHARS,
  MOCK_HOOKS_STYLE_HEADER,
  MOCK_HOOKS_TODO_HINT,
  MOCK_HOOKS_WORKSPACE_RULE,
  mockHookBlocksOf,
  mockHooksCall,
  mockHooksCallInput,
  mockHooksDetail,
  mockHooksTrigger,
  mockHooksTurn,
  mockHooksUserText,
} from './hooks.ts'
import { createMockLanguageModel, MOCK_MODEL_IDS, mockPlan } from './models.ts'

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
function step(id: string, name: string, output: LanguageModelV4ToolResultOutput, input: unknown = {}): LanguageModelV4Message[] {
  return [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: name, input }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: name, output }] },
  ]
}

/** The model text of a hook record (the shared `hookModelText`). */
function hook(data: HookModelTextInput, role: 'assistant' | 'user' = 'assistant'): string {
  const text = hookModelText(data, role)
  if (text === null)
    throw new Error('display-only record')
  return text
}

function functionTools(names: readonly string[]): LanguageModelV4CallOptions['tools'] {
  return names.map(name => ({ type: 'function' as const, name, inputSchema: { type: 'object', properties: {} } }))
}

function planOf(prompt: LanguageModelV4Prompt, tools: readonly string[] = []): MockPlan {
  return mockPlan('hooks', { prompt, tools: functionTools(tools) })
}

function callsOf(plan: MockPlan): Array<{ id: string, name: string, input: unknown }> {
  return [...(plan.toolCall === null ? [] : [plan.toolCall]), ...(plan.toolCalls ?? [])].map(call => ({ id: call.toolCallId, name: call.toolName, input: JSON.parse(call.input) as unknown }))
}

function text(value: string): MockPlan {
  return { reasoning: null, text: value, toolCall: null, finishReason: 'stop' }
}

const BASE = system('You are helpful.')
const CHILD = system(`You are a sub-agent.\n${SUBAGENT_INSTRUCTIONS_MARKER}`)
const SHELL_HI: LanguageModelV4ToolResultOutput = { type: 'text', value: 'Exit code: 0\nstdout:\nhi\n' }
const POST_CONTEXT = hook({ event: 'PostToolUse', outcome: 'context', toolName: 'shell', context: 'lint ok\nsecond line' })
const POST_FEEDBACK = hook({ event: 'PostToolUse', outcome: 'blocked', toolName: 'shell', reason: 'nope' })

// ---------- definitions ----------

describe('mock:hooks definitions', () => {
  it('is the 17th language model (followed by prompt-hook since Phase 12)', () => {
    expect(MOCK_MODEL_IDS.indexOf('hooks')).toBe(16)
    expect(MOCK_MODEL_IDS.slice(16)).toEqual(['hooks', 'prompt-hook'])
  })

  it('style? reads the texts the server writes: the style header, the workspace rule and TODO_HINT', () => {
    expect(MOCK_HOOKS_STYLE_HEADER).toBe('Output style: ')
    expect(workspaceBlock({ name: 'Demo', root: '/srv/demo' }, ['read_file'], 'linux').split('\n')).toContain(MOCK_HOOKS_WORKSPACE_RULE)
    expect(TODO_HINT.startsWith(MOCK_HOOKS_TODO_HINT)).toBe(true)
  })

  it('reads hook blocks of hookModelText: tag, event and the first non-empty line', () => {
    const both = hook({ event: 'PostToolUse', outcome: 'blocked', toolName: 'shell', context: '\n  lint ok  \nmore', reason: 'nope' })
    expect(mockHookBlocksOf(both)).toEqual([
      { tag: 'hook-context', event: 'PostToolUse', firstLine: 'lint ok' },
      { tag: 'hook-feedback', event: 'PostToolUse', firstLine: 'nope' },
    ])
    expect(mockHookBlocksOf(hook({ event: 'Stop', outcome: 'continued', reason: '' }, 'user'))).toEqual([{ tag: 'hook-feedback', event: 'Stop', firstLine: '(no reason given)' }])
    expect(mockHookBlocksOf('plain text <hook-context event="X">unterminated')).toEqual([])
  })

  it('the user text drops every hook block; the trigger is its last non-empty line', () => {
    const message = user('Run the checks.\n\n  call write_file {"path":"a.txt"}  ', hook({ event: 'UserPromptSubmit', outcome: 'context', context: 'ticket HF-12' }))
    expect(mockHooksUserText(message)).toBe('Run the checks.\n\n  call write_file {"path":"a.txt"}')
    expect(mockHooksTrigger(mockHooksUserText(message))).toBe('call write_file {"path":"a.txt"}')
    expect(mockHooksTrigger('')).toBe('')
  })

  it('call / run triggers: the tool is the second word, the rest of the line is JSON (else {})', () => {
    expect(mockHooksCall('call write_file {"path": "a  b.txt", "content": "x"}')).toEqual({ toolName: 'write_file', input: { path: 'a  b.txt', content: 'x' } })
    expect(mockHooksCall('call current_time')).toEqual({ toolName: 'current_time', input: {} })
    expect(mockHooksCall('run   rm -rf build ')).toEqual({ toolName: 'shell', input: { command: 'rm -rf build' } })
    expect(mockHooksCall('call')).toBeNull()
    expect(mockHooksCall('run')).toBeNull()
    expect(mockHooksCall('Call x {}')).toBeNull()
    for (const json of [undefined, '', 'not json', '[1,2]', 'null', '42', '"text"'])
      expect(mockHooksCallInput(json), String(json)).toEqual({})
  })

  it('the detail collapses whitespace, trims and keeps 120 code points', () => {
    expect(mockHooksDetail('  Exit code: 0\nstdout:\n  hi \n')).toBe('Exit code: 0 stdout: hi')
    const long = `${'é'.repeat(100)}\n${'x'.repeat(100)}`
    const detail = mockHooksDetail(long)
    expect(Array.from(detail)).toHaveLength(MOCK_HOOKS_DETAIL_MAX_CHARS)
    expect(detail).toBe(`${'é'.repeat(100)} ${'x'.repeat(19)}`)
  })

  it('a hook-only user message never opens a turn (step-boundary context, a carrier without feedback)', () => {
    const prompt = [BASE, user('run ls'), ...step('mock_call_1', 'shell', SHELL_HI), user(POST_CONTEXT)]
    expect(mockHooksTurn(prompt)).toMatchObject({ start: 1, userText: 'run ls', results: [{ toolName: 'shell' }] })
    const carrier = [BASE, user('tools?'), assistant('Tools: none'), user(hook({ event: 'SessionStart', outcome: 'context', context: 'branch main' }))]
    expect(mockHooksTurn(carrier)).toMatchObject({ start: 1, userText: 'tools?' })
  })
})

// ---------- rule 1: the child ----------

describe('mock:hooks child (rule 1)', () => {
  it('(a) a SubagentStop round: "Child continued: <first line>"', () => {
    const round = user(hook({ event: 'SubagentStop', outcome: 'blocked', reason: 'Check the tests too.\nThen report.' }, 'user'))
    expect(planOf([CHILD, user('look around'), assistant('Child done'), round], ['shell'])).toEqual(text('Child continued: Check the tests too.'))
    const twice = [CHILD, user('look around'), assistant('Child done'), round, assistant('Child continued: Check the tests too.'), user(hook({ event: 'SubagentStop', outcome: 'blocked', reason: 'Once more.' }, 'user'))]
    expect(planOf(twice)).toEqual(text('Child continued: Once more.'))
  })

  it('(b) a call or run trigger: that one call; Tools are disabled. when the tool is not offered', () => {
    expect(callsOf(planOf([CHILD, user('run ls -la')], ['shell']))).toEqual([{ id: 'mock_call_1', name: 'shell', input: { command: 'ls -la' } }])
    expect(callsOf(planOf([CHILD, user('Please do this.\ncall write_file {"path":"x.txt","content":"x"}')], ['write_file']))).toEqual([{ id: 'mock_call_1', name: 'write_file', input: { path: 'x.txt', content: 'x' } }])
    expect(planOf([CHILD, user('run ls')], ['read_file'])).toEqual(text('Tools are disabled.'))
  })

  it('(c) Child done: after the call returned (whatever its result) and for any other prompt', () => {
    const denied: LanguageModelV4ToolResultOutput = { type: 'execution-denied', reason: 'Sub-agents cannot ask the user.' }
    expect(planOf([CHILD, user('run ls'), ...step('mock_call_1', 'shell', denied)], ['shell'])).toEqual(text('Child done'))
    expect(planOf([CHILD, user('run ls'), ...step('mock_call_1', 'shell', { type: 'error-text', value: 'Boom.' })], ['shell'])).toEqual(text('Child done'))
    expect(planOf([CHILD, user('run ls'), ...step('mock_call_1', 'shell', SHELL_HI), user(POST_FEEDBACK)], ['shell'])).toEqual(text('Child done'))
    expect(planOf([CHILD, user('Look around.')], ['shell'])).toEqual(text('Child done'))
  })
})

// ---------- rule 2: the hook continuation ----------

describe('mock:hooks hook continuation (rule 2)', () => {
  it('the carrier of a Stop-hook turn: "Hook continuation: <first line>"', () => {
    const carrier = user(hook({ event: 'Stop', outcome: 'continued', reason: 'run the tests\nand fix them' }, 'user'))
    const prompt = [BASE, user('run ls'), ...step('mock_call_1', 'shell', SHELL_HI), assistant('Called shell: ok | Exit code: 0 stdout: hi | hooks: none'), carrier]
    expect(planOf(prompt, ['shell'])).toEqual(text('Hook continuation: run the tests'))
  })

  it('postToolUse feedback right after a tool result is no continuation: it goes into hooks:', () => {
    const prompt = [BASE, user('run make'), ...step('mock_call_1', 'shell', SHELL_HI), user(POST_FEEDBACK)]
    expect(planOf(prompt, ['shell'])).toEqual(text('Called shell: ok | Exit code: 0 stdout: hi | hooks: nope'))
  })
})

// ---------- rule 3: the triggers ----------

describe('mock:hooks call / run (rule 3)', () => {
  it('call: one call with the parsed input, mock_call_<n>', () => {
    const prompt = [BASE, user('earlier'), assistant('Hooks mock: earlier'), user('call write_file {"path":"notes.txt","content":"hi\\n"}')]
    expect(callsOf(planOf(prompt, ['write_file']))).toEqual([{ id: 'mock_call_2', name: 'write_file', input: { path: 'notes.txt', content: 'hi\n' } }])
    expect(callsOf(planOf([BASE, user('call current_time not-json')], ['current_time']))).toEqual([{ id: 'mock_call_1', name: 'current_time', input: {} }])
    expect(planOf([BASE, user('call write_file {}')], ['read_file'])).toEqual(text('Tools are disabled.'))
  })

  it('after the result: ok | the text for the model (JSON stringified) | hooks: none', () => {
    const json: LanguageModelV4ToolResultOutput = { type: 'json', value: { path: 'notes.txt', created: true } }
    expect(planOf([BASE, user('call write_file {"path":"notes.txt"}'), ...step('mock_call_1', 'write_file', json)], ['write_file']))
      .toEqual(text('Called write_file: ok | {"path":"notes.txt","created":true} | hooks: none'))
    expect(planOf([BASE, user('run echo hi'), ...step('mock_call_1', 'shell', SHELL_HI)], ['shell']))
      .toEqual(text('Called shell: ok | Exit code: 0 stdout: hi | hooks: none'))
  })

  it('denied (the reason, or none) and failed (the error text)', () => {
    const denied: LanguageModelV4ToolResultOutput = { type: 'execution-denied', reason: 'Blocked by hook: Denied by the deny hook.' }
    expect(planOf([BASE, user('run rm -rf build'), ...step('mock_call_1', 'shell', denied)], ['shell']))
      .toEqual(text('Called shell: denied | Blocked by hook: Denied by the deny hook. | hooks: none'))
    expect(planOf([BASE, user('run rm -rf build'), ...step('mock_call_1', 'shell', { type: 'execution-denied' })], ['shell']))
      .toEqual(text('Called shell: denied | none | hooks: none'))
    expect(planOf([BASE, user('call read_file {"path":"x"}'), ...step('mock_call_1', 'read_file', { type: 'error-text', value: 'The file\ndoes not exist.' })], ['read_file']))
      .toEqual(text('Called read_file: failed | The file does not exist. | hooks: none'))
  })

  it('a denied approval response without a result reads as denied', () => {
    const prompt: LanguageModelV4Prompt = [
      BASE,
      user('call mock_approval_tool {"text":"x"}'),
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'mock_call_1', toolName: 'mock_approval_tool', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: 'approval_1', approved: false, reason: 'No.' }] },
    ]
    expect(planOf(prompt, ['mock_approval_tool'])).toEqual(text('Called mock_approval_tool: denied | No. | hooks: none'))
  })

  it('hooks: the first lines of the hook blocks after the result, in order', () => {
    const prompt = [BASE, user('run make'), ...step('mock_call_1', 'shell', SHELL_HI), user(POST_CONTEXT, POST_FEEDBACK)]
    expect(planOf(prompt, ['shell'])).toEqual(text('Called shell: ok | Exit code: 0 stdout: hi | hooks: lint ok; nope'))
    // Blocks before the result (the user message's own context) are not counted.
    const before = [BASE, user('run make', hook({ event: 'UserPromptSubmit', outcome: 'context', context: 'ticket HF-12' })), ...step('mock_call_1', 'shell', SHELL_HI)]
    expect(planOf(before, ['shell'])).toEqual(text('Called shell: ok | Exit code: 0 stdout: hi | hooks: none'))
  })

  it('the detail is cut to 120 code points', () => {
    const long: LanguageModelV4ToolResultOutput = { type: 'text', value: `Exit code: 0\nstdout:\n${'word '.repeat(60)}` }
    const plan = planOf([BASE, user('run seq'), ...step('mock_call_1', 'shell', long)], ['shell'])
    expect(plan.text).toBe(`Called shell: ok | ${`Exit code: 0 stdout: ${'word '.repeat(60)}`.slice(0, 120)} | hooks: none`)
  })
})

describe('mock:hooks agent (rule 3)', () => {
  it('one task call { type: general, description: Hook child, prompt }, then "Agent report: <text>"', () => {
    const plan = planOf([BASE, user('agent run ls')], ['task', 'shell'])
    expect(callsOf(plan)).toEqual([{ id: 'mock_call_1', name: 'task', input: { type: 'general', description: 'Hook child', prompt: 'run ls' } }])
    expect(taskInputSchema.safeParse(callsOf(plan)[0]!.input).success).toBe(true)
    expect(planOf([BASE, user('agent run ls'), ...step('mock_call_1', 'task', { type: 'text', value: 'Child continued: Check the tests too.' })], ['task']))
      .toEqual(text('Agent report: Child continued: Check the tests too.'))
  })

  it('without task: Sub-agents are not available.; a denied or failed result ends as in the shared rules', () => {
    expect(planOf([BASE, user('agent run ls')], ['shell'])).toEqual(text('Sub-agents are not available.'))
    expect(planOf([BASE, user('agent run ls'), ...step('mock_call_1', 'task', { type: 'execution-denied' })], ['task'])).toEqual(text('The tool call was denied.'))
    expect(planOf([BASE, user('agent run ls'), ...step('mock_call_1', 'task', { type: 'error-text', value: 'Boom.' })], ['task'])).toEqual(text('The tool call failed: Boom.'))
  })
})

describe('mock:hooks questions (rule 3)', () => {
  it('context?: every hook block of the prompt as <Event>:<first line>, or none', () => {
    const prompt = [
      BASE,
      user('hello', hook({ event: 'SessionStart', outcome: 'context', context: 'branch main' })),
      assistant('Hooks mock: hello'),
      user('context?', hook({ event: 'UserPromptSubmit', outcome: 'context', context: 'ticket HF-12\nmore' })),
    ]
    expect(planOf(prompt)).toEqual(text('Context: SessionStart:branch main; UserPromptSubmit:ticket HF-12'))
    expect(planOf([BASE, user('context?')])).toEqual(text('Context: none'))
    // Blocks in the system text do not count.
    expect(planOf([system(hook({ event: 'SessionStart', outcome: 'context', context: 'x' })), user('context?')])).toEqual(text('Context: none'))
  })

  it('style?: the label on the first line, the workspace rule and the todo hint', () => {
    const instructions = [
      'Output style: Explanatory',
      '',
      'Besides doing the task, help the user understand the code.',
      '',
      'Project "Demo", folder /srv/demo (Linux).',
      '- Use paths relative to the project folder.',
      '',
      'Track multi-step work with todo_write: for a task with three or more steps ...',
    ].join('\n')
    expect(planOf([system(instructions), user('style?')])).toEqual(text('Style: Explanatory | workspace-rules: yes | todo-hint: yes'))
    expect(planOf([BASE, user('style?')])).toEqual(text('Style: none | workspace-rules: no | todo-hint: no'))
    // A style block that does not come first does not count.
    expect(planOf([system(`Global rules.\n\n${instructions}`), user('style?')])).toEqual(text('Style: none | workspace-rules: yes | todo-hint: yes'))
  })

  it('mcp? and tools?: the offered (mcp__) tools, sorted', () => {
    const tools = ['write_file', 'mcp__local-echo__echo', 'current_time', 'mcp__echo__pid']
    expect(planOf([BASE, user('mcp?')], tools)).toEqual(text('MCP tools: mcp__echo__pid, mcp__local-echo__echo'))
    expect(planOf([BASE, user('mcp?')], ['shell'])).toEqual(text('MCP tools: none'))
    expect(planOf([BASE, user('tools?')], tools)).toEqual(text('Tools: current_time, mcp__echo__pid, mcp__local-echo__echo, write_file'))
    expect(planOf([BASE, user('tools?')])).toEqual(text('Tools: none'))
    // A command whose body has no placeholder: the appended input is the last line.
    expect(planOf([BASE, user('Review the current diff.\n\ntools?')], ['read_file'])).toEqual(text('Tools: read_file'))
  })
})

describe('mock:hooks fallback (rule 4)', () => {
  it('"Hooks mock: <user text>": the whole expansion (span output, inlined files); (empty message) when empty', () => {
    const expansion = 'Status:\n M src/app.ts\n\n<file path="README.md">\n# Demo\n</file>\n\nSummarize.'
    expect(planOf([BASE, user(expansion)])).toEqual(text(`Hooks mock: ${expansion}`))
    expect(planOf([BASE, user('')])).toEqual(text('Hooks mock: (empty message)'))
    expect(planOf([BASE, { role: 'user', content: [{ type: 'file', mediaType: 'image/png', data: { type: 'data', data: new Uint8Array([1]) } }] }])).toEqual(text('Hooks mock: (empty message)'))
    expect(planOf([BASE, user('hello', hook({ event: 'UserPromptSubmit', outcome: 'context', context: 'ticket HF-12' }))])).toEqual(text('Hooks mock: hello'))
  })
})

// ---------- end to end ----------

describe('mock:hooks end to end through streamText', () => {
  const shell = tool({
    description: 'Runs a command.',
    inputSchema: z.object({ command: z.string() }),
    execute: async ({ command }) => `Exit code: 0\nstdout:\n${command.replace(/^echo /, '')}\n`,
  })

  it('run echo hi: one shell call, then the report', async () => {
    const result = streamText({ model: createMockLanguageModel('hooks'), prompt: 'run echo hi', tools: { shell }, stopWhen: isStepCount(3) })
    expect(await result.text).toBe('Called shell: ok | Exit code: 0 stdout: hi | hooks: none')
    expect((await result.steps)[0]?.toolCalls.map(call => [call.toolName, call.input])).toEqual([['shell', { command: 'echo hi' }]])
  })

  it('a PostToolUse context injected at the step boundary is reported in hooks:', async () => {
    const result = streamText({
      model: createMockLanguageModel('hooks'),
      prompt: 'run echo hi',
      tools: { shell },
      stopWhen: isStepCount(3),
      prepareStep: ({ stepNumber, messages }) => (stepNumber === 1 ? { messages: [...messages, { role: 'user', content: POST_CONTEXT }] } : undefined),
    })
    expect(await result.text).toBe('Called shell: ok | Exit code: 0 stdout: hi | hooks: lint ok')
  })

  it('agent run ls: the child calls shell and reports "Child done"; a SubagentStop round continues it', async () => {
    let round = false
    const task = tool({
      description: 'Runs a sub-agent.',
      inputSchema: taskInputSchema,
      outputSchema: taskOutputSchema,
      execute: async (input): Promise<TaskOutput> => {
        const child = streamText({ model: createMockLanguageModel('hooks'), instructions: SUBAGENT_INSTRUCTIONS_MARKER, prompt: input.prompt, tools: { shell }, stopWhen: isStepCount(3) })
        let report = await child.text
        if (round) {
          const messages = [
            { role: 'user' as const, content: input.prompt },
            ...(await child.response).messages,
            { role: 'user' as const, content: hook({ event: 'SubagentStop', outcome: 'blocked', reason: 'Check the tests too.' }, 'user') },
          ]
          report = await streamText({ model: createMockLanguageModel('hooks'), instructions: SUBAGENT_INSTRUCTIONS_MARKER, messages, tools: { shell } }).text
        }
        return { status: 'completed', type: input.type, description: input.description, modelRef: 'mock:hooks', steps: [], stepsOmitted: 0, report, startedAt: 1, finishedAt: 2 }
      },
      toModelOutput: ({ output }) => ({ type: 'text', value: taskModelText(output) }),
    })
    const first = streamText({ model: createMockLanguageModel('hooks'), prompt: 'agent run ls', tools: { task }, stopWhen: isStepCount(3) })
    expect(await first.text).toBe('Agent report: Child done')
    expect((await first.steps)[0]?.toolCalls.map(call => call.input)).toEqual([{ type: 'general', description: 'Hook child', prompt: 'run ls' }])
    round = true
    const second = streamText({ model: createMockLanguageModel('hooks'), prompt: 'agent run ls', tools: { task }, stopWhen: isStepCount(3) })
    expect(await second.text).toBe('Agent report: Child continued: Check the tests too.')
  })
})
