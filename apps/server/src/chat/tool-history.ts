// Tool history of a request that sends no tools (ARCHITECTURE.md 6.1): tool mode `off`, a model without tool support,
// or no usable tool. Earlier tool calls and results would reach the provider as tool-call / tool-result content, which
// providers such as Anthropic and Amazon Bedrock reject when a request defines no tools. For such requests the tool
// parts of the history become compact text in their assistant message, for example
//   [tool web_fetch({"url":"https://example.com"}) → ok: {"status":200,"text":"…"}]
// and that message is sent as one assistant turn (its step boundaries only separate tool round trips). Calls without a
// result (streaming, awaiting approval) are left out, as `convertToModelMessages({ ignoreIncompleteToolCalls })` does.
// Only the copy sent to the model changes: the stored transcript keeps its tool parts.
import type { HarnessUIMessage, HarnessUIMessagePart } from '@harness-forge/shared'
import type { DynamicToolUIPart, ToolUIPart, UITools } from 'ai'
import { getToolName, isToolUIPart } from 'ai'

/** Characters of a tool input kept in its text form. */
export const TOOL_TEXT_INPUT_MAX_CHARS = 500
/** Characters of a tool output (or error text) kept in its text form. */
export const TOOL_TEXT_OUTPUT_MAX_CHARS = 2000

type ToolPart = ToolUIPart<UITools> | DynamicToolUIPart

/** `text` cut to at most `max` characters (never inside a surrogate pair), marked with an ellipsis when cut. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max)
    return text
  let end = Math.max(0, max)
  const last = text.charCodeAt(end - 1)
  if (last >= 0xD800 && last <= 0xDBFF)
    end -= 1
  return `${text.slice(0, end)}…`
}

/** One-line text of a tool value: a string as it is, anything else as JSON; whitespace runs collapsed, then capped. */
export function compactValue(value: unknown, max: number): string {
  let text: string
  if (typeof value === 'string') {
    text = value
  }
  else {
    try {
      text = JSON.stringify(value) ?? String(value)
    }
    catch {
      text = String(value)
    }
  }
  return truncateText(text.replace(/\s+/g, ' ').trim(), max)
}

function reasonSuffix(reason: string | undefined): string {
  const text = reason === undefined ? '' : compactValue(reason, TOOL_TEXT_INPUT_MAX_CHARS)
  return text === '' ? '' : `: ${text}`
}

/** The text form of a tool part, or null for a call without a result (incomplete, awaiting approval, preliminary). */
export function toolPartText(part: ToolPart): string | null {
  const name = getToolName(part)
  const call = part.input === undefined ? name : `${name}(${compactValue(part.input, TOOL_TEXT_INPUT_MAX_CHARS)})`
  switch (part.state) {
    case 'output-available':
      return part.preliminary === true ? null : `[tool ${call} → ok: ${compactValue(part.output ?? null, TOOL_TEXT_OUTPUT_MAX_CHARS)}]`
    case 'output-error':
      return `[tool ${call} → error: ${compactValue(part.errorText, TOOL_TEXT_OUTPUT_MAX_CHARS)}]`
    case 'output-denied':
      return `[tool ${call} → denied${reasonSuffix(part.approval.reason)}]`
    case 'approval-responded':
      // An approved call of a continuation that has no tools now cannot run.
      return part.approval.approved ? `[tool ${call} → approved, not run]` : `[tool ${call} → denied${reasonSuffix(part.approval.reason)}]`
    default:
      return null
  }
}

/**
 * The history for a request that defines no tools: in every message with tool parts, each tool part becomes a text
 * part (or is left out, see `toolPartText`) and the `step-start` parts are dropped. Messages without tool parts are
 * returned as they are; the input is never changed.
 */
export function toolPartsAsText(messages: readonly HarnessUIMessage[]): HarnessUIMessage[] {
  return messages.map((message) => {
    if (!message.parts.some(part => isToolUIPart(part)))
      return message
    const parts: HarnessUIMessagePart[] = []
    for (const part of message.parts) {
      if (part.type === 'step-start')
        continue
      if (!isToolUIPart(part)) {
        parts.push(part)
        continue
      }
      const text = toolPartText(part)
      if (text !== null)
        parts.push({ type: 'text', text })
    }
    return { ...message, parts }
  })
}
