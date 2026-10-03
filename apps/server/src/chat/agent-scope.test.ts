// The agent scope side channel (Phase 9, C26-T4): unbound contexts answer null, a bound scope is a frozen copy, nothing
// is added to the context object (a plugin cannot reach the runner), and `wrapToolExecute` binds the run's scope to the
// call context of every tool call (only when the run has one: sub-agents bind none).
import type { ToolCallContext, ToolDefinition } from '@harness-forge/plugin-sdk'
import type { TaskOutput } from '@harness-forge/shared'
import type { ToolExecutionOptions } from 'ai'
import type { AgentRunScope } from './agent-scope.ts'
import type { ToolWrapContext } from './tools.ts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { agentScopeOf, bindAgentScope } from './agent-scope.ts'
import { wrapToolExecute } from './tools.ts'

function scope(overrides: Partial<AgentRunScope> = {}): AgentRunScope {
  return {
    chatId: '0199a8f0-0000-7000-8000-000000000001',
    messageId: 'msg_a000000000000001',
    toolMode: 'ask',
    async* runSubagent(): AsyncGenerator<TaskOutput> {},
    todos: () => null,
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
