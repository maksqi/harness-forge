// The first argument of a tool row (docs/UI.md 7.2, 7.15, 7.19, 7.25): the workspace registry first (the path, the
// pattern or the first line of a shell command), then the agent tools of `core-agent` (Phase 9: the current todo's
// `activeForm`, else its content; the plan's first heading, else its first line; a sub-agent's description), then for
// the builtin generate_image tool always its prompt (a model may list `aspectRatio` before it), else the first string
// value of the input, on one line. Shared by ToolPart and the share page's ShareToolRow. No Vue components, no stores.
import { GENERATE_IMAGE_TOOL_NAME } from '@harness-forge/shared'
import { planOf, planTitle, taskInputOf, TODO_TOOL_NAME, todoListOf, todoRowArgument } from '../agent/agent-tools'
import { firstStringArg, PLAN_TOOL_NAME, TASK_TOOL_NAME } from '../chat-format'
import { commandFirstLine, workspaceApprovalView, workspaceRowArgument } from './tools/workspace-tools'

/** + Phase 9: the argument of an agent tool whose input parses; undefined for other tools and other values. */
function agentRowArgument(toolName: string, input: unknown): string | null | undefined {
  if (toolName === TODO_TOOL_NAME)
    return todoListOf(input, undefined) === null ? undefined : todoRowArgument(input)
  if (toolName === PLAN_TOOL_NAME) {
    const plan = planOf(input)
    return plan === null ? undefined : planTitle(plan)
  }
  if (toolName === TASK_TOOL_NAME) {
    const task = taskInputOf(input)
    return task ? firstStringArg(task.description) : undefined
  }
  return undefined
}

export function toolRowArgument(toolName: string, input: unknown): string | null {
  const workspace = workspaceRowArgument(toolName, input)
  if (workspace)
    return workspace
  const agent = agentRowArgument(toolName, input)
  if (agent !== undefined)
    return agent
  if (toolName === GENERATE_IMAGE_TOOL_NAME && typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const prompt = (input as Record<string, unknown>).prompt
    const line = typeof prompt === 'string' ? firstStringArg(prompt) : null
    if (line)
      return line
  }
  return firstStringArg(input)
}

/**
 * The accessible name of an approval card and its live-region announcement (docs/UI.md 7.3, 7.25): "Approval needed: run
 * {command}" for a shell command (its first line, at most 60 characters), "Plan ready for review" for a plan
 * (`exit_plan_mode` with a valid input, Phase 9), else "Approval needed: {tool}".
 */
export function toolApprovalLabel(toolName: string, input: unknown): string {
  if (toolName === PLAN_TOOL_NAME && planOf(input) !== null)
    return 'Plan ready for review'
  const view = toolName === 'shell' ? workspaceApprovalView(toolName, input) : null
  if (view?.kind === 'terminal') {
    const command = commandFirstLine(view.command)
    if (command)
      return `Approval needed: run ${command}`
  }
  return `Approval needed: ${toolName}`
}
