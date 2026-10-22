// Native web search end to end in process (W14.4-T2 / T4 / T5 with the real pieces, no spy): the catalog probes the
// mock provider's hook (`mock:search` -> `webSearch: 'native'`), the turn asks the hook through `providerWebSearch`, the
// provider-executed `web_search` call never asks (tool modes `ask` and `plan`) and is stored with its sources; mode
// `off`, tool mode `off` and `webSearchNative: false` keep the tool away; a switch to another provider in the same chat
// sends that provider no provider-executed part (the history stage), and back on the mock provider the chat still runs.
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { ChatDetail, ChatRequestBody, HarnessUIMessage } from '@harness-forge/shared'
import type { UIMessageChunk } from 'ai'
import type { TestApp } from '../../testing/create-test-app.ts'
import { chatDetailSchema, isProviderExecutedPart } from '@harness-forge/shared'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MOCK_SEARCH_DONE, MOCK_SEARCH_OFF } from '../../builtin-plugins/mock/search.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { chatBody, postChat, readSse, runnerOf, streamedText, testChatId } from '../testing.ts'

const OTHER = 'otherkit'

describe('native web search through the pipeline (mock:search)', () => {
  let t: TestApp
  let nextChat = 24_000
  const disposables: Disposable[] = []
  const otherCalls: LanguageModelV4CallOptions[] = []

  function newChatId(): string {
    nextChat += 1
    return testChatId(nextChat)
  }

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
    disposables.push(t.deps.registry.providers.register('mock', {
      id: OTHER,
      name: 'Other kit',
      credentials: [],
      seedModels: [{ id: 'plain', name: 'Plain', contextWindow: 32_000, capabilities: { tools: true } }],
      createLanguageModel: modelId => new MockLanguageModelV4({
        provider: OTHER,
        modelId,
        doStream: async (options) => {
          otherCalls.push(options)
          return {
            stream: convertArrayToReadableStream([
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: 'Other answer' },
              { type: 'text-end', id: 't' },
              { type: 'finish', usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, finishReason: { unified: 'stop', raw: 'stop' } },
            ]),
          }
        },
      }),
    }))
  })

  afterAll(async () => {
    for (const disposable of disposables.reverse())
      disposable.dispose()
    await t.close()
  })

  async function detail(chatId: string): Promise<ChatDetail> {
    return chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId}`)).json())
  }

  async function send(body: ChatRequestBody): Promise<{ chunks: UIMessageChunk[], reply: HarnessUIMessage }> {
    const { chunks } = await readSse(await postChat(t, body))
    await runnerOf(t).idle()
    return { chunks, reply: (await detail(body.chatId)).messages.at(-1)! }
  }

  function noticeCodes(chunks: readonly UIMessageChunk[]): string[] {
    return chunks.flatMap(chunk => (chunk.type === 'data-notice' ? [(chunk.data as { code: string }).code] : []))
  }

  it('the catalog reports mock:search as native', async () => {
    const { items } = await t.client.models.list({ query: { providerId: 'mock' } })
    expect(items.find(model => model.id === 'search')?.webSearch).toBe('native')
    expect(items.find(model => model.id === 'echo')?.webSearch).toBeNull()
  })

  it('mode auto in ask and plan: a provider-executed web_search part with its sources, never an approval', async () => {
    for (const toolMode of ['ask', 'plan', 'auto'] as const) {
      const chatId = newChatId()
      const { chunks, reply } = await send(chatBody(chatId, 'find cats', { modelRef: 'mock:search', toolMode, webSearch: 'auto' }))
      expect(streamedText(chunks), toolMode).toBe(MOCK_SEARCH_DONE)
      expect(chunks.some(chunk => chunk.type === 'tool-approval-request'), toolMode).toBe(false)
      expect(chunks.some(chunk => chunk.type === 'tool-output-denied'), toolMode).toBe(false)
      const part = reply.parts.find(entry => entry.type === 'tool-web_search')
      expect(part, toolMode).toMatchObject({ state: 'output-available', providerExecuted: true, input: { query: 'find cats' } })
      expect(reply.parts.filter(entry => entry.type === 'source-url').map(entry => (entry as { url: string }).url), toolMode).toEqual(['https://example.com/mock-search-1', 'https://example.org/mock-search-2'])
      expect(noticeCodes(chunks), toolMode).toEqual([])
    }
  })

  it('mode off, tool mode off and webSearchNative off: no native tool ("Search off")', async () => {
    const off = await send(chatBody(newChatId(), 'find cats', { modelRef: 'mock:search', webSearch: 'off' }))
    expect(streamedText(off.chunks)).toBe(MOCK_SEARCH_OFF)
    const toolsOff = await send(chatBody(newChatId(), 'find cats', { modelRef: 'mock:search', webSearch: 'auto', toolMode: 'off' }))
    expect(streamedText(toolsOff.chunks)).toBe(MOCK_SEARCH_OFF)
    expect(noticeCodes(toolsOff.chunks)).toEqual(['web-search-unavailable'])
    await t.deps.settings.update({ webSearchNative: false })
    try {
      const builtinOnly = await send(chatBody(newChatId(), 'find cats', { modelRef: 'mock:search', webSearch: 'auto' }))
      expect(streamedText(builtinOnly.chunks)).toBe(MOCK_SEARCH_OFF)
      // No backend key: the builtin is not available either.
      expect(noticeCodes(builtinOnly.chunks)).toEqual(['web-search-unavailable'])
    }
    finally {
      await t.deps.settings.update({ webSearchNative: true })
    }
  })

  it('a switch to another provider sends it no provider-executed part; back on mock the chat still runs', async () => {
    const chatId = newChatId()
    const first = await send(chatBody(chatId, 'find cats', { modelRef: 'mock:search', webSearch: 'auto' }))
    expect(first.reply.parts.some(part => isProviderExecutedPart(part))).toBe(true)

    otherCalls.length = 0
    const second = await send(chatBody(chatId, 'and dogs?', { modelRef: `${OTHER}:plain`, webSearch: 'auto' }))
    expect(streamedText(second.chunks)).toBe('Other answer')
    expect(otherCalls).toHaveLength(1)
    const prompt = otherCalls[0]?.prompt ?? []
    const toolContent = prompt.flatMap((message): readonly { type: string }[] => (Array.isArray(message.content) ? message.content as readonly { type: string }[] : []))
      .filter(content => content.type === 'tool-call' || content.type === 'tool-result')
    expect(toolContent).toEqual([])
    // The earlier reply's text still reaches the other provider.
    expect(JSON.stringify(prompt)).toContain('Search done')

    const third = await send(chatBody(chatId, 'once more', { modelRef: 'mock:search', webSearch: 'auto' }))
    expect(streamedText(third.chunks)).toBe(MOCK_SEARCH_DONE)
    // The stored transcript keeps the first reply's provider-executed parts.
    const stored = (await detail(chatId)).messages.find(message => message.id === first.reply.id)
    expect(stored?.parts.filter(part => isProviderExecutedPart(part))).toHaveLength(1)
  })
})
