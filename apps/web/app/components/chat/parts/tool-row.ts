// The first argument of a tool row (docs/UI.md 7.2, 7.15): the first string value of the input, on one line; for the
// builtin generate_image tool always its prompt (a model may list `aspectRatio` before it). Shared by ToolPart and the
// share page's ShareToolRow. No Vue, no stores.
import { GENERATE_IMAGE_TOOL_NAME } from '@harness-forge/shared'
import { firstStringArg } from '../chat-format'

export function toolRowArgument(toolName: string, input: unknown): string | null {
  if (toolName === GENERATE_IMAGE_TOOL_NAME && typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const prompt = (input as Record<string, unknown>).prompt
    const line = typeof prompt === 'string' ? firstStringArg(prompt) : null
    if (line)
      return line
  }
  return firstStringArg(input)
}
