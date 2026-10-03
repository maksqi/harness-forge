import type { ToolCallContext, ToolDefinition, ToolWorkspace, ToolWorkspaceAccess } from '@harness-forge/plugin-sdk'
import type { ToolMode, ToolOverride } from '@harness-forge/shared'
import type { ApprovalOutcome, ApprovalTool, EffectivePolicy, HookDecision, ToolApprovalContext } from './approval.ts'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createSilentLogger } from '../logger.ts'
import {
  createToolApproval,
  DENIED_BY_HOOK,
  DENIED_BY_OVERRIDE,
  DENIED_BY_POLICY,
  DENIED_TOOLS_OFF,
  DENIED_UNAVAILABLE,
  evaluatePolicy,
  resolveApproval,
  toApprovalStatus,
  toolWorkspaceAccess,
} from './approval.ts'

const OVERRIDES: (ToolOverride | null)[] = [null, 'allow', 'ask', 'deny']
const HOOKS: (HookDecision | undefined)[] = [undefined, 'allow', 'ask', 'deny']
const MODES: ToolMode[] = ['off', 'ask', 'edits', 'auto']
const POLICIES: EffectivePolicy[] = ['safe', 'ask', 'always', 'deny']
const ACCESS: (ToolWorkspaceAccess | null)[] = [null, 'read', 'write', 'execute']

/** The expected outcome, written as the resolution table of ARCHITECTURE.md 6.2 / PLUGINS.md 10 (Phase 7: `edits`). */
function expected(override: ToolOverride | null, hook: HookDecision | undefined, mode: ToolMode, policy: EffectivePolicy, workspace: ToolWorkspaceAccess | null): ApprovalOutcome {
  const decision = { allow: 'approved', ask: 'user-approval', deny: 'denied' } as const
  if (override !== null)
    return decision[override]
  if (hook !== undefined)
    return decision[hook]
  if (policy === 'deny')
    return 'denied'
  if (mode === 'ask')
    return policy === 'safe' ? 'not-applicable' : 'user-approval'
  if (mode === 'edits')
    return policy === 'safe' || (policy === 'ask' && workspace === 'write') ? 'not-applicable' : 'user-approval'
  if (mode === 'auto')
    return policy === 'always' ? 'user-approval' : 'not-applicable'
  return 'denied'
}

const MATRIX = OVERRIDES.flatMap(override => HOOKS.flatMap(hook => MODES.flatMap(mode => POLICIES.flatMap(policy => ACCESS.map(workspace => ({ override, hook, mode, policy, workspace }))))))

describe('resolveApproval (resolution table)', () => {
  it('covers every (override, hook, mode, policy, workspace access) combination', () => {
    expect(MATRIX).toHaveLength(4 * 4 * 4 * 4 * 4)
  })

  it.each(MATRIX)('override $override, hook $hook, mode $mode, policy $policy, workspace $workspace', ({ override, hook, mode, policy, workspace }) => {
    const result = resolveApproval({ override, hookDecision: hook, toolMode: mode, policy, workspace })
    expect(result.outcome).toBe(expected(override, hook, mode, policy, workspace))
    if (result.outcome === 'denied')
      expect(result.reason).toBeTypeOf('string')
    else
      expect(result.reason).toBeUndefined()
  })

  it('accept edits: safe tools and ask-policy write tools run; everything else asks, always included', () => {
    const edits = (policy: EffectivePolicy, workspace: ToolWorkspaceAccess | null): ApprovalOutcome =>
      resolveApproval({ override: null, hookDecision: undefined, toolMode: 'edits', policy, workspace }).outcome
    expect(edits('safe', null)).toBe('not-applicable')
    expect(edits('safe', 'read')).toBe('not-applicable')
    expect(edits('ask', 'write')).toBe('not-applicable')
    expect(edits('ask', null)).toBe('user-approval')
    expect(edits('ask', 'read')).toBe('user-approval')
    expect(edits('ask', 'execute')).toBe('user-approval')
    expect(edits('always', 'write')).toBe('user-approval')
    expect(edits('always', null)).toBe('user-approval')
    expect(resolveApproval({ override: null, hookDecision: undefined, toolMode: 'edits', policy: 'deny', workspace: 'write' })).toEqual({ outcome: 'denied', reason: DENIED_BY_POLICY })
    // Overrides and hooks keep precedence in every mode.
    expect(resolveApproval({ override: 'ask', hookDecision: undefined, toolMode: 'edits', policy: 'ask', workspace: 'write' }).outcome).toBe('user-approval')
    expect(resolveApproval({ override: 'allow', hookDecision: undefined, toolMode: 'edits', policy: 'always', workspace: 'execute' }).outcome).toBe('approved')
    expect(resolveApproval({ override: null, hookDecision: 'ask', toolMode: 'edits', policy: 'ask', workspace: 'write' }).outcome).toBe('user-approval')
  })

  it('names the reason of an automatic denial', () => {
    expect(resolveApproval({ override: 'deny', hookDecision: 'allow', toolMode: 'auto', policy: 'safe', workspace: null }).reason).toBe(DENIED_BY_OVERRIDE)
    expect(resolveApproval({ override: null, hookDecision: 'deny', toolMode: 'auto', policy: 'safe', workspace: null }).reason).toBe(DENIED_BY_HOOK)
    expect(resolveApproval({ override: null, hookDecision: undefined, toolMode: 'auto', policy: 'deny', workspace: null }).reason).toBe(DENIED_BY_POLICY)
    expect(resolveApproval({ override: null, hookDecision: undefined, toolMode: 'off', policy: 'safe', workspace: null }).reason).toBe(DENIED_TOOLS_OFF)
  })

  it('reads the workspace access of a definition; an unknown value counts as execute', () => {
    expect(toolWorkspaceAccess({})).toBeNull()
    expect(toolWorkspaceAccess({ workspace: 'read' })).toBe('read')
    expect(toolWorkspaceAccess({ workspace: 'write' })).toBe('write')
    expect(toolWorkspaceAccess({ workspace: 'execute' })).toBe('execute')
    expect(toolWorkspaceAccess({ workspace: 'everything' as ToolWorkspaceAccess })).toBe('execute')
    expect(toolWorkspaceAccess({ workspace: null as unknown as ToolWorkspaceAccess })).toBeNull()
  })

  it('maps results to AI SDK statuses', () => {
    expect(toApprovalStatus({ outcome: 'not-applicable' })).toBe('not-applicable')
    expect(toApprovalStatus({ outcome: 'user-approval' })).toBe('user-approval')
    expect(toApprovalStatus({ outcome: 'approved' })).toBe('approved')
    expect(toApprovalStatus({ outcome: 'denied', reason: 'no' })).toEqual({ type: 'denied', reason: 'no' })
  })
})

function definition(policy: ToolDefinition['policy'], workspace?: ToolWorkspaceAccess): ToolDefinition {
  return { name: 'demo_tool', description: 'Demo.', inputSchema: z.object({}), policy, ...(workspace === undefined ? {} : { workspace }), execute: async () => ({}) }
}

/** A guard like the host's: runs `fn`, rejects with `plugin_error`-like errors on throw or after `timeoutMs`. */
const guard: ToolApprovalContext['plugins']['guard'] = async (_pluginId, fn, options) => {
  const controller = new AbortController()
  return Promise.race([
    Promise.resolve().then(() => fn(controller.signal)),
    new Promise<never>((_resolve, reject) => setTimeout(() => {
      controller.abort()
      reject(new Error('timed out'))
    }, options.timeoutMs)),
  ])
}

function context(overrides: Partial<ToolApprovalContext> & { tool?: ApprovalTool } = {}): ToolApprovalContext {
  const tool = overrides.tool ?? { pluginId: 'demo', definition: definition('ask') }
  return {
    chatId: 'chat',
    modelRef: 'mock:echo',
    toolMode: 'ask',
    tools: new Map([[tool.definition.name, tool]]),
    prefs: new Map(),
    registry: { hooks: { run: async () => {}, on: () => ({ dispose() {} }), list: () => [] } },
    plugins: { guard },
    signal: new AbortController().signal,
    logger: createSilentLogger(),
    ...overrides,
  }
}

const call = { toolCall: { toolName: 'demo_tool', toolCallId: 'call_1', input: {} }, messages: [] }

describe('createToolApproval', () => {
  it('denies a tool the run does not offer, whatever the override', async () => {
    const approve = createToolApproval(context({ prefs: new Map([['other_tool', { enabled: true, override: 'allow' }]]) }))
    expect(await approve({ ...call, toolCall: { ...call.toolCall, toolName: 'other_tool' } })).toEqual({ type: 'denied', reason: DENIED_UNAVAILABLE })
  })

  it('applies the user override before the hook and the policy', async () => {
    const run = vi.fn(async () => {})
    const approve = createToolApproval(context({ prefs: new Map([['demo_tool', { enabled: true, override: 'allow' }]]), registry: { hooks: { run, on: () => ({ dispose() {} }), list: () => [] } } }))
    expect(await approve(call)).toBe('approved')
    expect(run).not.toHaveBeenCalled()
  })

  it('uses the tool.approve hook decision and ignores invalid ones', async () => {
    let decision: unknown = 'deny'
    const hooks = {
      run: async (_name: string, input: unknown, output: unknown) => {
        expect(input).toMatchObject({ chatId: 'chat', modelRef: 'mock:echo', tool: 'demo_tool', toolCallId: 'call_1', input: {} });
        (output as { decision?: unknown }).decision = decision
      },
      on: () => ({ dispose() {} }),
      list: () => [],
    } as unknown as ToolApprovalContext['registry']['hooks']
    const approve = createToolApproval(context({ registry: { hooks } }))
    expect(await approve(call)).toEqual({ type: 'denied', reason: DENIED_BY_HOOK })
    decision = 'maybe'
    expect(await approve(call)).toBe('user-approval')
  })

  it('evaluates a policy function; a throw or timeout counts as always', async () => {
    const safe = createToolApproval(context({ tool: { pluginId: 'demo', definition: definition(() => 'safe') } }))
    expect(await safe(call)).toBe('not-applicable')
    const deny = createToolApproval(context({ tool: { pluginId: 'demo', definition: definition(async () => 'deny' as const) } }))
    expect(await deny(call)).toEqual({ type: 'denied', reason: DENIED_BY_POLICY })
    const throws = createToolApproval(context({ toolMode: 'auto', tool: { pluginId: 'demo', definition: definition(() => {
      throw new Error('boom')
    }) } }))
    expect(await throws(call)).toBe('user-approval')
  })

  it('treats a hanging policy function as always after the guard timeout', async () => {
    vi.useFakeTimers()
    try {
      const tool = { pluginId: 'demo', definition: definition(() => new Promise<never>(() => {})) }
      const pending = evaluatePolicy(tool, {}, { chatId: 'chat', modelRef: 'mock:echo', toolCallId: 'call_1', messages: [] }, { guard }, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(3000)
      expect(await pending).toBe('always')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('defaults to policy ask and asks the user when something unexpected fails', async () => {
    const noPolicy = createToolApproval(context({ tool: { pluginId: 'demo', definition: definition(undefined) } }))
    expect(await noPolicy(call)).toBe('user-approval')
    const prefs = {
      get: () => {
        throw new Error('db down')
      },
    } as unknown as ToolApprovalContext['prefs']
    const broken = createToolApproval(context({ prefs }))
    expect(await broken(call)).toBe('user-approval')
  })
})

describe('createToolApproval in accept edits mode (Phase 7)', () => {
  const workspace: ToolWorkspace = Object.freeze({ projectId: 'prj_0123456789abcdef', name: 'Demo', root: '/srv/demo' })

  it('runs an ask-policy write tool, asks for an execute tool and for a write tool whose policy says always', async () => {
    const write = createToolApproval(context({ toolMode: 'edits', workspace, tool: { pluginId: 'core-workspace', definition: definition('ask', 'write') } }))
    expect(await write(call)).toBe('not-applicable')
    const shell = createToolApproval(context({ toolMode: 'edits', workspace, tool: { pluginId: 'core-workspace', definition: definition('ask', 'execute') } }))
    expect(await shell(call)).toBe('user-approval')
    const hidden = createToolApproval(context({ toolMode: 'edits', workspace, tool: { pluginId: 'core-workspace', definition: definition(() => 'always', 'write') } }))
    expect(await hidden(call)).toBe('user-approval')
    const plain = createToolApproval(context({ toolMode: 'edits', tool: { pluginId: 'demo', definition: definition('ask') } }))
    expect(await plain(call)).toBe('user-approval')
    const safe = createToolApproval(context({ toolMode: 'edits', tool: { pluginId: 'demo', definition: definition('safe') } }))
    expect(await safe(call)).toBe('not-applicable')
  })

  it('keeps the override and the tool.approve hook ahead of the edits rule', async () => {
    const tool = { pluginId: 'core-workspace', definition: definition('ask', 'write') }
    const override = createToolApproval(context({ toolMode: 'edits', workspace, tool, prefs: new Map([['demo_tool', { enabled: true, override: 'ask' }]]) }))
    expect(await override(call)).toBe('user-approval')
    const hooks = {
      run: async (_name: string, _input: unknown, output: unknown) => {
        (output as { decision?: unknown }).decision = 'ask'
      },
      on: () => ({ dispose() {} }),
      list: () => [],
    } as unknown as ToolApprovalContext['registry']['hooks']
    const hooked = createToolApproval(context({ toolMode: 'edits', workspace, tool, registry: { hooks } }))
    expect(await hooked(call)).toBe('user-approval')
  })

  it('passes the workspace of the run to the policy function (absent without one)', async () => {
    const seen: (ToolWorkspace | undefined)[] = []
    const policy = (_input: unknown, c: ToolCallContext) => {
      seen.push(c.workspace)
      return 'safe' as const
    }
    const tool = { pluginId: 'core-workspace', definition: definition(policy, 'read') }
    await createToolApproval(context({ workspace, tool }))(call)
    await createToolApproval(context({ workspace: null, tool }))(call)
    await createToolApproval(context({ tool }))(call)
    expect(seen).toEqual([workspace, undefined, undefined])
    expect(seen[0]).toBe(workspace)
  })
})
