// `mock:search`, `mock:search-tool` and the mock provider's `webSearch` hook (Phase 14, C53-T1 / C53-T2; PROVIDERS.md 8
// "MCP and search mocks (Phase 14)"). Only mock models: the native tool is the hook's own provider tool, `search_web` a
// local stand-in with the output shape of `core-search`.
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Prompt, LanguageModelV4StreamPart, LanguageModelV4ToolResultOutput } from '@ai-sdk/provider'
import type { SearchWebOutput } from '@harness-forge/shared'
import type { UIMessage } from 'ai'
import { SEARCH_WEB_TOOL_NAME, searchWebInputSchema } from '@harness-forge/shared'
import { generateText, isStepCount, readUIMessageStream, streamText, tool, toUIMessageStream } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockModels, mockProvider } from './index.ts'
import { createMockLanguageModel, mockPlan } from './models.ts'
import {
  MOCK_SEARCH_TOOL_MODEL_ID,
  mockSearchResultText,
  mockSearchTitles,
  mockSearchToolPlan,
  mockSearchToolQuery,
} from './search-tool.ts'
import {
  MOCK_SEARCH_DONE,
  MOCK_SEARCH_OFF,
  MOCK_SEARCH_SOURCES,
  MOCK_WEB_SEARCH_TOOL_ID,
  MOCK_WEB_SEARCH_TOOL_NAME,
  mockSearchOffersNative,
  mockSearchQuery,
  mockWebSearchTool,
} from './search.ts'

function user(text: string): LanguageModelV4Prompt[number] {
  return { role: 'user', content: [{ type: 'text', text }] }
}

const NATIVE_TOOL = { type: 'provider', name: MOCK_WEB_SEARCH_TOOL_NAME, id: MOCK_WEB_SEARCH_TOOL_ID, args: {} } as const
const SEARCH_WEB_FUNCTION = { type: 'function', name: SEARCH_WEB_TOOL_NAME, inputSchema: { type: 'object', properties: { query: { type: 'string' } } } } as const
const OTHER_FUNCTION = { type: 'function', name: 'read_file', inputSchema: { type: 'object', properties: {} } } as const

async function collect(model: LanguageModelV4, options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamPart[]> {
  const { stream } = await model.doStream(options)
  const parts: LanguageModelV4StreamPart[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done)
      return parts
    parts.push(value)
  }
}

function streamedText(parts: LanguageModelV4StreamPart[]): string {
  return parts.flatMap(part => (part.type === 'text-delta' ? [part.delta] : [])).join('')
}

function finishOf(parts: LanguageModelV4StreamPart[]): Extract<LanguageModelV4StreamPart, { type: 'finish' }> {
  const finish = parts.find(part => part.type === 'finish')
  if (finish?.type !== 'finish')
    throw new Error('no finish part')
  return finish
}

const FIXED_USAGE = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }

/** A stand-in `search_web` with the output shape of `core-search` (titles from `titles`). */
function searchWebTool(titles: readonly string[], calls: string[] = []) {
  return tool({
    description: 'Searches the web.',
    inputSchema: searchWebInputSchema,
    execute: async ({ query }): Promise<SearchWebOutput> => {
      calls.push(query)
      return {
        query,
        backend: 'brave',
        results: titles.map((title, index) => ({ title, url: `https://example.com/${index + 1}`, snippet: `Snippet ${index + 1}`, published: null })),
      }
    },
  })
}

afterEach(() => {
  vi.useRealTimers()
})

// ---------- the webSearch hook ----------

describe('mockWebSearch (the provider hook)', () => {
  it('returns the provider-executed tool shape of the AI SDK for mock:search', () => {
    const search = mockModels().find(model => model.id === 'search')!
    const params = mockProvider.webSearch?.(search, { functionTools: 0, maxUses: 5 })
    const native = params?.tools?.[MOCK_WEB_SEARCH_TOOL_NAME] as Record<string, unknown> | undefined
    expect(native).toMatchObject({ type: 'provider', id: 'mock.web_search', args: {}, isProviderExecuted: true })
    expect(native?.inputSchema).toBeDefined()
    expect(native?.execute).toBeUndefined()
    expect(params?.exclusive).toBeUndefined()
    expect(params?.providerOptions).toBeUndefined()
    expect(mockWebSearchTool()).toMatchObject({ type: 'provider', id: MOCK_WEB_SEARCH_TOOL_ID })
  })
})

// ---------- mock:search ----------

describe('mock:search', () => {
  const model = (): LanguageModelV4 => createMockLanguageModel('search')

  it('answers "Search off" without the native tool: no tools, function tools only, search_web offered instead', async () => {
    for (const tools of [undefined, [], [OTHER_FUNCTION], [SEARCH_WEB_FUNCTION, OTHER_FUNCTION]]) {
      const parts = await collect(model(), { prompt: [user('find cats')], ...(tools === undefined ? {} : { tools: [...tools] }) })
      expect(streamedText(parts)).toBe(MOCK_SEARCH_OFF)
      expect(parts.some(part => part.type === 'tool-call' || part.type === 'tool-result' || part.type === 'source')).toBe(false)
      expect(finishOf(parts)).toEqual({ type: 'finish', usage: FIXED_USAGE, finishReason: { unified: 'stop', raw: 'stop' } })
    }
    expect(MOCK_SEARCH_OFF).toBe('Search off')
    expect(mockSearchOffersNative({ tools: [NATIVE_TOOL] })).toBe(true)
    // A provider tool of another name (or a function tool named web_search) is not the native search.
    expect(mockSearchOffersNative({ tools: [{ type: 'provider', name: 'google_search', id: 'google.google_search', args: {} }] })).toBe(false)
    expect(mockSearchOffersNative({ tools: [{ type: 'function', name: 'web_search', inputSchema: {} }] })).toBe(false)
  })

  it('streams a provider-executed web_search call, its result, two url sources and "Search done: 2 sources"', async () => {
    const prompt: LanguageModelV4Prompt = [user('earlier'), { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, user('  latest cat news  ')]
    const parts = await collect(model(), { prompt, tools: [NATIVE_TOOL, OTHER_FUNCTION] })
    expect(parts.map(part => part.type)).toEqual([
      'stream-start',
      'response-metadata',
      'tool-input-start',
      'tool-input-delta',
      'tool-input-end',
      'tool-call',
      'tool-result',
      'source',
      'source',
      'text-start',
      'text-delta',
      'text-delta',
      'text-delta',
      'text-delta',
      'text-end',
      'finish',
    ])
    const input = JSON.stringify({ query: 'latest cat news' })
    expect(parts[2]).toEqual({ type: 'tool-input-start', id: 'mock_call_2', toolName: 'web_search', providerExecuted: true })
    expect(parts[5]).toEqual({ type: 'tool-call', toolCallId: 'mock_call_2', toolName: 'web_search', input, providerExecuted: true })
    expect(parts[6]).toEqual({
      type: 'tool-result',
      toolCallId: 'mock_call_2',
      toolName: 'web_search',
      result: [
        { type: 'web_search_result', url: 'https://example.com/mock-search-1', title: 'Mock result one' },
        { type: 'web_search_result', url: 'https://example.org/mock-search-2', title: 'Mock result two' },
      ],
    })
    expect(parts.slice(7, 9)).toEqual([
      { type: 'source', sourceType: 'url', id: 'mock_source_2_1', url: 'https://example.com/mock-search-1', title: 'Mock result one' },
      { type: 'source', sourceType: 'url', id: 'mock_source_2_2', url: 'https://example.org/mock-search-2', title: 'Mock result two' },
    ])
    expect(streamedText(parts)).toBe(MOCK_SEARCH_DONE)
    expect(MOCK_SEARCH_DONE).toBe('Search done: 2 sources')
    expect(finishOf(parts)).toEqual({ type: 'finish', usage: FIXED_USAGE, finishReason: { unified: 'stop', raw: 'stop' } })
  })

  it('reaches streamText and the UI message as a provider-executed tool-web_search part with two source-url parts', async () => {
    const result = streamText({ model: model(), prompt: 'what is new', tools: { [MOCK_WEB_SEARCH_TOOL_NAME]: mockWebSearchTool() }, stopWhen: isStepCount(5) })
    let message: UIMessage | undefined
    for await (const snapshot of readUIMessageStream({ stream: toUIMessageStream({ stream: result.stream, sendSources: true }) }))
      message = snapshot
    expect(await result.text).toBe(MOCK_SEARCH_DONE)
    expect(await result.finishReason).toBe('stop')
    const steps = await result.steps
    expect(steps).toHaveLength(1)
    expect(steps[0]?.toolCalls).toMatchObject([{ toolName: 'web_search', input: { query: 'what is new' }, providerExecuted: true }])
    expect(steps[0]?.toolResults).toMatchObject([{ toolName: 'web_search', providerExecuted: true, output: [{ title: 'Mock result one' }, { title: 'Mock result two' }] }])
    expect(await result.sources).toMatchObject(MOCK_SEARCH_SOURCES.map(source => ({ sourceType: 'url', url: source.url, title: source.title })))
    expect(await result.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 })
    const parts = message?.parts ?? []
    const toolPart = parts.find(part => part.type === 'tool-web_search')
    expect(toolPart).toMatchObject({ type: 'tool-web_search', toolCallId: 'mock_call_1', state: 'output-available', providerExecuted: true, input: { query: 'what is new' } })
    expect(parts.filter(part => part.type === 'source-url').map(part => (part as { url: string }).url)).toEqual(MOCK_SEARCH_SOURCES.map(source => source.url))
    expect(parts.filter(part => part.type === 'text').map(part => (part as { text: string }).text).join('')).toBe(MOCK_SEARCH_DONE)
  })

  it('a tool approval function sees the provider-executed call (the harness answers not-applicable for it)', async () => {
    const seen: Array<{ toolName: string, providerExecuted: boolean | undefined }> = []
    const result = streamText({
      model: model(),
      prompt: 'approval check',
      tools: { [MOCK_WEB_SEARCH_TOOL_NAME]: mockWebSearchTool() },
      toolApproval: ({ toolCall }) => {
        seen.push({ toolName: toolCall.toolName, providerExecuted: toolCall.providerExecuted })
        return { type: 'not-applicable' }
      },
    })
    expect(await result.text).toBe(MOCK_SEARCH_DONE)
    expect(seen).toEqual([{ toolName: 'web_search', providerExecuted: true }])
  })

  it('queries the last user text, trimmed and cut to 200 code points; an empty text reads (empty message)', () => {
    const astral = '\u{1F600}'.repeat(250)
    expect(Array.from(mockSearchQuery([user(` ${astral} `)]))).toHaveLength(200)
    expect(mockSearchQuery([user(`${'a'.repeat(199)}\u{1F600}tail`)])).toBe(`${'a'.repeat(199)}\u{1F600}`)
    expect(mockSearchQuery([user('first'), { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, { role: 'user', content: [{ type: 'text', text: ' two ' }, { type: 'text', text: 'parts ' }] }])).toBe('two  parts')
    expect(mockSearchQuery([user('   ')])).toBe('(empty message)')
    expect(mockSearchQuery([])).toBe('(empty message)')
  })

  it('answers doGenerate with the same content, ignoring the reasoning setting and the output cap', async () => {
    const result = await model().doGenerate({ prompt: [user('cats')], tools: [NATIVE_TOOL], reasoning: 'xhigh', maxOutputTokens: 1 })
    expect(result.content.map(part => part.type)).toEqual(['tool-call', 'tool-result', 'source', 'source', 'text'])
    expect(result.content[0]).toMatchObject({ type: 'tool-call', toolName: 'web_search', providerExecuted: true, input: '{"query":"cats"}' })
    expect(result.content.at(-1)).toEqual({ type: 'text', text: MOCK_SEARCH_DONE })
    expect(result.usage).toEqual(FIXED_USAGE)
    expect(result.finishReason).toEqual({ unified: 'stop', raw: 'stop' })
    const off = await generateText({ model: model(), prompt: 'cats', maxOutputTokens: 1, reasoning: 'high', maxRetries: 0 })
    expect(off.text).toBe(MOCK_SEARCH_OFF)
    expect(off.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 })
  })

  it('streams at once without any timer (fake timers never advanced) and rejects an aborted call', async () => {
    vi.useFakeTimers()
    const parts = await collect(model(), { prompt: [user('quick')], tools: [NATIVE_TOOL] })
    expect(streamedText(parts)).toBe(MOCK_SEARCH_DONE)
    vi.useRealTimers()
    const controller = new AbortController()
    controller.abort()
    await expect(model().doStream({ prompt: [user('x')], abortSignal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(model().doGenerate({ prompt: [user('x')], abortSignal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('mockPlan gives the text only (the model itself is served by ./search.ts)', () => {
    expect(mockPlan('search', { prompt: [user('x')] })).toEqual({ reasoning: null, text: MOCK_SEARCH_OFF, toolCall: null, finishReason: 'stop' })
    expect(mockPlan('search', { prompt: [user('x')], tools: [NATIVE_TOOL] })).toMatchObject({ text: MOCK_SEARCH_DONE })
  })
})

// ---------- mock:search-tool ----------

function toolPrompt(output: LanguageModelV4ToolResultOutput, text = 'find cats'): LanguageModelV4Prompt {
  return [
    user(text),
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'mock_call_1', toolName: SEARCH_WEB_TOOL_NAME, input: { query: text } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'mock_call_1', toolName: SEARCH_WEB_TOOL_NAME, output }] },
  ]
}

const JSON_RESULT: LanguageModelV4ToolResultOutput = {
  type: 'json',
  value: { query: 'find cats', backend: 'brave', results: [{ title: 'Result one', url: 'https://example.com/a', snippet: 's', published: null }, { title: ' Result\n two ', url: 'https://example.org/b', snippet: 's', published: null }] },
}

describe('mock:search-tool', () => {
  const model = (): LanguageModelV4 => createMockLanguageModel(MOCK_SEARCH_TOOL_MODEL_ID)

  it('answers "Tools are disabled." without search_web (no tools, other tools, the native tool only)', () => {
    for (const tools of [undefined, [OTHER_FUNCTION], [NATIVE_TOOL]])
      expect(mockSearchToolPlan({ prompt: [user('x')], ...(tools === undefined ? {} : { tools: [...tools] }) }).text).toBe('Tools are disabled.')
  })

  it('calls search_web once with the last user text when the turn has no result yet', async () => {
    const plan = mockSearchToolPlan({ prompt: [user('  find cats  ')], tools: [SEARCH_WEB_FUNCTION, OTHER_FUNCTION] })
    expect(plan).toEqual({ reasoning: null, text: null, toolCall: { toolCallId: 'mock_call_1', toolName: 'search_web', input: '{"query":"find cats"}' }, finishReason: 'tool-calls' })
    const parts = await collect(model(), { prompt: [user('find cats')], tools: [SEARCH_WEB_FUNCTION] })
    expect(parts.map(part => part.type)).toEqual(['stream-start', 'response-metadata', 'tool-input-start', 'tool-input-delta', 'tool-input-end', 'tool-call', 'finish'])
    expect(parts[5]).toEqual({ type: 'tool-call', toolCallId: 'mock_call_1', toolName: 'search_web', input: '{"query":"find cats"}' })
    expect(finishOf(parts)).toEqual({ type: 'finish', usage: FIXED_USAGE, finishReason: { unified: 'tool-calls', raw: 'tool-calls' } })
  })

  it('cuts the query to 400 code points; an empty text reads (empty message)', () => {
    expect(Array.from(mockSearchToolQuery([user('\u{1F600}'.repeat(500))]))).toHaveLength(400)
    expect(mockSearchToolQuery([user('')])).toBe('(empty message)')
  })

  it('lists the result titles after the result: JSON, JSON text, content, an empty list, an unreadable output', () => {
    expect(mockSearchToolPlan({ prompt: toolPrompt(JSON_RESULT), tools: [SEARCH_WEB_FUNCTION] }).text).toBe('Results: Result one | Result two')
    expect(mockSearchResultText({ type: 'text', value: JSON.stringify(JSON_RESULT.value) })).toBe('Results: Result one | Result two')
    expect(mockSearchResultText({ type: 'text', value: `Found 2 results:\n${JSON.stringify(JSON_RESULT.value)}\nEnd.` })).toBe('Results: Result one | Result two')
    expect(mockSearchResultText({ type: 'content', value: [{ type: 'text', text: JSON.stringify(JSON_RESULT.value) }] })).toBe('Results: Result one | Result two')
    expect(mockSearchResultText({ type: 'json', value: { query: 'q', backend: 'exa', results: [] } })).toBe('Results: none')
    expect(mockSearchResultText({ type: 'text', value: 'no json here' })).toBe('Results: none')
    expect(mockSearchTitles({ type: 'json', value: { results: [{ title: 'A' }, { title: 3 }, null, { title: 'B' }] } })).toEqual(['A', 'B'])
  })

  it('answers after the result even when search_web is no longer offered (a finalize step)', () => {
    expect(mockSearchToolPlan({ prompt: toolPrompt(JSON_RESULT) }).text).toBe('Results: Result one | Result two')
  })

  it('a failed call answers "Search failed: <error text>" (one line, 120 code points); a denied one the denial', () => {
    expect(mockSearchToolPlan({ prompt: toolPrompt({ type: 'error-text', value: 'The search key was rejected\n(401).' }), tools: [SEARCH_WEB_FUNCTION] }).text)
      .toBe('Search failed: The search key was rejected (401).')
    const long = mockSearchResultText({ type: 'error-text', value: 'x'.repeat(300) })
    expect(long).toBe(`Search failed: ${'x'.repeat(120)}`)
    expect(mockSearchResultText({ type: 'error-json', value: { code: 'rate_limited' } })).toBe('Search failed: {"code":"rate_limited"}')
    expect(mockSearchToolPlan({ prompt: toolPrompt({ type: 'execution-denied', reason: 'no' }), tools: [SEARCH_WEB_FUNCTION] }).text).toBe('The tool call was denied.')
    const approvalDenied: LanguageModelV4Prompt = [
      user('find cats'),
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'mock_call_1', toolName: SEARCH_WEB_TOOL_NAME, input: {} }] },
      { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: 'a1', approved: false }] },
    ]
    expect(mockSearchToolPlan({ prompt: approvalDenied, tools: [SEARCH_WEB_FUNCTION] }).text).toBe('The tool call was denied.')
  })

  it('a new user message opens a new turn: the old result does not count', () => {
    const prompt: LanguageModelV4Prompt = [...toolPrompt(JSON_RESULT), { role: 'assistant', content: [{ type: 'text', text: 'Results: Result one | Result two' }] }, user('find dogs')]
    expect(mockSearchToolPlan({ prompt, tools: [SEARCH_WEB_FUNCTION] }).toolCall).toEqual({ toolCallId: 'mock_call_3', toolName: 'search_web', input: '{"query":"find dogs"}' })
  })

  it('runs end to end through streamText with a search_web stand-in: one call, then the titles', async () => {
    const calls: string[] = []
    const result = streamText({
      model: model(),
      prompt: 'harness forge',
      tools: { [SEARCH_WEB_TOOL_NAME]: searchWebTool(['Result one', 'Result two', 'Result three'], calls) },
      stopWhen: isStepCount(4),
      reasoning: 'high',
      maxOutputTokens: 1,
    })
    expect(await result.text).toBe('Results: Result one | Result two | Result three')
    expect(calls).toEqual(['harness forge'])
    expect(await result.steps).toHaveLength(2)
    expect(await result.totalUsage).toMatchObject({ inputTokens: 20, outputTokens: 10 })
    const empty = streamText({ model: model(), prompt: 'nothing', tools: { [SEARCH_WEB_TOOL_NAME]: searchWebTool([]) }, stopWhen: isStepCount(4) })
    expect(await empty.text).toBe('Results: none')
  })

  it('answers doGenerate at once with the fixed usage and rejects an aborted call', async () => {
    vi.useFakeTimers()
    const generated = await model().doGenerate({ prompt: toolPrompt(JSON_RESULT), tools: [SEARCH_WEB_FUNCTION] })
    expect(generated.content).toEqual([{ type: 'text', text: 'Results: Result one | Result two' }])
    expect(generated.usage).toEqual(FIXED_USAGE)
    const parts = await collect(model(), { prompt: toolPrompt(JSON_RESULT), tools: [SEARCH_WEB_FUNCTION] })
    expect(streamedText(parts)).toBe('Results: Result one | Result two')
    vi.useRealTimers()
    const controller = new AbortController()
    controller.abort()
    await expect(model().doStream({ prompt: [user('x')], abortSignal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('mockPlan gives the same step', () => {
    const options = { prompt: [user('find cats')], tools: [SEARCH_WEB_FUNCTION] }
    expect(mockPlan('search-tool', options)).toEqual(mockSearchToolPlan(options))
  })
})
