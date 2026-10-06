// Tool approval (ARCHITECTURE.md 6.2, PLUGINS.md 10), passed as `streamText({ toolApproval })`. Resolution order, first
// match wins:
//   0. `core-agent`'s `exit_plan_mode` (Phase 9, ADR-041)           -> user-approval (the plan card; before overrides
//      and hooks, so neither can approve or deny it; on an approved continuation the SDK re-runs this function, and
//      a result other than `denied` keeps the user's approval)
//   1. user override in `tool_prefs` (deny / allow / ask)            -> denied / approved / user-approval
//      (Phase 8, ADR-038: a stored `allow` on a tool with workspace access `execute` is ignored, as if none were set)
//   2. `tool.approve` hook decision (deny / allow / ask)             -> denied / approved / user-approval
//   3. tool policy (static or function) is `deny`                    -> denied
//   4. mode `ask`:   policy `safe` -> not-applicable; `ask` / `always` -> user-approval
//   5. mode `edits` (Accept edits, Phase 7, ADR-032): policy `safe`, or policy `ask` of a tool with workspace access
//      `write` -> not-applicable; everything else (`ask` without workspace `write`, `always`) -> user-approval
//   6. mode `auto`:  policy `always` -> user-approval; `safe` / `ask` -> not-applicable
//   (Phase 9, ADR-041: mode `plan` resolves like `ask`; its tool set is narrowed by `modes.ts`.)
// `staticApprovalOutcome` is the part of this order that does not depend on the call (no hook, no policy function):
// the sub-agent tool set (`subagent/tools.ts`) leaves out the tools that could only ask.
// Mode `off` sends no tools; a call that still arrives is denied. A policy function is guarded (3 s) and receives the
// call context with `workspace` (the run's project folder) and, in a run with a workspace (Phase 8), the run scope bound
// to that context object (`runScopeOf(c)`: the shell rules and the working folder of `shellPolicy`); a throw or timeout
// counts as `always`. The approval function never throws: an unexpected failure asks the user.
// Phase 11 (C37, ADR-048; COMPLETE and FROZEN after P11-0b): command hooks `PreToolUse` run in `createToolApproval`
// right after "unknown → denied" and the plan card, before the user override (`ToolApprovalContext.hooks`, the run's
// `RunHooks` or a child's `ChildHooks`, `hooks.ts`): once per tool call, never again for a call answered in the continued
// message (the SDK re-runs this function on approved continuations; the stored decision is replayed). The harness result
// (steps 1-6) is computed as before and combined with the hook decision (`applyHookDecision`): a harness `denied` wins;
// hook `deny` (or a blocking exit 2) → denied "Blocked by hook: <reason>"; hook `ask` → user-approval (a child's approval
// wrapper turns it into a denial, `denyUserApproval`); hook `allow` → approved only when the harness would ask, the
// tool's workspace access is not `execute` and its policy is `safe` or `ask` (narrower than Claude Code: a hook never
// skips the card of the shell or of a hidden-path write, whose policy is `always`); otherwise the harness result. The
// hook record is stored by the hooks (`data-hook`); its `updatedInput` is applied by the tool wrapper (`tools.ts`), so
// the tool part and the approval signature keep the model's input. Plan mode is unchanged (its tool set is `modes.ts`'s;
// the plan card is decided before the hooks).
import type { ToolCallContext, ToolDefinition, ToolWorkspace, ToolWorkspaceAccess } from '@harness-forge/plugin-sdk'
import type { ToolMode, ToolOverride, ToolPolicy } from '@harness-forge/shared'
import type { ModelMessage, ToolApprovalStatus, ToolSet } from 'ai'
import type { Logger } from '../logger.ts'
import type { ToolPref } from '../mcp/types.ts'
import type { PluginHost } from '../plugins/types.ts'
import type { Registry } from '../registry/types.ts'
import type { WorkspaceRunScope, WorkspaceRunScopeInit } from '../workspace/run-scope.ts'
import type { PreToolUseDecision, ToolHooks } from './hooks.ts'
import { CORE_AGENT_PLUGIN_ID, EXIT_PLAN_MODE_TOOL_NAME } from '../builtin-plugins/core-agent/index.ts'
import { GUARD_TIMEOUTS } from '../plugins/guard.ts'
import { bindRunScope } from '../workspace/run-scope.ts'

export type ApprovalOutcome = 'not-applicable' | 'approved' | 'denied' | 'user-approval'
export type HookDecision = 'allow' | 'ask' | 'deny'
/** A policy value after evaluation (a policy function may also answer `deny`). */
export type EffectivePolicy = ToolPolicy | 'deny'

export interface ApprovalInput {
  override: ToolOverride | null
  hookDecision: HookDecision | undefined
  toolMode: ToolMode
  policy: EffectivePolicy
  /** The tool's workspace access (`ToolDefinition.workspace`, see `toolWorkspaceAccess`), or null (Phase 7). */
  workspace: ToolWorkspaceAccess | null
}

export interface ApprovalResult {
  outcome: ApprovalOutcome
  /** Reason of an automatic denial (sent to the model with the denied result). */
  reason?: string
}

export const DENIED_BY_OVERRIDE = 'Denied by the tool settings.'
export const DENIED_BY_HOOK = 'Denied by a plugin.'
export const DENIED_BY_POLICY = 'Denied by the tool policy.'
export const DENIED_TOOLS_OFF = 'Tools are turned off for this chat.'
export const DENIED_UNAVAILABLE = 'The tool is not available in this chat.'
/** Phase 11: the reason of a call a `PreToolUse` hook denied without a reason. */
export const BLOCKED_BY_HOOK = 'Blocked by hook.'

/** The denial reason of a `PreToolUse` hook: "Blocked by hook: <reason>" (`BLOCKED_BY_HOOK` without a reason). */
export function blockedByHookReason(reason: string | null | undefined): string {
  const text = typeof reason === 'string' ? reason.trim() : ''
  return text === '' ? BLOCKED_BY_HOOK : `Blocked by hook: ${text}`
}

const DECISIONS: Readonly<Record<HookDecision, ApprovalOutcome>> = {
  allow: 'approved',
  ask: 'user-approval',
  deny: 'denied',
}

/** The pure resolution table (steps 1-6). */
export function resolveApproval(input: ApprovalInput): ApprovalResult {
  if (input.override !== null) {
    const outcome = DECISIONS[input.override]
    return outcome === 'denied' ? { outcome, reason: DENIED_BY_OVERRIDE } : { outcome }
  }
  if (input.hookDecision !== undefined) {
    const outcome = DECISIONS[input.hookDecision]
    return outcome === 'denied' ? { outcome, reason: DENIED_BY_HOOK } : { outcome }
  }
  if (input.policy === 'deny')
    return { outcome: 'denied', reason: DENIED_BY_POLICY }
  switch (input.toolMode) {
    case 'ask':
    case 'plan':
      return { outcome: input.policy === 'safe' ? 'not-applicable' : 'user-approval' }
    case 'edits':
      return { outcome: input.policy === 'safe' || (input.policy === 'ask' && input.workspace === 'write') ? 'not-applicable' : 'user-approval' }
    case 'auto':
      return { outcome: input.policy === 'always' ? 'user-approval' : 'not-applicable' }
    default:
      return { outcome: 'denied', reason: DENIED_TOOLS_OFF }
  }
}

/** The AI SDK status of a result. */
export function toApprovalStatus(result: ApprovalResult): ToolApprovalStatus {
  if (result.outcome === 'denied')
    return { type: 'denied', ...(result.reason === undefined ? {} : { reason: result.reason }) }
  return result.outcome
}

const POLICIES: ReadonlySet<string> = new Set(['safe', 'ask', 'always', 'deny'])
const HOOK_DECISIONS: ReadonlySet<string> = new Set(['allow', 'ask', 'deny'])

export function isHookDecision(value: unknown): value is HookDecision {
  return typeof value === 'string' && HOOK_DECISIONS.has(value)
}

/**
 * The workspace access of a tool definition (plugin API 1.2.0): null when the tool does not declare one; an unknown
 * value (the registry validates the enum, this is plugin data) counts as `execute`, the most restricted access: offered
 * only with a workspace and the shell switch on, never run without asking in `edits` mode.
 */
export function toolWorkspaceAccess(definition: Pick<ToolDefinition, 'workspace'>): ToolWorkspaceAccess | null {
  const access: unknown = definition.workspace
  if (access === undefined || access === null)
    return null
  return access === 'read' || access === 'write' ? access : 'execute'
}

/** A tool of the run as the approval function sees it. */
export interface ApprovalTool {
  readonly pluginId: string
  readonly definition: ToolDefinition
}

/**
 * `core-agent`'s `exit_plan_mode` (ADR-041), recognized by owner and name (tool names are global, so no other plugin
 * can register the name, and a tool of another owner is never treated as the plan exit).
 */
export function isPlanExitTool(tool: { readonly pluginId: string, readonly definition: Pick<ToolDefinition, 'name'> }): boolean {
  return tool.pluginId === CORE_AGENT_PLUGIN_ID && tool.definition.name === EXIT_PLAN_MODE_TOOL_NAME
}

export interface ToolApprovalContext {
  chatId: string
  modelRef: string
  toolMode: ToolMode
  /** Tools sent to the model, by name. */
  tools: ReadonlyMap<string, ApprovalTool>
  prefs: ReadonlyMap<string, ToolPref>
  registry: Pick<Registry, 'hooks'>
  plugins: Pick<PluginHost, 'guard'>
  signal: AbortSignal
  logger: Logger
  /** The project folder of the run (`ToolCallContext.workspace` of the policy functions); null or absent = none. */
  workspace?: ToolWorkspace | null
  /**
   * The run scope (Phase 8, `AssembledTools.scope`): bound with the call's `toolCallId` to the context object of each
   * policy function. Null or absent = nothing is bound.
   */
  scope?: WorkspaceRunScopeInit | null
  /**
   * The command hooks of the run (Phase 11, `RunHooks` / `ChildHooks` of `hooks.ts`): `PreToolUse` per call (see the
   * module comment). Null or absent = no hooks.
   */
  hooks?: Pick<ToolHooks, 'preToolUse'> | null
}

/**
 * The override that applies to a tool: the stored one, except a stored `allow` on a tool with workspace access
 * `execute` (Phase 8, ADR-038: such an override can no longer be set, and one stored before v1.4 is ignored, so the
 * call falls through to the hook, the policy and the mode; the shell skips the card only through a rule or Auto).
 */
export function effectiveOverride(stored: ToolOverride | null, workspace: ToolWorkspaceAccess | null): ToolOverride | null {
  return stored === 'allow' && workspace === 'execute' ? null : stored
}

/**
 * The approval outcome of `tool` that does not depend on the call (Phase 9): `exit_plan_mode` -> `user-approval`; else
 * the effective override of `stored` (`effectiveOverride`); else a static policy resolved in `toolMode` (no policy =
 * `ask`, an unknown string = `ask`, as in `evaluatePolicy`); null when a policy function decides per call. `tool.approve`
 * hooks are not consulted (they run per call). A tool whose outcome is `user-approval` can only ask in that mode.
 */
export function staticApprovalOutcome(tool: ApprovalTool, toolMode: ToolMode, stored: ToolOverride | null): ApprovalOutcome | null {
  if (isPlanExitTool(tool))
    return 'user-approval'
  const workspace = toolWorkspaceAccess(tool.definition)
  const override = effectiveOverride(stored, workspace)
  if (override !== null)
    return resolveApproval({ override, hookDecision: undefined, toolMode, policy: 'ask', workspace }).outcome
  const policy = tool.definition.policy
  if (typeof policy === 'function')
    return null
  const effective: EffectivePolicy = typeof policy === 'string' && POLICIES.has(policy) ? policy : 'ask'
  return resolveApproval({ override: null, hookDecision: undefined, toolMode, policy: effective, workspace }).outcome
}

/**
 * Evaluates the tool policy: default `ask`; a function is guarded (3 s) and a throw or timeout counts as `always`. With
 * a `scope` (Phase 8), the scope is bound to the context object the function receives (`runScopeOf(c)`).
 */
export async function evaluatePolicy(
  tool: ApprovalTool,
  input: unknown,
  context: Omit<ToolCallContext, 'signal'>,
  plugins: Pick<PluginHost, 'guard'>,
  signal: AbortSignal,
  scope: WorkspaceRunScope | null = null,
): Promise<EffectivePolicy> {
  const policy = tool.definition.policy
  if (policy === undefined)
    return 'ask'
  if (typeof policy === 'string')
    return POLICIES.has(policy) ? policy : 'ask'
  try {
    const value = await plugins.guard(
      tool.pluginId,
      (guardSignal) => {
        const callContext: ToolCallContext = { ...context, signal: guardSignal }
        if (scope !== null)
          bindRunScope(callContext, scope)
        return policy.call(tool.definition, input, callContext)
      },
      { timeoutMs: GUARD_TIMEOUTS.hook, phase: 'tool', signal, label: `${tool.definition.name} policy` },
    )
    return typeof value === 'string' && POLICIES.has(value) ? value as EffectivePolicy : 'always'
  }
  catch {
    return 'always'
  }
}

/** The harness result of one call (steps 1-6) and the policy it evaluated (null when an override or hook decided). */
export interface HarnessApproval {
  readonly result: ApprovalResult
  readonly policy: EffectivePolicy | null
}

/**
 * Combines the harness result of a call with its `PreToolUse` decision (Phase 11, see the module comment): a harness
 * `denied` wins; `deny` → denied "Blocked by hook: …"; `ask` → user-approval; `allow` → approved only when the harness
 * result is `user-approval`, `workspace` is not `execute` and `policy` is `safe` or `ask` (an `allow` with an unknown
 * policy, null, keeps the harness result); no decision → the harness result.
 */
export function applyHookDecision(
  harness: ApprovalResult,
  hook: Pick<PreToolUseDecision, 'decision' | 'reason'> | null,
  workspace: ToolWorkspaceAccess | null,
  policy: EffectivePolicy | null,
): ApprovalResult {
  if (hook === null || hook.decision === null || harness.outcome === 'denied')
    return harness
  switch (hook.decision) {
    case 'deny':
      return { outcome: 'denied', reason: blockedByHookReason(hook.reason) }
    case 'ask':
      return { outcome: 'user-approval' }
    case 'allow':
      return harness.outcome === 'user-approval' && workspace !== 'execute' && (policy === 'safe' || policy === 'ask')
        ? { outcome: 'approved' }
        : harness
    default:
      return harness
  }
}

/** A tool call as the approval function receives it. */
interface ApprovalCall {
  readonly toolName: string
  readonly toolCallId: string
  readonly input: unknown
}

/** The tool's policy for one call (`evaluatePolicy` with the run's call context and scope). */
function callPolicy(context: ToolApprovalContext, tool: ApprovalTool, toolCall: ApprovalCall, messages: ModelMessage[]): Promise<EffectivePolicy> {
  return evaluatePolicy(
    tool,
    toolCall.input,
    {
      chatId: context.chatId,
      modelRef: context.modelRef,
      toolCallId: toolCall.toolCallId,
      messages,
      ...(context.workspace == null ? {} : { workspace: context.workspace }),
    },
    context.plugins,
    context.signal,
    context.scope == null ? null : { ...context.scope, toolCallId: toolCall.toolCallId },
  )
}

/** Steps 1-6 of the module comment for one call (the v1.6 approval, unchanged). */
async function harnessApproval(
  context: ToolApprovalContext,
  tool: ApprovalTool,
  workspace: ToolWorkspaceAccess | null,
  toolCall: ApprovalCall,
  messages: ModelMessage[],
): Promise<HarnessApproval> {
  const override = effectiveOverride(context.prefs.get(toolCall.toolName)?.override ?? null, workspace)
  if (override !== null)
    return { result: resolveApproval({ override, hookDecision: undefined, toolMode: context.toolMode, policy: 'ask', workspace }), policy: null }

  const hookOutput: { decision?: HookDecision } = {}
  await context.registry.hooks.run(
    'tool.approve',
    { chatId: context.chatId, modelRef: context.modelRef, tool: toolCall.toolName, toolCallId: toolCall.toolCallId, input: toolCall.input },
    hookOutput,
  )
  const hookDecision = isHookDecision(hookOutput.decision) ? hookOutput.decision : undefined
  if (hookDecision !== undefined)
    return { result: resolveApproval({ override: null, hookDecision, toolMode: context.toolMode, policy: 'ask', workspace }), policy: null }

  const policy = await callPolicy(context, tool, toolCall, messages)
  return { result: resolveApproval({ override: null, hookDecision: undefined, toolMode: context.toolMode, policy, workspace }), policy }
}

/** The approval function passed as `streamText({ toolApproval })` (and re-run by the SDK on approved continuations). */
export function createToolApproval(context: ToolApprovalContext) {
  return async (options: { toolCall: { toolName: string, toolCallId: string, input: unknown }, messages: ModelMessage[], tools?: ToolSet }): Promise<ToolApprovalStatus> => {
    const { toolCall } = options
    try {
      // A call to a tool this run does not offer (tool mode off, disabled, owner inactive, a workspace tool without a
      // workspace) can only be denied: an approved call without an executable tool would leave the model without a
      // result.
      const tool = context.tools.get(toolCall.toolName)
      if (tool === undefined)
        return { type: 'denied', reason: DENIED_UNAVAILABLE }
      // The plan card always shows (ADR-041): no override or hook decides it, and on an approved continuation this
      // result keeps the user's approval.
      if (isPlanExitTool(tool))
        return 'user-approval'
      const workspace = toolWorkspaceAccess(tool.definition)
      // Phase 11: `PreToolUse` once per call (replayed for a call answered in the continued message).
      const hook = context.hooks == null
        ? null
        : await context.hooks.preToolUse({ toolName: toolCall.toolName, toolCallId: toolCall.toolCallId, input: toolCall.input }, context.signal)
      const harness = await harnessApproval(context, tool, workspace, toolCall, options.messages)
      if (hook === null || hook.decision === null)
        return toApprovalStatus(harness.result)
      // An `allow` needs the tool's policy: evaluated now when an override or a `tool.approve` hook decided.
      const policy = hook.decision === 'allow' && harness.result.outcome === 'user-approval' && harness.policy === null
        ? await callPolicy(context, tool, toolCall, options.messages)
        : harness.policy
      return toApprovalStatus(applyHookDecision(harness.result, hook, workspace, policy))
    }
    catch (error) {
      context.logger.warn('tool approval failed, asking the user', { tool: toolCall.toolName, err: error })
      return 'user-approval'
    }
  }
}
