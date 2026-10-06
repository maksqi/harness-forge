import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Prompt, LanguageModelV4StreamPart, LanguageModelV4ToolResultOutput } from '@ai-sdk/provider'
import { APICallError } from '@ai-sdk/provider'
import { buildHookPayload, expandHookPrompt, GENERATE_IMAGE_TOOL_NAME, generateImageToolInputSchema, promptHookOutcome, readPromptHookAnswer } from '@harness-forge/shared'
import { generateText, isStepCount, streamText, tool } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { firstPixel, readPng } from './media.test-util.ts'
import { mockImageColor } from './media.ts'
import {
  createMockLanguageModel,
  generatedImageCount,
  MOCK_MODEL_IDS,
  MOCK_TIMING,
  MOCK_TOOL_NAME,
  mockPlan,
  mockUserText,
  promptWordCount,
  streamSchedule,
  wordChunks,
} from './models.ts'
import {
  findPromptHookMarker,
  MOCK_PROMPT_HOOK_FENCED,
  MOCK_PROMPT_HOOK_INVALID,
  MOCK_PROMPT_HOOK_OK,
  mockPromptHookAnswer,
  mockPromptHookText,
} from './prompt-hook.ts'

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

describe('mock:image-chat (Phase 6)', () => {
  it('streams "Image for: <user text>" word by word, then one PNG file part', async () => {
    const parts = await collect(createMockLanguageModel('image-chat'), { prompt: [user('a red fox')] })
    expect(textOf(parts)).toBe('Image for: a red fox')
    const types = parts.map(part => part.type)
    expect(types.indexOf('file')).toBeGreaterThan(types.indexOf('text-end'))
    expect(types.indexOf('file')).toBeLessThan(types.indexOf('finish'))
    const file = parts.find(part => part.type === 'file')
    if (file?.type !== 'file' || file.data.type !== 'data' || typeof file.data.data === 'string')
      throw new Error('expected a file part with raw bytes')
    expect(file.mediaType).toBe('image/png')
    const png = readPng(file.data.data)
    expect(png).toMatchObject({ width: 320, height: 320, crcOk: true })
    expect(firstPixel(png)).toEqual(mockImageColor('a red fox', 0))
    const finish = finishOf(parts)
    expect(finish.finishReason.unified).toBe('stop')
    expect(finish.usage.outputTokens).toEqual({ total: 5, text: 5, reasoning: 0 })
  })

  it('sizes the image by the aspect ratio of providerOptions.mock (imageParams)', async () => {
    const parts = await collect(createMockLanguageModel('image-chat'), { prompt: [user('wide')], providerOptions: { mock: { aspectRatio: '16:9' } } })
    const file = parts.find(part => part.type === 'file')
    if (file?.type !== 'file' || file.data.type !== 'data' || typeof file.data.data === 'string')
      throw new Error('expected a file part with raw bytes')
    expect(readPng(file.data.data)).toMatchObject({ width: 320, height: 180 })
  })

  it('a model-side file reaches streamText as a generated file (the pipeline stores it); generate returns it too', async () => {
    const result = streamText({ model: createMockLanguageModel('image-chat'), prompt: 'draw a boat' })
    expect(await result.text).toBe('Image for: draw a boat')
    const files = await result.files
    expect(files).toHaveLength(1)
    expect(files[0]?.mediaType).toBe('image/png')
    expect(readPng(files[0]!.uint8Array).crcOk).toBe(true)
    const generated = await createMockLanguageModel('image-chat').doGenerate({ prompt: [user('')] })
    expect(generated.content.map(part => part.type)).toEqual(['text', 'file'])
    expect(generated.content[0]).toEqual({ type: 'text', text: 'Image for: (empty message)' })
  })
})

describe('mock:image-tool (Phase 6)', () => {
  const IMAGE_TOOL = { type: 'function', name: GENERATE_IMAGE_TOOL_NAME, inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } } } as const

  function afterResult(output: LanguageModelV4ToolResultOutput): LanguageModelV4Prompt {
    return [
      user('a castle'),
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'mock_call_1', toolName: GENERATE_IMAGE_TOOL_NAME, input: { prompt: 'a castle' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'mock_call_1', toolName: GENERATE_IMAGE_TOOL_NAME, output }] },
    ]
  }

  it('says tools are disabled without generate_image, else calls it with the user text as prompt', async () => {
    expect(textOf(await collect(createMockLanguageModel('image-tool'), { prompt: [user('a castle')], tools: [TOOL] }))).toBe('Tools are disabled.')
    const parts = await collect(createMockLanguageModel('image-tool'), { prompt: [user('a castle')], tools: [IMAGE_TOOL] })
    expect(parts.find(part => part.type === 'tool-call')).toEqual({ type: 'tool-call', toolCallId: 'mock_call_1', toolName: GENERATE_IMAGE_TOOL_NAME, input: '{"prompt":"a castle"}' })
    expect(parts.find(part => part.type === 'tool-input-start')).toMatchObject({ toolName: GENERATE_IMAGE_TOOL_NAME })
    expect(finishOf(parts).finishReason.unified).toBe('tool-calls')
    const empty = await collect(createMockLanguageModel('image-tool'), { prompt: [user(' ')], tools: [IMAGE_TOOL] })
    expect(generateImageToolInputSchema.safeParse(JSON.parse((empty.find(part => part.type === 'tool-call') as { input: string }).input)).success).toBe(true)
  })

  it('reports the images of the result, or the denial', async () => {
    const summary = { type: 'text', value: 'Generated 2 images with Mock Image; they are shown to the user below this call.' } as const
    expect(textOf(await collect(createMockLanguageModel('image-tool'), { prompt: afterResult(summary), tools: [IMAGE_TOOL] }))).toBe('Image tool result: 2 image(s)')
    const json = { type: 'json', value: { modelRef: 'mock:image', images: [{ fileId: 'file_0000000000000001' }] } } as const
    expect(textOf(await collect(createMockLanguageModel('image-tool'), { prompt: afterResult(json), tools: [IMAGE_TOOL] }))).toBe('Image tool result: 1 image(s)')
    const denied = await collect(createMockLanguageModel('image-tool'), { prompt: afterResult({ type: 'execution-denied' }), tools: [IMAGE_TOOL] })
    expect(textOf(denied)).toBe('The tool call was denied.')
  })

  it('counts the images of every output kind', () => {
    expect(generatedImageCount({ type: 'text', value: 'Generated 1 image with X; it is shown below.' })).toBe(1)
    expect(generatedImageCount({ type: 'text', value: 'nothing' })).toBe(0)
    expect(generatedImageCount({ type: 'json', value: { images: [1, 2, 3] } })).toBe(3)
    expect(generatedImageCount({ type: 'json', value: null })).toBe(0)
    expect(generatedImageCount({ type: 'error-text', value: 'Choose an image model in Settings → Media.' })).toBe(0)
    expect(generatedImageCount({ type: 'content', value: [{ type: 'file', mediaType: 'image/png', data: { type: 'data', data: new Uint8Array([1]) } }] })).toBe(1)
    expect(generatedImageCount({ type: 'content', value: [{ type: 'text', text: 'Generated 4 images' }] })).toBe(4)
  })

  it('runs the whole tool flow through streamText: call, tool result (text summary), answer', async () => {
    const generate = tool({
      description: 'Generates images.',
      inputSchema: generateImageToolInputSchema,
      execute: async input => ({ modelRef: 'mock:image', images: [{ fileId: 'file_0000000000000001', prompt: input.prompt }] }),
      toModelOutput: () => ({ type: 'text', value: 'Generated 1 image with Mock Image; they are shown to the user below this call.' }),
    })
    const result = streamText({ model: createMockLanguageModel('image-tool'), prompt: 'a castle at night', tools: { [GENERATE_IMAGE_TOOL_NAME]: generate }, stopWhen: isStepCount(3) })
    expect(await result.text).toBe('Image tool result: 1 image(s)')
    const steps = await result.steps
    expect(steps).toHaveLength(2)
    expect(steps[0]?.toolCalls.map(call => [call.toolName, call.input])).toEqual([[GENERATE_IMAGE_TOOL_NAME, { prompt: 'a castle at night' }]])
  })
})

describe('language model ids', () => {
  it('covers the four v1 models, the two Phase 6 chat models, the Phase 7 workspace model, the Phase 8 checkpoint and shell models, the five Phase 9 agent mocks, the two Phase 10 customization mocks, the Phase 11 hook mock and the Phase 12 prompt hook mock', () => {
    expect(MOCK_MODEL_IDS).toEqual(['echo', 'reasoning', 'tool-approval', 'error', 'image-chat', 'image-tool', 'workspace', 'checkpoint', 'shell', 'compact', 'plan', 'todo', 'subagent', 'steer', 'agents', 'background', 'hooks', 'prompt-hook'])
    expect(MOCK_MODEL_IDS).toHaveLength(18)
    for (const modelId of ['image', 'transcribe', 'speech'])
      expect(MOCK_MODEL_IDS as readonly string[]).not.toContain(modelId)
  })

  it('a media model id used as a language model rejects with a 404', async () => {
    await expect(createMockLanguageModel('image').doStream({ prompt: [user('x')] })).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('mockPlan additions of Phase 9: parallel calls and the step delay', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const TWO_CALLS = {
    reasoning: null,
    text: 'Two at once.',
    toolCall: null,
    toolCalls: [
      { toolCallId: 'mock_call_1_1', toolName: 'alpha', input: '{"n":1}' },
      { toolCallId: 'mock_call_1_2', toolName: 'beta', input: '{"n":2}' },
    ],
    finishReason: 'tool-calls',
  } as const

  it('streams every call of a step in order after the text', () => {
    const types = streamSchedule({ ...TWO_CALLS, toolCalls: [...TWO_CALLS.toolCalls] }, [user('go')], 'subagent')
      .map(entry => entry.part)
      .flatMap(part => (part.type.startsWith('tool-') ? [`${part.type}:${'id' in part ? part.id : (part as { toolCallId: string }).toolCallId}`] : []))
    expect(types).toEqual([
      'tool-input-start:mock_call_1_1',
      'tool-input-delta:mock_call_1_1',
      'tool-input-end:mock_call_1_1',
      'tool-call:mock_call_1_1',
      'tool-input-start:mock_call_1_2',
      'tool-input-delta:mock_call_1_2',
      'tool-input-end:mock_call_1_2',
      'tool-call:mock_call_1_2',
    ])
  })

  it('the SDK runs both calls of one step (doStream and doGenerate)', async () => {
    const executed: string[] = []
    const model = createMockLanguageModel('subagent')
    // A parent turn of mock:subagent: two parallel task calls in one step.
    const task = tool({
      description: 'Task.',
      inputSchema: z.object({ description: z.string(), prompt: z.string(), type: z.string() }),
      execute: async (input) => {
        executed.push(input.prompt)
        return input.prompt
      },
    })
    const result = streamText({ model, prompt: 'Look around', tools: { task }, stopWhen: isStepCount(1) })
    const steps = await result.steps
    expect(steps[0]?.toolCalls.map(call => [call.toolCallId, call.toolName])).toEqual([['mock_call_1_1', 'task'], ['mock_call_1_2', 'task']])
    expect(executed.sort()).toEqual(['Check the time.', 'List the project files.'])
    const generated = await model.doGenerate({ prompt: [user('Look around')], tools: [{ type: 'function', name: 'task', inputSchema: { type: 'object' } }] })
    expect(generated.content.map(part => (part.type === 'tool-call' ? part.toolCallId : part.type))).toEqual(['mock_call_1_1', 'mock_call_1_2'])
    expect(generated.finishReason.unified).toBe('tool-calls')
  })

  it('stepDelayMs waits before the first chunk (fake timers)', async () => {
    vi.useFakeTimers()
    const schedule = streamSchedule({ reasoning: null, text: 'a', toolCall: null, stepDelayMs: 400, finishReason: 'stop' }, [user('a')], 'todo')
    expect(schedule[0]).toMatchObject({ delayMs: 400, part: { type: 'stream-start' } })
    const { stream } = await createMockLanguageModel('todo').doStream({ prompt: [user('go')], tools: [{ type: 'function', name: 'todo_write', inputSchema: { type: 'object' } }] })
    const reader = stream.getReader()
    let first: LanguageModelV4StreamPart | undefined
    const reading = reader.read().then(({ value }) => {
      first = value
    })
    await vi.advanceTimersByTimeAsync(399)
    expect(first).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await reading
    expect(first?.type).toBe('stream-start')
    reader.releaseLock()
  })

  it('an abort during the step delay ends the stream at once', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const { stream } = await createMockLanguageModel('steer').doStream({
      prompt: [user('steps 2')],
      tools: [{ type: 'function', name: 'current_time', inputSchema: { type: 'object' } }],
      abortSignal: controller.signal,
    })
    const reading = stream.getReader().read()
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    await expect(createMockLanguageModel('steer').doGenerate({ prompt: [user('steps 2')], tools: [{ type: 'function', name: 'current_time', inputSchema: { type: 'object' } }], abortSignal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('doGenerate waits the step delay too', async () => {
    vi.useFakeTimers()
    let settled = false
    const generating = createMockLanguageModel('todo').doGenerate({ prompt: [user('go')], tools: [{ type: 'function', name: 'todo_write', inputSchema: { type: 'object' } }] }).then((value) => {
      settled = true
      return value
    })
    await vi.advanceTimersByTimeAsync(399)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect((await generating).content.map(part => part.type)).toEqual(['tool-call'])
  })
})

// ---------- Phase 12 (C45-T1): mock:prompt-hook (PROVIDERS.md 8 "Prompt hook mock (Phase 12)") ----------

describe('mock:prompt-hook', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const model = (): LanguageModelV4 => createMockLanguageModel('prompt-hook')

  it.each([
    ['[[ph:ok]]', '{"ok":true}', { ok: true, reason: null, impossible: false }],
    ['[[ph:deny no writes]]', '{"ok":false,"reason":"no writes"}', { ok: false, reason: 'no writes', impossible: false }],
    ['[[ph:deny   spaced out  ]]', '{"ok":false,"reason":"spaced out"}', { ok: false, reason: 'spaced out', impossible: false }],
    ['[[ph:impossible done]]', '{"ok":false,"reason":"done","impossible":true}', { ok: false, reason: 'done', impossible: true }],
    ['[[ph:fenced]]', MOCK_PROMPT_HOOK_FENCED, { ok: false, reason: 'fenced', impossible: false }],
    ['no marker at all', '{"ok":true}', { ok: true, reason: null, impossible: false }],
  ] as const)('%s answers %s (read by readPromptHookAnswer)', async (prompt, answer, read) => {
    const result = await generateText({ model: model(), prompt: `Judge this. ${prompt}`, maxRetries: 0 })
    expect(result.text).toBe(answer)
    expect(readPromptHookAnswer(result.text)).toEqual({ valid: true, answer: read })
  })

  it('[[ph:fenced]] is a line of prose, then the object in a json fence', () => {
    expect(MOCK_PROMPT_HOOK_FENCED).toBe('Here is my answer:\n```json\n{"ok":false,"reason":"fenced"}\n```')
  })

  it('[[ph:invalid]] answers prose without JSON (a non-blocking error); an empty deny reason is invalid too', async () => {
    const invalid = await generateText({ model: model(), prompt: '[[ph:invalid]]', maxRetries: 0 })
    expect(invalid.text).toBe(MOCK_PROMPT_HOOK_INVALID)
    expect(invalid.text).toBe('I cannot decide.')
    expect(readPromptHookAnswer(invalid.text)).toMatchObject({ valid: false })
    expect(mockPromptHookAnswer('[[ph:deny]]')).toBe('{"ok":false,"reason":""}')
    expect(readPromptHookAnswer(mockPromptHookAnswer('[[ph:deny]]'))).toMatchObject({ valid: false })
    expect(mockPromptHookAnswer('[[ph:impossible]]')).toBe('{"ok":false,"reason":"","impossible":true}')
  })

  it('answers from the first marker; unknown keywords and markers with extra text are skipped', () => {
    expect(mockPromptHookAnswer('[[ph:deny first]] then [[ph:ok]]')).toBe('{"ok":false,"reason":"first"}')
    expect(mockPromptHookAnswer('[[ph:ok]] then [[ph:deny second]]')).toBe(MOCK_PROMPT_HOOK_OK)
    expect(findPromptHookMarker('[[ph:bogus]] [[ph:okay]] [[ph:ok please]] [[ph:impossible why]]')).toEqual({ marker: 'impossible', reason: 'why' })
    expect(findPromptHookMarker('[[ph:deny reason with ] bracket]] tail')).toEqual({ marker: 'deny', reason: 'reason with ] bracket' })
    expect(findPromptHookMarker('[[ph:deny\nacross lines]]')).toEqual({ marker: 'deny', reason: 'across lines' })
    expect(findPromptHookMarker('[[PH:deny x]] [ph:deny y] [[ph:deny z]')).toBeNull()
    expect(mockPromptHookAnswer('')).toBe(MOCK_PROMPT_HOOK_OK)
  })

  it('searches the user messages in order, never the system text or assistant messages', async () => {
    const prompt: LanguageModelV4Prompt = [
      { role: 'system', content: 'Rules: [[ph:deny from the system]]' },
      user('first: [[ph:impossible from the first user message]]'),
      { role: 'assistant', content: [{ type: 'text', text: '[[ph:deny from the assistant]]' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }, { type: 'text', text: '[[ph:deny from the second]]' }] },
    ]
    expect(mockPromptHookText(prompt)).toBe('first: [[ph:impossible from the first user message]]\nsecond\n[[ph:deny from the second]]')
    const result = await model().doGenerate({ prompt })
    expect(result.content).toEqual([{ type: 'text', text: '{"ok":false,"reason":"from the first user message","impossible":true}' }])
    const systemOnly = await model().doGenerate({ prompt: [{ role: 'system', content: '[[ph:deny system]]' }, user('nothing here')] })
    expect(systemOnly.content).toEqual([{ type: 'text', text: MOCK_PROMPT_HOOK_OK }])
  })

  it('a marker in the hook prompt wins over one in the hook input, unless $ARGUMENTS comes first', () => {
    const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: { content: '[[ph:deny from the input]]' } })
    expect(mockPromptHookAnswer(expandHookPrompt('Allow it? [[ph:ok]]', payload))).toBe(MOCK_PROMPT_HOOK_OK)
    expect(mockPromptHookAnswer(expandHookPrompt('Check [[ph:impossible prompt]] $ARGUMENTS', payload))).toBe('{"ok":false,"reason":"prompt","impossible":true}')
    expect(mockPromptHookAnswer(expandHookPrompt('$ARGUMENTS and then [[ph:ok]]', payload))).toBe('{"ok":false,"reason":"from the input"}')
    expect(mockPromptHookAnswer(expandHookPrompt('Is this write allowed?', payload))).toBe('{"ok":false,"reason":"from the input"}')
  })

  it('drives promptHookOutcome end to end: a PreToolUse write_file whose content holds [[ph:deny no writes]] is denied', async () => {
    const payload = buildHookPayload('PreToolUse', {
      chatId: '0199a8f0-0000-7000-8000-000000000001',
      projectId: 'prj_AAAAAAAAAAAAAAAA',
      modelRef: 'mock:hooks',
      origin: 'request',
      cwd: '/tmp/project',
      toolMode: 'ask',
      source: 'project',
      tool: { name: 'write_file', callId: 'mock_call_1', input: { path: 'a.txt', content: '[[ph:deny no writes]]' } },
    })
    const result = await generateText({ model: model(), prompt: expandHookPrompt('May the agent write this file?', payload.json), maxRetries: 0 })
    const read = readPromptHookAnswer(result.text)
    expect(read).toEqual({ valid: true, answer: { ok: false, reason: 'no writes', impossible: false } })
    const answer = read.valid ? read.answer : null
    expect(promptHookOutcome('PreToolUse', answer)).toMatchObject({ status: 'blocked', decision: 'deny', reason: 'no writes', continue: false })
    expect(promptHookOutcome('PreToolUse', answer, { continueOnBlock: true })).toMatchObject({ status: 'blocked', decision: 'deny', reason: 'no writes', continue: true })
  })

  it('has a fixed usage of 10 input and 5 output tokens and finishes with stop, ignoring reasoning and the output cap', async () => {
    const result = await generateText({ model: model(), prompt: 'a long prompt with many words [[ph:deny x]]', maxOutputTokens: 1, reasoning: 'high', maxRetries: 0 })
    expect(result.text).toBe('{"ok":false,"reason":"x"}')
    expect(result.finishReason).toBe('stop')
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 })
    const parts = await collect(model(), { prompt: [user('[[ph:ok]]')], maxOutputTokens: 1, reasoning: 'xhigh' })
    expect(finishOf(parts).usage).toEqual({ inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } })
    expect(finishOf(parts).finishReason).toEqual({ unified: 'stop', raw: 'stop' })
    expect(parts.some(part => part.type === 'reasoning-delta' || part.type === 'tool-call')).toBe(false)
  })

  it('streams the whole answer at once without any timer (fake timers never advanced)', async () => {
    vi.useFakeTimers()
    const parts = await collect(model(), { prompt: [user('[[ph:fenced]]')] })
    expect(parts.map(part => part.type)).toEqual(['stream-start', 'response-metadata', 'text-start', 'text-delta', 'text-end', 'finish'])
    expect(textOf(parts)).toBe(MOCK_PROMPT_HOOK_FENCED)
    const streamed = streamText({ model: model(), prompt: '[[ph:impossible all done]]' })
    expect(await streamed.text).toBe('{"ok":false,"reason":"all done","impossible":true}')
  })

  it('rejects at once with the reason of an aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(model().doGenerate({ prompt: [user('[[ph:ok]]')], abortSignal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(model().doStream({ prompt: [user('[[ph:ok]]')], abortSignal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('mockPlan gives the same answer as text (the model itself is served by ./prompt-hook.ts)', () => {
    expect(mockPlan('prompt-hook', { prompt: [user('[[ph:deny plan]]')] })).toEqual({ reasoning: null, text: '{"ok":false,"reason":"plan"}', toolCall: null, finishReason: 'stop' })
  })
})
