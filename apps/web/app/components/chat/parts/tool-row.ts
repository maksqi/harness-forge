// The first argument of a tool row (docs/UI.md 7.2, 7.15, 7.19): the workspace registry first (the path, the pattern
// or the first line of a shell command), then for the builtin generate_image tool always its prompt (a model may list
// `aspectRatio` before it), else the first string value of the input, on one line. Shared by ToolPart and the share
// page's ShareToolRow. No Vue components, no stores.
import { GENERATE_IMAGE_TOOL_NAME } from '@harness-forge/shared'
import { firstStringArg } from '../chat-format'
import { commandFirstLine, workspaceApprovalView, workspaceRowArgument } from './tools/workspace-tools'

export function toolRowArgument(toolName: string, input: unknown): string | null {
  const workspace = workspaceRowArgument(toolName, input)
  if (workspace)
    return workspace
  if (toolName === GENERATE_IMAGE_TOOL_NAME && typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const prompt = (input as Record<string, unknown>).prompt
    const line = typeof prompt === 'string' ? firstStringArg(prompt) : null
    if (line)
      return line
  }
  return firstStringArg(input)
}

/**
 * The accessible name of an approval card and its live-region announcement (docs/UI.md 7.3): "Approval needed: run
 * {command}" for a shell command (its first line, at most 60 characters), else "Approval needed: {tool}".
 */
export function toolApprovalLabel(toolName: string, input: unknown): string {
  const view = toolName === 'shell' ? workspaceApprovalView(toolName, input) : null
  if (view?.kind === 'terminal') {
    const command = commandFirstLine(view.command)
    if (command)
      return `Approval needed: run ${command}`
  }
  return `Approval needed: ${toolName}`
}
