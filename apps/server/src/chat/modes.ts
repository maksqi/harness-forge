// Permission modes and the tool set (Phase 9, ADR-041 amends ADR-032, ARCHITECTURE.md 6.19). Signatures FROZEN after
// P9-0b (C26); the implementation is W9.3's.
//
// - `applyToolMode(tools, { toolMode, continuation })`, called by `assembleTools` (`tools.ts`) on the candidate tools
//   (and by the sub-agent tool set, `subagent/tools.ts`). W9.3: in `plan` the tools with workspace access `write` or
//   `execute` are not offered (tools without an access level, MCP and third-party tools, stay and ask like in `ask`)
//   and `exit_plan_mode` is offered; outside `plan` it is not, except on a continuation whose message holds an approved
//   `exit_plan_mode` part: then it stays in `tools` (so the SDK executes the approved call) and is left out of
//   `activeTools` (so the model never calls it again). `todo_write` and `task` stay in every mode with tools.
// - `checkPlanApprovalMode(stored, merged, toolMode)`, called by the continuation branch of `prepare.ts`. W9.3: when
//   the merge approves an `exit_plan_mode` call while the continuation's `toolMode` is `off` or `plan`, it throws
//   `validation_error` on `['toolMode']` (the web switches the mode first).
//
// P9-0b stub: `applyToolMode` returns the tools unchanged (no `activeTools`), `checkPlanApprovalMode` accepts everything;
// `plan` resolves approvals like `ask` (`approval.ts`).
import type { ToolDefinition } from '@harness-forge/plugin-sdk'
import type { HarnessUIMessage, ToolMode } from '@harness-forge/shared'

/** A tool as the mode filter sees it (`RegisteredTool` and `ApprovalTool` fit). */
export interface ModeTool {
  readonly pluginId: string
  readonly definition: Pick<ToolDefinition, 'name' | 'workspace'>
}

export interface ToolModeOptions {
  /** The run's permission mode. */
  readonly toolMode: ToolMode
  /** The continued assistant message of an approval continuation (merged decisions), else null. */
  readonly continuation: HarnessUIMessage | null
}

export interface ToolModeResult<T extends ModeTool> {
  /** The tools of the run (what the SDK can execute). */
  readonly tools: T[]
  /** The names the model may call (`streamText({ activeTools })`); undefined = every tool of `tools`. */
  readonly activeTools?: string[]
}

/** The tool set of a permission mode (stub until W9.3: unchanged; see the module comment). */
export function applyToolMode<T extends ModeTool>(tools: readonly T[], _options: ToolModeOptions): ToolModeResult<T> {
  return { tools: [...tools] }
}

/**
 * Refuses to approve an `exit_plan_mode` call in a continuation whose `toolMode` is `off` or `plan` (stub until W9.3:
 * accepts everything; see the module comment). `stored` is the continued message as stored, `merged` the same message
 * with the request's decisions merged.
 */
export function checkPlanApprovalMode(_stored: HarnessUIMessage, _merged: HarnessUIMessage, _toolMode: ToolMode): void {}
