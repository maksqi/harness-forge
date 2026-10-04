// The `exit_plan_mode` tool of `core-agent` (ADR-041; policy `always`, no workspace access, timeout 60 s). The host
// offers it only in plan mode (`chat/modes.ts`) and resolves every call to `user-approval` before overrides and hooks
// (`chat/approval.ts`), so the user always sees the plan card. Approve: the continuation carries the mode the user
// picked (`edits` or `ask`) and `execute` returns `{ approved: true, mode }` from the agent scope's `toolMode`; Keep
// planning: the SDK sends `execution-denied` with the user's feedback as the reason, and the model revises the plan.
//
// P9-0b (C27): the definition (name, description, schema, policy, timeout, model text) is final and frozen. `execute`
// (W9.3) runs only for an approved call: the continuation's `toolMode` is the mode the user picked (`prepare.ts`
// refuses to approve in any other mode, `chat/modes.ts` `checkPlanApprovalMode`), read from the run's agent scope. A
// call without an agent scope, or in another mode, fails with a tool error (it never reports a mode it is not in).
//
// The model reads "The user approved the plan. Mode is now <label>. Implement it now; track progress with todo_write."
// (label "Accept edits" or "Ask"). Phase 10 (ADR-047; the text frozen by C32 in P10-0b, the plan file written by W10.5
// through `scope.savePlan`): a second line "The plan was saved to <planPath>." when the plan file was written, or "The
// plan file could not be saved: <planError>." when the write failed (the approval stands either way).
import type { ToolDefinition, ToolResultOutput } from '@harness-forge/plugin-sdk'
import type { ExitPlanModeInput, ExitPlanModeOutput } from '@harness-forge/shared'
import type { AgentRunScope } from '../../chat/agent-scope.ts'
import { exitPlanModeInputSchema, exitPlanModeOutputSchema } from '@harness-forge/shared'
import { agentScopeOf } from '../../chat/agent-scope.ts'
import { EXIT_PLAN_MODE_TIMEOUT_MS, textModelOutput, TOOL_MODE_LABELS } from './common.ts'

export const EXIT_PLAN_MODE_TOOL_NAME = 'exit_plan_mode'

export const EXIT_PLAN_MODE_DESCRIPTION = 'Present your implementation plan to the user for approval and leave plan mode. Use it only in plan mode, once you have investigated with read-only tools and have a complete, concrete plan; pass the whole plan as Markdown (the steps, the files to create or change, how to verify the result). The user either approves it, and you then implement it, or asks you to keep planning: you then receive their feedback as the reason of the denied call; revise the plan and call this tool again. Do not use it to ask questions (ask in your reply instead) or for requests that need no code changes, such as explaining or researching something.'

/** The tool error of a call outside a chat run (no agent scope). */
export const EXIT_PLAN_MODE_NO_RUN_ERROR = 'A plan can only be approved in a chat.'
/** The tool error of a call whose run is not in a mode a plan is approved in. */
export const EXIT_PLAN_MODE_MODE_ERROR = 'A plan can only be approved in the Accept edits or Ask mode.'

/** The output of an approved call: the run's mode (`edits` or `ask`); throws the tool errors above otherwise. */
export function exitPlanModeOutput(scope: AgentRunScope | null): ExitPlanModeOutput {
  if (scope === null)
    throw new Error(EXIT_PLAN_MODE_NO_RUN_ERROR)
  const mode = scope.toolMode
  if (mode !== 'edits' && mode !== 'ask')
    throw new Error(EXIT_PLAN_MODE_MODE_ERROR)
  return { approved: true, mode }
}

/** The text the model reads for an approved `exit_plan_mode` output (the plan file line only with a plan file). */
export function exitPlanModeModelText(output: ExitPlanModeOutput): string {
  const approved = `The user approved the plan. Mode is now ${TOOL_MODE_LABELS[output.mode]}. Implement it now; track progress with todo_write.`
  if (output.planPath !== undefined)
    return `${approved}\nThe plan was saved to ${output.planPath}.`
  const planError = (output.planError ?? '').trim().replace(/\.+$/, '')
  return planError === '' ? approved : `${approved}\nThe plan file could not be saved: ${planError}.`
}

export function createExitPlanModeTool(): ToolDefinition<ExitPlanModeInput, ExitPlanModeOutput> {
  return {
    name: EXIT_PLAN_MODE_TOOL_NAME,
    description: EXIT_PLAN_MODE_DESCRIPTION,
    inputSchema: exitPlanModeInputSchema,
    policy: 'always',
    timeoutMs: EXIT_PLAN_MODE_TIMEOUT_MS,
    async execute(_input, c) {
      return exitPlanModeOutput(agentScopeOf(c))
    },
    toModelOutput(output): ToolResultOutput {
      return textModelOutput(exitPlanModeOutputSchema, output, exitPlanModeModelText)
    },
  }
}
