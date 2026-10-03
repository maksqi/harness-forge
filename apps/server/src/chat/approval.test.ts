import type { ToolCallContext, ToolDefinition, ToolWorkspace, ToolWorkspaceAccess } from '@harness-forge/plugin-sdk'
import type { ToolMode, ToolOverride } from '@harness-forge/shared'
import type { WorkspaceRunScope, WorkspaceRunScopeInit } from '../workspace/run-scope.ts'
import type { ApprovalOutcome, ApprovalTool, EffectivePolicy, HookDecision, ToolApprovalContext } from './approval.ts'
import { matchShellRules } from '@harness-forge/shared'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createSilentLogger } from '../logger.ts'
import { createFakeCheckpointService } from '../testing/fake-checkpoints.ts'
import { runScopeOf } from '../workspace/run-scope.ts'
import {
  createToolApproval,
  DENIED_BY_HOOK,
  DENIED_BY_OVERRIDE,
  DENIED_BY_POLICY,
  DENIED_TOOLS_OFF,
  DENIED_UNAVAILABLE,
  effectiveOverride,
  evaluatePolicy,
  isPlanExitTool,
  resolveApproval,
  staticApprovalOutcome,
  toApprovalStatus,
  toolWorkspaceAccess,
} from './approval.ts'

const OVERRIDES: (ToolOverride | null)[] = [null, 'allow', 'ask', 'deny']
const HOOKS: (HookDecision | undefined)[] = [undefined, 'allow', 'ask', 'deny']
const MODES: ToolMode[] = ['off', 'ask', 'edits', 'plan', 'auto']
const POLICIES: EffectivePolicy[] = ['safe', 'ask', 'always', 'deny']
const ACCESS: (ToolWorkspaceAccess | null)[] = [null, 'read', 'write', 'execute']

/**
 * The expected outcome, written as the resolution table of ARCHITECTURE.md 6.2 / PLUGINS.md 10 (Phase 7: `edits`;
 * Phase 9: `plan` resolves like `ask`).
 */
function expected(override: ToolOverride | null, hook: HookDecision | undefined, mode: ToolMode, policy: EffectivePolicy, workspace: ToolWorkspaceAccess | null): ApprovalOutcome {
  const decision = { allow: 'approved', ask: 'user-approval', deny: 'denied' } as const
  if (override !== null)
    return decision[override]
  if (hook !== undefined)
    return decision[hook]
  if (policy === 'deny')
    return 'denied'
  if (mode === 'ask' || mode === 'plan')
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
    expect(MATRIX).toHaveLength(4 * 4 * 5 * 4 * 4)
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

  it('plan (Phase 9): safe tools run, everything else asks, like ask', () => {
    const plan = (policy: EffectivePolicy, workspace: ToolWorkspaceAccess | null): ApprovalOutcome =>
      resolveApproval({ override: null, hookDecision: undefined, toolMode: 'plan', policy, workspace }).outcome
    expect(plan('safe', null)).toBe('not-applicable')
    expect(plan('safe', 'read')).toBe('not-applicable')
    expect(plan('ask', 'write')).toBe('user-approval')
    expect(plan('ask', null)).toBe('user-approval')
    expect(plan('always', null)).toBe('user-approval')
    expect(resolveApproval({ override: null, hookDecision: undefined, toolMode: 'plan', policy: 'deny', workspace: null })).toEqual({ outcome: 'denied', reason: DENIED_BY_POLICY })
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

// ---------- Phase 8: the run scope of policy functions, the ignored allow override on execute tools ----------

const PROJECT_ID = 'prj_0123456789abcdef'
const MESSAGE_ID = 'msg_a000000000000001'
const WORKSPACE: ToolWorkspace = Object.freeze({ projectId: PROJECT_ID, name: 'Demo', root: '/srv/demo' })

function runScope(prefixes: readonly string[] = ['ls', 'pnpm test']): WorkspaceRunScopeInit {
  return {
    chatId: 'chat',
    messageId: MESSAGE_ID,
    projectId: PROJECT_ID,
    journal: createFakeCheckpointService().journal({ chatId: 'chat', messageId: MESSAGE_ID, projectId: PROJECT_ID }),
    shellRules: Object.freeze({ projectId: PROJECT_ID, prefixes: Object.freeze([...prefixes]) }),
    shellCwd: { current: '.' },
  }
}

/** A stand-in of the core `shellPolicy`: `safe` when the run's rules match the whole command, else `ask`. */
function shellPolicy(input: unknown, c: ToolCallContext): 'safe' | 'ask' {
  const rules = runScopeOf(c)?.shellRules.prefixes ?? []
  return matchShellRules((input as { command: string }).command, rules).allowed ? 'safe' : 'ask'
}

/** The core `shell` as the approval function sees it (policy function, access `execute`). */
const SHELL: ApprovalTool = { pluginId: 'core-workspace', definition: { ...definition(shellPolicy, 'execute'), name: 'shell' } }

function shellCall(command: string) {
  return { toolCall: { toolName: 'shell', toolCallId: 'call_shell', input: { command } }, messages: [] }
}

function shellContext(overrides: Partial<ToolApprovalContext> = {}): ToolApprovalContext {
  return context({ tool: SHELL, workspace: WORKSPACE, scope: runScope(), ...overrides })
}

describe('createToolApproval: the run scope of policy functions (Phase 8)', () => {
  it('binds the scope with the call id to the policy context; nothing without a scope', async () => {
    const seen: Array<WorkspaceRunScope | null> = []
    const contexts: ToolCallContext[] = []
    const policy = (_input: unknown, c: ToolCallContext) => {
      seen.push(runScopeOf(c))
      contexts.push(c)
      return 'safe' as const
    }
    const tool = { pluginId: 'core-workspace', definition: definition(policy, 'execute') }
    const scope = runScope()
    await createToolApproval(context({ tool, workspace: WORKSPACE, scope }))(call)
    await createToolApproval(context({ tool, workspace: WORKSPACE, scope: null }))(call)
    await createToolApproval(context({ tool }))(call)
    expect(seen[0]).toEqual({ ...scope, toolCallId: 'call_1' })
    expect(seen[0]?.shellRules.prefixes).toEqual(['ls', 'pnpm test'])
    expect(seen[0]?.shellCwd).toBe(scope.shellCwd)
    expect(seen.slice(1)).toEqual([null, null])
    expect(Reflect.ownKeys(contexts[0]!).sort()).toEqual(['chatId', 'messages', 'modelRef', 'signal', 'toolCallId', 'workspace'])
  })

  it('evaluatePolicy binds a given scope to the context it creates', async () => {
    const scope = { ...runScope(), toolCallId: 'call_9' }
    let bound: WorkspaceRunScope | null = null
    const tool = { pluginId: 'demo', definition: definition((_input: unknown, c: ToolCallContext) => {
      bound = runScopeOf(c)
      return 'ask' as const
    }) }
    const base = { chatId: 'chat', modelRef: 'mock:echo', toolCallId: 'call_9', messages: [] }
    expect(await evaluatePolicy(tool, {}, base, { guard }, new AbortController().signal, scope)).toBe('ask')
    expect(bound).toEqual(scope)
    expect(await evaluatePolicy(tool, {}, base, { guard }, new AbortController().signal)).toBe('ask')
    expect(bound).toBeNull()
  })

  it('runs allowlisted shell commands without a card in ask and edits; others ask; auto unchanged', async () => {
    for (const toolMode of ['ask', 'edits'] as const) {
      const approve = createToolApproval(shellContext({ toolMode }))
      expect(await approve(shellCall('ls -la'))).toBe('not-applicable')
      expect(await approve(shellCall('pnpm test --run'))).toBe('not-applicable')
      expect(await approve(shellCall('ls && rm x'))).toBe('user-approval')
      expect(await approve(shellCall('ls $(whoami)'))).toBe('user-approval')
    }
    const auto = createToolApproval(shellContext({ toolMode: 'auto' }))
    expect(await auto(shellCall('rm x'))).toBe('not-applicable')
    // Without the scope's rules (another project, or no rules) the same command asks.
    expect(await createToolApproval(shellContext({ scope: runScope([]) }))(shellCall('ls'))).toBe('user-approval')
  })
})

describe('createToolApproval: a stored allow override on an execute tool (Phase 8)', () => {
  const allow = new Map([['shell', { enabled: true, override: 'allow' as const }]])

  it('ignores it: the call falls through to the policy and the mode', async () => {
    expect(await createToolApproval(shellContext({ prefs: allow }))(shellCall('rm -rf build'))).toBe('user-approval')
    expect(await createToolApproval(shellContext({ prefs: allow, toolMode: 'edits' }))(shellCall('rm -rf build'))).toBe('user-approval')
    expect(await createToolApproval(shellContext({ prefs: allow }))(shellCall('ls'))).toBe('not-applicable')
    expect(await createToolApproval(shellContext({ prefs: allow, toolMode: 'auto' }))(shellCall('rm -rf build'))).toBe('not-applicable')
    // A third-party execute tool (static policy) asks too.
    const runner = { pluginId: 'runner', definition: { ...definition('ask', 'execute'), name: 'run_task' } }
    const prefs = new Map([['run_task', { enabled: true, override: 'allow' as const }]])
    expect(await createToolApproval(context({ tool: runner, workspace: WORKSPACE, prefs }))({ ...call, toolCall: { ...call.toolCall, toolName: 'run_task' } })).toBe('user-approval')
  })

  it('keeps allow on other tools, deny / ask on execute tools, and a tool.approve hook ahead of the policy', async () => {
    const write = { pluginId: 'core-workspace', definition: definition('ask', 'write') }
    expect(await createToolApproval(context({ tool: write, workspace: WORKSPACE, prefs: new Map([['demo_tool', { enabled: true, override: 'allow' }]]) }))(call)).toBe('approved')
    expect(await createToolApproval(context({ prefs: new Map([['demo_tool', { enabled: true, override: 'allow' }]]) }))(call)).toBe('approved')
    expect(await createToolApproval(shellContext({ prefs: new Map([['shell', { enabled: true, override: 'deny' }]]) }))(shellCall('ls'))).toEqual({ type: 'denied', reason: DENIED_BY_OVERRIDE })
    expect(await createToolApproval(shellContext({ prefs: new Map([['shell', { enabled: true, override: 'ask' }]]) }))(shellCall('ls'))).toBe('user-approval')

    let decision: HookDecision = 'deny'
    const hooks = {
      run: async (_name: string, _input: unknown, output: unknown) => {
        (output as { decision?: unknown }).decision = decision
      },
      on: () => ({ dispose() {} }),
      list: () => [],
    } as unknown as ToolApprovalContext['registry']['hooks']
    const hooked = createToolApproval(shellContext({ prefs: allow, registry: { hooks } }))
    expect(await hooked(shellCall('ls'))).toEqual({ type: 'denied', reason: DENIED_BY_HOOK })
    decision = 'allow'
    expect(await hooked(shellCall('rm x'))).toBe('approved')
    decision = 'ask'
    expect(await hooked(shellCall('ls'))).toBe('user-approval')
  })

  it('effectiveOverride drops only allow on execute', () => {
    for (const access of [null, 'read', 'write', 'execute'] as const) {
      for (const stored of OVERRIDES)
        expect(effectiveOverride(stored, access)).toBe(stored === 'allow' && access === 'execute' ? null : stored)
    }
  })
})

// ---------- Phase 9: exit_plan_mode always asks; the call-independent outcome ----------

describe('createToolApproval: core-agent exit_plan_mode (Phase 9, ADR-041)', () => {
  const plan: ApprovalTool = { pluginId: 'core-agent', definition: { ...definition('always'), name: 'exit_plan_mode' } }
  const planCall = { toolCall: { toolName: 'exit_plan_mode', toolCallId: 'call_plan', input: { plan: '# Plan' } }, messages: [] }

  function recordingHooks(decision: HookDecision, calls: string[]): ToolApprovalContext['registry']['hooks'] {
    return {
      run: async (_name: string, input: unknown, output: unknown) => {
        calls.push((input as { tool: string }).tool);
        (output as { decision?: unknown }).decision = decision
      },
      on: () => ({ dispose() {} }),
      list: () => [],
    } as unknown as ToolApprovalContext['registry']['hooks']
  }

  it('asks in every mode, before the overrides (allow / deny / ask) and the tool.approve hook', async () => {
    for (const toolMode of MODES) {
      for (const override of ['allow', 'deny', 'ask'] as const) {
        const calls: string[] = []
        const approve = createToolApproval(context({ toolMode, tool: plan, prefs: new Map([['exit_plan_mode', { enabled: true, override }]]), registry: { hooks: recordingHooks('allow', calls) } }))
        expect(await approve(planCall)).toBe('user-approval')
        expect(calls).toEqual([])
      }
      const calls: string[] = []
      for (const decision of ['allow', 'deny'] as const)
        expect(await createToolApproval(context({ toolMode, tool: plan, registry: { hooks: recordingHooks(decision, calls) } }))(planCall)).toBe('user-approval')
      expect(calls).toEqual([])
    }
  })

  it('never evaluates a policy for it (the card always shows, also on the approved continuation)', async () => {
    let evaluated = 0
    const tool: ApprovalTool = { pluginId: 'core-agent', definition: { ...definition(() => {
      evaluated += 1
      return 'safe' as const
    }), name: 'exit_plan_mode' } }
    expect(await createToolApproval(context({ toolMode: 'edits', tool }))(planCall)).toBe('user-approval')
    expect(evaluated).toBe(0)
  })

  it('a tool of another owner with that name resolves like any other tool; an unoffered exit_plan_mode is denied', async () => {
    const impostor: ApprovalTool = { pluginId: 'impostor', definition: { ...definition('ask'), name: 'exit_plan_mode' } }
    expect(isPlanExitTool(impostor)).toBe(false)
    expect(isPlanExitTool(plan)).toBe(true)
    expect(await createToolApproval(context({ tool: impostor, prefs: new Map([['exit_plan_mode', { enabled: true, override: 'allow' }]]) }))(planCall)).toBe('approved')
    // Not offered in this run (another mode, switched off): denied like any unknown tool.
    expect(await createToolApproval(context({ toolMode: 'edits' }))(planCall)).toEqual({ type: 'denied', reason: DENIED_UNAVAILABLE })
  })
})

describe('staticApprovalOutcome (Phase 9, the sub-agent tool set)', () => {
  const tool = (policy: ToolDefinition['policy'], workspace?: ToolWorkspaceAccess, pluginId = 'demo'): ApprovalTool => ({ pluginId, definition: definition(policy, workspace) })

  it('equals resolveApproval without a hook for static policies, in every mode, with every override', () => {
    for (const toolMode of MODES) {
      for (const stored of OVERRIDES) {
        for (const policy of ['safe', 'ask', 'always', 'deny'] as const) {
          for (const workspace of ACCESS) {
            const expectedOutcome = expected(effectiveOverride(stored, workspace), undefined, toolMode, policy, workspace)
            // A static `deny` string is plugin data the type does not allow (a policy function may answer it).
            expect(staticApprovalOutcome(tool(policy as ToolDefinition['policy'], workspace ?? undefined), toolMode, stored)).toBe(expectedOutcome)
          }
        }
      }
    }
  })

  it('no policy or an unknown string counts as ask; a policy function decides per call (null) unless an override decides', () => {
    expect(staticApprovalOutcome(tool(undefined), 'ask', null)).toBe('user-approval')
    expect(staticApprovalOutcome(tool(undefined), 'auto', null)).toBe('not-applicable')
    expect(staticApprovalOutcome(tool('sometimes' as ToolDefinition['policy']), 'ask', null)).toBe('user-approval')
    expect(staticApprovalOutcome(tool(() => 'safe', 'execute'), 'ask', null)).toBeNull()
    expect(staticApprovalOutcome(tool(() => 'safe', 'execute'), 'ask', 'deny')).toBe('denied')
    // A stored allow on an execute tool is ignored (ADR-038): the policy function decides.
    expect(staticApprovalOutcome(tool(() => 'safe', 'execute'), 'ask', 'allow')).toBeNull()
    expect(staticApprovalOutcome(tool(() => 'safe', 'write'), 'ask', 'allow')).toBe('approved')
  })

  it('exit_plan_mode of core-agent can only ask', () => {
    const plan: ApprovalTool = { pluginId: 'core-agent', definition: { ...definition('always'), name: 'exit_plan_mode' } }
    for (const toolMode of MODES) {
      for (const stored of OVERRIDES)
        expect(staticApprovalOutcome(plan, toolMode, stored)).toBe('user-approval')
    }
  })
})
