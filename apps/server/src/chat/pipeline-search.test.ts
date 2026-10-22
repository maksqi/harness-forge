// The Phase 14 seams of the run pipeline (C52-T2 / T3 / T5), end to end over `POST /api/chat` with a scripted test
// provider whose `webSearch` hook offers a provider-executed `web_search` tool and a stand-in `core-search` builtin that
// owns `search_web`:
// - native tools reach `streamText` only when the turn resolves to native; `search_web` only for the builtin;
// - a provider-executed native call is never an approval, never a hook record; the reply and the stored message hold it;
// - the effective mode (body > chat > global) and a new chat keeping its mode;
// - the notice `web-search-unavailable` once per chat, model and reason;
// - the agent scope's `notify` runs the run's `Notification` hooks with `elicitation_dialog`.
// `providerWebSearch` (W14.4) is replaced by a spy that calls the provider's hook, and `resolveModel` reports the
// catalog's `webSearch` for the native model (W14.4 computes it in the catalog).
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { Disposable, ToolCallContext, WebSearchParams, WebSearchRequest } from '@harness-forge/plugin-sdk'
import type { BuiltinPluginId, ChatDetail, ChatRequestBody, HarnessUIMessage } from '@harness-forge/shared'
import type { Tool, UIMessageChunk } from 'ai'
import type { BuiltinPlugin } from '../plugins/types.ts'
import type { TestApp } from '../testing/create-test-app.ts'
import type { FakeHookService } from '../testing/fake-hooks.ts'
import { chatDetailSchema, SEARCH_WEB_TOOL_NAME } from '@harness-forge/shared'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createTestApp } from '../testing/create-test-app.ts'
import { agentScopeOf } from './agent-scope.ts'
import { NOTICES } from './notices.ts'
import { providerWebSearch } from './search/resolve.ts'
import { SEARCH_TOOL_PLUGIN_ID } from './search/types.ts'
import { chatBody, postChat, readSse, runnerOf, streamedText, testChatId } from './testing.ts'

vi.mock('./search/resolve.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./search/resolve.ts')>()
  return {
    ...actual,
    // What W14.4 implements (without its validation): the provider's own hook.
    providerWebSearch: vi.fn((resolved: { info: unknown, provider: { definition: { webSearch?: (info: unknown, request: WebSearchRequest) => WebSearchParams | undefined } } }, request: WebSearchRequest) => resolved.provider.definition.webSearch?.(resolved.info, request)),
  }
})

const PROVIDER = 'searchkit'

function builtin(id: BuiltinPluginId): BuiltinPlugin {
  return { id, manifest: { manifestVersion: 1, id, name: id, version: '1.0.0', engines: { harness: '^1.0.0' } }, module: { setup: () => {} } }
}

function finishPart(reason: 'stop' | 'tool-calls' = 'stop'): LanguageModelV4StreamPart {
  return {
    type: 'finish',
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
    finishReason: { unified: reason, raw: reason },
  }
}

function textParts(text: string): LanguageModelV4StreamPart[] {
  return [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }]
}

/** The provider-executed search tool the hook offers (`searchkit:native` only). */
function webSearchTool(): Tool {
  return { type: 'provider', id: `${PROVIDER}.web_search`, args: { maxUses: 5 }, isProviderExecuted: true, inputSchema: z.object({ query: z.string() }) } as unknown as Tool
}

function offersNative(options: LanguageModelV4CallOptions): boolean {
  return options.tools?.some(entry => entry.type === 'provider' && entry.name === 'web_search') ?? false
}

function functionNames(options: LanguageModelV4CallOptions | undefined): string[] {
  return (options?.tools ?? []).flatMap(entry => (entry.type === 'function' ? [entry.name] : [])).sort()
}

/** Native offered: one provider-executed search with its result and a source, then text; otherwise "Search off". */
function searchParts(options: LanguageModelV4CallOptions): LanguageModelV4StreamPart[] {
  if (!offersNative(options))
    return [...textParts('Search off'), finishPart()]
  return [
    { type: 'tool-call', toolCallId: 'srvtoolu_1', toolName: 'web_search', input: JSON.stringify({ query: 'cats' }), providerExecuted: true },
    { type: 'tool-result', toolCallId: 'srvtoolu_1', toolName: 'web_search', result: [{ type: 'web_search_result', url: 'https://example.com/cats', title: 'Cats' }] },
    { type: 'source', sourceType: 'url', id: 'src_1', url: 'https://example.com/cats', title: 'Cats' },
    ...textParts('Search done'),
    finishPart(),
  ]
}

describe('pipeline seams (Phase 14, C52)', () => {
  let t: TestApp
  let hooks: FakeHookService
  const disposables: Disposable[] = []
  const calls: LanguageModelV4CallOptions[] = []
  /** The scripted answer of every model call (default: `searchParts`). */
  let script: (options: LanguageModelV4CallOptions, call: number) => LanguageModelV4StreamPart[] = searchParts
  let nextChat = 14_000
  let searchTool: Disposable | null = null

  function newChatId(): string {
    nextChat += 1
    return testChatId(nextChat)
  }

  function model(id: string): LanguageModelV4 {
    return new MockLanguageModelV4({
      provider: PROVIDER,
      modelId: id,
      doStream: async (options) => {
        calls.push(options)
        return { stream: convertArrayToReadableStream(script(options, calls.length)) }
      },
    })
  }

  function registerSearchTool(): void {
    searchTool ??= t.deps.registry.tools.register(SEARCH_TOOL_PLUGIN_ID, {
      name: SEARCH_WEB_TOOL_NAME,
      description: 'Searches the web.',
      inputSchema: z.object({ query: z.string() }),
      policy: 'safe',
      execute: async input => ({ query: (input as { query: string }).query, backend: 'brave', results: [] }),
    })
  }

  function unregisterSearchTool(): void {
    searchTool?.dispose()
    searchTool = null
  }

  beforeAll(async () => {
    t = await createTestApp({ builtins: [builtin('mock'), builtin(SEARCH_TOOL_PLUGIN_ID)], hooks: 'fake' })
    hooks = t.deps.hooks as FakeHookService
    disposables.push(t.deps.registry.providers.register('mock', {
      id: PROVIDER,
      name: 'Search kit',
      credentials: [],
      seedModels: [
        { id: 'native', name: 'Native', contextWindow: 32_000, capabilities: { tools: true } },
        { id: 'plain', name: 'Plain', contextWindow: 32_000, capabilities: { tools: true } },
        { id: 'plain2', name: 'Plain Two', contextWindow: 32_000, capabilities: { tools: true } },
      ],
      createLanguageModel: modelId => model(modelId),
      webSearch: (info: { id: string }) => (info.id === 'native' ? { tools: { web_search: webSearchTool() } } : undefined),
    }))
    disposables.push(t.deps.registry.tools.register('mock', {
      name: 'lookup',
      description: 'Looks something up.',
      inputSchema: z.object({ q: z.string() }),
      policy: 'safe',
      execute: async () => ({ found: true }),
    }))
    disposables.push(t.deps.registry.tools.register('mock', {
      name: 'notify_probe',
      description: 'Asks the run to notify.',
      inputSchema: z.object({}),
      policy: 'safe',
      execute: async (_input: unknown, c: ToolCallContext) => {
        agentScopeOf(c)?.notify?.({ message: 'The server needs your input.', notificationType: 'elicitation_dialog' })
        return { notified: agentScopeOf(c)?.notify !== undefined }
      },
    }))
    // The catalog's native support (W14.4 computes it in `catalog/merge.ts`).
    const resolveModel = t.deps.providers.resolveModel.bind(t.deps.providers)
    vi.spyOn(t.deps.providers, 'resolveModel').mockImplementation(async (modelRef, options) => {
      const resolved = await resolveModel(modelRef, options)
      return modelRef === `${PROVIDER}:native` ? { ...resolved, entry: { ...resolved.entry, webSearch: 'native' } } : resolved
    })
  })

  beforeEach(() => {
    calls.length = 0
    script = searchParts
    hooks.results.clear()
    hooks.present.clear()
    hooks.runCalls.length = 0
    vi.mocked(providerWebSearch).mockClear()
    registerSearchTool()
  })

  afterAll(async () => {
    unregisterSearchTool()
    for (const disposable of disposables.reverse())
      disposable.dispose()
    await t.close()
  })

  function body(chatId: string, text: string, overrides: Partial<ChatRequestBody> = {}): ChatRequestBody {
    return chatBody(chatId, text, { modelRef: `${PROVIDER}:plain`, toolMode: 'ask', ...overrides })
  }

  async function detail(chatId: string): Promise<ChatDetail> {
    return chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId}`)).json())
  }

  async function send(request: ChatRequestBody): Promise<{ chunks: UIMessageChunk[], reply: HarnessUIMessage, call: LanguageModelV4CallOptions | undefined }> {
    const before = calls.length
    const { chunks } = await readSse(await postChat(t, request))
    await runnerOf(t).idle()
    return { chunks, reply: (await detail(request.chatId)).messages.at(-1)!, call: calls[before] }
  }

  function notices(chunks: UIMessageChunk[]): string[] {
    return chunks.flatMap(chunk => (chunk.type === 'data-notice' && (chunk.data as { code?: string }).code === 'web-search-unavailable' ? [(chunk.data as { message: string }).message] : []))
  }

  it('native: the provider tool reaches the model, search_web does not; the provider-executed call never asks and no hook sees it', async () => {
    hooks.present.add('PreToolUse')
    hooks.present.add('PostToolUse')
    for (const toolMode of ['ask', 'plan', 'auto'] as const) {
      const chatId = newChatId()
      const { chunks, reply, call } = await send(body(chatId, 'find cats', { modelRef: `${PROVIDER}:native`, toolMode, webSearch: 'auto' }))
      expect(offersNative(call!)).toBe(true)
      expect(call!.tools?.find(entry => entry.type === 'provider')).toMatchObject({ type: 'provider', name: 'web_search', id: `${PROVIDER}.web_search` })
      expect(functionNames(call)).not.toContain(SEARCH_WEB_TOOL_NAME)
      expect(streamedText(chunks)).toBe('Search done')
      expect(chunks.some(chunk => chunk.type === 'tool-approval-request')).toBe(false)
      expect(chunks.some(chunk => chunk.type === 'tool-output-denied')).toBe(false)
      expect(chunks.some(chunk => chunk.type === 'source-url')).toBe(true)
      const part = reply.parts.find(entry => entry.type === 'tool-web_search') as Record<string, unknown> | undefined
      expect(part).toMatchObject({ state: 'output-available', providerExecuted: true })
      expect(reply.parts.some(entry => entry.type === 'source-url')).toBe(true)
      expect(notices(chunks)).toEqual([])
      expect(vi.mocked(providerWebSearch).mock.calls.at(-1)?.[1]).toMatchObject({ maxUses: 5 })
    }
    expect(hooks.runCalls.filter(entry => entry.event === 'PreToolUse' || entry.event === 'PostToolUse')).toEqual([])
  })

  it('off: no provider tool and no search_web; the provider is never asked', async () => {
    const chatId = newChatId()
    const { chunks, call } = await send(body(chatId, 'find cats', { modelRef: `${PROVIDER}:native`, webSearch: 'off' }))
    expect(offersNative(call!)).toBe(false)
    expect(functionNames(call)).toEqual(['lookup', 'notify_probe'])
    expect(streamedText(chunks)).toBe('Search off')
    expect(providerWebSearch).not.toHaveBeenCalled()
    expect(notices(chunks)).toEqual([])
  })

  it('builtin: a model without native search gets core-search\'s search_web only while search is on', async () => {
    const on = await send(body(newChatId(), 'find cats', { webSearch: 'auto' }))
    expect(functionNames(on.call)).toEqual(['lookup', 'notify_probe', SEARCH_WEB_TOOL_NAME])
    expect(offersNative(on.call!)).toBe(false)
    const off = await send(body(newChatId(), 'find cats', { webSearch: 'off' }))
    expect(functionNames(off.call)).toEqual(['lookup', 'notify_probe'])
    // Native wins over the builtin, and webSearchNative off brings the builtin back.
    const native = await send(body(newChatId(), 'find cats', { modelRef: `${PROVIDER}:native`, webSearch: 'auto' }))
    expect(functionNames(native.call)).toEqual(['lookup', 'notify_probe'])
    await t.deps.settings.update({ webSearchNative: false })
    try {
      const builtinOnly = await send(body(newChatId(), 'find cats', { modelRef: `${PROVIDER}:native`, webSearch: 'auto' }))
      expect(offersNative(builtinOnly.call!)).toBe(false)
      expect(functionNames(builtinOnly.call)).toContain(SEARCH_WEB_TOOL_NAME)
    }
    finally {
      await t.deps.settings.update({ webSearchNative: true })
    }
  })

  it('the effective mode: body > chat > global; a new chat keeps the body\'s mode', async () => {
    const chatId = newChatId()
    await send(body(chatId, 'one', { modelRef: `${PROVIDER}:native`, webSearch: 'auto' }))
    expect((await detail(chatId)).settings.webSearch).toBe('auto')
    // The chat's setting applies without a body value; the body overrides it for its turn (never stored).
    const kept = await send(body(chatId, 'two', { modelRef: `${PROVIDER}:native` }))
    expect(offersNative(kept.call!)).toBe(true)
    const overridden = await send(body(chatId, 'three', { modelRef: `${PROVIDER}:native`, webSearch: 'off' }))
    expect(offersNative(overridden.call!)).toBe(false)
    expect((await detail(chatId)).settings.webSearch).toBe('auto')
    // Without a chat setting: the global default.
    const plainChat = newChatId()
    await send(body(plainChat, 'one', { modelRef: `${PROVIDER}:native` }))
    expect((await detail(plainChat)).settings.webSearch).toBeUndefined()
    expect(offersNative(calls.at(-1)!)).toBe(false)
    await t.deps.settings.update({ webSearchDefault: 'auto' })
    try {
      const followsDefault = await send(body(plainChat, 'two', { modelRef: `${PROVIDER}:native` }))
      expect(offersNative(followsDefault.call!)).toBe(true)
    }
    finally {
      await t.deps.settings.update({ webSearchDefault: 'off' })
    }
  })

  it('unavailable: the notice once per chat, model and reason (a regenerate does not repeat it)', async () => {
    unregisterSearchTool()
    const chatId = newChatId()
    const first = await send(body(chatId, 'one', { webSearch: 'auto' }))
    const expected = NOTICES.webSearchUnavailable('no-backend', 'Plain').message
    expect(notices(first.chunks)).toEqual([expected])
    expect(first.reply.parts.some(part => part.type === 'data-notice' && part.data.message === expected)).toBe(true)
    expect(notices((await send(body(chatId, 'two', { webSearch: 'auto' }))).chunks)).toEqual([])
    // Another model, another reason: their own notice, once.
    expect(notices((await send(body(chatId, 'three', { modelRef: `${PROVIDER}:plain2`, webSearch: 'auto' }))).chunks)).toEqual([NOTICES.webSearchUnavailable('no-backend', 'Plain Two').message])
    const toolsOff = NOTICES.webSearchUnavailable('tool-mode-off', 'Plain').message
    expect(notices((await send(body(chatId, 'four', { webSearch: 'auto', toolMode: 'off' }))).chunks)).toEqual([toolsOff])
    expect(notices((await send(body(chatId, 'five', { webSearch: 'auto', toolMode: 'off' }))).chunks)).toEqual([])
    // A regenerate of the first reply: the history no longer shows it, the runner's memory does.
    const firstReply = (await detail(chatId)).messages[1]!
    const regenerate = { ...body(chatId, 'one', { webSearch: 'auto' }), trigger: 'regenerate-message' as const, messageId: firstReply.id }
    const { chunks } = await readSse(await postChat(t, regenerate))
    await runnerOf(t).idle()
    expect(notices(chunks)).toEqual([])
    // Search off: never a notice.
    expect(notices((await send(body(newChatId(), 'x', { webSearch: 'off' }))).chunks)).toEqual([])
  })

  it('the agent scope\'s notify runs the run\'s Notification hooks with elicitation_dialog (nothing without such hooks)', async () => {
    script = (_options, call) => (call % 2 === 1
      ? [{ type: 'tool-call', toolCallId: `call_${call}`, toolName: 'notify_probe', input: '{}' }, finishPart('tool-calls')]
      : [...textParts('done'), finishPart()])
    await send(body(newChatId(), 'notify'))
    expect(hooks.runCalls.filter(entry => entry.event === 'Notification')).toEqual([])
    hooks.present.add('Notification')
    const { reply } = await send(body(newChatId(), 'notify'))
    expect(reply.parts.find(part => part.type === 'tool-notify_probe')).toMatchObject({ state: 'output-available', output: { notified: true } })
    const notified = hooks.runCalls.filter(entry => entry.event === 'Notification')
    expect(notified).toHaveLength(1)
    expect(notified[0]?.input).toMatchObject({ message: 'The server needs your input.', notificationType: 'elicitation_dialog' })
  })
})

describe('the web-search-unavailable notice (Phase 14)', () => {
  it('is an info notice naming the reason and the model', () => {
    expect(NOTICES.webSearchUnavailable('tool-mode-off', 'Gemini 2.5 Flash')).toEqual({ level: 'info', code: 'web-search-unavailable', message: 'Web search is off for this reply: tools are off in this chat.' })
    expect(NOTICES.webSearchUnavailable('tools-conflict', 'Gemini 2.5 Flash').message).toBe('Web search is off for this reply: Gemini 2.5 Flash can\'t search while tools are on. Add a search key in Settings → Web search to search with tools.')
    expect(NOTICES.webSearchUnavailable('tools-unsupported', 'Tiny').message).toBe('Web search is off for this reply: Tiny can\'t use tools.')
    expect(NOTICES.webSearchUnavailable('no-backend', ' ').message).toBe('Web search is off for this reply: This model has no web search of its own. Add a search key in Settings → Web search.')
  })
})
