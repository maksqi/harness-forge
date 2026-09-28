// Deterministic mock language models of the dev-only `mock` provider (PROVIDERS.md 8): `MockLanguageModelV4` instances
// whose streams come from `simulateReadableStream` with a per-chunk schedule (text: first chunk after 50 ms, then every
// 25 ms; reasoning: every 100 ms). Every delay aborts with the call's `abortSignal`, so a stopped run ends at once.
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolResultOutput,
  LanguageModelV4Usage,
} from '@ai-sdk/provider'
import { APICallError } from '@ai-sdk/provider'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'

export const MOCK_PROVIDER_ID = 'mock'
export const MOCK_TOOL_NAME = 'mock_approval_tool'
/** The model ids of the mock provider. */
export const MOCK_MODEL_IDS = ['echo', 'reasoning', 'tool-approval', 'error'] as const
export type MockModelId = (typeof MOCK_MODEL_IDS)[number]

/** Stream timing (PROVIDERS.md 8). */
export const MOCK_TIMING = {
  /** Delay before the first text chunk. */
  firstTextChunkMs: 50,
  /** Delay between text chunks. */
  textChunkMs: 25,
  /** Delay before each reasoning chunk. */
  reasoningChunkMs: 100,
} as const

export const MOCK_EMPTY_MESSAGE = '(empty message)'
export const MOCK_TOOLS_DISABLED = 'Tools are disabled.'
export const MOCK_TOOL_DENIED = 'The tool call was denied.'
export const MOCK_AUTH_FAILURE = 'Mock authentication failure'
export const MOCK_ERROR_URL = 'mock://error'

// ---------- prompt helpers ----------

type UserMessage = Extract<LanguageModelV4Message, { role: 'user' }>

function lastUserMessage(prompt: LanguageModelV4Prompt): UserMessage | undefined {
  for (let index = prompt.length - 1; index >= 0; index--) {
    const message = prompt[index]
    if (message?.role === 'user')
      return message
  }
  return undefined
}

/** The text parts of the last user message, joined with a space and trimmed. */
export function mockUserText(prompt: LanguageModelV4Prompt): string {
  const message = lastUserMessage(prompt)
  if (message === undefined)
    return ''
  return message.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join(' ').trim()
}

/** File parts of the last user message. */
export function mockFileCount(prompt: LanguageModelV4Prompt): number {
  return lastUserMessage(prompt)?.content.filter(part => part.type === 'file').length ?? 0
}

/** Whitespace-separated words. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter(word => word !== '').length
}

/** Chunks of one word plus its following whitespace. */
export function wordChunks(text: string): string[] {
  return text.match(/\S+\s*/g) ?? []
}

/** Words of every prompt text part (system text, user and assistant text parts). */
export function promptWordCount(prompt: LanguageModelV4Prompt): number {
  let words = 0
  for (const message of prompt) {
    if (message.role === 'system') {
      words += countWords(message.content)
      continue
    }
    if (message.role === 'user' || message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type === 'text')
          words += countWords(part.text)
      }
    }
  }
  return words
}

// ---------- plans ----------

/** What a call answers: optional reasoning, then text or one tool call. */
export interface MockPlan {
  reasoning: string | null
  text: string | null
  toolCall: { toolCallId: string, input: string } | null
  finishReason: 'stop' | 'tool-calls'
}

function textPlan(text: string, reasoning: string | null = null): MockPlan {
  return { reasoning, text, toolCall: null, finishReason: 'stop' }
}

function echoPlan(prompt: LanguageModelV4Prompt): MockPlan {
  const files = mockFileCount(prompt)
  const text = mockUserText(prompt) || MOCK_EMPTY_MESSAGE
  return textPlan(files > 0 ? `${text}\n\n[files: ${files}]` : text)
}

function reasoningPlan(options: LanguageModelV4CallOptions): MockPlan {
  const userText = mockUserText(options.prompt)
  const answer = `Answer: ${userText}`.trimEnd()
  const effort = options.reasoning ?? 'provider-default'
  if (effort === 'none')
    return textPlan(answer)
  const firstWords = userText.split(/\s+/).filter(word => word !== '').slice(0, 8).join(' ')
  return textPlan(answer, `Thinking about "${firstWords}" with effort ${effort}.`)
}

function outputJson(output: LanguageModelV4ToolResultOutput): string {
  if (output.type === 'execution-denied')
    return 'null'
  return JSON.stringify(output.value) ?? 'null'
}

function toolApprovalPlan(options: LanguageModelV4CallOptions): MockPlan {
  const hasTool = options.tools?.some(tool => tool.type === 'function' && tool.name === MOCK_TOOL_NAME) ?? false
  if (!hasTool)
    return textPlan(MOCK_TOOLS_DISABLED)
  const last = options.prompt.at(-1)
  if (last?.role === 'tool') {
    const result = last.content.findLast(part => part.type === 'tool-result' && part.toolName === MOCK_TOOL_NAME)
    if (result?.type === 'tool-result') {
      if (result.output.type === 'execution-denied')
        return textPlan(MOCK_TOOL_DENIED)
      return textPlan(`Tool result: ${outputJson(result.output)}`)
    }
    if (last.content.some(part => part.type === 'tool-approval-response' && !part.approved))
      return textPlan(MOCK_TOOL_DENIED)
  }
  const assistantMessages = options.prompt.filter(message => message.role === 'assistant').length
  return {
    reasoning: null,
    text: null,
    toolCall: { toolCallId: `mock_call_${assistantMessages + 1}`, input: JSON.stringify({ text: mockUserText(options.prompt) }) },
    finishReason: 'tool-calls',
  }
}

/** The answer of a mock model to a call (`error` and unknown ids never get here). */
export function mockPlan(modelId: MockModelId, options: LanguageModelV4CallOptions): MockPlan {
  switch (modelId) {
    case 'reasoning':
      return reasoningPlan(options)
    case 'tool-approval':
      return toolApprovalPlan(options)
    default:
      return echoPlan(options.prompt)
  }
}

function usageOf(plan: MockPlan, prompt: LanguageModelV4Prompt): LanguageModelV4Usage {
  const inputTokens = promptWordCount(prompt)
  const textWords = plan.text === null ? 0 : countWords(plan.text)
  const reasoningWords = plan.reasoning === null ? 0 : countWords(plan.reasoning)
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: textWords + reasoningWords, text: textWords, reasoning: reasoningWords },
  }
}

// ---------- results ----------

function generateResult(plan: MockPlan, prompt: LanguageModelV4Prompt, modelId: string): LanguageModelV4GenerateResult {
  const content: LanguageModelV4Content[] = []
  if (plan.reasoning !== null)
    content.push({ type: 'reasoning', text: plan.reasoning })
  if (plan.text !== null)
    content.push({ type: 'text', text: plan.text })
  if (plan.toolCall !== null)
    content.push({ type: 'tool-call', toolCallId: plan.toolCall.toolCallId, toolName: MOCK_TOOL_NAME, input: plan.toolCall.input })
  return {
    content,
    finishReason: { unified: plan.finishReason, raw: plan.finishReason },
    usage: usageOf(plan, prompt),
    response: { id: 'mock-response', modelId, timestamp: new Date(0) },
    warnings: [],
  }
}

/** A stream part and the delay before it is emitted. */
export interface ScheduledPart {
  delayMs: number
  part: LanguageModelV4StreamPart
}

/** The timed stream of a plan. */
export function streamSchedule(plan: MockPlan, prompt: LanguageModelV4Prompt, modelId: string): ScheduledPart[] {
  const parts: ScheduledPart[] = [
    { delayMs: 0, part: { type: 'stream-start', warnings: [] } },
    { delayMs: 0, part: { type: 'response-metadata', id: 'mock-response', modelId, timestamp: new Date(0) } },
  ]
  if (plan.reasoning !== null) {
    parts.push({ delayMs: 0, part: { type: 'reasoning-start', id: 'reasoning-0' } })
    for (const delta of wordChunks(plan.reasoning))
      parts.push({ delayMs: MOCK_TIMING.reasoningChunkMs, part: { type: 'reasoning-delta', id: 'reasoning-0', delta } })
    parts.push({ delayMs: 0, part: { type: 'reasoning-end', id: 'reasoning-0' } })
  }
  if (plan.text !== null) {
    parts.push({ delayMs: 0, part: { type: 'text-start', id: 'text-0' } })
    wordChunks(plan.text).forEach((delta, index) => {
      parts.push({ delayMs: index === 0 ? MOCK_TIMING.firstTextChunkMs : MOCK_TIMING.textChunkMs, part: { type: 'text-delta', id: 'text-0', delta } })
    })
    parts.push({ delayMs: 0, part: { type: 'text-end', id: 'text-0' } })
  }
  if (plan.toolCall !== null) {
    const { toolCallId, input } = plan.toolCall
    parts.push(
      { delayMs: MOCK_TIMING.firstTextChunkMs, part: { type: 'tool-input-start', id: toolCallId, toolName: MOCK_TOOL_NAME } },
      { delayMs: 0, part: { type: 'tool-input-delta', id: toolCallId, delta: input } },
      { delayMs: 0, part: { type: 'tool-input-end', id: toolCallId } },
      { delayMs: 0, part: { type: 'tool-call', toolCallId, toolName: MOCK_TOOL_NAME, input } },
    )
  }
  parts.push({
    delayMs: 0,
    part: { type: 'finish', usage: usageOf(plan, prompt), finishReason: { unified: plan.finishReason, raw: plan.finishReason } },
  })
  return parts
}

function abortError(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason
  return reason instanceof Error || reason instanceof DOMException ? reason : new DOMException('The operation was aborted.', 'AbortError')
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(abortError(signal))
  if (ms <= 0)
    return Promise.resolve()
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError(signal as AbortSignal))
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** `simulateReadableStream` driven by the schedule: each chunk waits for its own delay. */
function timedStream(schedule: readonly ScheduledPart[], signal?: AbortSignal): ReadableStream<LanguageModelV4StreamPart> {
  let next = 0
  return simulateReadableStream({
    chunks: schedule.map(entry => entry.part),
    initialDelayInMs: 0,
    chunkDelayInMs: 0,
    _internal: { delay: async () => abortableDelay(schedule[next++]?.delayMs ?? 0, signal) },
  })
}

// ---------- models ----------

/** The `APICallError` of `mock:error` (PROVIDERS.md 8). */
export function mockAuthError(): APICallError {
  return new APICallError({
    message: MOCK_AUTH_FAILURE,
    url: MOCK_ERROR_URL,
    requestBodyValues: {},
    statusCode: 401,
    responseHeaders: {},
    responseBody: JSON.stringify({ error: { type: 'authentication_error', message: MOCK_AUTH_FAILURE } }),
    isRetryable: false,
  })
}

function unknownModelError(modelId: string): APICallError {
  return new APICallError({
    message: `Unknown mock model "${modelId}".`,
    url: `mock://${encodeURIComponent(modelId)}`,
    requestBodyValues: {},
    statusCode: 404,
    isRetryable: false,
  })
}

function isMockModelId(modelId: string): modelId is MockModelId {
  return (MOCK_MODEL_IDS as readonly string[]).includes(modelId)
}

/** A mock model instance (`createLanguageModel` of the `mock` provider). */
export function createMockLanguageModel(modelId: string): LanguageModelV4 {
  const failure = modelId === 'error' ? mockAuthError : isMockModelId(modelId) ? null : () => unknownModelError(modelId)
  return new MockLanguageModelV4({
    provider: MOCK_PROVIDER_ID,
    modelId,
    supportedUrls: {},
    doGenerate: async (options) => {
      if (failure !== null)
        throw failure()
      if (options.abortSignal?.aborted)
        throw abortError(options.abortSignal)
      return generateResult(mockPlan(modelId as MockModelId, options), options.prompt, modelId)
    },
    doStream: async (options) => {
      if (failure !== null)
        throw failure()
      const schedule = streamSchedule(mockPlan(modelId as MockModelId, options), options.prompt, modelId)
      return { stream: timedStream(schedule, options.abortSignal) }
    },
  })
}
