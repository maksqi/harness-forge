import type { ToolCallContext, ToolDefinition, ToolWorkspace, ToolWorkspaceAccess } from '@harness-forge/plugin-sdk'
import type { HarnessUIMessage, HookData, ToolMode, ToolOverride } from '@harness-forge/shared'
import type { WorkspaceRunScope, WorkspaceRunScopeInit } from '../workspace/run-scope.ts'
import type { ApprovalOutcome, ApprovalTool, EffectivePolicy, HookDecision, ToolApprovalContext } from './approval.ts'
import { matchShellRules } from '@harness-forge/shared'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createSilentLogger } from '../logger.ts'
import { createFakeCheckpointService } from '../testing/fake-checkpoints.ts'
import { createFakeHookSnapshot, fakeHookRecord, fakeHookResult } from '../testing/fake-hooks.ts'
import { runScopeOf } from '../workspace/run-scope.ts'
import {
  applyHookDecision,
  applyPermissionRequest,
  BLOCKED_BY_HOOK,
  blockedByHookReason,
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
import { createRunHooks } from './hooks.ts'
import { denyUserApproval, SUBAGENT_APPROVAL_DENIED_TEXT } from './subagent/tools.ts'

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

describe('createToolApproval: PreToolUse command hooks (Phase 11, C37-T2)', () => {
  const MODES_WITH_TOOLS: ToolMode[] = ['ask', 'edits', 'plan', 'auto']

  function hooked(results: Parameters<typeof createFakeHookSnapshot>[0], continued: HarnessUIMessage | null = null) {
    const snapshot = createFakeHookSnapshot(results)
    const injected: HookData[] = []
    const hooks = createRunHooks({
      snapshot,
      host: { stepNumber: 0, inject: chunk => (chunk.type === 'data-hook' ? injected.push(chunk.data) : 0), writeTransient: () => {} },
      continued,
      messageId: 'msg_a000000000000001',
      logger: createSilentLogger(),
    })
    return { snapshot, hooks, injected }
  }

  it('applyHookDecision: a harness denial wins; deny, ask and the narrow allow', () => {
    const denied = { outcome: 'denied' as const, reason: DENIED_BY_POLICY }
    for (const decision of ['allow', 'ask', 'deny'] as const)
      expect(applyHookDecision(denied, { decision, reason: 'x' }, null, 'deny')).toBe(denied)
    expect(applyHookDecision({ outcome: 'approved' }, { decision: 'deny', reason: 'rm is not allowed' }, null, null)).toEqual({ outcome: 'denied', reason: 'Blocked by hook: rm is not allowed' })
    expect(applyHookDecision({ outcome: 'not-applicable' }, { decision: 'deny', reason: '  ' }, null, 'safe')).toEqual({ outcome: 'denied', reason: BLOCKED_BY_HOOK })
    expect(applyHookDecision({ outcome: 'not-applicable' }, { decision: 'ask', reason: null }, null, 'safe')).toEqual({ outcome: 'user-approval' })
    const ask = { outcome: 'user-approval' as const }
    expect(applyHookDecision(ask, { decision: 'allow', reason: null }, null, 'ask')).toEqual({ outcome: 'approved' })
    expect(applyHookDecision(ask, { decision: 'allow', reason: null }, 'write', 'safe')).toEqual({ outcome: 'approved' })
    expect(applyHookDecision(ask, { decision: 'allow', reason: null }, 'execute', 'ask')).toBe(ask)
    expect(applyHookDecision(ask, { decision: 'allow', reason: null }, 'write', 'always')).toBe(ask)
    expect(applyHookDecision(ask, { decision: 'allow', reason: null }, null, null)).toBe(ask)
    expect(applyHookDecision({ outcome: 'not-applicable' }, { decision: 'allow', reason: null }, null, 'safe')).toEqual({ outcome: 'not-applicable' })
    expect(applyHookDecision(ask, { decision: null, reason: 'x' }, null, 'ask')).toBe(ask)
    expect(applyHookDecision(ask, null, null, 'ask')).toBe(ask)
    expect(blockedByHookReason('why')).toBe('Blocked by hook: why')
  })

  it('applyHookDecision: in plan mode an allow keeps the harness result; deny and ask still apply', () => {
    const ask = { outcome: 'user-approval' as const }
    for (const workspace of ACCESS) {
      for (const policy of ['safe', 'ask', 'always', null] as const)
        expect(applyHookDecision(ask, { decision: 'allow', reason: null }, workspace, policy, 'plan')).toBe(ask)
    }
    expect(applyHookDecision({ outcome: 'not-applicable' }, { decision: 'allow', reason: null }, null, 'safe', 'plan')).toEqual({ outcome: 'not-applicable' })
    expect(applyHookDecision({ outcome: 'not-applicable' }, { decision: 'deny', reason: 'no' }, null, 'safe', 'plan')).toEqual({ outcome: 'denied', reason: 'Blocked by hook: no' })
    expect(applyHookDecision({ outcome: 'not-applicable' }, { decision: 'ask', reason: null }, null, 'safe', 'plan')).toEqual({ outcome: 'user-approval' })
    // Every other mode keeps the narrow allow.
    for (const toolMode of ['ask', 'edits', 'auto'] as const) {
      expect(applyHookDecision(ask, { decision: 'allow', reason: null }, 'write', 'ask', toolMode)).toEqual({ outcome: 'approved' })
      expect(applyHookDecision(ask, { decision: 'allow', reason: null }, 'execute', 'ask', toolMode)).toBe(ask)
      expect(applyHookDecision(ask, { decision: 'allow', reason: null }, null, 'always', toolMode)).toBe(ask)
    }
  })

  it('plan mode: a hook allow never skips the card; ask mode: it approves a non-execute ask tool', async () => {
    const allow = () => hooked({ results: { PreToolUse: fakeHookResult({ decision: 'allow' }) } }).hooks
    const approve = (tool: ApprovalTool, toolMode: ToolMode, overrides: Partial<ToolApprovalContext> = {}) =>
      createToolApproval(context({ tool, toolMode, hooks: allow(), ...overrides }))(call)
    for (const access of [undefined, 'read', 'write'] as const) {
      const tool = { pluginId: 'demo', definition: definition('ask', access) }
      expect(await approve(tool, 'plan')).toBe('user-approval')
      expect(await approve(tool, 'ask')).toBe('approved')
    }
    // A policy function answering `ask`: approved in ask mode, the card in plan mode.
    expect(await approve({ pluginId: 'demo', definition: definition(() => 'ask') }, 'ask')).toBe('approved')
    expect(await approve({ pluginId: 'demo', definition: definition(() => 'ask') }, 'plan')).toBe('user-approval')
    // An `ask` override in plan mode: the card, and the policy is not evaluated for the allow.
    let evaluated = 0
    const counted: ApprovalTool = { pluginId: 'demo', definition: definition(() => {
      evaluated += 1
      return 'ask' as const
    }) }
    const askOverride = new Map([['demo_tool', { enabled: true, override: 'ask' as const }]])
    expect(await approve(counted, 'plan', { prefs: askOverride })).toBe('user-approval')
    expect(evaluated).toBe(0)
    expect(await approve(counted, 'ask', { prefs: askOverride })).toBe('approved')
    expect(evaluated).toBe(1)
    // A safe tool runs without a card in plan mode either way (the harness result).
    expect(await approve({ pluginId: 'demo', definition: definition('safe') }, 'plan')).toBe('not-applicable')
    // execute and always still ask, in every mode that asks for them.
    for (const toolMode of ['ask', 'plan', 'edits'] as const) {
      expect(await approve({ pluginId: 'demo', definition: definition('ask', 'execute') }, toolMode)).toBe('user-approval')
      expect(await approve({ pluginId: 'demo', definition: definition('always', 'write') }, toolMode)).toBe('user-approval')
    }
    expect(await approve({ pluginId: 'demo', definition: definition('always') }, 'auto')).toBe('user-approval')
    // A deny wins in every mode, whatever the policy.
    for (const toolMode of MODES_WITH_TOOLS) {
      for (const policy of ['safe', 'ask', 'always'] as const) {
        const deny = hooked({ results: { PreToolUse: fakeHookResult({ decision: 'deny', reason: 'stop' }) } }).hooks
        expect(await createToolApproval(context({ tool: { pluginId: 'demo', definition: definition(policy) }, toolMode, hooks: deny }))(call)).toEqual({ type: 'denied', reason: 'Blocked by hook: stop' })
      }
    }
  })

  it('deny blocks and ask asks in every mode, for every access', async () => {
    for (const toolMode of MODES_WITH_TOOLS) {
      for (const access of [undefined, 'read', 'write', 'execute'] as const) {
        const tool = { pluginId: 'demo', definition: definition('safe', access) }
        const deny = hooked({ results: { PreToolUse: fakeHookResult({ decision: 'deny', reason: 'nope' }) } })
        expect(await createToolApproval(context({ toolMode, tool, hooks: deny.hooks }))(call)).toEqual({ type: 'denied', reason: 'Blocked by hook: nope' })
        const ask = hooked({ results: { PreToolUse: fakeHookResult({ decision: 'ask' }) } })
        expect(await createToolApproval(context({ toolMode, tool, hooks: ask.hooks }))(call)).toBe('user-approval')
      }
    }
  })

  it('allow skips the card only for a tool that would ask, is not execute and whose policy is safe or ask', async () => {
    const allow = () => hooked({ results: { PreToolUse: fakeHookResult({ decision: 'allow' }) } }).hooks
    const approve = (tool: ApprovalTool, overrides: Partial<ToolApprovalContext> = {}) => createToolApproval(context({ tool, hooks: allow(), ...overrides }))(call)
    expect(await approve({ pluginId: 'demo', definition: definition('ask') })).toBe('approved')
    expect(await approve({ pluginId: 'demo', definition: definition('ask', 'write') })).toBe('approved')
    expect(await approve({ pluginId: 'demo', definition: definition('ask', 'execute') })).toBe('user-approval')
    // A hidden-path write (policy `always`) keeps its card.
    expect(await approve({ pluginId: 'demo', definition: definition(() => 'always', 'write') })).toBe('user-approval')
    expect(await approve({ pluginId: 'demo', definition: definition('always') }, { toolMode: 'auto' })).toBe('user-approval')
    // Auto runs it anyway; a harness denial wins.
    expect(await approve({ pluginId: 'demo', definition: definition('ask') }, { toolMode: 'auto' })).toBe('not-applicable')
    expect(await approve({ pluginId: 'demo', definition: definition(() => 'deny' as const) })).toEqual({ type: 'denied', reason: DENIED_BY_POLICY })
    expect(await approve({ pluginId: 'demo', definition: definition('ask') }, { prefs: new Map([['demo_tool', { enabled: true, override: 'deny' }]]) })).toEqual({ type: 'denied', reason: DENIED_BY_OVERRIDE })
    // An `ask` override: the policy is evaluated for the allow (ask → approved, always → the card).
    const askOverride = new Map([['demo_tool', { enabled: true, override: 'ask' as const }]])
    expect(await approve({ pluginId: 'demo', definition: definition('ask') }, { prefs: askOverride })).toBe('approved')
    expect(await approve({ pluginId: 'demo', definition: definition(() => 'always') }, { prefs: askOverride })).toBe('user-approval')
  })

  it('runs PreToolUse once across a request and its approved continuation (the SDK re-run is replayed)', async () => {
    const tool = { pluginId: 'demo', definition: definition('ask') }
    const record = fakeHookRecord('PreToolUse', 'rewritten', { toolCallId: 'call_1', toolName: 'demo_tool', updatedInput: { a: 1 } })
    const first = hooked({ results: { PreToolUse: fakeHookResult({ updatedInput: { a: 1 }, record }) } })
    expect(await createToolApproval(context({ tool, hooks: first.hooks }))(call)).toBe('user-approval')
    expect(first.snapshot.calls).toHaveLength(1)
    expect(first.injected).toEqual([record])
    const continued: HarnessUIMessage = {
      id: 'msg_a000000000000001',
      role: 'assistant',
      parts: [
        { type: 'tool-demo_tool', toolCallId: 'call_1', state: 'approval-responded', input: {}, approval: { id: 'ap_1', approved: true } } as unknown as HarnessUIMessage['parts'][number],
        { type: 'data-hook', data: record },
      ],
    }
    const second = hooked({ results: { PreToolUse: fakeHookResult({ decision: 'deny', reason: 'would deny now' }) } }, continued)
    expect(await createToolApproval(context({ tool, hooks: second.hooks }))(call)).toBe('user-approval')
    expect(second.snapshot.calls).toHaveLength(0)
    expect(second.hooks.updatedInput('call_1')).toEqual({ input: { a: 1 } })
  })

  it('a child turns a hook ask into the sub-agent denial; the plan card never runs the hooks', async () => {
    const ask = hooked({ results: { PreToolUse: fakeHookResult({ decision: 'ask' }) } })
    const child = ask.hooks.forChild('call_t/')
    const approve = createToolApproval(context({ toolMode: 'auto', hooks: child }))
    expect(denyUserApproval(await approve(call))).toEqual({ type: 'denied', reason: SUBAGENT_APPROVAL_DENIED_TEXT })
    const plan: ApprovalTool = { pluginId: 'core-agent', definition: { ...definition('always'), name: 'exit_plan_mode' } }
    const deny = hooked({ results: { PreToolUse: fakeHookResult({ decision: 'deny' }) } })
    expect(await createToolApproval(context({ toolMode: 'plan', tool: plan, hooks: deny.hooks }))({ toolCall: { toolName: 'exit_plan_mode', toolCallId: 'p', input: {} }, messages: [] })).toBe('user-approval')
    expect(deny.snapshot.calls).toHaveLength(0)
  })

  it('asks the user when the hooks fail unexpectedly', async () => {
    const broken = hooked({ results: { PreToolUse: () => {
      throw new Error('broken')
    } } })
    expect(await createToolApproval(context({ toolMode: 'auto', hooks: broken.hooks }))(call)).toBe('user-approval')
  })
})

describe('createToolApproval: PermissionRequest and the allow record (Phase 12, C44-T2)', () => {
  const MODES_WITH_TOOLS: ToolMode[] = ['ask', 'edits', 'plan', 'auto']
  const STATIC_POLICIES = ['safe', 'ask', 'always'] as const

  function hooked(options: Parameters<typeof createFakeHookSnapshot>[0], continued: HarnessUIMessage | null = null) {
    const snapshot = createFakeHookSnapshot(options)
    const injected: HookData[] = []
    const hooks = createRunHooks({
      snapshot,
      host: { stepNumber: 0, inject: chunk => (chunk.type === 'data-hook' ? injected.push(chunk.data) : 0), writeTransient: () => {} },
      continued,
      messageId: 'msg_a000000000000001',
      logger: createSilentLogger(),
    })
    const requests = () => snapshot.calls.filter(entry => entry.event === 'PermissionRequest').length
    return { snapshot, hooks, injected, requests }
  }

  /** What the approval answers without hooks (the harness result). */
  function harnessOutcome(mode: ToolMode, policy: EffectivePolicy, access: ToolWorkspaceAccess | null): ApprovalOutcome {
    return resolveApproval({ override: null, hookDecision: undefined, toolMode: mode, policy, workspace: access }).outcome
  }

  it('applyPermissionRequest: only a user-approval result changes; deny denies, allow passes the PreToolUse gate', () => {
    const ask = { outcome: 'user-approval' as const }
    expect(applyPermissionRequest(ask, { decision: 'deny', reason: 'not now' }, null, 'ask', 'ask')).toEqual({ outcome: 'denied', reason: 'Blocked by hook: not now' })
    expect(applyPermissionRequest(ask, { decision: 'deny', reason: null }, null, 'ask', 'ask')).toEqual({ outcome: 'denied', reason: BLOCKED_BY_HOOK })
    expect(applyPermissionRequest(ask, { decision: 'allow', reason: null }, 'write', 'ask', 'edits')).toEqual({ outcome: 'approved' })
    expect(applyPermissionRequest(ask, { decision: 'allow', reason: null }, 'execute', 'ask', 'ask')).toBe(ask)
    expect(applyPermissionRequest(ask, { decision: 'allow', reason: null }, null, 'always', 'ask')).toBe(ask)
    expect(applyPermissionRequest(ask, { decision: 'allow', reason: null }, null, 'ask', 'plan')).toBe(ask)
    expect(applyPermissionRequest(ask, { decision: null, reason: 'x' }, null, 'ask', 'ask')).toBe(ask)
    expect(applyPermissionRequest(ask, null, null, 'ask', 'ask')).toBe(ask)
    const approved = { outcome: 'approved' as const }
    expect(applyPermissionRequest(approved, { decision: 'deny', reason: 'x' }, null, 'ask', 'ask')).toBe(approved)
  })

  it('each decision × mode × access × policy: runs only when the call would ask; allow through the gate, deny blocks', async () => {
    for (const mode of MODES_WITH_TOOLS) {
      for (const access of [undefined, 'read', 'write', 'execute'] as const) {
        for (const policy of STATIC_POLICIES) {
          const tool = { pluginId: 'demo', definition: definition(policy, access) }
          const before = harnessOutcome(mode, policy, access ?? null)
          for (const decision of ['allow', 'deny', null] as const) {
            const result = decision === null ? fakeHookResult() : fakeHookResult({ decision, block: decision === 'deny', reason: decision === 'deny' ? 'no' : null })
            const h = hooked({ results: { PermissionRequest: result } })
            const status = await createToolApproval(context({ tool, toolMode: mode, hooks: h.hooks }))(call)
            const label = `${mode} ${access ?? 'none'} ${policy} ${decision ?? 'none'}`
            if (before !== 'user-approval') {
              expect(h.requests(), label).toBe(0)
              expect(status, label).toBe(before)
              continue
            }
            expect(h.requests(), label).toBe(1)
            if (decision === 'deny')
              expect(status, label).toEqual({ type: 'denied', reason: 'Blocked by hook: no' })
            else if (decision === 'allow' && mode !== 'plan' && access !== 'execute' && policy !== 'always')
              expect(status, label).toBe('approved')
            else
              expect(status, label).toBe('user-approval')
          }
        }
      }
    }
  })

  it('runs after a PreToolUse ask, never after a PreToolUse deny or allow that decided, and evaluates a policy function once', async () => {
    let evaluated = 0
    const tool: ApprovalTool = { pluginId: 'demo', definition: definition(() => {
      evaluated += 1
      return 'ask' as const
    }) }
    const askThenAllow = hooked({ results: { PreToolUse: fakeHookResult({ decision: 'ask' }), PermissionRequest: fakeHookResult({ decision: 'allow' }) } })
    expect(await createToolApproval(context({ tool, toolMode: 'auto', hooks: askThenAllow.hooks }))(call)).toBe('approved')
    expect(askThenAllow.requests()).toBe(1)
    const deny = hooked({ results: { PreToolUse: fakeHookResult({ decision: 'deny' }), PermissionRequest: fakeHookResult({ decision: 'allow' }) } })
    expect(await createToolApproval(context({ tool, hooks: deny.hooks }))(call)).toEqual({ type: 'denied', reason: BLOCKED_BY_HOOK })
    expect(deny.requests()).toBe(0)
    evaluated = 0
    const allow = hooked({ results: { PreToolUse: fakeHookResult({ decision: 'allow' }), PermissionRequest: fakeHookResult({ decision: 'deny' }) } })
    expect(await createToolApproval(context({ tool, hooks: allow.hooks }))(call)).toBe('approved')
    expect(allow.requests()).toBe(0)
    expect(evaluated).toBe(1)
    // An `ask` override: the policy is evaluated for the PermissionRequest allow, once.
    evaluated = 0
    const overridden = hooked({ results: { PermissionRequest: fakeHookResult({ decision: 'allow' }) } })
    const askOverride = new Map([['demo_tool', { enabled: true, override: 'ask' as const }]])
    expect(await createToolApproval(context({ tool, prefs: askOverride, hooks: overridden.hooks }))(call)).toBe('approved')
    expect(evaluated).toBe(1)
    // The plan card never runs it.
    const plan: ApprovalTool = { pluginId: 'core-agent', definition: { ...definition('always'), name: 'exit_plan_mode' } }
    const planHooks = hooked({ results: { PermissionRequest: fakeHookResult({ decision: 'allow' }) } })
    expect(await createToolApproval(context({ toolMode: 'plan', tool: plan, hooks: planHooks.hooks }))({ toolCall: { toolName: 'exit_plan_mode', toolCallId: 'p', input: {} }, messages: [] })).toBe('user-approval')
    expect(planHooks.requests()).toBe(0)
  })

  it('an approving allow applies its updatedInput; a deny or an allow the gate refuses does not run the call', async () => {
    const h = hooked({ results: { PermissionRequest: fakeHookResult({ decision: 'allow', updatedInput: { safe: true } }) } })
    expect(await createToolApproval(context({ hooks: h.hooks }))(call)).toBe('approved')
    expect(h.hooks.updatedInput('call_1')).toEqual({ input: { safe: true } })
  })

  it('children never run it: a child asks nothing and its approval turns the card into the sub-agent denial', async () => {
    const h = hooked({ results: { PermissionRequest: fakeHookResult({ decision: 'allow' }) } })
    const approve = createToolApproval(context({ hooks: h.hooks.forChild('call_t/') }))
    expect(denyUserApproval(await approve(call))).toEqual({ type: 'denied', reason: SUBAGENT_APPROVAL_DENIED_TEXT })
    expect(h.requests()).toBe(0)
  })

  it('runs exactly once across a request and its approved continuation', async () => {
    const record = fakeHookRecord('PermissionRequest', 'context', { toolCallId: 'call_1', toolName: 'demo_tool', context: 'noted' })
    const first = hooked({ results: { PermissionRequest: fakeHookResult({ context: 'noted', record }) } })
    expect(await createToolApproval(context({ hooks: first.hooks }))(call)).toBe('user-approval')
    expect(first.requests()).toBe(1)
    expect(first.injected).toEqual([record])
    const continued: HarnessUIMessage = {
      id: 'msg_a000000000000001',
      role: 'assistant',
      parts: [
        { type: 'tool-demo_tool', toolCallId: 'call_1', state: 'approval-responded', input: {}, approval: { id: 'ap_1', approved: true } } as unknown as HarnessUIMessage['parts'][number],
        { type: 'data-hook', data: record },
      ],
    }
    const second = hooked({ results: { PermissionRequest: fakeHookResult({ decision: 'deny', reason: 'would deny now' }) } }, continued)
    expect(await createToolApproval(context({ hooks: second.hooks }))(call)).toBe('user-approval')
    expect(second.requests()).toBe(0)
    expect(second.injected).toEqual([])
  })

  it('settles every call: harnessAsked on a PreToolUse allow the harness still asks for, in order with the PermissionRequest record', async () => {
    const allowedRecord = () => fakeHookRecord('PreToolUse', 'allowed', { toolCallId: 'call_1', toolName: 'demo_tool' })
    // Plan mode: the allow keeps the card.
    const plan = hooked({ results: { PreToolUse: fakeHookResult({ decision: 'allow', record: allowedRecord() }) } })
    expect(await createToolApproval(context({ toolMode: 'plan', hooks: plan.hooks }))(call)).toBe('user-approval')
    expect(plan.injected).toHaveLength(1)
    expect(plan.injected[0]).toMatchObject({ event: 'PreToolUse', outcome: 'allowed', harnessAsked: true })
    // An execute tool: the card stays, the PermissionRequest record follows the PreToolUse one.
    const request = fakeHookRecord('PermissionRequest', 'error', { toolCallId: 'call_1', toolName: 'demo_tool' })
    const execute = hooked({ results: { PreToolUse: fakeHookResult({ decision: 'allow', record: allowedRecord() }), PermissionRequest: fakeHookResult({ decision: 'allow', record: request }) } })
    expect(await createToolApproval(context({ tool: { pluginId: 'demo', definition: definition('ask', 'execute') }, hooks: execute.hooks }))(call)).toBe('user-approval')
    expect(execute.injected.map(data => [data.event, data.harnessAsked ?? false])).toEqual([['PreToolUse', true], ['PermissionRequest', false]])
    // An allow that approves, or a PermissionRequest deny: no flag.
    const approved = hooked({ results: { PreToolUse: fakeHookResult({ decision: 'allow', record: allowedRecord() }) } })
    expect(await createToolApproval(context({ hooks: approved.hooks }))(call)).toBe('approved')
    expect(approved.injected[0]).not.toHaveProperty('harnessAsked')
    const denied = hooked({ results: { PreToolUse: fakeHookResult({ decision: 'allow', record: allowedRecord() }), PermissionRequest: fakeHookResult({ decision: 'deny', block: true }) } })
    expect(await createToolApproval(context({ tool: { pluginId: 'demo', definition: definition('always') }, hooks: denied.hooks }))(call)).toEqual({ type: 'denied', reason: BLOCKED_BY_HOOK })
    expect(denied.injected[0]).not.toHaveProperty('harnessAsked')
    // The catch path settles too: a failing PermissionRequest asks the user, the allowed record is stored with the flag.
    const failing = hooked({ results: { PreToolUse: fakeHookResult({ decision: 'allow', record: allowedRecord() }), PermissionRequest: () => {
      throw new Error('broken')
    } } })
    expect(await createToolApproval(context({ tool: { pluginId: 'demo', definition: definition('always') }, hooks: failing.hooks }))(call)).toBe('user-approval')
    expect(failing.injected).toHaveLength(1)
    expect(failing.injected[0]).toMatchObject({ harnessAsked: true })
  })
})
