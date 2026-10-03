// The tool set of a sub-agent (Phase 9, ADR-043, ARCHITECTURE.md 6.22). Signatures FROZEN after P9-0b (C26); the
// implementation is W9.5's.
//
// W9.5: `assembleTools` with the parent's mode, workspace and scope, then `applyToolMode` (`modes.ts`), minus every tool
// that can only ask in that mode, minus the `core-agent` tools (never `task`: depth 1) and `generate_image`, minus the
// tools with a user override `deny` or `ask`; type `explore`, or a parent in `plan`, also drops the workspace `write` /
// `execute` tools and lowers the effective mode to `ask`. Child calls bind the parent run scope with `toolCallId =
// <parentCallId>/<child call id>` and a copy of the shell folder; no agent scope. The approval function is
// `createToolApproval(parent mode, child tools)` with `user-approval` mapped to a denial
// (`SUBAGENT_APPROVAL_DENIED_TEXT`): a child never creates an approval request.
//
// P9-0b stub: no tools, and an approval function that denies.
import type { TaskType, ToolMode } from '@harness-forge/shared'
import type { ToolSet } from 'ai'
import type { ResolvedModel } from '../../providers/types.ts'
import type { OpenWorkspace } from '../../services/projects/types.ts'
import type { WorkspaceRunScopeInit } from '../../workspace/run-scope.ts'
import type { ApprovalTool, createToolApproval } from '../approval.ts'
import type { RunSession } from '../pipeline.ts'

/** The reason a sub-agent's call that would need an approval is denied with. */
export const SUBAGENT_APPROVAL_DENIED_TEXT = 'Sub-agents cannot ask the user: this call needs approval.'

/** The approval function of a child (`streamText({ toolApproval })`). */
export type ChildToolApproval = ReturnType<typeof createToolApproval>

export interface ChildToolsInput {
  /** The parent run: deps (registry, plugins, tool prefs, MCP, `env.workspaceShell`), chat id, the logger. */
  readonly session: RunSession
  /** `explore` (read-only) or `general`. */
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
}

export interface ChildTools {
  /** The AI SDK tools of the child (empty when none). */
  readonly tools: ToolSet
  /** The child's tools by name (what its approval function sees). */
  readonly byName: ReadonlyMap<string, ApprovalTool>
  /** The child's approval function: never `user-approval`. */
  readonly toolApproval: ChildToolApproval
}

/** The tools of one sub-agent (stub until W9.5: none; see the module comment). */
export async function childTools(_input: ChildToolsInput): Promise<ChildTools> {
  return {
    tools: {},
    byName: new Map(),
    toolApproval: async () => ({ type: 'denied', reason: SUBAGENT_APPROVAL_DENIED_TEXT }),
  }
}
