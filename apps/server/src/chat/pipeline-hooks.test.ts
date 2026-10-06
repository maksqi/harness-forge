// The Phase 11 seams of the run pipeline (C37-T5), end to end over `POST /api/chat` and `launchRun` with the C36 fakes
// (`createTestApp({ hooks: 'fake', projectMcp: 'fake' })`) and a scripted test-kit model:
// - one hook snapshot per model run with the run's scope; PreToolUse deny / rewrite, PostToolUse context and stop;
// - the `Stop` gate: no hooks → nothing runs (zero cost), a block → the record ends the reply and a follow-up reaches
//   `onReleased`, an abort during the hooks cancels it;
// - project MCP tools: `toolsFor` only for project chats, the extra tools offered, the notice `project-mcp-unavailable`.
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { ChatDetail, ChatRequestBody, HarnessUIMessage, HookData } from '@harness-forge/shared'
import type { TestApp } from '../testing/create-test-app.ts'
import type { FakeHookService } from '../testing/fake-hooks.ts'
import type { FakeProjectMcpManager } from '../testing/fake-project-mcp.ts'
import type { FakeProjectService } from '../testing/fake-projects.ts'
import type { RunEnding } from './history.ts'
import type { RunReleaseFollowUp } from './types.ts'
import { chatDetailSchema, hookModelText, LIMITS } from '@harness-forge/shared'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createSilentLogger } from '../logger.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { fakeHookRecord, fakeHookResult, hookTargetKey } from '../testing/fake-hooks.ts'
import { fakeProjectMcpTool, fakeProjectMcpTools } from '../testing/fake-project-mcp.ts'
import { createFakeProjectService } from '../testing/fake-projects.ts'
import { createBackgroundTasks } from './background/index.ts'
import { NOTICES } from './notices.ts'
import { launchRun, TaskTracker } from './pipeline.ts'
import { commitHistory, prepareRun } from './prepare.ts'
import { createChatQueue } from './queue.ts'
import { createRunRegistry } from './runs.ts'
import { chatBody, postChat, readSse, runnerOf, testChatId } from './testing.ts'

let nextChat = 11_000

function newChatId(): string {
  nextChat += 1
  return testChatId(nextChat)
}

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

function callParts(toolName: string, input: unknown, toolCallId = 'call_1'): LanguageModelV4StreamPart[] {
  return [{ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) }, finishPart('tool-calls')]
}

/** A model that answers from its call options (calls recorded); a title request gets a short text. */
function scriptedModel(script: (call: number, options: LanguageModelV4CallOptions) => LanguageModelV4StreamPart[]): { model: LanguageModelV4, calls: LanguageModelV4CallOptions[] } {
  const calls: LanguageModelV4CallOptions[] = []
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      calls.push(options)
      return { stream: convertArrayToReadableStream(script(calls.length, options)) }
    },
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'Title' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      warnings: [],
    }),
  })
  return { model, calls }
}

function toolNames(call: LanguageModelV4CallOptions | undefined): string[] {
  return (call?.tools ?? []).flatMap(tool => (tool.type === 'function' ? [tool.name] : [])).sort()
}

function userTexts(call: LanguageModelV4CallOptions | undefined): string[] {
  return (call?.prompt ?? []).flatMap(message => (message.role === 'user' ? message.content.flatMap(part => (part.type === 'text' ? [part.text] : [])) : []))
}

describe('pipeline seams (Phase 11, C37-T5)', () => {
  let t: TestApp
  let hooks: FakeHookService
  let projectMcp: FakeProjectMcpManager
  let projects: FakeProjectService
  const disposables: Disposable[] = []
  const scripted = new Map<string, LanguageModelV4>()
  const probes: unknown[] = []

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, hooks: 'fake', projectMcp: 'fake', factories: { projects: createFakeProjectService } })
    hooks = t.deps.hooks as FakeHookService
    projectMcp = t.deps.projectMcp as FakeProjectMcpManager
    projects = t.deps.projects as FakeProjectService
    disposables.push(t.deps.registry.providers.register('mock', {
      id: 'hookkit',
      name: 'Hook kit',
      credentials: [],
      seedModels: [{ id: 'agent', name: 'Agent', contextWindow: 64_000, capabilities: { tools: true } }],
      createLanguageModel: (modelId) => {
        const model = scripted.get(modelId)
        if (model === undefined)
          throw new Error(`No scripted model "${modelId}".`)
        return model
      },
    }))
    disposables.push(t.deps.registry.tools.register('mock', {
      name: 'hook_probe',
      description: 'Records its input.',
      inputSchema: z.object({ text: z.string() }),
      policy: 'safe',
      execute: async (input) => {
        probes.push(input)
        return { echoed: (input as { text: string }).text }
      },
    }))
  })

  beforeEach(() => {
    scripted.clear()
    probes.length = 0
    hooks.results.clear()
    hooks.targets.clear()
    hooks.present.clear()
    hooks.runCalls.length = 0
    hooks.snapshots.length = 0
    projectMcp.tools.clear()
    projectMcp.toolsCalls.length = 0
  })

  afterAll(async () => {
    for (const disposable of disposables)
      disposable.dispose()
    await t.close()
  })

  function body(chatId: string, text: string, overrides: Partial<ChatRequestBody> = {}): ChatRequestBody {
    return chatBody(chatId, text, { modelRef: 'hookkit:agent', toolMode: 'ask', ...overrides })
  }

  async function detail(chatId: string): Promise<ChatDetail> {
    return chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId}`)).json())
  }

  async function post(request: ChatRequestBody): Promise<HarnessUIMessage> {
    await readSse(await postChat(t, request))
    await runnerOf(t).idle()
    return (await detail(request.chatId)).messages.at(-1)!
  }

  /** `prepareRun` + `commitHistory` + `launchRun` with a recording `onReleased` (what `startRun` does). */
  async function launch(request: ChatRequestBody, options: { abortDuringStop?: boolean } = {}) {
    const registry = createRunRegistry()
    const run = registry.acquire(request.chatId, request.modelRef)
    const logger = createSilentLogger()
    const prepared = await prepareRun(t.deps, run, request, logger)
    await commitHistory(t.deps, request.chatId, prepared.writes)
    const released: { ending: RunEnding, awaitingApproval: boolean, followUp: RunReleaseFollowUp | undefined }[] = []
    if (options.abortDuringStop === true) {
      const result = hooks.results.get('Stop')
      hooks.results.set('Stop', async (input, runOptions) => {
        run.controller.abort(new DOMException('stopped', 'AbortError'))
        return typeof result === 'function' ? result(input, runOptions) : result!
      })
    }
    const tasks = new TaskTracker()
    const response = await launchRun({
      deps: t.deps,
      registry,
      run,
      prepared,
      toolMode: request.toolMode,
      reasoningEffort: request.reasoningEffort,
      logger,
      now: Date.now,
      tasks,
      titleTimeoutMs: 1000,
      lifecycle: new AbortController().signal,
      queue: createChatQueue(t.deps, { hasRun: () => false, now: Date.now }),
      onReleased: (ending, awaitingApproval, followUp) => released.push({ ending, awaitingApproval, followUp }),
      origin: 'request',
      background: createBackgroundTasks(t.deps, { hasRun: () => false, startTaskTurn: async () => new Response(null) }),
    })
    const { chunks } = await readSse(response)
    await run.settled
    await tasks.idle()
    await runnerOf(t).idle()
    return { chunks, released, reply: (await detail(request.chatId)).messages.at(-1)! }
  }

  it('takes one hook snapshot per model run with the run\'s scope; runs nothing without hooks', async () => {
    scripted.set('agent', scriptedModel(call => (call === 1 ? callParts('hook_probe', { text: 'a' }) : textParts('done'))).model)
    const chatId = newChatId()
    const reply = await post(body(chatId, 'go'))
    expect(hooks.snapshots).toHaveLength(1)
    expect(hooks.snapshots[0]!.scope).toEqual({ chatId, projectId: null, workspace: null, toolMode: 'ask', origin: 'request', modelRef: 'hookkit:agent' })
    expect(hooks.runCalls).toEqual([])
    expect(reply.parts.some(part => part.type === 'data-hook')).toBe(false)
    expect(probes).toEqual([{ text: 'a' }])
  })

  it('a PreToolUse deny blocks the call with the hook reason and stores the record', async () => {
    const record = fakeHookRecord('PreToolUse', 'denied', { toolCallId: 'call_1', toolName: 'hook_probe', reason: 'not now' })
    hooks.targets.set(hookTargetKey('PreToolUse', 'hook_probe'), fakeHookResult({ decision: 'deny', reason: 'not now', record }))
    scripted.set('agent', scriptedModel(call => (call === 1 ? callParts('hook_probe', { text: 'a' }) : textParts('done'))).model)
    const reply = await post(body(newChatId(), 'go'))
    expect(probes).toEqual([])
    const tool = reply.parts.find(part => part.type === 'tool-hook_probe') as { state?: string, approval?: { reason?: string } } | undefined
    expect(tool?.state).toBe('output-denied')
    expect(tool?.approval?.reason).toBe('Blocked by hook: not now')
    expect(reply.parts.filter(part => part.type === 'data-hook').map(part => (part as { data: HookData }).data)).toEqual([record])
    expect(hooks.runCalls.map(call => call.event)).toEqual(['PreToolUse'])
  })

  it('a PreToolUse rewrite runs the tool with the new input; the tool part keeps the model\'s input', async () => {
    const record = fakeHookRecord('PreToolUse', 'rewritten', { toolCallId: 'call_1', toolName: 'hook_probe', updatedInput: { text: 'rewritten' } })
    hooks.targets.set(hookTargetKey('PreToolUse', 'hook_probe'), fakeHookResult({ updatedInput: { text: 'rewritten' }, record }))
    scripted.set('agent', scriptedModel(call => (call === 1 ? callParts('hook_probe', { text: 'model' }) : textParts('done'))).model)
    const reply = await post(body(newChatId(), 'go'))
    expect(probes).toEqual([{ text: 'rewritten' }])
    const tool = reply.parts.find(part => part.type === 'tool-hook_probe') as { input?: unknown, output?: unknown } | undefined
    expect(tool?.input).toEqual({ text: 'model' })
    expect(tool?.output).toEqual({ echoed: 'rewritten' })
  })

  it('a PostToolUse context reaches the next step and the reply; continue: false ends the run after the step', async () => {
    const record = fakeHookRecord('PostToolUse', 'context', { toolCallId: 'call_1', toolName: 'hook_probe', context: 'lint ok' })
    hooks.results.set('PostToolUse', fakeHookResult({ context: 'lint ok', record }))
    const { model, calls } = scriptedModel(call => (call === 1 ? callParts('hook_probe', { text: 'a' }) : textParts('done')))
    scripted.set('agent', model)
    const reply = await post(body(newChatId(), 'go'))
    expect(userTexts(calls[1])).toEqual(['go', hookModelText(record, 'assistant')])
    const types = reply.parts.map(part => part.type)
    expect(types.indexOf('data-hook')).toBeGreaterThan(types.indexOf('tool-hook_probe'))

    hooks.results.set('PostToolUse', fakeHookResult({ continue: false, stopReason: 'enough', record: fakeHookRecord('PostToolUse', 'stopped', { toolCallId: 'call_1' }) }))
    const looping = scriptedModel(call => callParts('hook_probe', { text: String(call) }, `call_${call}`))
    scripted.set('agent', looping.model)
    await post(body(newChatId(), 'loop'))
    expect(looping.calls.filter(call => (call.tools ?? []).length > 0)).toHaveLength(1)
  })

  it('the Stop gate costs nothing without Stop hooks and hands a follow-up over for a block', async () => {
    scripted.set('agent', scriptedModel(() => textParts('done')).model)
    const plain = await launch(body(newChatId(), 'hi'))
    expect(plain.released).toEqual([{ ending: 'completed', awaitingApproval: false, followUp: undefined }])
    expect(hooks.runCalls).toEqual([])

    const record = fakeHookRecord('Stop', 'continued', { reason: 'run the tests' })
    hooks.results.set('Stop', fakeHookResult({ block: true, reason: 'run the tests', record }))
    const blocked = await launch(body(newChatId(), 'hi'))
    expect(blocked.released).toEqual([{ ending: 'completed', awaitingApproval: false, followUp: { kind: 'hook', data: record } }])
    expect(hooks.runCalls.map(call => [call.event, call.input.stopHookActive])).toEqual([['Stop', false]])
    expect(blocked.reply.parts.at(-1)).toEqual({ type: 'data-hook', data: record })
    const chunkTypes = blocked.chunks.map(chunk => chunk.type)
    expect(chunkTypes.indexOf('data-hook')).toBe(chunkTypes.indexOf('finish') - 1)
  })

  it('a Stop during the Stop hooks cancels the follow-up; a run waiting for an approval runs no Stop hook', async () => {
    const record = fakeHookRecord('Stop', 'continued', { reason: 'again' })
    hooks.results.set('Stop', fakeHookResult({ block: true, record }))
    scripted.set('agent', scriptedModel(() => textParts('done')).model)
    const aborted = await launch(body(newChatId(), 'hi'), { abortDuringStop: true })
    expect(aborted.released).toHaveLength(1)
    expect(aborted.released[0]!.followUp).toBeUndefined()

    hooks.results.set('Stop', fakeHookResult({ block: true, record }))
    hooks.present.add('Notification')
    hooks.runCalls.length = 0
    disposables.push(t.deps.registry.tools.register('mock', {
      name: 'hook_asking',
      description: 'Asks first.',
      inputSchema: z.object({}),
      policy: 'ask',
      execute: async () => 'ok',
    }))
    scripted.set('agent', scriptedModel(call => (call === 1 ? callParts('hook_asking', {}) : textParts('done'))).model)
    const waiting = await launch(body(newChatId(), 'hi'))
    expect(waiting.released).toEqual([{ ending: 'completed', awaitingApproval: true, followUp: undefined }])
    expect(hooks.runCalls.filter(call => call.event === 'Stop')).toEqual([])
    // One Notification for the approval request (fire-and-forget, never stored).
    expect(hooks.runCalls.filter(call => call.event === 'Notification').map(call => call.input)).toEqual([
      { messageId: waiting.reply.id, message: 'The agent needs your permission to use hook_asking.', notificationType: 'permission_prompt' },
    ])
    expect(waiting.reply.parts.some(part => part.type === 'data-hook')).toBe(false)
  })

  it('asks the project MCP manager only for project chats and offers its tools; not-ready servers get the notice', async () => {
    const project = await projects.add({ name: 'Mcp' })
    projectMcp.tools.set(project.id, fakeProjectMcpTools([fakeProjectMcpTool('docs', 'search', { policy: 'safe' })], { unavailable: ['Slow Server'], names: { docs: 'Docs' } }))
    const { model, calls } = scriptedModel(() => textParts('ok'))
    scripted.set('agent', model)
    await post(body(newChatId(), 'plain'))
    expect(projectMcp.toolsCalls).toEqual([])
    expect(toolNames(calls[0])).not.toContain('mcp__docs__search')

    const chatId = newChatId()
    const reply = await post(body(chatId, 'project', { projectId: project.id }))
    expect(projectMcp.toolsCalls).toEqual([{ projectId: project.id, waitMs: LIMITS.projectMcpConnectWaitMs }])
    expect(toolNames(calls.at(-1))).toContain('mcp__docs__search')
    expect(reply.parts.filter(part => part.type === 'data-notice').map(part => (part as { data: unknown }).data)).toContainEqual(NOTICES.projectMcpUnavailable(['Slow Server']))
    expect(hooks.snapshots.at(-1)!.scope).toMatchObject({ chatId, projectId: project.id, workspace: { projectId: project.id } })

    // Tools off: no project servers are started.
    projectMcp.toolsCalls.length = 0
    await post(body(newChatId(), 'off', { projectId: project.id, toolMode: 'off' }))
    expect(projectMcp.toolsCalls).toEqual([])
  })
})
