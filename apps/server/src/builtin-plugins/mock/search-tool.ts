// `mock:search-tool` (Phase 14, ADR-063, PROVIDERS.md 8 "MCP and search mocks (Phase 14)"; C53-T2, FROZEN after Gate
// P14-0b): a model without native search that calls the builtin `search_web` tool of `core-search`, so the probes and the
// e2e specs drive the builtin search (Brave, Tavily or Exa behind the fake remote) without a real model. The 20th
// language model of the mock provider: `kind: 'chat'`, the `tools` capability only; no native search (the provider's
// `webSearch` hook answers `undefined` for it).
//
// The turn and its results follow the shared Phase 9 rule (`turnOf` of ./turn.ts: the messages after the last user
// message that is not a steer). Checked in this order:
// 1. The turn holds a `search_web` result (the last one counts): a denied result (`execution-denied`) → `The tool call
//    was denied.`; an error result (`error-text` / `error-json`) → `Search failed: <error text>` (whitespace runs
//    collapsed to one space, trimmed, cut to its first 120 code points); otherwise `Results: <title 1> | <title 2> | …`
//    (the result titles in order, each with its whitespace runs collapsed, joined with ` | `), or `Results: none` for
//    an empty list. The titles are read from `results[].title` of the output's JSON: a `json` output, or a `text` /
//    `content` output whose text is that JSON (or holds it between its first `{` and its last `}`); any other output
//    reads as an empty list. A denied approval response in the prompt's last tool message also answers `The tool call
//    was denied.`.
// 2. `search_web` is not among the offered function tools: `Tools are disabled.`
// 3. Otherwise one call `search_web` with `{ "query": <q> }` (id `mock_call_<n>`, n = the assistant messages of the
//    prompt + 1; `finishReason: 'tool-calls'`), where <q> = the text parts of the last user message joined with a space,
//    trimmed and cut to its first 400 code points (`(empty message)` for an empty text).
//
// Timing and usage as `mock:search`: no waits, the text one word per chunk, a fixed usage of 10 input and 5 output
// tokens; the reasoning setting and the output-token cap are ignored; an aborted signal rejects with its reason.
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4GenerateResult, LanguageModelV4StreamPart, LanguageModelV4ToolResultOutput } from '@ai-sdk/provider'
import type { MockPlan } from './models.ts'
import { SEARCH_WEB_TOOL_NAME } from '@harness-forge/shared'
import { MockLanguageModelV4 } from 'ai/test'
import { abortError, MOCK_EMPTY_MESSAGE, MOCK_PROVIDER_ID, MOCK_TOOL_DENIED, MOCK_TOOLS_DISABLED } from './common.ts'
import { firstCodePoints, immediateStream, mockLastUserText, mockSearchUsage, mockStreamHead, mockTextParts } from './search.ts'
import { callStep, isDeniedResult, offeredToolNames, textStep, turnOf } from './turn.ts'
import { textOf } from './workspace.ts'

/** This mock's model id (`mock:search-tool`). */
export const MOCK_SEARCH_TOOL_MODEL_ID = 'search-tool'
/** Code points of the query (the last user text). */
export const MOCK_SEARCH_TOOL_QUERY_MAX_CHARS = 400
/** Followed by the result titles (` | `-joined) or `none`. */
export const MOCK_SEARCH_RESULTS_PREFIX = 'Results:'
/** Followed by the error text of a failed call. */
export const MOCK_SEARCH_FAILED_PREFIX = 'Search failed:'
/** Code points of the error text after `Search failed:`. */
export const MOCK_SEARCH_ERROR_MAX_CHARS = 120

/** The query of the `search_web` call (see the module comment). */
export function mockSearchToolQuery(prompt: LanguageModelV4CallOptions['prompt']): string {
  return firstCodePoints(mockLastUserText(prompt), MOCK_SEARCH_TOOL_QUERY_MAX_CHARS) || MOCK_EMPTY_MESSAGE
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  }
  catch {
    return undefined
  }
}

/** The output's JSON: the `json` value, or the JSON of a text / content output (whole, or from its first `{` to its last `}`). */
function outputJson(output: LanguageModelV4ToolResultOutput): unknown {
  if (output.type === 'json')
    return output.value
  if (output.type !== 'text' && output.type !== 'content')
    return undefined
  const text = textOf(output).trim()
  const whole = parseJson(text)
  if (whole !== undefined)
    return whole
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start >= 0 && end > start ? parseJson(text.slice(start, end + 1)) : undefined
}

/** The result titles of a `search_web` output, in order (see the module comment). */
export function mockSearchTitles(output: LanguageModelV4ToolResultOutput): string[] {
  const results = (outputJson(output) as { results?: unknown } | null | undefined)?.results
  if (!Array.isArray(results))
    return []
  return results.flatMap((result: unknown) => {
    const title = (result as { title?: unknown } | null)?.title
    return typeof title === 'string' ? [oneLine(title)] : []
  })
}

/** The answer after a `search_web` result that is not a denial. */
export function mockSearchResultText(output: LanguageModelV4ToolResultOutput): string {
  if (output.type === 'error-text' || output.type === 'error-json')
    return `${MOCK_SEARCH_FAILED_PREFIX} ${firstCodePoints(oneLine(textOf(output)), MOCK_SEARCH_ERROR_MAX_CHARS)}`.trimEnd()
  const titles = mockSearchTitles(output)
  return `${MOCK_SEARCH_RESULTS_PREFIX} ${titles.length === 0 ? 'none' : titles.join(' | ')}`
}

/** The step of a call (see the module comment). */
export function mockSearchToolPlan(options: LanguageModelV4CallOptions): MockPlan {
  const turn = turnOf(options.prompt)
  const result = turn.results.findLast(entry => entry.toolName === SEARCH_WEB_TOOL_NAME)
  if (result !== undefined)
    return textStep(isDeniedResult(result) ? MOCK_TOOL_DENIED : mockSearchResultText(result.output))
  const last = options.prompt.at(-1)
  if (last?.role === 'tool' && last.content.some(part => part.type === 'tool-approval-response' && !part.approved))
    return textStep(MOCK_TOOL_DENIED)
  if (!offeredToolNames(options).includes(SEARCH_WEB_TOOL_NAME))
    return textStep(MOCK_TOOLS_DISABLED)
  return callStep(options.prompt, [{ toolName: SEARCH_WEB_TOOL_NAME, input: { query: mockSearchToolQuery(options.prompt) } }])
}

/** The stream parts of one step (no delays, the fixed usage). */
export function mockSearchToolStreamParts(options: LanguageModelV4CallOptions): LanguageModelV4StreamPart[] {
  const plan = mockSearchToolPlan(options)
  const parts = mockStreamHead(MOCK_SEARCH_TOOL_MODEL_ID)
  if (plan.text !== null)
    parts.push(...mockTextParts(plan.text))
  const call = plan.toolCall
  if (call !== null) {
    parts.push(
      { type: 'tool-input-start', id: call.toolCallId, toolName: call.toolName },
      { type: 'tool-input-delta', id: call.toolCallId, delta: call.input },
      { type: 'tool-input-end', id: call.toolCallId },
      { type: 'tool-call', toolCallId: call.toolCallId, toolName: call.toolName, input: call.input },
    )
  }
  parts.push({ type: 'finish', usage: mockSearchUsage(), finishReason: { unified: plan.finishReason, raw: plan.finishReason } })
  return parts
}

function generateContent(plan: MockPlan): LanguageModelV4Content[] {
  const content: LanguageModelV4Content[] = []
  if (plan.text !== null)
    content.push({ type: 'text', text: plan.text })
  if (plan.toolCall !== null)
    content.push({ type: 'tool-call', toolCallId: plan.toolCall.toolCallId, toolName: plan.toolCall.toolName, input: plan.toolCall.input })
  return content
}

/** `mock:search-tool` (`createMockLanguageModel('search-tool')` of ./models.ts returns this). */
export function createMockSearchToolModel(): LanguageModelV4 {
  return new MockLanguageModelV4({
    provider: MOCK_PROVIDER_ID,
    modelId: MOCK_SEARCH_TOOL_MODEL_ID,
    supportedUrls: {},
    doGenerate: async (options): Promise<LanguageModelV4GenerateResult> => {
      if (options.abortSignal?.aborted)
        throw abortError(options.abortSignal)
      const plan = mockSearchToolPlan(options)
      return {
        content: generateContent(plan),
        finishReason: { unified: plan.finishReason, raw: plan.finishReason },
        usage: mockSearchUsage(),
        response: { id: 'mock-response', modelId: MOCK_SEARCH_TOOL_MODEL_ID, timestamp: new Date(0) },
        warnings: [],
      }
    },
    doStream: async (options) => {
      if (options.abortSignal?.aborted)
        throw abortError(options.abortSignal)
      return { stream: immediateStream(mockSearchToolStreamParts(options), options.abortSignal) }
    },
  })
}
