/// <reference path="./harness-forge.d.ts" />
// Echo provider: an LLM provider whose models answer without a network call or an API key. The models implement the
// AI SDK language model spec (`LanguageModelV4` of `@ai-sdk/provider`) by hand, so this file is also a starting point
// for an API that has no AI SDK provider: replace `reply()` with requests through `rt.fetch`.
// The host compiles this TypeScript entry with esbuild (no type checking); only Node built-ins may be imported.
import type { ModelInfo } from '@harness-forge/plugin-sdk'
import { setTimeout as delay } from 'node:timers/promises'
import { definePlugin } from '@harness-forge/plugin-sdk'

const PROVIDER_ID = 'echo-provider'
/** Pause between streamed words, so the answer visibly streams (and Stop has something to stop). */
const WORD_DELAY_MS = 30

const MODELS: ModelInfo[] = [
  { id: 'echo', name: 'Echo', contextWindow: 32_000, maxOutputTokens: 32_000, capabilities: { tools: false } },
  { id: 'reverse', name: 'Echo reversed', contextWindow: 32_000, maxOutputTokens: 32_000, capabilities: { tools: false } },
]

// ---------- the part of the LanguageModelV4 spec used here ----------
// Written out so the example reads without `@ai-sdk/provider` in your editor. `import type` from that package would
// work too (esbuild removes type imports), but plugins cannot import its runtime.

interface PromptMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** A string for system messages; parts (text, file, tool call, ...) for the other roles. */
  content: string | Array<{ type: string, text?: string }>
}
interface CallOptions {
  prompt: PromptMessage[]
  abortSignal?: AbortSignal
}
interface Usage {
  inputTokens: { total: number, noCache: number, cacheRead: number, cacheWrite: number }
  outputTokens: { total: number, text: number, reasoning: number }
}
interface FinishReason {
  unified: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'
  raw: string | undefined
}
type StreamPart
  = | { type: 'stream-start', warnings: unknown[] }
    | { type: 'text-start' | 'text-end', id: string }
    | { type: 'text-delta', id: string, delta: string }
    | { type: 'finish', usage: Usage, finishReason: FinishReason }
interface EchoLanguageModel {
  readonly specificationVersion: 'v4'
  readonly provider: string
  readonly modelId: string
  /** URLs the model downloads itself, by media type (none: the SDK inlines attachments). */
  readonly supportedUrls: Record<string, RegExp[]>
  doGenerate: (options: CallOptions) => Promise<{ content: Array<{ type: 'text', text: string }>, finishReason: FinishReason, usage: Usage, warnings: unknown[] }>
  doStream: (options: CallOptions) => Promise<{ stream: ReadableStream<StreamPart> }>
}

// ---------- the model ----------

const STOP: FinishReason = { unified: 'stop', raw: 'stop' }

/** The text parts of the last user message. */
function lastUserText(prompt: PromptMessage[]): string {
  const content = prompt.findLast(entry => entry.role === 'user')?.content ?? ''
  if (typeof content === 'string')
    return content.trim()
  return content.map(part => (part.type === 'text' ? part.text ?? '' : '')).join(' ').trim()
}

/** The answer: the last user message, reversed for the `reverse` model. */
function reply(modelId: string, prompt: PromptMessage[]): string {
  const text = lastUserText(prompt)
  if (text === '')
    return '(nothing to echo)'
  return modelId === 'reverse' ? [...text].reverse().join('') : text
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(word => word !== '').length
}

/** Words stand in for tokens, so the usage row of the chat shows real numbers. */
function usage(prompt: PromptMessage[], answer: string): Usage {
  const input = prompt.reduce((sum, message) => sum + countWords(
    typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join(' '),
  ), 0)
  const output = countWords(answer)
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  }
}

function createEchoModel(modelId: string): EchoLanguageModel {
  return {
    specificationVersion: 'v4',
    provider: PROVIDER_ID,
    modelId,
    supportedUrls: {},

    // Non-streaming calls (for example chat titles).
    async doGenerate(options) {
      const text = reply(modelId, options.prompt)
      return { content: [{ type: 'text', text }], finishReason: STOP, usage: usage(options.prompt, text), warnings: [] }
    },

    // Streaming calls (the chat): stream-start, text-start, one text-delta per word, text-end, finish.
    async doStream(options) {
      const text = reply(modelId, options.prompt)
      const words = text.match(/\S+\s*/g) ?? []
      const parts: StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text-0' },
        ...words.map((delta): StreamPart => ({ type: 'text-delta', id: 'text-0', delta })),
        { type: 'text-end', id: 'text-0' },
        { type: 'finish', usage: usage(options.prompt, text), finishReason: STOP },
      ]
      let next = 0
      const stream = new ReadableStream<StreamPart>({
        async pull(controller) {
          const part = parts[next++]
          if (part === undefined) {
            controller.close()
            return
          }
          // Rejects as soon as the run is stopped, which ends the stream with the abort error.
          if (part.type === 'text-delta')
            await delay(WORD_DELAY_MS, undefined, { signal: options.abortSignal })
          controller.enqueue(part)
        },
      })
      return { stream }
    },
  }
}

export default definePlugin({
  setup(ctx) {
    ctx.providers.register({
      // Model refs: "echo-provider:echo" and "echo-provider:reverse".
      id: PROVIDER_ID,
      name: 'Echo',
      // No key dialog: the provider is connected as soon as the plugin is active.
      credentials: [],
      smallModelId: 'echo',
      seedModels: MODELS,
      // Called for every request; must not do network I/O. Unknown (custom) model ids echo too.
      createLanguageModel: modelId => createEchoModel(modelId),
      // The live model list; also the "Test" button of Settings -> Providers.
      listModels: async () => MODELS,
    })
    ctx.logger.info('Echo provider ready: pick "Echo" in the model picker.')
  },
})
