// Permission modes (Phase 9, W9.3; ADR-041, ARCHITECTURE.md 6.19):
// - `applyToolMode`: each mode's tool set, the continuation exception (an approved `exit_plan_mode` stays executable but
//   leaves `activeTools`), `activeTools` only when needed;
// - `checkPlanApprovalMode`: approving the plan with a `toolMode` other than `edits` / `ask` is a 400 on `['toolMode']`;
// - end to end over `POST /api/chat` with a scripted `MockLanguageModelV4` in a project chat (the plan tool set, approve
//   in Accept edits, Keep planning with feedback, the 400s) and with `mock:plan` (PROVIDERS.md 8).
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart, LanguageModelV4ToolResultOutput } from '@ai-sdk/provider'
import type { Disposable, ToolDefinition, ToolWorkspaceAccess } from '@harness-forge/plugin-sdk'
import type { ChatDetail, HarnessUIMessage, ProjectSummary, ToolMode } from '@harness-forge/shared'
import type { BuiltinPlugin } from '../plugins/types.ts'
import type { TestApp } from '../testing/create-test-app.ts'
import type { FakeProjectService } from '../testing/fake-projects.ts'
import type { ModeTool } from './modes.ts'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { definePlugin } from '@harness-forge/plugin-sdk'
import { chatDetailSchema, countTodos, HarnessError, harnessErrorEnvelopeSchema, isHarnessError, todoWriteInputSchema } from '@harness-forge/shared'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CORE_AGENT_PLUGIN_ID, createAgentTools, TODO_WRITE_TOOL_NAME } from '../builtin-plugins/core-agent/index.ts'
import { getBuiltinPlugins } from '../builtin-plugins/index.ts'
import { MOCK_PLAN_NOTES_CONTENT, MOCK_PLAN_NOTES_FILE } from '../builtin-plugins/mock/plan-mode.ts'
import { toolPrefs, workspaceChanges } from '../db/schema.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { createFakeProjectService } from '../testing/fake-projects.ts'
import { applyToolMode, checkPlanApprovalMode, hasApprovedPlanExit, PLAN_APPROVAL_MODE_MESSAGE } from './modes.ts'
import { chatBody, postChat, readSse, runnerOf, streamedText, testChatId } from './testing.ts'

// ---------- applyToolMode ----------

function modeTool(pluginId: string, name: string, workspace?: ToolWorkspaceAccess): ModeTool {
  return { pluginId, definition: { name, ...(workspace === undefined ? {} : { workspace }) } }
}

const READ_FILE = modeTool('core-workspace', 'read_file', 'read')
const LIST_DIRECTORY = modeTool('core-workspace', 'list_directory', 'read')
const WRITE_FILE = modeTool('core-workspace', 'write_file', 'write')
const EDIT_FILE = modeTool('core-workspace', 'edit_file', 'write')
const SHELL = modeTool('core-workspace', 'shell', 'execute')
const CURRENT_TIME = modeTool('core-tools', 'current_time')
const MCP_SEARCH = modeTool('core-mcp', 'mcp__docs__search')
/** A third-party tool with an unknown access value (counts as `execute`). */
const ODD_ACCESS = modeTool('odd', 'odd_tool', 'everything' as ToolWorkspaceAccess)
const PLUGIN_WRITER = modeTool('notes', 'notes_append', 'write')
const TODO_WRITE = modeTool('core-agent', 'todo_write')
const EXIT_PLAN = modeTool('core-agent', 'exit_plan_mode')
const TASK = modeTool('core-agent', 'task')

const ALL: ModeTool[] = [READ_FILE, LIST_DIRECTORY, WRITE_FILE, EDIT_FILE, SHELL, CURRENT_TIME, MCP_SEARCH, ODD_ACCESS, PLUGIN_WRITER, TODO_WRITE, EXIT_PLAN, TASK]

function names(tools: readonly ModeTool[]): string[] {
  return tools.map(tool => tool.definition.name)
}

type PlanPartState = 'approval-requested' | 'approval-responded' | 'output-available' | 'output-denied'

/** An assistant message with one `exit_plan_mode` part (and an optional other tool part). */
function planMessage(state: PlanPartState, approved?: boolean, extra: Record<string, unknown>[] = []): HarnessUIMessage {
  const approval = approved === undefined ? { id: 'apr_1' } : { id: 'apr_1', approved }
  const part = {
    type: 'tool-exit_plan_mode',
    toolCallId: 'call_plan',
    state,
    input: { plan: '# Plan' },
    approval,
    ...(state === 'output-available' ? { output: { approved: true, mode: 'edits' } } : {}),
  }
  return { id: 'msg_a000000000000001', role: 'assistant', parts: [part, ...extra] as unknown as HarnessUIMessage['parts'] }
}

describe('applyToolMode', () => {
  it('plan: drops the write / execute tools (an unknown access counts as execute) and keeps the rest, exit_plan_mode included', () => {
    const result = applyToolMode(ALL, { toolMode: 'plan', continuation: null })
    expect(names(result.tools)).toEqual(['read_file', 'list_directory', 'current_time', 'mcp__docs__search', 'todo_write', 'exit_plan_mode', 'task'])
    expect(result.activeTools).toBeUndefined()
  })

  it.each(['ask', 'edits', 'auto'] as const)('%s: every tool except exit_plan_mode, no activeTools', (toolMode) => {
    const result = applyToolMode(ALL, { toolMode, continuation: null })
    expect(names(result.tools)).toEqual(names(ALL.filter(tool => tool !== EXIT_PLAN)))
    expect(result.activeTools).toBeUndefined()
  })

  it('off: no tool', () => {
    expect(applyToolMode(ALL, { toolMode: 'off', continuation: null })).toEqual({ tools: [] })
  })

  it('returns a new array of the same objects in the input order', () => {
    const result = applyToolMode(ALL, { toolMode: 'plan', continuation: null })
    expect(result.tools).not.toBe(ALL)
    expect(result.tools[0]).toBe(READ_FILE)
    const ask = applyToolMode([TASK, CURRENT_TIME], { toolMode: 'ask', continuation: null })
    expect(ask.tools).toEqual([TASK, CURRENT_TIME])
  })

  it('recognizes exit_plan_mode by its owner: a tool of another plugin with that name is an ordinary tool', () => {
    const impostor = modeTool('impostor', 'exit_plan_mode')
    expect(applyToolMode([impostor, CURRENT_TIME], { toolMode: 'ask', continuation: null }).tools).toEqual([impostor, CURRENT_TIME])
    expect(applyToolMode([impostor], { toolMode: 'edits', continuation: planMessage('approval-responded', true) })).toEqual({ tools: [impostor] })
  })

  it('a continuation with an approved exit_plan_mode keeps it executable and hides it from the model', () => {
    for (const toolMode of ['ask', 'edits', 'auto'] as const) {
      const result = applyToolMode(ALL, { toolMode, continuation: planMessage('approval-responded', true) })
      expect(names(result.tools)).toEqual(names(ALL))
      expect(result.activeTools).toEqual(names(ALL.filter(tool => tool !== EXIT_PLAN)))
    }
    // Only exit_plan_mode left: the model gets no tool, the SDK can still execute the approved call.
    expect(applyToolMode([EXIT_PLAN], { toolMode: 'edits', continuation: planMessage('approval-responded', true) })).toEqual({ tools: [EXIT_PLAN], activeTools: [] })
  })

  it('no exception (and no activeTools) for a denied, unanswered or executed plan, or without the tool', () => {
    for (const continuation of [planMessage('approval-responded', false), planMessage('approval-requested'), planMessage('output-available', true), planMessage('output-denied', false)]) {
      const result = applyToolMode(ALL, { toolMode: 'edits', continuation })
      expect(names(result.tools)).not.toContain('exit_plan_mode')
      expect(result.activeTools).toBeUndefined()
    }
    // exit_plan_mode switched off (not a candidate): nothing to keep, no activeTools.
    expect(applyToolMode([CURRENT_TIME], { toolMode: 'edits', continuation: planMessage('approval-responded', true) })).toEqual({ tools: [CURRENT_TIME] })
    // Plan mode offers the tool anyway (`prepare.ts` refuses to approve there): no activeTools.
    expect(applyToolMode(ALL, { toolMode: 'plan', continuation: planMessage('approval-responded', true) }).activeTools).toBeUndefined()
  })

  it('hasApprovedPlanExit reads only approved, not yet executed exit_plan_mode parts', () => {
    expect(hasApprovedPlanExit(null)).toBe(false)
    expect(hasApprovedPlanExit(planMessage('approval-responded', true))).toBe(true)
    expect(hasApprovedPlanExit(planMessage('approval-responded', false))).toBe(false)
    expect(hasApprovedPlanExit(planMessage('approval-requested'))).toBe(false)
    expect(hasApprovedPlanExit(planMessage('output-available', true))).toBe(false)
    const other = { type: 'tool-write_file', toolCallId: 'call_w', state: 'approval-responded', input: {}, approval: { id: 'apr_2', approved: true } }
    expect(hasApprovedPlanExit(planMessage('approval-responded', false, [other]))).toBe(false)
  })
})

// ---------- checkPlanApprovalMode ----------

/** The issue paths of a `validation_error` (`details.issues`). */
function pathsOf(details: unknown): unknown[] {
  return ((details as { issues: { path: unknown[] }[] }).issues).map(issue => issue.path)
}

function issuePaths(error: unknown): unknown[] {
  expect(isHarnessError(error)).toBe(true)
  return pathsOf((error as HarnessError).details)
}

describe('checkPlanApprovalMode', () => {
  const stored = planMessage('approval-requested')

  it.each(['off', 'plan', 'auto'] as const)('refuses to approve the plan with toolMode %s (400 on toolMode)', (toolMode) => {
    let caught: unknown
    try {
      checkPlanApprovalMode(stored, planMessage('approval-responded', true), toolMode)
    }
    catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(HarnessError)
    expect((caught as HarnessError).code).toBe('validation_error')
    expect((caught as HarnessError).message).toBe(PLAN_APPROVAL_MODE_MESSAGE)
    expect(issuePaths(caught)).toEqual([['toolMode']])
  })

  it.each(['edits', 'ask'] as const)('accepts approving the plan with toolMode %s', (toolMode) => {
    expect(() => checkPlanApprovalMode(stored, planMessage('approval-responded', true), toolMode)).not.toThrow()
  })

  it('accepts Keep planning (a denial) and other approvals in every mode', () => {
    const other = { type: 'tool-mock_approval_tool', toolCallId: 'call_m', state: 'approval-responded', input: {}, approval: { id: 'apr_2', approved: true } }
    const otherOnly: HarnessUIMessage = { id: 'msg_a000000000000001', role: 'assistant', parts: [other] as unknown as HarnessUIMessage['parts'] }
    for (const toolMode of ['off', 'ask', 'edits', 'plan', 'auto'] as const) {
      expect(() => checkPlanApprovalMode(stored, planMessage('approval-responded', false), toolMode)).not.toThrow()
      expect(() => checkPlanApprovalMode(otherOnly, otherOnly, toolMode)).not.toThrow()
    }
  })
})

// ---------- end to end ----------

function finishPart(reason: 'stop' | 'tool-calls' = 'stop'): LanguageModelV4StreamPart {
  return {
    type: 'finish',
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
    finishReason: { unified: reason, raw: reason },
  }
}

function textParts(text: string): LanguageModelV4StreamPart[] {
  return [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, finishPart()]
}

function callParts(toolCallId: string, toolName: string, input: unknown): LanguageModelV4StreamPart[] {
  return [{ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) }, finishPart('tool-calls')]
}

/** A model whose answer is computed from the call options (calls are recorded). */
function scriptedModel(script: (options: LanguageModelV4CallOptions, call: number) => LanguageModelV4StreamPart[]): { model: LanguageModelV4, calls: LanguageModelV4CallOptions[] } {
  const calls: LanguageModelV4CallOptions[] = []
  const model = new MockLanguageModelV4({
    provider: 'testkit',
    modelId: 'agent',
    doStream: async (options) => {
      calls.push(options)
      return { stream: convertArrayToReadableStream(script(options, calls.length)) }
    },
  })
  return { model, calls }
}

/** Names of the function tools of a model call (what the model may call). */
function toolNames(call: LanguageModelV4CallOptions | undefined): string[] {
  return (call?.tools ?? []).flatMap(tool => (tool.type === 'function' ? [tool.name] : [])).sort()
}

/** The tool results of a model call's prompt, by tool name. */
function toolResults(call: LanguageModelV4CallOptions | undefined): { toolName: string, output: LanguageModelV4ToolResultOutput }[] {
  return (call?.prompt ?? []).flatMap(message => (message.role === 'tool'
    ? message.content.flatMap(part => (part.type === 'tool-result' ? [{ toolName: part.toolName, output: part.output }] : []))
    : []))
}

/** The real builtins, with a stand-in `todo_write` execute (the tool itself is W9.4's). */
function agentBuiltins(): readonly BuiltinPlugin[] {
  return getBuiltinPlugins({ mockProvider: true }).map(builtin => (builtin.id === CORE_AGENT_PLUGIN_ID
    ? {
        ...builtin,
        module: definePlugin({
          setup(ctx) {
            for (const tool of createAgentTools()) {
              ctx.tools.register(tool.name === TODO_WRITE_TOOL_NAME
                ? {
                    ...tool,
                    execute: async (input: unknown) => {
                      const { todos } = todoWriteInputSchema.parse(input)
                      return { todos, counts: countTodos(todos) }
                    },
                  } as ToolDefinition
                : tool)
            }
          },
        }),
      }
    : builtin))
}

/** Registers the `testkit` provider (model `agent`, tools, from `scripted`) on an app. */
function registerTestkit(app: TestApp, scripted: Map<string, LanguageModelV4>): Disposable {
  return app.deps.registry.providers.register('mock', {
    id: 'testkit',
    name: 'Test kit',
    credentials: [],
    seedModels: [{ id: 'agent', name: 'Agent', contextWindow: 64_000, capabilities: { tools: true } }],
    createLanguageModel: (modelId) => {
      const model = scripted.get(modelId)
      if (model === undefined)
        throw new Error(`No scripted model "${modelId}".`)
      return model
    },
  })
}

async function detailOf(app: TestApp, chatId: string): Promise<ChatDetail> {
  const response = await app.request(`/api/chats/${chatId}`)
  expect(response.status).toBe(200)
  return chatDetailSchema.parse(await response.json())
}

function toolParts(message: HarnessUIMessage | undefined): Record<string, unknown>[] {
  return (message?.parts ?? []).filter(part => part.type.startsWith('tool-')) as unknown as Record<string, unknown>[]
}

/** The client's answer to every pending approval of `message` (`addToolApprovalResponse`), with an optional reason. */
function decide(message: HarnessUIMessage, approved: boolean, reason?: string): HarnessUIMessage {
  return {
    ...message,
    parts: message.parts.map((part) => {
      const value = part as unknown as Record<string, unknown>
      if (value.state !== 'approval-requested')
        return part
      const approval = { ...(value.approval as object), approved, ...(reason === undefined ? {} : { reason }) }
      return { ...value, state: 'approval-responded', approval } as unknown as typeof part
    }),
  }
}

/** Posts the approval continuation of the chat's pending leaf. */
async function continueWith(t: TestApp, chatId: string, modelRef: string, toolMode: ToolMode, approved: boolean, reason?: string): Promise<Response> {
  const detail = await detailOf(t, chatId)
  const leaf = detail.messages.at(-1)!
  expect(leaf.role).toBe('assistant')
  return postChat(t, { ...chatBody(chatId, '', { modelRef, toolMode }), message: decide(leaf, approved, reason) })
}

const AGENT_TOOLS = ['exit_plan_mode', 'task', 'todo_write']
const READ_TOOLS = ['find_files', 'list_directory', 'read_file', 'search_files']
const CHANGE_TOOLS = ['edit_file', 'shell', 'write_file']
const APPROVED_EDITS_TEXT = 'The user approved the plan. Mode is now Accept edits. Implement it now; track progress with todo_write.'
let nextChat = 9300

function newChatId(): string {
  nextChat += 1
  return testChatId(nextChat)
}

describe('plan mode through POST /api/chat (scripted model)', () => {
  let t: TestApp
  let projects: FakeProjectService
  let project: ProjectSummary
  let testkit: Disposable
  const scripted = new Map<string, LanguageModelV4>()

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, builtins: agentBuiltins(), factories: { projects: createFakeProjectService } })
    projects = t.deps.projects as FakeProjectService
    testkit = registerTestkit(t, scripted)
  })

  beforeEach(async () => {
    scripted.clear()
    project = await projects.add({ name: 'Plan' })
  })

  afterAll(async () => {
    testkit.dispose()
    await t.close()
  })

  it('offers the read tools and the agent tools in plan, no write / execute tool; outside plan no exit_plan_mode', async () => {
    const { model, calls } = scriptedModel(() => textParts('ok'))
    scripted.set('agent', model)
    await readSse(await postChat(t, chatBody(newChatId(), 'look around', { modelRef: 'testkit:agent', toolMode: 'plan', projectId: project.id })))
    const plan = toolNames(calls[0])
    for (const name of [...READ_TOOLS, ...AGENT_TOOLS, 'current_time'])
      expect(plan).toContain(name)
    for (const name of CHANGE_TOOLS)
      expect(plan).not.toContain(name)

    await readSse(await postChat(t, chatBody(newChatId(), 'look around', { modelRef: 'testkit:agent', toolMode: 'edits', projectId: project.id })))
    const edits = toolNames(calls[1])
    expect(edits).toContain('write_file')
    expect(edits).toContain('todo_write')
    expect(edits).toContain('task')
    expect(edits).not.toContain('exit_plan_mode')
    await runnerOf(t).idle()
  })

  it('accepts plan in a chat without a project (no workspace tool to drop)', async () => {
    const { model, calls } = scriptedModel(() => textParts('ok'))
    scripted.set('agent', model)
    const chatId = newChatId()
    const response = await postChat(t, chatBody(chatId, 'hi', { modelRef: 'testkit:agent', toolMode: 'plan' }))
    expect(response.status).toBe(200)
    expect(streamedText((await readSse(response)).chunks)).toBe('ok')
    const sent = toolNames(calls[0])
    for (const name of [...AGENT_TOOLS, 'current_time'])
      expect(sent).toContain(name)
    for (const name of [...READ_TOOLS, ...CHANGE_TOOLS])
      expect(sent).not.toContain(name)
    expect((await detailOf(t, chatId)).settings.toolMode).toBe('plan')
    await runnerOf(t).idle()
  })

  it('approve in Accept edits: exit_plan_mode runs hidden from the model, then write_file runs without another card', async () => {
    const { model, calls } = scriptedModel((options) => {
      const results = toolResults(options)
      if (results.length === 0)
        return callParts('call_plan', 'exit_plan_mode', { plan: '# Plan\n1. Write notes.txt.' })
      if (!results.some(result => result.toolName === 'write_file'))
        return callParts('call_write', 'write_file', { path: 'notes.txt', content: 'planned\n' })
      return textParts('Implemented.')
    })
    scripted.set('agent', model)
    const chatId = newChatId()
    const first = await readSse(await postChat(t, chatBody(chatId, 'plan it', { modelRef: 'testkit:agent', toolMode: 'plan', projectId: project.id })))
    expect(first.chunks.filter(chunk => chunk.type === 'tool-approval-request')).toHaveLength(1)
    const pending = await detailOf(t, chatId)
    expect(pending.pendingApproval).toBe(true)
    expect(toolParts(pending.messages[1]).map(part => [part.type, part.state])).toEqual([['tool-exit_plan_mode', 'approval-requested']])
    expect(existsSync(`${project.path}/notes.txt`)).toBe(false)

    const response = await continueWith(t, chatId, 'testkit:agent', 'edits', true)
    expect(response.status).toBe(200)
    const second = await readSse(response)
    expect(second.chunks.some(chunk => chunk.type === 'tool-approval-request')).toBe(false)
    expect(streamedText(second.chunks)).toBe('Implemented.')
    // The model never saw exit_plan_mode again (activeTools), but read the approved result.
    expect(calls).toHaveLength(3)
    for (const call of calls.slice(1)) {
      expect(toolNames(call)).not.toContain('exit_plan_mode')
      expect(toolNames(call)).toContain('write_file')
    }
    expect(toolResults(calls[1])).toEqual([{ toolName: 'exit_plan_mode', output: { type: 'text', value: APPROVED_EDITS_TEXT } }])
    expect(await readFile(`${project.path}/notes.txt`, 'utf8')).toBe('planned\n')

    const done = await detailOf(t, chatId)
    expect(done.pendingApproval).toBe(false)
    expect(done.settings.toolMode).toBe('edits')
    const parts = toolParts(done.messages[1])
    expect(parts.map(part => [part.type, part.state])).toEqual([['tool-exit_plan_mode', 'output-available'], ['tool-write_file', 'output-available']])
    expect(parts[0]!.output).toEqual({ approved: true, mode: 'edits' })
    const rows = await t.db.select().from(workspaceChanges).where(eq(workspaceChanges.chatId, chatId))
    expect(rows.map(row => [row.tool, row.toolCallId, row.messageId])).toEqual([['write_file', 'call_write', done.messages[1]!.id]])
    await runnerOf(t).idle()
  })

  it('approve in Ask: the mode is ask and the write asks', async () => {
    const { model } = scriptedModel((options) => {
      const results = toolResults(options)
      if (results.length === 0)
        return callParts('call_plan', 'exit_plan_mode', { plan: '# Plan' })
      return callParts('call_write', 'write_file', { path: 'notes.txt', content: 'x\n' })
    })
    scripted.set('agent', model)
    const chatId = newChatId()
    await readSse(await postChat(t, chatBody(chatId, 'plan it', { modelRef: 'testkit:agent', toolMode: 'plan', projectId: project.id })))
    const second = await readSse(await continueWith(t, chatId, 'testkit:agent', 'ask', true))
    expect(second.chunks.filter(chunk => chunk.type === 'tool-approval-request')).toHaveLength(1)
    const parts = toolParts((await detailOf(t, chatId)).messages[1])
    expect(parts.map(part => [part.type, part.state])).toEqual([['tool-exit_plan_mode', 'output-available'], ['tool-write_file', 'approval-requested']])
    expect(parts[0]!.output).toEqual({ approved: true, mode: 'ask' })
    expect(existsSync(`${project.path}/notes.txt`)).toBe(false)
    await runnerOf(t).idle()
  })

  it('keep planning in plan: the model receives the feedback as the denial reason and still has exit_plan_mode', async () => {
    const { model, calls } = scriptedModel((options) => {
      const results = toolResults(options)
      if (results.length === 0)
        return callParts('call_plan', 'exit_plan_mode', { plan: '# Plan' })
      return textParts('Revising.')
    })
    scripted.set('agent', model)
    const chatId = newChatId()
    await readSse(await postChat(t, chatBody(chatId, 'plan it', { modelRef: 'testkit:agent', toolMode: 'plan', projectId: project.id })))
    const response = await continueWith(t, chatId, 'testkit:agent', 'plan', false, 'Add a test step.')
    expect(response.status).toBe(200)
    expect(streamedText((await readSse(response)).chunks)).toBe('Revising.')
    expect(toolResults(calls[1])).toEqual([{ toolName: 'exit_plan_mode', output: { type: 'execution-denied', reason: 'Add a test step.' } }])
    expect(toolNames(calls[1])).toContain('exit_plan_mode')
    expect(toolNames(calls[1])).not.toContain('write_file')
    const done = await detailOf(t, chatId)
    expect(done.settings.toolMode).toBe('plan')
    expect(toolParts(done.messages[1]).map(part => part.state)).toEqual(['output-denied'])
    expect(existsSync(`${project.path}/notes.txt`)).toBe(false)
    await runnerOf(t).idle()
  })

  it('overrides and hooks cannot approve exit_plan_mode: the card shows with a stored allow and an approving hook', async () => {
    const { model } = scriptedModel(() => callParts('call_plan', 'exit_plan_mode', { plan: '# Plan' }))
    scripted.set('agent', model)
    // A stored allow (planted: `PATCH /tools` refuses it) and a hook that approves everything.
    await t.db.insert(toolPrefs).values({ toolName: 'exit_plan_mode', enabled: true, override: 'allow' })
    const hooked: string[] = []
    const hook = t.deps.registry.hooks.on('mock', 'tool.approve', (input, output) => {
      hooked.push(input.tool)
      output.decision = 'allow'
    })
    try {
      const chatId = newChatId()
      const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'plan it', { modelRef: 'testkit:agent', toolMode: 'plan', projectId: project.id })))
      expect(chunks.filter(chunk => chunk.type === 'tool-approval-request')).toHaveLength(1)
      expect((await detailOf(t, chatId)).pendingApproval).toBe(true)
      expect(hooked).toEqual([])
      await runnerOf(t).idle()
    }
    finally {
      hook.dispose()
      await t.db.delete(toolPrefs).where(eq(toolPrefs.toolName, 'exit_plan_mode'))
    }
  })

  it.each(['plan', 'off', 'auto'] as const)('refuses to approve the plan with toolMode %s (400 on toolMode), the history stays pending', async (toolMode) => {
    const { model, calls } = scriptedModel(() => callParts('call_plan', 'exit_plan_mode', { plan: '# Plan' }))
    scripted.set('agent', model)
    const chatId = newChatId()
    await readSse(await postChat(t, chatBody(chatId, 'plan it', { modelRef: 'testkit:agent', toolMode: 'plan', projectId: project.id })))
    await runnerOf(t).idle()
    const response = await continueWith(t, chatId, 'testkit:agent', toolMode, true)
    expect(response.status).toBe(400)
    const { error } = harnessErrorEnvelopeSchema.parse(await response.json())
    expect(error.code).toBe('validation_error')
    expect(pathsOf(error.details)).toEqual([['toolMode']])
    expect(calls).toHaveLength(1)
    // The history is untouched (the chat row upsert before the check may already store the request's mode).
    const detail = await detailOf(t, chatId)
    expect(detail.pendingApproval).toBe(true)
    expect(detail.messages).toHaveLength(2)
    expect(toolParts(detail.messages[1]).map(part => part.state)).toEqual(['approval-requested'])
  })
})

describe('plan mode with a tool without workspace access (mock:tool-approval)', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
  })

  afterAll(async () => {
    await t.close()
  })

  it('keeps the tool and asks before the call, like ask', async () => {
    const chatId = testChatId(9201)
    const response = await postChat(t, chatBody(chatId, 'echo me', { modelRef: 'mock:tool-approval', toolMode: 'plan' }))
    expect(response.status).toBe(200)
    const { chunks } = await readSse(response)
    expect(chunks.some(chunk => chunk.type === 'tool-approval-request')).toBe(true)
    await runnerOf(t).idle()
    const detail = await detailOf(t, chatId)
    expect(detail.pendingApproval).toBe(true)
    expect(detail.settings.toolMode).toBe('plan')
  })
})

describe('mock:plan in a project chat (PROVIDERS.md 8)', () => {
  let t: TestApp
  let project: ProjectSummary

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, builtins: agentBuiltins(), factories: { projects: createFakeProjectService } })
  })

  beforeEach(async () => {
    project = await (t.deps.projects as FakeProjectService).add({ name: 'Mock plan' })
  })

  afterAll(async () => {
    await t.close()
  })

  it('plan -> card -> approve with Accept edits -> notes.txt written without another card', async () => {
    const chatId = newChatId()
    const first = await readSse(await postChat(t, chatBody(chatId, 'make a plan', { modelRef: 'mock:plan', toolMode: 'plan', projectId: project.id })))
    const header = streamedText(first.chunks).split('\n')[0]!
    expect(header.startsWith('tools: ')).toBe(true)
    const offered = header.slice('tools: '.length).split(', ')
    for (const name of [...AGENT_TOOLS, 'list_directory', 'read_file'])
      expect(offered).toContain(name)
    for (const name of CHANGE_TOOLS)
      expect(offered).not.toContain(name)
    expect(first.chunks.filter(chunk => chunk.type === 'tool-approval-request')).toHaveLength(1)
    const pending = await detailOf(t, chatId)
    expect(toolParts(pending.messages[1]).map(part => [part.type, part.state])).toEqual([
      ['tool-todo_write', 'output-available'],
      ['tool-list_directory', 'output-available'],
      ['tool-exit_plan_mode', 'approval-requested'],
    ])
    expect(existsSync(`${project.path}/${MOCK_PLAN_NOTES_FILE}`)).toBe(false)

    const second = await readSse(await continueWith(t, chatId, 'mock:plan', 'edits', true))
    expect(second.chunks.some(chunk => chunk.type === 'tool-approval-request')).toBe(false)
    expect(streamedText(second.chunks)).toContain('Plan done in mode edits.')
    expect(await readFile(`${project.path}/${MOCK_PLAN_NOTES_FILE}`, 'utf8')).toBe(MOCK_PLAN_NOTES_CONTENT)
    const done = await detailOf(t, chatId)
    expect(done.pendingApproval).toBe(false)
    expect(toolParts(done.messages[1]).map(part => part.state)).toEqual(['output-available', 'output-available', 'output-available', 'output-available'])
    const rows = await t.db.select().from(workspaceChanges).where(eq(workspaceChanges.chatId, chatId))
    expect(rows.map(row => row.tool)).toEqual(['write_file'])
    await runnerOf(t).idle()
  })

  it('keep planning with feedback -> "Revising: <feedback>" and a new card, nothing written', async () => {
    const chatId = newChatId()
    await readSse(await postChat(t, chatBody(chatId, 'make a plan', { modelRef: 'mock:plan', toolMode: 'plan', projectId: project.id })))
    const second = await readSse(await continueWith(t, chatId, 'mock:plan', 'plan', false, 'Use a table'))
    expect(streamedText(second.chunks)).toContain('Revising: Use a table')
    expect(second.chunks.filter(chunk => chunk.type === 'tool-approval-request')).toHaveLength(1)
    const detail = await detailOf(t, chatId)
    expect(detail.pendingApproval).toBe(true)
    const plans = toolParts(detail.messages[1]).filter(part => part.type === 'tool-exit_plan_mode')
    expect(plans.map(part => part.state)).toEqual(['output-denied', 'approval-requested'])
    expect(existsSync(`${project.path}/${MOCK_PLAN_NOTES_FILE}`)).toBe(false)
    await runnerOf(t).idle()
  })

  it('outside plan mode it answers "Plan mode is off."; mock:workspace in plan gets no write tool', async () => {
    const off = await readSse(await postChat(t, chatBody(newChatId(), 'make a plan', { modelRef: 'mock:plan', toolMode: 'edits', projectId: project.id })))
    expect(streamedText(off.chunks)).toContain('Plan mode is off.')
    const workspace = await readSse(await postChat(t, chatBody(newChatId(), 'go', { modelRef: 'mock:workspace', toolMode: 'plan', projectId: project.id })))
    expect(streamedText(workspace.chunks)).toBe('Workspace tools are not available.')
    expect(workspace.chunks.some(chunk => chunk.type === 'tool-approval-request')).toBe(false)
    await runnerOf(t).idle()
  })
})
