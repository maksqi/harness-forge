// The `exit_plan_mode` tool of `core-agent` (ADR-041; policy `always`, no workspace access, timeout 60 s). The host
// offers it only in plan mode (`chat/modes.ts`) and resolves every call to `user-approval` before overrides and hooks
// (`chat/approval.ts`), so the user always sees the plan card. Approve: the continuation carries the mode the user
// picked (`edits` or `ask`) and `execute` returns `{ approved: true, mode }` from the agent scope's `toolMode`; Keep
// planning: the SDK sends `execution-denied` with the user's feedback as the reason, and the model revises the plan.
//
// P9-0b (C27): the definition (name, description, schema, policy, timeout, model text) is final and frozen; `execute`
// is a stub until W9.3 (`exit-plan-mode*`) implements it (`agentScopeOf(c).toolMode`, `edits` or `ask`).
//
// The model reads "The user approved the plan. Mode is now <label>. Implement it now; track progress with todo_write."
// (label "Accept edits" or "Ask").
import type { ToolDefinition, ToolResultOutput } from '@harness-forge/plugin-sdk'
import type { ExitPlanModeInput, ExitPlanModeOutput } from '@harness-forge/shared'
import { exitPlanModeInputSchema, exitPlanModeOutputSchema } from '@harness-forge/shared'
import { agentToolNotImplemented, EXIT_PLAN_MODE_TIMEOUT_MS, textModelOutput, TOOL_MODE_LABELS } from './common.ts'

export const EXIT_PLAN_MODE_TOOL_NAME = 'exit_plan_mode'

export const EXIT_PLAN_MODE_DESCRIPTION = 'Present your implementation plan to the user for approval and leave plan mode. Use it only in plan mode, once you have investigated with read-only tools and have a complete, concrete plan; pass the whole plan as Markdown (the steps, the files to create or change, how to verify the result). The user either approves it, and you then implement it, or asks you to keep planning: you then receive their feedback as the reason of the denied call; revise the plan and call this tool again. Do not use it to ask questions (ask in your reply instead) or for requests that need no code changes, such as explaining or researching something.'

/** The text the model reads for an approved `exit_plan_mode` output. */
export function exitPlanModeModelText(output: ExitPlanModeOutput): string {
  return `The user approved the plan. Mode is now ${TOOL_MODE_LABELS[output.mode]}. Implement it now; track progress with todo_write.`
}

export function createExitPlanModeTool(): ToolDefinition<ExitPlanModeInput, ExitPlanModeOutput> {
  return {
    name: EXIT_PLAN_MODE_TOOL_NAME,
    description: EXIT_PLAN_MODE_DESCRIPTION,
    inputSchema: exitPlanModeInputSchema,
    policy: 'always',
    timeoutMs: EXIT_PLAN_MODE_TIMEOUT_MS,
    async execute() {
      throw agentToolNotImplemented(EXIT_PLAN_MODE_TOOL_NAME)
    },
    toModelOutput(output): ToolResultOutput {
      return textModelOutput(exitPlanModeOutputSchema, output, exitPlanModeModelText)
    },
  }
}
