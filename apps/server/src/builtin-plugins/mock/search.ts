// `mock:search` (Phase 14, ADR-062 / ADR-063, PROVIDERS.md 8 "MCP and search mocks (Phase 14)"; C53-T1, FROZEN after
// Gate P14-0b) and the mock provider's `webSearch` hook (plugin API 1.7.0): a model with the provider's own ("native")
// web search, so the probes and the e2e specs drive provider-executed search calls without a real provider. The 19th
// language model of the mock provider: `kind: 'chat'`, the `tools` capability only.
//
// The hook (`mockWebSearch`): for the model `search` it returns `{ tools: { web_search: <provider tool> } }`, the AI
// SDK's `ProviderExecutedTool` shape `{ type: 'provider', id: 'mock.web_search', args: {}, isProviderExecuted: true }`
// (plus the `inputSchema` / `outputSchema` the `Tool` type requires: input `{ query: string }`, output an array of
// `{ type: 'web_search_result', url, title }`), no `exclusive` and no provider options; for every other model
// `undefined`. So the catalog lists `mock:search` with `webSearch: 'native'` (once W14.4 probes the hook) and every
// other mock with `webSearch: null`.
//
// The answer depends only on the call's tools:
// - the call offers a provider tool named `web_search` (`options.tools` holds `{ type: 'provider', name: 'web_search',
//   … }`: the turn's web search resolved to native): ONE step that streams, in this order, a provider-executed
//   `tool-call` `web_search` (id `mock_call_<n>`, n = the assistant messages of the prompt + 1; `providerExecuted: true`;
//   input `{ "query": <q> }`), its `tool-result` (an array of the two results below, as `{ type: 'web_search_result',
//   url, title }`; a V4 `tool-result` part carries no `providerExecuted` flag, the AI SDK marks a model's own result
//   provider-executed), two `source` parts (`sourceType: 'url'`, ids `mock_source_<n>_1` / `mock_source_<n>_2`:
//   `https://example.com/mock-search-1` "Mock result one" and `https://example.org/mock-search-2` "Mock result two"),
//   then the text `Search done: 2 sources`; `finishReason: 'stop'`;
// - otherwise (search off, tool mode `off`, `webSearchNative` off, the builtin `search_web` offered instead, any
//   function tools): the text `Search off`. It never calls a function tool.
// <q> = the text parts of the last user message joined with a space, trimmed and cut to its first 200 code points;
// `(empty message)` for an empty text.
//
// No waits: every chunk follows at once (`doGenerate` answers at once too); the text streams one word per chunk. The
// reasoning setting and the output-token cap are ignored. Usage is fixed at 10 input and 5 output tokens. An aborted
// signal rejects with its reason (also between chunks).
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider'
import type { ModelInfo, WebSearchParams } from '@harness-forge/plugin-sdk'
import type { Tool } from 'ai'
import { jsonSchema, simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { abortableDelay, abortError, MOCK_EMPTY_MESSAGE, MOCK_PROVIDER_ID, wordChunks } from './common.ts'
import { userMessageText } from './turn.ts'

/** This mock's model id (`mock:search`). */
export const MOCK_SEARCH_MODEL_ID = 'search'
/** The key of the native search tool in the turn's tool set (the wire name of Anthropic's and OpenAI's tools too). */
export const MOCK_WEB_SEARCH_TOOL_NAME = 'web_search'
/** The provider tool id of the native search tool. */
export const MOCK_WEB_SEARCH_TOOL_ID = 'mock.web_search'
/** The answer without the native tool. */
export const MOCK_SEARCH_OFF = 'Search off'
/** The text after a native search. */
export const MOCK_SEARCH_DONE = 'Search done: 2 sources'
/** Code points of the query (the last user text). */
export const MOCK_SEARCH_QUERY_MAX_CHARS = 200
/** The fixed usage of every call of `mock:search` and `mock:search-tool`: 10 input tokens, 5 output tokens. */
export const MOCK_SEARCH_USAGE = { inputTokens: 10, outputTokens: 5 } as const

/** One result of the native search: the `tool-result` entry and the `source` part. */
export interface MockSearchSource {
  readonly url: string
  readonly title: string
}

/** The two results of every native search, in order. */
export const MOCK_SEARCH_SOURCES: readonly MockSearchSource[] = [
  { url: 'https://example.com/mock-search-1', title: 'Mock result one' },
  { url: 'https://example.org/mock-search-2', title: 'Mock result two' },
]

/** One entry of the native tool's result (the shape Anthropic's `web_search` results have, without `encryptedContent`). */
export interface MockWebSearchResult {
  readonly type: 'web_search_result'
  readonly url: string
  readonly title: string
}

/** The provider-executed search tool the hook returns (a fresh object per call). */
export function mockWebSearchTool(): Tool {
  return {
    type: 'provider',
    id: MOCK_WEB_SEARCH_TOOL_ID,
    args: {},
    isProviderExecuted: true,
    inputSchema: jsonSchema<{ query: string }>({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    }),
    outputSchema: jsonSchema<MockWebSearchResult[]>({
      type: 'array',
      items: {
        type: 'object',
        properties: { type: { type: 'string', const: 'web_search_result' }, url: { type: 'string' }, title: { type: 'string' } },
        required: ['type', 'url', 'title'],
      },
    }),
  }
}

/** The mock provider's `webSearch` hook: the native tool for `mock:search`, `undefined` for every other model. */
export function mockWebSearch(model: ModelInfo): WebSearchParams | undefined {
  if (model.id !== MOCK_SEARCH_MODEL_ID)
    return undefined
  return { tools: { [MOCK_WEB_SEARCH_TOOL_NAME]: mockWebSearchTool() } }
}

/** True when the call offers the native search tool (a provider tool named `web_search`). */
export function mockSearchOffersNative(options: Pick<LanguageModelV4CallOptions, 'tools'>): boolean {
  return options.tools?.some(tool => tool.type === 'provider' && tool.name === MOCK_WEB_SEARCH_TOOL_NAME) ?? false
}

/** The text parts of the last user message, joined with a space and trimmed. */
export function mockLastUserText(prompt: LanguageModelV4Prompt): string {
  for (let index = prompt.length - 1; index >= 0; index--) {
    if (prompt[index]?.role === 'user')
      return userMessageText(prompt[index])
  }
  return ''
}

/** The first `max` code points of `text`. */
export function firstCodePoints(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('')
}

/** The query of the native call (see the module comment). */
export function mockSearchQuery(prompt: LanguageModelV4Prompt): string {
  return firstCodePoints(mockLastUserText(prompt), MOCK_SEARCH_QUERY_MAX_CHARS) || MOCK_EMPTY_MESSAGE
}

/** The fixed usage (see `MOCK_SEARCH_USAGE`). */
export function mockSearchUsage(): LanguageModelV4Usage {
  const input = MOCK_SEARCH_USAGE.inputTokens
  const output = MOCK_SEARCH_USAGE.outputTokens
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  }
}

/** The stream parts of one text (one word per chunk). */
export function mockTextParts(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'text-start', id: 'text-0' },
    ...wordChunks(text).map((delta): LanguageModelV4StreamPart => ({ type: 'text-delta', id: 'text-0', delta })),
    { type: 'text-end', id: 'text-0' },
  ]
}

/** `stream-start` and `response-metadata` of a model. */
export function mockStreamHead(modelId: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: 'mock-response', modelId, timestamp: new Date(0) },
  ]
}

/** `parts` as a stream without any timer; it fails with the signal's reason once the call is aborted. */
export function immediateStream(parts: readonly LanguageModelV4StreamPart[], signal?: AbortSignal): ReadableStream<LanguageModelV4StreamPart> {
  return simulateReadableStream({
    chunks: [...parts],
    initialDelayInMs: 0,
    chunkDelayInMs: 0,
    _internal: { delay: async () => abortableDelay(0, signal) },
  })
}

/** A native search call of this step: its id, its JSON input and its result entries. */
interface NativeCall {
  readonly toolCallId: string
  readonly input: string
  readonly results: MockWebSearchResult[]
  readonly n: number
}

function nativeCall(prompt: LanguageModelV4Prompt): NativeCall {
  const n = prompt.filter(message => message.role === 'assistant').length + 1
  return {
    toolCallId: `mock_call_${n}`,
    input: JSON.stringify({ query: mockSearchQuery(prompt) }),
    results: MOCK_SEARCH_SOURCES.map(source => ({ type: 'web_search_result', url: source.url, title: source.title })),
    n,
  }
}

function sourceParts(n: number): Array<Extract<LanguageModelV4Content, { type: 'source' }>> {
  return MOCK_SEARCH_SOURCES.map((source, index) => ({ type: 'source', sourceType: 'url', id: `mock_source_${n}_${index + 1}`, url: source.url, title: source.title }))
}

/** The text of a call: `Search done: 2 sources` with the native tool, else `Search off`. */
export function mockSearchText(options: Pick<LanguageModelV4CallOptions, 'tools'>): string {
  return mockSearchOffersNative(options) ? MOCK_SEARCH_DONE : MOCK_SEARCH_OFF
}

/** The stream parts of one call (see the module comment). */
export function mockSearchStreamParts(options: LanguageModelV4CallOptions): LanguageModelV4StreamPart[] {
  const parts = mockStreamHead(MOCK_SEARCH_MODEL_ID)
  if (mockSearchOffersNative(options)) {
    const call = nativeCall(options.prompt)
    parts.push(
      { type: 'tool-input-start', id: call.toolCallId, toolName: MOCK_WEB_SEARCH_TOOL_NAME, providerExecuted: true },
      { type: 'tool-input-delta', id: call.toolCallId, delta: call.input },
      { type: 'tool-input-end', id: call.toolCallId },
      { type: 'tool-call', toolCallId: call.toolCallId, toolName: MOCK_WEB_SEARCH_TOOL_NAME, input: call.input, providerExecuted: true },
      { type: 'tool-result', toolCallId: call.toolCallId, toolName: MOCK_WEB_SEARCH_TOOL_NAME, result: call.results.map(result => ({ ...result })) },
      ...sourceParts(call.n),
    )
  }
  parts.push(
    ...mockTextParts(mockSearchText(options)),
    { type: 'finish', usage: mockSearchUsage(), finishReason: { unified: 'stop', raw: 'stop' } },
  )
  return parts
}

/** The content of a `doGenerate` call (the same parts as the stream). */
function generateContent(options: LanguageModelV4CallOptions): LanguageModelV4Content[] {
  const content: LanguageModelV4Content[] = []
  if (mockSearchOffersNative(options)) {
    const call = nativeCall(options.prompt)
    content.push(
      { type: 'tool-call', toolCallId: call.toolCallId, toolName: MOCK_WEB_SEARCH_TOOL_NAME, input: call.input, providerExecuted: true },
      { type: 'tool-result', toolCallId: call.toolCallId, toolName: MOCK_WEB_SEARCH_TOOL_NAME, result: call.results.map(result => ({ ...result })) },
      ...sourceParts(call.n),
    )
  }
  content.push({ type: 'text', text: mockSearchText(options) })
  return content
}

/** `mock:search` (`createMockLanguageModel('search')` of ./models.ts returns this). */
export function createMockSearchModel(): LanguageModelV4 {
  return new MockLanguageModelV4({
    provider: MOCK_PROVIDER_ID,
    modelId: MOCK_SEARCH_MODEL_ID,
    supportedUrls: {},
    doGenerate: async (options): Promise<LanguageModelV4GenerateResult> => {
      if (options.abortSignal?.aborted)
        throw abortError(options.abortSignal)
      return {
        content: generateContent(options),
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: mockSearchUsage(),
        response: { id: 'mock-response', modelId: MOCK_SEARCH_MODEL_ID, timestamp: new Date(0) },
        warnings: [],
      }
    },
    doStream: async (options) => {
      if (options.abortSignal?.aborted)
        throw abortError(options.abortSignal)
      return { stream: immediateStream(mockSearchStreamParts(options), options.abortSignal) }
    },
  })
}
