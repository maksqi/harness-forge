// The sources transform of the builtin search tool (W14.5-T4): one `source-url` chunk per result URL after a final
// `search_web` output of `core-search` (deduplicated within the reply, http(s) only, the title kept); nothing for a
// preliminary, dynamic or provider-executed output, another tool, or a `search_web` of another plugin; the continued
// message seeds the tool names and the URLs already shown. End to end over `POST /api/chat`: `mock:search-tool` with the
// real `core-search` (behind `createFakeSearchFetch`) stores the tool part and its sources in the saved message, and the
// model reads the titles from the tool's JSON output.
import type { BuiltinPluginId, ChatDetail, HarnessUIMessage } from '@harness-forge/shared'
import type { UIMessageChunk } from 'ai'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeSearchFetch } from '../../testing/fake-search.ts'
import type { HarnessUIMessageChunk } from '../generated-files.ts'
import type { SourcesTransformOptions } from './types.ts'
import { chatDetailSchema, SEARCH_WEB_TOOL_NAME } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CORE_SEARCH_PLUGIN_ID, manifest as coreSearchManifest, createCoreSearchPlugin } from '../../builtin-plugins/core-search/index.ts'
import mock, { manifest as mockManifest } from '../../builtin-plugins/mock/index.ts'
import { createMemoryLogger, createSilentLogger } from '../../logger.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeSearchFetch } from '../../testing/fake-search.ts'
import { chatBody, postChat, readSse, runnerOf, streamedText, testChatId } from '../testing.ts'
import { createSourcesTransform, searchOutputSources, searchSourceId } from './sources.ts'
import { SEARCH_TOOL_PLUGIN_ID } from './types.ts'

function result(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { title: `Result ${n}`, url: `https://example.com/${n}`, snippet: `Snippet ${n}`, published: null, ...overrides }
}

function input(toolCallId: string, toolName = SEARCH_WEB_TOOL_NAME): HarnessUIMessageChunk {
  return { type: 'tool-input-available', toolCallId, toolName, input: { query: 'cats' } }
}

function output(toolCallId: string, results: unknown[], extra: Record<string, unknown> = {}): HarnessUIMessageChunk {
  return { type: 'tool-output-available', toolCallId, output: { query: 'cats', backend: 'brave', results }, ...extra } as HarnessUIMessageChunk
}

async function run(chunks: HarnessUIMessageChunk[], options: Partial<SourcesTransformOptions> = {}): Promise<HarnessUIMessageChunk[]> {
  const source = new ReadableStream<HarnessUIMessageChunk>({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(chunk)
      controller.close()
    },
  })
  const transform = createSourcesTransform({ toolOwner: () => SEARCH_TOOL_PLUGIN_ID, continued: null, logger: createSilentLogger(), ...options })
  const out: HarnessUIMessageChunk[] = []
  const reader = source.pipeThrough(transform).getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done)
      break
    out.push(value)
  }
  return out
}

function sources(chunks: readonly HarnessUIMessageChunk[]): Array<{ url: string, title?: string }> {
  return chunks.flatMap(chunk => (chunk.type === 'source-url' ? [{ url: chunk.url, ...(chunk.title === undefined ? {} : { title: chunk.title }) }] : []))
}

describe('createSourcesTransform', () => {
  it('adds one source-url per result right after the final output, with the title and a stable sourceId', async () => {
    const chunks = [{ type: 'start' }, input('c1'), output('c1', [result(1), result(2)]), { type: 'finish' }] as HarnessUIMessageChunk[]
    const out = await run(chunks)
    expect(out.map(chunk => chunk.type)).toEqual(['start', 'tool-input-available', 'tool-output-available', 'source-url', 'source-url', 'finish'])
    expect(out[3]).toEqual({ type: 'source-url', sourceId: searchSourceId('https://example.com/1'), url: 'https://example.com/1', title: 'Result 1' })
    expect(searchSourceId('https://example.com/1')).toMatch(/^search-[0-9a-f]{24}$/)
    expect(searchSourceId(`https://example.com/${'x'.repeat(2000)}`).length).toBeLessThanOrEqual(64)
  })

  it('deduplicates by URL within the reply: one output, two outputs, sources already streamed or in the continued message', async () => {
    const out = await run([
      { type: 'source-url', sourceId: 'native-1', url: 'https://example.com/0' },
      input('c1'),
      output('c1', [result(0), result(1), result(1, { title: 'Again' }), result(2)]),
      input('c2'),
      output('c2', [result(2), result(3)]),
    ] as HarnessUIMessageChunk[], {
      continued: { id: 'msg_1', role: 'assistant', parts: [{ type: 'source-url', sourceId: 's', url: 'https://example.com/3' }] } as HarnessUIMessage,
    })
    expect(sources(out).map(source => source.url)).toEqual(['https://example.com/0', 'https://example.com/1', 'https://example.com/2'])
    expect(sources(out)[1]).toEqual({ url: 'https://example.com/1', title: 'Result 1' })
  })

  it('keeps http(s) URLs only; a bad result is skipped, the others still count', async () => {
    const out = await run([input('c1'), output('c1', [
      result(1, { url: 'javascript:alert(1)' }),
      result(2, { url: 'ftp://example.com/x' }),
      result(3, { title: 'x'.repeat(301) }),
      result(4, { url: 'http://example.org/4' }),
      'not a result',
      null,
    ])] as HarnessUIMessageChunk[])
    expect(sources(out)).toEqual([{ url: 'http://example.org/4', title: 'Result 4' }])
  })

  it('adds nothing for a preliminary, dynamic or provider-executed output, another tool, or a search_web of another plugin', async () => {
    const base = [input('c1')]
    expect(sources(await run([...base, output('c1', [result(1)], { preliminary: true })] as HarnessUIMessageChunk[]))).toEqual([])
    expect(sources(await run([...base, output('c1', [result(1)], { dynamic: true })] as HarnessUIMessageChunk[]))).toEqual([])
    expect(sources(await run([...base, output('c1', [result(1)], { providerExecuted: true })] as HarnessUIMessageChunk[]))).toEqual([])
    expect(sources(await run([input('c1', 'web_fetch'), output('c1', [result(1)])] as HarnessUIMessageChunk[]))).toEqual([])
    expect(sources(await run([...base, output('c1', [result(1)])] as HarnessUIMessageChunk[], { toolOwner: () => 'other-plugin' }))).toEqual([])
    expect(sources(await run([...base, output('c1', [result(1)])] as HarnessUIMessageChunk[], { toolOwner: () => undefined }))).toEqual([])
    // An unknown call id (no input chunk, no continued part) adds nothing either.
    expect(sources(await run([output('c9', [result(1)])] as HarnessUIMessageChunk[]))).toEqual([])
  })

  it('an approval continuation: the continued message\'s tool part names the call', async () => {
    const continued = {
      id: 'msg_1',
      role: 'assistant',
      parts: [{ type: 'tool-search_web', toolCallId: 'c1', state: 'approval-responded', input: { query: 'cats' }, approval: { id: 'a1', approved: true } }],
    } as unknown as HarnessUIMessage
    const out = await run([output('c1', [result(1)])] as HarnessUIMessageChunk[], { continued })
    expect(sources(out)).toEqual([{ url: 'https://example.com/1', title: 'Result 1' }])
  })

  it('ignores outputs that are not search results (a capped output, null, text) and never fails the stream', async () => {
    const memory = createMemoryLogger()
    const chunks = [
      input('c1'),
      { type: 'tool-output-available', toolCallId: 'c1', output: { truncated: true, originalBytes: 70_000, preview: '{' } },
      input('c2'),
      { type: 'tool-output-available', toolCallId: 'c2', output: null },
      input('c3'),
      { type: 'tool-output-available', toolCallId: 'c3', output: 'text' },
    ] as HarnessUIMessageChunk[]
    const out = await run(chunks, { logger: memory.logger })
    expect(out).toEqual(chunks)
    expect(searchOutputSources({ results: 'nope' })).toEqual([])
    // A failing owner lookup is logged, the chunk still passes.
    const failing = await run([input('c1'), output('c1', [result(1)])] as HarnessUIMessageChunk[], {
      logger: memory.logger,
      toolOwner: () => {
        throw new Error('owner lookup failed')
      },
    })
    expect(failing.map(chunk => chunk.type)).toEqual(['tool-input-available', 'tool-output-available'])
    expect(memory.text()).toContain('the sources of a web search were not added')
    expect(memory.text()).not.toContain('cats')
  })
})

describe('the saved message holds the parts (end to end: mock:search-tool and core-search)', () => {
  let t: TestApp
  let fake: FakeSearchFetch
  let nextChat = 145_000

  beforeAll(async () => {
    fake = createFakeSearchFetch()
    t = await createTestApp({
      builtins: [
        { id: 'mock', manifest: mockManifest, module: mock },
        { id: CORE_SEARCH_PLUGIN_ID as BuiltinPluginId, manifest: coreSearchManifest, module: createCoreSearchPlugin({ safeFetch: fake.safeFetch, timeoutMs: 50 }) },
      ],
    })
  })

  afterAll(async () => {
    await t.close()
  })

  async function send(text: string): Promise<{ chunks: UIMessageChunk[], reply: HarnessUIMessage }> {
    nextChat += 1
    const chatId = testChatId(nextChat)
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, text, { modelRef: 'mock:search-tool', toolMode: 'ask', webSearch: 'auto' })))
    await runnerOf(t).idle()
    const detail: ChatDetail = chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId}`)).json())
    return { chunks, reply: detail.messages.at(-1)! }
  }

  it('without a key: search_web is not offered ("Tools are disabled.")', async () => {
    const { chunks } = await send('find cats')
    expect(streamedText(chunks)).toBe('Tools are disabled.')
    expect(chunks.some(chunk => chunk.type === 'source-url')).toBe(false)
  })

  it('with a key: the search_web part, then one source-url part per result; the model read the titles from the JSON', async () => {
    await t.deps.plugins.updateSettings(CORE_SEARCH_PLUGIN_ID, { braveApiKey: 'brave-e2e-key', maxResults: 3 })
    const { chunks, reply } = await send('find cats')
    expect(streamedText(chunks)).toBe('Results: Result one | Result two | Result three')
    const types = reply.parts.map(part => part.type)
    const toolIndex = types.indexOf('tool-search_web')
    expect(toolIndex).toBeGreaterThanOrEqual(0)
    expect(reply.parts[toolIndex]).toMatchObject({ state: 'output-available', output: { query: 'find cats', backend: 'brave' } })
    const stored = reply.parts.filter(part => part.type === 'source-url')
    expect(stored.map(part => (part as { url: string }).url)).toEqual(['https://example.com/a', 'https://example.org/b', 'https://example.com/c'])
    expect(stored.map(part => (part as { title?: string }).title)).toEqual(['Result one', 'Result two', 'Result three'])
    expect(types.indexOf('source-url')).toBeGreaterThan(toolIndex)
    expect(fake.requests.at(-1)).toMatchObject({ method: 'GET', status: 200 })
    expect(new URL(fake.requests.at(-1)!.url).searchParams.get('q')).toBe('find cats')
  })
})
