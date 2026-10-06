// The Phase 12 seams of a child's host (C44-T4, ADR-057 / ADR-058): the child spec (`ChildAgentSpec`, `childMaxSteps`,
// `DEFAULT_CHILD_SPEC`), the first user message with the `SubagentStart` context (`childFirstMessage`), `SubagentStart`
// run before the child's step 0 over the C43 fake snapshot, and `childTools({ disallowedTools })`.
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { ToolCallContext } from '@harness-forge/plugin-sdk'
import type { McpServer, TaskInput, TaskOutput } from '@harness-forge/shared'
import type { ResolvedModel } from '../../providers/types.ts'
import type { RegisteredTool } from '../../registry/types.ts'
import type { FakeHookSnapshotOptions } from '../../testing/fake-hooks.ts'
import type { RunSession } from '../pipeline.ts'
import { hookModelText, LIMITS } from '@harness-forge/shared'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createSilentLogger } from '../../logger.ts'
import { createFakeBackgroundTasks } from '../../testing/fake-background-tasks.ts'
import { createFakeCustomizationService } from '../../testing/fake-customizations.ts'
import { createFakeHookSnapshot, fakeHookResult } from '../../testing/fake-hooks.ts'
import { createRunHooks } from '../hooks.ts'
import { testCatalog } from '../testing.ts'
import { childFirstMessage, childMaxSteps, DEFAULT_CHILD_SPEC } from './host.ts'
import { childSpec, createSubagentRunner } from './index.ts'
import { childTools } from './tools.ts'

const MESSAGE_ID = 'msg_a000000000000001'
const TASK: TaskInput = { description: 'Check the build', prompt: 'Build the project and report.', type: 'general' }

describe('the child spec (Phase 12)', () => {
  it('dEFAULT_CHILD_SPEC changes nothing; maxTurns lowers the step limit within its bounds', () => {
    expect(DEFAULT_CHILD_SPEC).toEqual({ maxTurns: null, skillsText: null, disallowedTools: null })
    expect(Object.isFrozen(DEFAULT_CHILD_SPEC)).toBe(true)
    expect(childMaxSteps(30, DEFAULT_CHILD_SPEC)).toBe(30)
    expect(childMaxSteps(30, { maxTurns: 2 })).toBe(2)
    expect(childMaxSteps(5, { maxTurns: 50 })).toBe(5)
    for (const ignored of [0, -1, 1.5, Number.NaN, LIMITS.agentMaxTurnsMax + 1])
      expect(childMaxSteps(30, { maxTurns: ignored })).toBe(30)
    expect(childMaxSteps(0, DEFAULT_CHILD_SPEC)).toBe(1)
  })

  it('childSpec (the C44 stub W12.6 implements) answers the default spec; an aborted signal rejects', async () => {
    const choice = { name: 'general', base: 'general' as const, entry: null, agent: { source: 'builtin' as const, description: 'General.' } }
    const definition = { name: 'reviewer', description: 'Reviews.', tools: null, model: null, instructions: 'Review.', maxTurns: 2, skills: ['pdf'], disallowedTools: ['shell'] }
    expect(await childSpec({} as RunSession, choice, definition, new AbortController().signal)).toBe(DEFAULT_CHILD_SPEC)
    const controller = new AbortController()
    controller.abort(new DOMException('stopped', 'AbortError'))
    await expect(childSpec({} as RunSession, choice, null, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('childFirstMessage: the prompt alone, or the prompt then the SubagentStart context', () => {
    expect(childFirstMessage('Do it.', null)).toEqual({ role: 'user', content: [{ type: 'text', text: 'Do it.' }] })
    expect(childFirstMessage('Do it.', '   ')).toEqual({ role: 'user', content: [{ type: 'text', text: 'Do it.' }] })
    const context = hookModelText({ event: 'SubagentStart', outcome: 'context', context: 'Use staging.' }, 'user')!
    expect(context).toContain('<hook-context event="SubagentStart">')
    expect(childFirstMessage('Do it.', ' Use staging. ')).toEqual({ role: 'user', content: [{ type: 'text', text: 'Do it.' }, { type: 'text', text: context }] })
  })
})

function finishPart(): LanguageModelV4StreamPart {
  return {
    type: 'finish',
    usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } },
    finishReason: { unified: 'stop', raw: 'stop' },
  }
}

function scripted(text: string) {
  const calls: LanguageModelV4CallOptions[] = []
  const model = new MockLanguageModelV4({
    provider: 'testkit',
    modelId: 'child',
    doStream: async (options) => {
      calls.push(options)
      return { stream: convertArrayToReadableStream([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, finishPart()]) }
    },
  })
  return { model, calls }
}

function resolvedModel(model: LanguageModelV4): ResolvedModel {
  return {
    modelRef: 'testkit:child',
    providerId: 'testkit',
    modelId: 'child',
    info: { id: 'child', name: 'child' },
    entry: {
      ref: 'testkit:child',
      kind: 'chat',
      contextWindow: 128_000,
      capabilities: { tools: true, vision: false, pdf: false, reasoning: false, structuredOutput: false, imageOutput: false },
      reasoningEfforts: [],
      cost: { input: 1, output: 2 },
    },
    provider: { definition: {}, pluginId: 'testkit' },
    model,
  } as unknown as ResolvedModel
}

/** A parent run without tools whose one hook snapshot is scripted by `options`. */
function parent(options: FakeHookSnapshotOptions) {
  const snapshot = createFakeHookSnapshot(options)
  const logger = createSilentLogger()
  const deps = {
    registry: {
      tools: { list: () => [], get: () => undefined, register: () => ({ dispose() {} }) },
      hooks: { run: async () => {}, on: () => ({ dispose() {} }), list: () => [] },
    },
    plugins: { guard: async <T>(_id: string, fn: (signal: AbortSignal) => T | Promise<T>) => fn(new AbortController().signal), isActive: () => true },
    tools: { prefs: async () => new Map() },
    mcp: { list: async () => [] },
    env: { workspaceShell: true },
    providers: { resolveModel: async () => Promise.reject(new Error('no model')), mapError: (_id: string, error: unknown) => error },
    chats: { addUsage: async () => {} },
    redactor: { redactText: (text: string) => text },
    customizations: createFakeCustomizationService(),
  }
  const session = {
    chatId: 'chat',
    assistantId: MESSAGE_ID,
    notices: [],
    addExtraCost: () => {},
    inject: () => {},
    writeTransient: () => {},
    ctx: {
      deps,
      prepared: { settings: { instructions: null, subagentModelRef: null, subagentMaxSteps: 30, autoCompact: false, compactModelRef: null }, chat: { settings: {} }, history: [] },
      reasoningEffort: 'auto',
      run: { signal: new AbortController().signal },
      now: () => Date.now(),
      logger,
    },
  } as unknown as RunSession
  Object.assign(session, { hooks: createRunHooks({ snapshot, host: { stepNumber: 0, inject: () => {}, writeTransient: () => {} }, continued: null, messageId: MESSAGE_ID, logger }) })
  return { session, snapshot }
}

async function runChild(session: RunSession, model: LanguageModelV4, task: TaskInput = TASK): Promise<TaskOutput[]> {
  const runner = createSubagentRunner({
    session,
    model: resolvedModel(model),
    toolMode: 'auto',
    workspace: null,
    scope: null,
    catalog: testCatalog(),
    background: createFakeBackgroundTasks(),
    origin: 'request',
  })
  const outputs: TaskOutput[] = []
  for await (const output of runner.run(task, { toolCallId: 'call_parent', signal: new AbortController().signal }))
    outputs.push(output)
  return outputs
}

describe('subagentStart before the child\'s step 0 (C44 seam over the C43 fake snapshot)', () => {
  it('runs SubagentStart with the agent and adds its context to the child\'s first user message', async () => {
    const p = parent({ results: { SubagentStart: fakeHookResult({ context: 'Use the staging database.' }) } })
    const { model, calls } = scripted('Done.')
    const final = (await runChild(p.session, model)).at(-1)!
    expect(final).toMatchObject({ status: 'completed', report: 'Done.' })
    expect(p.snapshot.calls[0]).toMatchObject({
      event: 'SubagentStart',
      input: { messageId: MESSAGE_ID, agent: { id: 'call_parent', type: 'general' } },
      options: { target: 'general', aliases: ['general', 'general-purpose'] },
    })
    const context = hookModelText({ event: 'SubagentStart', outcome: 'context', context: 'Use the staging database.' }, 'user')!
    expect(calls[0]?.prompt.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: TASK.prompt, providerOptions: undefined }, { type: 'text', text: context, providerOptions: undefined }],
      providerOptions: undefined,
    })
  })

  it('without SubagentStart hooks (or without a context) the first message is the prompt alone', async () => {
    for (const options of [{}, { results: { SubagentStart: fakeHookResult() } }] satisfies FakeHookSnapshotOptions[]) {
      const p = parent(options)
      const { model, calls } = scripted('Done.')
      expect((await runChild(p.session, model, { ...TASK, type: 'explore' })).at(-1)?.status).toBe('completed')
      expect(calls[0]?.prompt.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: TASK.prompt, providerOptions: undefined }], providerOptions: undefined })
    }
  })
})

describe('childTools: an agent\'s disallowedTools (C44 seam)', () => {
  function tool(name: string, mcpServerId: string | null = null): RegisteredTool {
    return {
      pluginId: mcpServerId === null ? 'acme' : 'core-mcp',
      mcpServerId,
      title: null,
      definition: { name, description: name, inputSchema: z.object({}), policy: 'safe', execute: async (_input: unknown, _c: ToolCallContext) => 'ok' },
    }
  }

  async function names(disallowedTools: readonly string[] | null | undefined, allowlist: readonly string[] | null = null): Promise<string[]> {
    const tools = [tool('current_time'), tool('acme_safe'), tool('mcp__srv__lookup', 'srv'), tool('mcp__srv__search', 'srv')]
    const deps = {
      registry: {
        tools: { list: () => tools, get: (name: string) => tools.find(entry => entry.definition.name === name), register: () => ({ dispose() {} }) },
        hooks: { run: async () => {}, on: () => ({ dispose() {} }), list: () => [] },
      },
      plugins: { guard: async <T>(_id: string, fn: (signal: AbortSignal) => T | Promise<T>) => fn(new AbortController().signal), isActive: () => true },
      tools: { prefs: async () => new Map() },
      mcp: { list: async () => [{ id: 'srv', status: 'connected' }] as McpServer[] },
      env: { workspaceShell: true },
    }
    const session = { chatId: 'chat', assistantId: MESSAGE_ID, ctx: { deps, logger: createSilentLogger() } } as unknown as RunSession
    const child = await childTools({
      session,
      type: 'general',
      toolMode: 'auto',
      model: { modelRef: 'mock:subagent', entry: { capabilities: { tools: true } } } as unknown as ResolvedModel,
      workspace: null,
      scope: null,
      parentCallId: 'call_parent',
      signal: new AbortController().signal,
      allowlist,
      ...(disallowedTools === undefined ? {} : { disallowedTools }),
    })
    return Object.keys(child.tools).sort()
  }

  it('removes the tools it matches before the allowlist narrows; null or absent removes nothing', async () => {
    const all = ['acme_safe', 'current_time', 'mcp__srv__lookup', 'mcp__srv__search']
    expect(await names(undefined)).toEqual(all)
    expect(await names(null)).toEqual(all)
    expect(await names(['current_time'])).toEqual(['acme_safe', 'mcp__srv__lookup', 'mcp__srv__search'])
    expect(await names(['mcp__srv__*'])).toEqual(['acme_safe', 'current_time'])
    // Restrict-only: an allowlist cannot bring a disallowed tool back.
    expect(await names(['acme_safe'], ['acme_safe', 'current_time'])).toEqual(['current_time'])
  })
})
