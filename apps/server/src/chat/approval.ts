// Tool approval (ARCHITECTURE.md 6.2, PLUGINS.md 10), passed as `streamText({ toolApproval })`. Resolution order, first
// match wins:
//   1. user override in `tool_prefs` (deny / allow / ask)            -> denied / approved / user-approval
//   2. `tool.approve` hook decision (deny / allow / ask)             -> denied / approved / user-approval
//   3. tool policy (static or function) is `deny`                    -> denied
//   4. mode `ask`:  policy `safe` -> not-applicable; `ask` / `always` -> user-approval
//   5. mode `auto`: policy `always` -> user-approval; `safe` / `ask` -> not-applicable
// Mode `off` sends no tools; a call that still arrives is denied. A policy function is guarded (3 s); a throw or
// timeout counts as `always`. The approval function never throws: an unexpected failure asks the user.
import type { ToolCallContext, ToolDefinition } from '@harness-forge/plugin-sdk'
import type { ToolMode, ToolOverride, ToolPolicy } from '@harness-forge/shared'
import type { ModelMessage, ToolApprovalStatus, ToolSet } from 'ai'
import type { Logger } from '../logger.ts'
import type { ToolPref } from '../mcp/types.ts'
import type { PluginHost } from '../plugins/types.ts'
import type { Registry } from '../registry/types.ts'
import { GUARD_TIMEOUTS } from '../plugins/guard.ts'

export type ApprovalOutcome = 'not-applicable' | 'approved' | 'denied' | 'user-approval'
export type HookDecision = 'allow' | 'ask' | 'deny'
/** A policy value after evaluation (a policy function may also answer `deny`). */
export type EffectivePolicy = ToolPolicy | 'deny'

export interface ApprovalInput {
  override: ToolOverride | null
  hookDecision: HookDecision | undefined
  toolMode: ToolMode
  policy: EffectivePolicy
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

const DECISIONS: Readonly<Record<HookDecision, ApprovalOutcome>> = {
  allow: 'approved',
  ask: 'user-approval',
  deny: 'denied',
}

/** The pure resolution table (steps 1-5). */
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
      return { outcome: input.policy === 'safe' ? 'not-applicable' : 'user-approval' }
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

/** A tool of the run as the approval function sees it. */
export interface ApprovalTool {
  readonly pluginId: string
  readonly definition: ToolDefinition
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
}

/** Evaluates the tool policy: default `ask`; a function is guarded (3 s) and a throw or timeout counts as `always`. */
export async function evaluatePolicy(
  tool: ApprovalTool,
  input: unknown,
  context: Omit<ToolCallContext, 'signal'>,
  plugins: Pick<PluginHost, 'guard'>,
  signal: AbortSignal,
): Promise<EffectivePolicy> {
  const policy = tool.definition.policy
  if (policy === undefined)
    return 'ask'
  if (typeof policy === 'string')
    return POLICIES.has(policy) ? policy : 'ask'
  try {
    const value = await plugins.guard(
      tool.pluginId,
      guardSignal => policy.call(tool.definition, input, { ...context, signal: guardSignal }),
      { timeoutMs: GUARD_TIMEOUTS.hook, phase: 'tool', signal, label: `${tool.definition.name} policy` },
    )
    return typeof value === 'string' && POLICIES.has(value) ? value as EffectivePolicy : 'always'
  }
  catch {
    return 'always'
  }
}

/** The approval function passed as `streamText({ toolApproval })` (and re-run by the SDK on approved continuations). */
export function createToolApproval(context: ToolApprovalContext) {
  return async (options: { toolCall: { toolName: string, toolCallId: string, input: unknown }, messages: ModelMessage[], tools?: ToolSet }): Promise<ToolApprovalStatus> => {
    const { toolCall } = options
    try {
      // A call to a tool this run does not offer (tool mode off, disabled, owner inactive) can only be denied: an
      // approved call without an executable tool would leave the model without a result.
      const tool = context.tools.get(toolCall.toolName)
      if (tool === undefined)
        return { type: 'denied', reason: DENIED_UNAVAILABLE }
      const override = context.prefs.get(toolCall.toolName)?.override ?? null
      if (override !== null)
        return toApprovalStatus(resolveApproval({ override, hookDecision: undefined, toolMode: context.toolMode, policy: 'ask' }))

      const hookOutput: { decision?: HookDecision } = {}
      await context.registry.hooks.run(
        'tool.approve',
        { chatId: context.chatId, modelRef: context.modelRef, tool: toolCall.toolName, toolCallId: toolCall.toolCallId, input: toolCall.input },
        hookOutput,
      )
      const hookDecision = isHookDecision(hookOutput.decision) ? hookOutput.decision : undefined
      if (hookDecision !== undefined)
        return toApprovalStatus(resolveApproval({ override: null, hookDecision, toolMode: context.toolMode, policy: 'ask' }))

      const policy = await evaluatePolicy(
        tool,
        toolCall.input,
        { chatId: context.chatId, modelRef: context.modelRef, toolCallId: toolCall.toolCallId, messages: options.messages },
        context.plugins,
        context.signal,
      )
      return toApprovalStatus(resolveApproval({ override: null, hookDecision: undefined, toolMode: context.toolMode, policy }))
    }
    catch (error) {
      context.logger.warn('tool approval failed, asking the user', { tool: toolCall.toolName, err: error })
      return 'user-approval'
    }
  }
}
