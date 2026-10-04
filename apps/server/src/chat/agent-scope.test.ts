// The agent scope side channel (Phase 9, C26-T4): unbound contexts answer null, a bound scope is a frozen copy, nothing
// is added to the context object (a plugin cannot reach the runner), and `wrapToolExecute` binds the run's scope to the
// call context of every tool call (only when the run has one: sub-agents bind none). Phase 10 (C31-T4): `loadSkill` and
// `savePlan` travel with the scope only, and their P10-0b stubs (`skills.ts`, `plan-file.ts`).
import type { ToolCallContext, ToolDefinition } from '@harness-forge/plugin-sdk'
import type { TaskOutput } from '@harness-forge/shared'
import type { ToolExecutionOptions } from 'ai'
import type { AppDeps } from '../types.ts'
import type { AgentRunScope } from './agent-scope.ts'
import type { ToolWrapContext } from './tools.ts'
import { DEFAULT_SETTINGS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createSilentLogger } from '../logger.ts'
import { agentScopeOf, bindAgentScope } from './agent-scope.ts'
import { savePlan } from './plan-file.ts'
import { loadSkill, SKILLS_UNAVAILABLE_TEXT } from './skills.ts'
import { testCatalog } from './testing.ts'
import { wrapToolExecute } from './tools.ts'

function scope(overrides: Partial<AgentRunScope> = {}): AgentRunScope {
  return {
    chatId: '0199a8f0-0000-7000-8000-000000000001',
    messageId: 'msg_a000000000000001',
    toolMode: 'ask',
    async* runSubagent(): AsyncGenerator<TaskOutput> {},
    todos: () => null,
    loadSkill: async (name) => {
      throw new Error(`no skill ${name}`)
    },
    savePlan: async () => ({}),
    ...overrides,
  }
}

describe('agent scope', () => {
  it('answers null for a context without a scope', () => {
    expect(agentScopeOf({})).toBeNull()
  })

  it('binds a frozen copy without adding anything to the context object', () => {
    const context = { chatId: 'c', modelRef: 'mock:echo', toolCallId: 'call_1' }
    const keys = Reflect.ownKeys(context)
    const bound = scope({ toolMode: 'plan' })
    bindAgentScope(context, bound)
    const read = agentScopeOf(context)
    expect(read).toEqual(bound)
    expect(read).not.toBe(bound)
    expect(Object.isFrozen(read)).toBe(true)
    expect(Reflect.ownKeys(context)).toEqual(keys)
    expect(Object.getOwnPropertySymbols(context)).toEqual([])
    expect(JSON.parse(JSON.stringify(context))).toEqual(context)
    bindAgentScope(context, scope({ toolMode: 'edits' }))
    expect(agentScopeOf(context)?.toolMode).toBe('edits')
    expect(agentScopeOf({ ...context })).toBeNull()
  })
})

describe('wrapToolExecute binds the agent scope', () => {
  function wrapContext(agent: AgentRunScope | null | undefined): ToolWrapContext {
    return {
      chatId: '0199a8f0-0000-7000-8000-000000000001',
      messageId: 'msg_a000000000000001',
      modelRef: 'mock:echo',
      registry: { hooks: { run: async () => {} } } as unknown as ToolWrapContext['registry'],
      plugins: { isActive: () => true, guard: async (_pluginId, fn) => fn(new AbortController().signal) },
      signal: new AbortController().signal,
      ...(agent === undefined ? {} : { agent }),
    }
  }

  it('to the call context of every call of a run with an agent scope, and to none without', async () => {
    const seen: (AgentRunScope | null)[] = []
    const definition: ToolDefinition = {
      name: 'probe',
      description: 'Probe.',
      inputSchema: z.object({}),
      policy: 'safe',
      execute: async (_input, c: ToolCallContext) => {
        seen.push(agentScopeOf(c))
        return { keys: Reflect.ownKeys(c).map(String).sort() }
      },
    }
    const options = { toolCallId: 'call_1', messages: [] } as unknown as ToolExecutionOptions<unknown>
    const bound = scope({ toolMode: 'auto' })
    const output = await wrapToolExecute({ pluginId: 'core-agent', definition }, wrapContext(bound))({}, options)
    await wrapToolExecute({ pluginId: 'core-agent', definition }, wrapContext(null))({}, options)
    await wrapToolExecute({ pluginId: 'core-agent', definition }, wrapContext(undefined))({}, options)
    expect(seen[0]).toEqual(bound)
    expect(seen.slice(1)).toEqual([null, null])
    // The plugin sees only the documented context fields.
    expect(output).toEqual({ keys: ['chatId', 'messages', 'modelRef', 'signal', 'toolCallId'] })
  })
})

describe('the Phase 10 members (C31-T4)', () => {
  it('a bound scope carries loadSkill and savePlan; an unbound context (a child, a plugin object) reaches neither', async () => {
    const plans: string[] = []
    const bound = scope({
      loadSkill: async name => ({ name, description: 'Release notes.', source: 'project', content: '# Notes', truncated: false }),
      savePlan: async (plan) => {
        plans.push(plan)
        return { planPath: '.harness/plans/2026-10-04-plan.md' }
      },
    })
    const context = { chatId: 'c', modelRef: 'mock:echo', toolCallId: 'call_1' }
    bindAgentScope(context, bound)
    const read = agentScopeOf(context)!
    expect(await read.loadSkill('release-notes', new AbortController().signal)).toMatchObject({ name: 'release-notes', content: '# Notes' })
    expect(await read.savePlan('# Plan', context as unknown as ToolCallContext)).toEqual({ planPath: '.harness/plans/2026-10-04-plan.md' })
    expect(plans).toEqual(['# Plan'])
    expect(Reflect.ownKeys(context)).toEqual(['chatId', 'modelRef', 'toolCallId'])
    expect(agentScopeOf({ ...context })).toBeNull()
  })

  it('the P10-0b stubs: loadSkill rejects not_found, savePlan writes no file', async () => {
    const deps = {} as AppDeps
    await expect(loadSkill({ deps, catalog: testCatalog(), workspace: null, logger: createSilentLogger() }, 'release-notes', new AbortController().signal))
      .rejects
      .toMatchObject({ code: 'not_found', message: SKILLS_UNAVAILABLE_TEXT })
    const aborted = new AbortController()
    aborted.abort(new Error('stopped'))
    await expect(loadSkill({ deps, catalog: testCatalog(), workspace: null, logger: createSilentLogger() }, 'x', aborted.signal)).rejects.toThrow('stopped')
    const c = { chatId: 'c', modelRef: 'mock:echo', toolCallId: 'call_1', messages: [], signal: new AbortController().signal, workspace: { projectId: 'prj_0123456789abcdef', name: 'Demo', root: '/tmp/demo' } }
    expect(await savePlan({ deps, settings: { ...DEFAULT_SETTINGS, planFiles: true }, logger: createSilentLogger(), now: () => 0 }, '# Plan', c)).toEqual({})
  })
})
