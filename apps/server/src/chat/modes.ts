// Permission modes and the tool set (Phase 9, ADR-041 amends ADR-032, ARCHITECTURE.md 6.19). Signatures FROZEN after
// P9-0b (C26); the implementation is W9.3's.
//
// - `applyToolMode(tools, { toolMode, continuation })`, called by `assembleTools` (`tools.ts`) on the candidate tools
//   (and by the sub-agent tool set, `subagent/tools.ts`):
//   - `off`: no tool (`assembleTools` returns before it is called);
//   - `plan`: the tools with workspace access `write` or `execute` (an unknown access counts as `execute`) are not
//     offered; everything else stays, `exit_plan_mode` included, and tools without an access level (MCP, third-party
//     tools) keep their policy and ask like in `ask` (`approval.ts`). The server accepts `plan` in any chat: without a
//     project there is no workspace tool to drop;
//   - `ask`, `edits`, `auto`: `core-agent`'s `exit_plan_mode` is not offered, except on a continuation whose message
//     holds an approved `exit_plan_mode` part (`approval-responded`, `approved: true`): it then stays in `tools` (so the
//     SDK executes the approved call) and is left out of `activeTools` (so the model never calls it again);
//   - `todo_write` and `task` stay in every mode with tools (a sub-agent's set drops them, `subagent/tools.ts`).
//   `activeTools` is set only in that continuation case; undefined = every tool of `tools`.
// - `checkPlanApprovalMode(stored, merged, toolMode)`, called by the continuation branch of `prepare.ts` before the
//   history is written: when the merged message holds an approved `exit_plan_mode` part while the continuation's
//   `toolMode` is not `edits` or `ask`, it throws `validation_error` on `['toolMode']` (the web switches the mode
//   first). `off` and `plan` are the documented cases; `auto` is refused too, since the approved output names the mode
//   the user picked on the plan card (`exitPlanModeOutputSchema.mode`: `edits` | `ask`).
import type { ToolDefinition } from '@harness-forge/plugin-sdk'
import type { HarnessUIMessage, ToolMode } from '@harness-forge/shared'
import { validationError } from '@harness-forge/shared'
import { EXIT_PLAN_MODE_TOOL_NAME } from '../builtin-plugins/core-agent/index.ts'
import { isPlanExitTool, toolWorkspaceAccess } from './approval.ts'

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

/** The modes an `exit_plan_mode` call can be approved in (`exitPlanModeOutputSchema.mode`). */
export const PLAN_APPROVAL_MODES: readonly ToolMode[] = Object.freeze(['edits', 'ask'])

/** The message of the 400 for approving a plan in another mode. */
export const PLAN_APPROVAL_MODE_MESSAGE = 'A plan can only be approved with toolMode "edits" or "ask": switch the chat\'s permission mode first.'

const PLAN_EXIT_PART_TYPE = `tool-${EXIT_PLAN_MODE_TOOL_NAME}`

/** The tool changes the workspace (access `write` or `execute`): not offered in `plan`. */
function changesWorkspace(tool: ModeTool): boolean {
  const access = toolWorkspaceAccess(tool.definition)
  return access === 'write' || access === 'execute'
}

/**
 * The message holds an `exit_plan_mode` part the user approved and the run has not executed yet (`approval-responded`
 * with `approved: true`): the SDK executes every such part when the continuation starts.
 */
export function hasApprovedPlanExit(message: HarnessUIMessage | null): boolean {
  if (message === null)
    return false
  return message.parts.some((part) => {
    const value = part as unknown as { type: string, state?: unknown, approval?: unknown }
    if (value.type !== PLAN_EXIT_PART_TYPE || value.state !== 'approval-responded')
      return false
    const approval = value.approval
    return typeof approval === 'object' && approval !== null && (approval as { approved?: unknown }).approved === true
  })
}

/** The tool set of a permission mode (see the module comment). */
export function applyToolMode<T extends ModeTool>(tools: readonly T[], options: ToolModeOptions): ToolModeResult<T> {
  const { toolMode } = options
  if (toolMode === 'off')
    return { tools: [] }
  if (toolMode === 'plan')
    return { tools: tools.filter(tool => !changesWorkspace(tool)) }
  if (!hasApprovedPlanExit(options.continuation))
    return { tools: tools.filter(tool => !isPlanExitTool(tool)) }
  const kept = [...tools]
  if (!kept.some(isPlanExitTool))
    return { tools: kept }
  return { tools: kept, activeTools: kept.filter(tool => !isPlanExitTool(tool)).map(tool => tool.definition.name) }
}

/**
 * Refuses to approve an `exit_plan_mode` call in a continuation whose `toolMode` is not `edits` or `ask` (see the
 * module comment): `validation_error` on `['toolMode']`. `stored` is the continued message as stored, `merged` the same
 * message with the request's decisions merged; every approved part of `merged` runs in this continuation, so `merged`
 * decides.
 */
export function checkPlanApprovalMode(_stored: HarnessUIMessage, merged: HarnessUIMessage, toolMode: ToolMode): void {
  if (PLAN_APPROVAL_MODES.includes(toolMode) || !hasApprovedPlanExit(merged))
    return
  throw validationError([{ path: ['toolMode'], message: PLAN_APPROVAL_MODE_MESSAGE, code: 'custom' }], PLAN_APPROVAL_MODE_MESSAGE)
}
