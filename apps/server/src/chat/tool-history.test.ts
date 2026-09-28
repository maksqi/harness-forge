// Tool history of requests without tools (W4.6): unit tests of the text form, and runs against a strict fake provider
// that rejects tool content in a request that defines no tools (as Anthropic and Bedrock do).
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Prompt, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { ChatDetail, HarnessUIMessage, HarnessUIMessagePart } from '@harness-forge/shared'
import type { ModelMessage, UIMessageChunk } from 'ai'
import type { BuiltinPlugin } from '../plugins/types.ts'
import type { TestApp } from '../testing/create-test-app.ts'
import { APICallError } from '@ai-sdk/provider'
import { chatDetailSchema } from '@harness-forge/shared'
import { convertToModelMessages, streamText } from 'ai'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createTestApp } from '../testing/create-test-app.ts'
import { chatBody, messageText, postChat, readSse, runnerOf, streamedText, testChatId } from './testing.ts'
import { compactValue, TOOL_TEXT_INPUT_MAX_CHARS, TOOL_TEXT_OUTPUT_MAX_CHARS, toolPartsAsText, toolPartText, truncateText } from './tool-history.ts'

function tool(part: Record<string, unknown>): HarnessUIMessagePart {
  return { type: 'tool-web_fetch', toolCallId: 'call_1', input: { url: 'https://example.com' }, ...part } as unknown as HarnessUIMessagePart
}

function textOf(part: HarnessUIMessagePart): string | null {
  return toolPartText(part as never)
}

describe('toolPartText', () => {
  it('writes results, errors and denials as one compact line', () => {
    expect(textOf(tool({ state: 'output-available', output: { status: 200, text: 'Example   Domain\n\nMore' } })))
      .toBe('[tool web_fetch({"url":"https://example.com"}) → ok: {"status":200,"text":"Example Domain\\n\\nMore"}]')
    expect(textOf(tool({ state: 'output-available', output: 'plain  text\nresult' }))).toBe('[tool web_fetch({"url":"https://example.com"}) → ok: plain text result]')
    expect(textOf(tool({ state: 'output-error', errorText: 'Fetch failed:\n  404' }))).toBe('[tool web_fetch({"url":"https://example.com"}) → error: Fetch failed: 404]')
    expect(textOf(tool({ state: 'output-error', input: undefined, errorText: 'Invalid input' }))).toBe('[tool web_fetch → error: Invalid input]')
    expect(textOf(tool({ state: 'output-denied', approval: { id: 'a1', approved: false, reason: 'superseded' } }))).toBe('[tool web_fetch({"url":"https://example.com"}) → denied: superseded]')
    expect(textOf(tool({ state: 'output-denied', approval: { id: 'a1', approved: false } }))).toBe('[tool web_fetch({"url":"https://example.com"}) → denied]')
    expect(textOf(tool({ state: 'approval-responded', approval: { id: 'a1', approved: false, reason: 'not now' } }))).toBe('[tool web_fetch({"url":"https://example.com"}) → denied: not now]')
    expect(textOf(tool({ state: 'approval-responded', approval: { id: 'a1', approved: true } }))).toBe('[tool web_fetch({"url":"https://example.com"}) → approved, not run]')
    expect(textOf({ type: 'dynamic-tool', toolName: 'mcp__docs__search', toolCallId: 'c', state: 'output-available', input: { q: 'x' }, output: { hits: 1 } } as HarnessUIMessagePart))
      .toBe('[tool mcp__docs__search({"q":"x"}) → ok: {"hits":1}]')
  })

  it('leaves out calls without a result', () => {
    expect(textOf(tool({ state: 'input-streaming', input: undefined }))).toBeNull()
    expect(textOf(tool({ state: 'input-available' }))).toBeNull()
    expect(textOf(tool({ state: 'approval-requested', approval: { id: 'a1' } }))).toBeNull()
    expect(textOf(tool({ state: 'output-available', output: 'partial', preliminary: true }))).toBeNull()
  })

  it('caps inputs and outputs (never inside a surrogate pair)', () => {
    const long = textOf(tool({ state: 'output-available', input: { q: 'i'.repeat(5000) }, output: 'o'.repeat(50_000) }))!
    const [input, output] = long.split(' → ok: ')
    expect(input!.length).toBeLessThanOrEqual('[tool web_fetch('.length + TOOL_TEXT_INPUT_MAX_CHARS + 2)
    expect(output!.length).toBe(TOOL_TEXT_OUTPUT_MAX_CHARS + 2)
    expect(output!.endsWith('…]')).toBe(true)
    expect(truncateText('ab\u{1F600}cd', 3)).toBe('ab…')
    expect(truncateText('abc', 3)).toBe('abc')
    expect(compactValue(undefined, 10)).toBe('undefined')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(compactValue(cyclic, 50)).toBe('[object Object]')
  })
})

describe('toolPartsAsText', () => {
  it('turns tool parts into text, drops the step boundaries of those messages and keeps everything else', () => {
    const user: HarnessUIMessage = { id: 'msg_u000000000000001', role: 'user', parts: [{ type: 'text', text: 'fetch it' }] }
    const assistant: HarnessUIMessage = {
      id: 'msg_a000000000000001',
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        { type: 'reasoning', text: 'Need the page.', state: 'done' },
        tool({ state: 'output-available', output: { status: 200 } }),
        tool({ toolCallId: 'call_2', state: 'approval-requested', approval: { id: 'a2' } }),
        { type: 'step-start' },
        { type: 'text', text: 'The page says hello.', state: 'done' },
        { type: 'data-notice', data: { level: 'info', code: 'context-trimmed', message: 'Trimmed.' } },
      ],
    }
    const plain: HarnessUIMessage = { id: 'msg_a000000000000002', role: 'assistant', parts: [{ type: 'step-start' }, { type: 'text', text: 'Hi.' }] }
    const snapshot = structuredClone([user, assistant, plain])
    const converted = toolPartsAsText([user, assistant, plain])
    expect(converted[0]).toBe(user)
    expect(converted[2]).toBe(plain)
    expect(converted[1]?.parts).toEqual([
      { type: 'reasoning', text: 'Need the page.', state: 'done' },
      { type: 'text', text: '[tool web_fetch({"url":"https://example.com"}) → ok: {"status":200}]' },
      { type: 'text', text: 'The page says hello.', state: 'done' },
      { type: 'data-notice', data: { level: 'info', code: 'context-trimmed', message: 'Trimmed.' } },
    ])
    // The stored transcript is never changed.
    expect([user, assistant, plain]).toEqual(snapshot)
  })

  it('produces model messages without tool content, as one assistant turn', async () => {
    const history: HarnessUIMessage[] = [
      { id: 'msg_u000000000000001', role: 'user', parts: [{ type: 'text', text: 'fetch it' }] },
      {
        id: 'msg_a000000000000001',
        role: 'assistant',
        parts: [{ type: 'step-start' }, tool({ state: 'output-available', output: { status: 200 } }), { type: 'step-start' }, { type: 'text', text: 'Done.' }],
      },
      { id: 'msg_u000000000000002', role: 'user', parts: [{ type: 'text', text: 'thanks' }] },
    ]
    const withTools = await convertToModelMessages(history)
    expect(withTools.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user'])
    const converted = await convertToModelMessages(toolPartsAsText(history))
    expect(converted).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'fetch it' }] },
      { role: 'assistant', content: [{ type: 'text', text: '[tool web_fetch({"url":"https://example.com"}) → ok: {"status":200}]' }, { type: 'text', text: 'Done.' }] },
      { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
    ])
  })
})

// ---------- runs against a provider that rejects tool content without tools ----------

const REJECTION = 'Requests which include `tool_use` or `tool_result` blocks must define tools.'

/** Tool calls, tool results or approval parts anywhere in the prompt. */
function hasToolContent(prompt: LanguageModelV4Prompt | ModelMessage[]): boolean {
  return prompt.some(message => message.role === 'tool' || (Array.isArray(message.content)
    && (message.content as readonly { type: string }[]).some(part => part.type.startsWith('tool-'))))
}

function finishPart(reason: 'stop' | 'tool-calls' = 'stop'): LanguageModelV4StreamPart {
  return {
    type: 'finish',
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
    finishReason: { unified: reason, raw: reason },
  }
}

function textParts(text: string): LanguageModelV4StreamPart[] {
  return [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, finishPart()]
}

/**
 * A model of the `strict` provider: it rejects a request with tool content but no tools (HTTP 400), calls `lookup`
 * when tools are defined and the last message is not a tool result, and answers "done" otherwise.
 */
function strictModel(modelId: string, calls: LanguageModelV4CallOptions[]): LanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'strict',
    modelId,
    doStream: async (options) => {
      calls.push(options)
      if (hasToolContent(options.prompt) && (options.tools?.length ?? 0) === 0)
        throw new APICallError({ message: REJECTION, url: 'https://strict.example.com/v1/messages', requestBodyValues: {}, statusCode: 400, isRetryable: false })
      const wantsTool = (options.tools?.length ?? 0) > 0 && options.prompt.at(-1)?.role !== 'tool'
      return {
        stream: convertArrayToReadableStream(wantsTool
          ? [{ type: 'tool-call', toolCallId: `call_${calls.length}`, toolName: 'lookup', input: '{"q":"cats"}' }, finishPart('tool-calls')]
          : textParts('done')),
      }
    },
  })
}

const OWNER: BuiltinPlugin = {
  id: 'mock',
  manifest: { manifestVersion: 1, id: 'mock', name: 'Mock', version: '1.0.0', engines: { harness: '^1.0.0' } },
  module: { setup: () => {} },
}

describe('runs without tools against a strict provider', () => {
  let t: TestApp
  let nextChat = 700
  const calls: LanguageModelV4CallOptions[] = []
  const models = new Map<string, LanguageModelV4>()
  const registrations: Disposable[] = []

  function registerLookup(): Disposable {
    return t.deps.registry.tools.register('mock', {
      name: 'lookup',
      description: 'Looks something up.',
      inputSchema: z.object({ q: z.string() }),
      policy: 'safe',
      execute: async input => ({ found: (input as { q: string }).q, note: 'from the lookup tool' }),
    })
  }

  async function newChat(): Promise<string> {
    nextChat += 1
    const chatId = testChatId(nextChat)
    // A user title: no title generation (its model calls would mix with the recorded ones).
    await t.request('/api/chats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: chatId, title: 'Tool history' }) })
    return chatId
  }

  async function detailOf(chatId: string): Promise<ChatDetail> {
    return chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId}`)).json())
  }

  /** Sends a user message and returns the stream chunks and the model calls of the reply. */
  async function send(chatId: string, text: string, overrides: Parameters<typeof chatBody>[2]): Promise<{ chunks: UIMessageChunk[], turn: LanguageModelV4CallOptions[] }> {
    const before = calls.length
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, text, overrides)))
    await runnerOf(t).idle()
    const turn = calls.slice(before)
    expect(turn.length, 'the model was called').toBeGreaterThan(0)
    return { chunks, turn }
  }

  function toolPartOf(message: HarnessUIMessage | undefined): Record<string, unknown> | undefined {
    return message?.parts.find(part => part.type === 'tool-lookup') as Record<string, unknown> | undefined
  }

  beforeAll(async () => {
    // Only an empty `mock` builtin: the owner of the test provider and tool, and no other tool.
    t = await createTestApp({ builtins: [OWNER] })
    for (const id of ['tools', 'plain', 'plain2'])
      models.set(id, strictModel(id, calls))
    registrations.push(t.deps.registry.providers.register('mock', {
      id: 'strict',
      name: 'Strict',
      credentials: [],
      seedModels: [
        { id: 'tools', name: 'Tools', contextWindow: 32_000, capabilities: { tools: true } },
        { id: 'plain', name: 'Plain', contextWindow: 32_000, capabilities: { tools: false } },
        { id: 'plain2', name: 'Plain 2', contextWindow: 32_000, capabilities: { tools: false } },
      ],
      createLanguageModel: modelId => models.get(modelId)!,
    }))
    registrations.push(registerLookup())
  })

  afterAll(async () => {
    for (const registration of registrations.splice(0).reverse())
      registration.dispose()
    await t.close()
  })

  it('the provider rejects the stored tool history when it is sent without tools as before', async () => {
    const chatId = await newChat()
    await send(chatId, 'look up cats', { modelRef: 'strict:tools', toolMode: 'auto' })
    const stored = (await detailOf(chatId)).messages
    const legacy = streamText({ model: models.get('tools')!, messages: await convertToModelMessages(stored, { ignoreIncompleteToolCalls: true }), maxRetries: 0 })
    const errors: unknown[] = []
    for await (const part of legacy.stream) {
      if (part.type === 'error')
        errors.push(part.error)
    }
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe(REJECTION)
  })

  it('sends earlier tool calls as text when the tool mode is off, a model has no tools or no tool is usable', async () => {
    const chatId = await newChat()
    const first = await send(chatId, 'look up cats', { modelRef: 'strict:tools', toolMode: 'auto' })
    expect(first.turn.map(call => call.tools?.map(entry => entry.name))).toEqual([['lookup'], ['lookup']])
    expect(streamedText(first.chunks)).toBe('done')
    const transcript = (await detailOf(chatId)).messages
    expect(toolPartOf(transcript[1])).toMatchObject({ state: 'output-available', input: { q: 'cats' }, output: { found: 'cats', note: 'from the lookup tool' } })

    const expectedText = '[tool lookup({"q":"cats"}) → ok: {"found":"cats","note":"from the lookup tool"}]'
    const withoutTools = async (text: string, overrides: Parameters<typeof chatBody>[2]): Promise<void> => {
      const { chunks, turn } = await send(chatId, text, overrides)
      expect(turn).toHaveLength(1)
      const call = turn[0]!
      expect(chunks.some(chunk => chunk.type === 'error')).toBe(false)
      expect(streamedText(chunks)).toBe('done')
      expect(call.tools ?? []).toEqual([])
      expect(hasToolContent(call.prompt)).toBe(false)
      expect(JSON.stringify(call.prompt)).toContain(JSON.stringify(expectedText).slice(1, -1))
    }

    // 1. Tool mode off.
    await withoutTools('and dogs?', { modelRef: 'strict:tools', toolMode: 'off' })
    // 2. A model without tool support (the tools-unsupported notice explains it).
    await withoutTools('and birds?', { modelRef: 'strict:plain', toolMode: 'ask' })
    expect((await detailOf(chatId)).messages.at(-1)?.parts.some(part => part.type === 'data-notice' && part.data.code === 'tools-unsupported')).toBe(true)
    // 3. Tools on, but none is usable.
    registrations.pop()?.dispose()
    try {
      await withoutTools('and fish?', { modelRef: 'strict:tools', toolMode: 'auto' })
    }
    finally {
      registrations.push(registerLookup())
    }

    // The stored transcript keeps the tool part; every reply was stored.
    const after = (await detailOf(chatId)).messages
    expect(after).toHaveLength(8)
    expect(toolPartOf(after[1])).toEqual(toolPartOf(transcript[1]))
    expect(after.filter(message => message.role === 'assistant').map(message => messageText(message))).toEqual(['done', 'done', 'done', 'done'])
    expect(after.every(message => message.metadata?.error === undefined)).toBe(true)

    // With tools again, the history keeps its tool calls and results (the first call of the reply shows them).
    const again = await send(chatId, 'once more', { modelRef: 'strict:tools', toolMode: 'auto' })
    expect(hasToolContent(again.turn[0]!.prompt)).toBe(true)
    expect(JSON.stringify(again.turn[0]!.prompt)).not.toContain('[tool lookup')
    expect(again.chunks.some(chunk => chunk.type === 'error')).toBe(false)
  })

  it('shows the tools-unsupported notice at most once per chat and model, never in tool mode off', async () => {
    const streamedNotices = (chunks: UIMessageChunk[]): number =>
      chunks.filter(chunk => chunk.type === 'data-notice' && (chunk.data as { code?: string }).code === 'tools-unsupported').length
    const storedNotices = async (chatId: string, modelRef: string): Promise<number> => (await detailOf(chatId)).messages.filter(message => message.role === 'assistant' && message.metadata?.modelRef === modelRef).flatMap(message => message.parts.filter(part => part.type === 'data-notice' && part.data.code === 'tools-unsupported')).length

    const chatId = await newChat()
    const first = chatBody(chatId, 'one', { modelRef: 'strict:plain', toolMode: 'ask' })
    const { chunks } = await readSse(await postChat(t, first))
    await runnerOf(t).idle()
    expect(streamedNotices(chunks)).toBe(1)
    // Later replies of the same model in this chat do not repeat it; another model gets its own notice once.
    expect(streamedNotices((await send(chatId, 'two', { modelRef: 'strict:plain', toolMode: 'ask' })).chunks)).toBe(0)
    expect(streamedNotices((await send(chatId, 'three', { modelRef: 'strict:plain2', toolMode: 'auto' })).chunks)).toBe(1)
    expect(streamedNotices((await send(chatId, 'four', { modelRef: 'strict:plain', toolMode: 'ask' })).chunks)).toBe(0)
    expect(streamedNotices((await send(chatId, 'five', { modelRef: 'strict:plain2', toolMode: 'ask' })).chunks)).toBe(0)
    expect(await storedNotices(chatId, 'strict:plain')).toBe(1)
    expect(await storedNotices(chatId, 'strict:plain2')).toBe(1)

    // Regenerating the reply that carried it moves it to the new reply: the chat still shows it once.
    const firstReply = (await detailOf(chatId)).messages[1]!
    await readSse(await postChat(t, { ...first, trigger: 'regenerate-message', messageId: firstReply.id }))
    await runnerOf(t).idle()
    const regenerated = (await detailOf(chatId)).messages
    expect(regenerated).toHaveLength(2)
    expect(await storedNotices(chatId, 'strict:plain')).toBe(1)
    expect(streamedNotices((await send(chatId, 'six', { modelRef: 'strict:plain', toolMode: 'ask' })).chunks)).toBe(0)

    // Tool mode off: no tools would have been sent, so there is nothing to explain.
    const off = await newChat()
    for (const text of ['a', 'b'])
      expect(streamedNotices((await send(off, text, { modelRef: 'strict:plain', toolMode: 'off' })).chunks)).toBe(0)
    expect(await storedNotices(off, 'strict:plain')).toBe(0)
  })
})
