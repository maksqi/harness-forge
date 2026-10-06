// The tool set of a sub-agent (Phase 9, ADR-043, ARCHITECTURE.md 6.22). Signatures FROZEN after P9-0b (C26); the
// implementation is W9.5's.
//
// A child only gets the tools that can run without approval in the parent's permission mode, and its approval function
// turns every request for approval into a denial, so a child never creates an approval request (no card, no
// `pending_approval`):
// - `assembleTools` with the parent's mode (which applies `applyToolMode`, `modes.ts`), the parent's workspace and a
//   child copy of the parent's run scope, no agent scope (depth 1: a `task` call inside a child finds none) and the call
//   id prefix `<parentCallId>/` (the child's calls are journaled under the parent assistant message with the tool call id
//   `<parent call id>/<child call id>`, so rewind and the changes panel cover them);
// - minus the `core-agent` tools (`task` is never in a child's set) and `generate_image`;
// - type `explore`, or a parent in `plan`, lowers the effective mode to `ask`; in `ask` the tools with workspace access
//   `write` / `execute` are not offered (`ask`: the safe tools and the read tools);
// - minus every tool that can only ask (or is always denied) in the effective mode: `staticApprovalOutcome`
//   (`approval.ts`) of the tool's static policy and the user override (`ask` / `deny` overrides drop the tool); a policy
//   function decides per call, so such a tool stays and the approval function is the gate (`edits`: writes and the shell
//   commands that match a shell rule; `auto`: everything except `always`).
// - Phase 10 (ADR-045): a custom agent's `tools` list (`allowlist`) filters **after** this ceiling with the shared
//   `matchToolAllowlist` (exact names, `*` prefixes, `mcp__<server>` entries): it only narrows the set, so it never adds
//   a tool, never brings back a tool that would ask, a `core-agent` tool (`task`, `skill`) or `generate_image`; a custom
//   agent runs with the type `general` (an `explore` child stays read-only).
// The approval function is `createToolApproval` of the effective mode over the child's tools and scope, with
// `user-approval` mapped to a denial (`SUBAGENT_APPROVAL_DENIED_TEXT`); the hooks see the prefixed call id.
// The child's scope is a shallow copy of the parent's with its own `shellCwd` object: a child's `cd` never moves the
// parent's sticky folder (the journal, the rules and the message id stay the parent's).
// Phase 11 (C37, ADR-048): a child with hooks (`ChildToolsInput.hooks`, `ChildHooks` of `../hooks.ts`) runs `PreToolUse`
// in its approval function (an `ask` becomes the sub-agent denial above, never a card) and the `PreToolUse` rewrite and
// `PostToolUse` in its tool wrapper, with the prefixed call ids; nothing of it is stored.
import type { TaskType, ToolMode } from '@harness-forge/shared'
import type { ToolApprovalStatus, ToolSet } from 'ai'
import type { ResolvedModel } from '../../providers/types.ts'
import type { OpenWorkspace } from '../../services/projects/types.ts'
import type { WorkspaceRunScopeInit } from '../../workspace/run-scope.ts'
import type { ApprovalTool } from '../approval.ts'
import type { ToolHooks } from '../hooks.ts'
import type { ChildSession } from './host.ts'
import { GENERATE_IMAGE_TOOL_NAME, matchToolAllowlist } from '@harness-forge/shared'
import { CORE_AGENT_PLUGIN_ID } from '../../builtin-plugins/core-agent/index.ts'
import { createToolApproval, staticApprovalOutcome, toolWorkspaceAccess } from '../approval.ts'
import { assembleTools } from '../tools.ts'

/** The reason a sub-agent's call that would need an approval is denied with. */
export const SUBAGENT_APPROVAL_DENIED_TEXT = 'Sub-agents cannot ask the user: this call needs approval.'

/** The approval function of a child (`streamText({ toolApproval })`). */
export type ChildToolApproval = ReturnType<typeof createToolApproval>

export interface ChildToolsInput {
  /**
   * The host (`./host.ts`; the parent run, or a background task's detached session): deps (registry, plugins, tool
   * prefs, MCP, `env.workspaceShell`), chat id, the message id of the journal rows, the logger.
   */
  readonly session: ChildSession
  /** `explore` (read-only) or `general` (also every custom agent type, Phase 10). */
  readonly type: TaskType
  /** The parent's permission mode. */
  readonly toolMode: ToolMode
  /** The child's model (its ref, and whether it supports tools). */
  readonly model: ResolvedModel
  /** The parent run's open project folder, or null. */
  readonly workspace: OpenWorkspace | null
  /** The parent run scope, or null without a workspace. */
  readonly scope: WorkspaceRunScopeInit | null
  /** The parent's `task` call id (the prefix of the child's journal tool call ids). */
  readonly parentCallId: string
  /** The child's signal (the parent call's signal and the child deadline). */
  readonly signal: AbortSignal
  /**
   * Phase 10 (ADR-045): a custom agent's normalized `tools` list; only the tools of the ceiling it matches stay
   * (`matchToolAllowlist`). Null or absent = no restriction (the builtins, an agent without `tools`); `[]` = no tool.
   */
  readonly allowlist?: readonly string[] | null
  /**
   * Phase 11 (ADR-048): the child's hooks (`ChildSession.hooks.forChild(childCallIdPrefix(parentCallId))`); null or
   * absent = none.
   */
  readonly hooks?: ToolHooks | null
}

export interface ChildTools {
  /** The AI SDK tools of the child (empty when none). */
  readonly tools: ToolSet
  /** The child's tools by name (what its approval function sees). */
  readonly byName: ReadonlyMap<string, ApprovalTool>
  /** The child's approval function: never `user-approval`. */
  readonly toolApproval: ChildToolApproval
}

/** The mode a child's tools and approvals follow: `ask` for `explore` and for a parent in `plan`, else the parent's. */
export function childToolMode(type: TaskType, parentMode: ToolMode): ToolMode {
  return type === 'explore' || parentMode === 'plan' ? 'ask' : parentMode
}

/** The call id prefix of a child's calls: `<parentCallId>/`. */
export function childCallIdPrefix(parentCallId: string): string {
  return `${parentCallId}/`
}

/** A copy of the parent's run scope with its own sticky folder (the child's `cd` never moves the parent's). */
export function childRunScope(scope: WorkspaceRunScopeInit | null): WorkspaceRunScopeInit | null {
  return scope === null ? null : { ...scope, shellCwd: { current: scope.shellCwd.current } }
}

/** The stored override of a tool (`ToolPref.override`). */
type StoredOverride = Parameters<typeof staticApprovalOutcome>[2]

/**
 * Whether a child is offered `tool` (see the module comment): never a `core-agent` tool or `generate_image`; in `ask`
 * no workspace `write` / `execute` tool; never a tool whose static outcome in `mode` (policy and stored override) is
 * `user-approval` or `denied`.
 */
export function offeredToChild(tool: ApprovalTool, mode: ToolMode, stored: StoredOverride): boolean {
  if (tool.pluginId === CORE_AGENT_PLUGIN_ID || tool.definition.name === GENERATE_IMAGE_TOOL_NAME)
    return false
  const access = toolWorkspaceAccess(tool.definition)
  if (mode === 'ask' && (access === 'write' || access === 'execute'))
    return false
  const outcome = staticApprovalOutcome(tool, mode, stored)
  return outcome !== 'user-approval' && outcome !== 'denied'
}

/** `status` with `user-approval` turned into the sub-agent denial (nothing else changes). */
export function denyUserApproval(status: ToolApprovalStatus): ToolApprovalStatus {
  const type = typeof status === 'object' ? status.type : status
  return type === 'user-approval' ? { type: 'denied', reason: SUBAGENT_APPROVAL_DENIED_TEXT } : status
}

/** The tools of one sub-agent (see the module comment). */
export async function childTools(input: ChildToolsInput): Promise<ChildTools> {
  const { session, model } = input
  const { deps, logger } = session.ctx
  const mode = childToolMode(input.type, input.toolMode)
  const scope = childRunScope(input.scope)
  const callIdPrefix = childCallIdPrefix(input.parentCallId)
  const assembled = await assembleTools({
    chatId: session.chatId,
    messageId: session.assistantId,
    modelRef: model.modelRef,
    toolMode: input.toolMode,
    modelSupportsTools: model.entry.capabilities.tools,
    registry: deps.registry,
    plugins: deps.plugins,
    toolService: deps.tools,
    mcp: deps.mcp,
    signal: input.signal,
    logger,
    workspace: input.workspace,
    scope,
    allowExecute: deps.env.workspaceShell,
    continuation: null,
    agent: null,
    callIdPrefix,
    hooks: input.hooks ?? null,
  })

  const active = assembled.activeTools === undefined ? null : new Set(assembled.activeTools)
  const allowlist = input.allowlist ?? null
  const tools: ToolSet = {}
  const byName = new Map<string, ApprovalTool>()
  for (const [name, entry] of assembled.byName) {
    const tool = assembled.tools[name]
    if (tool === undefined || (active !== null && !active.has(name)))
      continue
    if (!offeredToChild(entry, mode, assembled.prefs.get(name)?.override ?? null))
      continue
    if (allowlist !== null && !matchToolAllowlist(name, allowlist))
      continue
    tools[name] = tool
    byName.set(name, entry)
  }

  const approval = createToolApproval({
    chatId: session.chatId,
    modelRef: model.modelRef,
    toolMode: mode,
    tools: byName,
    prefs: assembled.prefs,
    registry: deps.registry,
    plugins: deps.plugins,
    signal: input.signal,
    logger,
    workspace: assembled.workspace,
    scope: assembled.scope,
    hooks: input.hooks ?? null,
  })
  const toolApproval: ChildToolApproval = async options => denyUserApproval(await approval({
    ...options,
    toolCall: { ...options.toolCall, toolCallId: `${callIdPrefix}${options.toolCall.toolCallId}` },
  }))
  return { tools, byName, toolApproval }
}
