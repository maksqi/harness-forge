import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Prompt, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { APICallError } from '@ai-sdk/provider'
import { streamText } from 'ai'
import { describe, expect, it } from 'vitest'
import {
  createMockLanguageModel,
  MOCK_TIMING,
  MOCK_TOOL_NAME,
  mockPlan,
  mockUserText,
  promptWordCount,
  streamSchedule,
  wordChunks,
} from './models.ts'

function user(text: string, files = 0): LanguageModelV4Prompt[number] {
  const content: Extract<LanguageModelV4Prompt[number], { role: 'user' }>['content'] = [{ type: 'text', text }]
  for (let index = 0; index < files; index++)
    content.push({ type: 'file', mediaType: 'image/png', data: { type: 'data', data: new Uint8Array([1]) } })
  return { role: 'user', content }
}

const TOOL = { type: 'function', name: MOCK_TOOL_NAME, inputSchema: { type: 'object', properties: { text: { type: 'string' } } } } as const

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

function textOf(parts: LanguageModelV4StreamPart[], type: 'text-delta' | 'reasoning-delta' = 'text-delta'): string {
  return parts.flatMap(part => (part.type === type ? [part.delta] : [])).join('')
}

function finishOf(parts: LanguageModelV4StreamPart[]): Extract<LanguageModelV4StreamPart, { type: 'finish' }> {
  const finish = parts.find(part => part.type === 'finish')
  if (finish?.type !== 'finish')
    throw new Error('no finish part')
  return finish
}

describe('prompt helpers', () => {
  it('reads the text of the last user message and counts prompt words', () => {
    const prompt: LanguageModelV4Prompt = [
      { role: 'system', content: 'Be brief please' },
      user('first question'),
      { role: 'assistant', content: [{ type: 'text', text: 'an answer' }] },
      { role: 'user', content: [{ type: 'text', text: '  hello ' }, { type: 'text', text: 'world  ' }] },
    ]
    expect(mockUserText(prompt)).toBe('hello  world')
    expect(promptWordCount(prompt)).toBe(3 + 2 + 2 + 2)
    expect(wordChunks('hello  big\nworld')).toEqual(['hello  ', 'big\n', 'world'])
  })
})

describe('mock:echo', () => {
  it('streams the user text back one word per chunk with usage', async () => {
    const parts = await collect(createMockLanguageModel('echo'), { prompt: [user('hello big world')] })
    expect(parts.filter(part => part.type === 'text-delta').map(part => (part as { delta: string }).delta)).toEqual(['hello ', 'big ', 'world'])
    const finish = finishOf(parts)
    expect(finish.finishReason).toEqual({ unified: 'stop', raw: 'stop' })
    expect(finish.usage.inputTokens.total).toBe(3)
    expect(finish.usage.outputTokens).toEqual({ total: 3, text: 3, reasoning: 0 })
  })

  it('answers "(empty message)" and appends the file count', async () => {
    expect(textOf(await collect(createMockLanguageModel('echo'), { prompt: [user('  ')] }))).toBe('(empty message)')
    expect(textOf(await collect(createMockLanguageModel('echo'), { prompt: [user('look', 2)] }))).toBe('look\n\n[files: 2]')
  })

  it('schedules the first text chunk after 50 ms, then one every 25 ms', () => {
    const schedule = streamSchedule({ reasoning: null, text: 'a b c', toolCall: null, finishReason: 'stop' }, [user('a b c')], 'echo')
    const deltas = schedule.filter(entry => entry.part.type === 'text-delta').map(entry => entry.delayMs)
    expect(deltas).toEqual([MOCK_TIMING.firstTextChunkMs, MOCK_TIMING.textChunkMs, MOCK_TIMING.textChunkMs])
    expect(MOCK_TIMING).toEqual({ firstTextChunkMs: 50, textChunkMs: 25, reasoningChunkMs: 100 })
    const total = schedule.reduce((sum, entry) => sum + entry.delayMs, 0)
    expect(total).toBe(100)
  })

  it('takes about 10 s for 400 words and stops promptly on abort', async () => {
    const words = Array.from({ length: 400 }, (_, index) => `w${index}`).join(' ')
    const schedule = streamSchedule({ reasoning: null, text: words, toolCall: null, finishReason: 'stop' }, [user(words)], 'echo')
    expect(schedule.reduce((sum, entry) => sum + entry.delayMs, 0)).toBe(50 + 399 * 25)

    const controller = new AbortController()
    const { stream } = await createMockLanguageModel('echo').doStream({ prompt: [user(words)], abortSignal: controller.signal })
    const reader = stream.getReader()
    const started = Date.now()
    let deltas = 0
    const reading = (async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done)
          return
        if (value.type === 'text-delta' && ++deltas === 3)
          controller.abort()
      }
    })()
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    expect(deltas).toBe(3)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('works through streamText and generate', async () => {
    const result = streamText({ model: createMockLanguageModel('echo'), prompt: 'ping pong' })
    expect(await result.text).toBe('ping pong')
    expect((await result.usage).outputTokens).toBe(2)
    const generated = await createMockLanguageModel('echo').doGenerate({ prompt: [user('title words here')] })
    expect(generated.content).toEqual([{ type: 'text', text: 'title words here' }])
    expect(generated.finishReason.unified).toBe('stop')
  })
})

describe('mock:reasoning', () => {
  it('streams no reasoning for reasoning "none"', async () => {
    const parts = await collect(createMockLanguageModel('reasoning'), { prompt: [user('why is the sky blue')], reasoning: 'none' })
    expect(parts.some(part => part.type === 'reasoning-start')).toBe(false)
    expect(textOf(parts)).toBe('Answer: why is the sky blue')
  })

  it.each([
    [undefined, 'provider-default'],
    ['low', 'low'],
    ['xhigh', 'xhigh'],
  ] as const)('reasons with the received option %s', async (reasoning, shown) => {
    const parts = await collect(createMockLanguageModel('reasoning'), { prompt: [user('hi there')], ...(reasoning ? { reasoning } : {}) })
    expect(textOf(parts, 'reasoning-delta')).toBe(`Thinking about "hi there" with effort ${shown}.`)
    expect(textOf(parts)).toBe('Answer: hi there')
    const finish = finishOf(parts)
    expect(finish.usage.outputTokens.reasoning).toBe(7)
    expect(finish.usage.outputTokens.total).toBe(7 + 3)
    const reasoningIndex = parts.findIndex(part => part.type === 'reasoning-end')
    const textIndex = parts.findIndex(part => part.type === 'text-start')
    expect(reasoningIndex).toBeLessThan(textIndex)
  })

  it('quotes the first 8 words of the user text', () => {
    const text = 'one two three four five six seven eight nine ten'
    expect(mockPlan('reasoning', { prompt: [user(text)], reasoning: 'medium' })).toEqual({
      reasoning: 'Thinking about "one two three four five six seven eight" with effort medium.',
      text: `Answer: ${text}`,
      toolCall: null,
      finishReason: 'stop',
    })
  })

  it('schedules reasoning chunks every 100 ms', () => {
    const schedule = streamSchedule({ reasoning: 'a b', text: 'c', toolCall: null, finishReason: 'stop' }, [user('c')], 'reasoning')
    expect(schedule.filter(entry => entry.part.type === 'reasoning-delta').map(entry => entry.delayMs)).toEqual([100, 100])
  })
})

describe('mock:tool-approval', () => {
  it('says tools are disabled without the tool', async () => {
    expect(textOf(await collect(createMockLanguageModel('tool-approval'), { prompt: [user('go')] }))).toBe('Tools are disabled.')
  })

  it('calls the tool with the user text', async () => {
    const parts = await collect(createMockLanguageModel('tool-approval'), { prompt: [user('echo this')], tools: [TOOL] })
    const call = parts.find(part => part.type === 'tool-call')
    expect(call).toEqual({ type: 'tool-call', toolCallId: 'mock_call_1', toolName: MOCK_TOOL_NAME, input: '{"text":"echo this"}' })
    expect(finishOf(parts).finishReason.unified).toBe('tool-calls')
  })

  it('numbers calls by the assistant messages of the prompt', async () => {
    const prompt: LanguageModelV4Prompt = [user('a'), { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, user('b')]
    const parts = await collect(createMockLanguageModel('tool-approval'), { prompt, tools: [TOOL] })
    expect(parts.find(part => part.type === 'tool-call')).toMatchObject({ toolCallId: 'mock_call_2', input: '{"text":"b"}' })
  })

  it('reports the tool result or the denial', async () => {
    const call = { type: 'tool-call', toolCallId: 'mock_call_1', toolName: MOCK_TOOL_NAME, input: { text: 'hi' } } as const
    const approved: LanguageModelV4Prompt = [
      user('hi'),
      { role: 'assistant', content: [call] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'mock_call_1', toolName: MOCK_TOOL_NAME, output: { type: 'json', value: { echoed: 'hi' } } }] },
    ]
    expect(textOf(await collect(createMockLanguageModel('tool-approval'), { prompt: approved, tools: [TOOL] }))).toBe('Tool result: {"echoed":"hi"}')
    const denied: LanguageModelV4Prompt = [
      user('hi'),
      { role: 'assistant', content: [call] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'mock_call_1', toolName: MOCK_TOOL_NAME, output: { type: 'execution-denied' } }] },
    ]
    expect(textOf(await collect(createMockLanguageModel('tool-approval'), { prompt: denied, tools: [TOOL] }))).toBe('The tool call was denied.')
  })
})

describe('mock:error and unknown ids', () => {
  it('rejects doStream before any chunk with a 401 APICallError', async () => {
    const error = await createMockLanguageModel('error').doStream({ prompt: [user('x')] }).then(() => null, (caught: unknown) => caught)
    expect(APICallError.isInstance(error)).toBe(true)
    expect(error).toMatchObject({ statusCode: 401, message: 'Mock authentication failure', url: 'mock://error', isRetryable: false })
    await expect(createMockLanguageModel('error').doGenerate({ prompt: [user('x')] })).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects unknown model ids with a 404', async () => {
    const model = createMockLanguageModel('nope')
    expect(model.provider).toBe('mock')
    await expect(model.doStream({ prompt: [user('x')] })).rejects.toMatchObject({ statusCode: 404 })
  })
})
