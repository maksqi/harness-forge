// Model context of a run (ARCHITECTURE.md 6.1 "Params"): prompt-command expansions replace the text the model sees,
// the history is converted with `convertToModelMessages` (async in v7), `chat.messages` hooks may change it, and the
// oldest turns are left out while the estimated prompt is above 85 percent of the model's context window.
// Phase 9 (ADR-040): the trimming runs inside the context guard (`compaction/guard.ts`) before the first model call of a
// run, only when automatic compaction is off (85 percent) or failed (down to the compaction trigger, 80 percent); the
// guard and the summarizer size the context with the same estimate.
import type { HarnessUIMessage, HarnessUIMessagePart } from '@harness-forge/shared'
import type { ModelMessage } from 'ai'
import { modelMessageSchema } from 'ai'

/** Share of the context window the prompt may use before the oldest turns are trimmed. */
export const CONTEXT_BUDGET_RATIO = 0.85
/** Rough token cost of an image or other binary attachment. */
const IMAGE_TOKENS = 1600
/** Rough token cost per byte of a non-image binary attachment (PDF pages). */
const BINARY_BYTES_PER_TOKEN = 32
/** Per-message overhead (role, separators). */
const MESSAGE_OVERHEAD_TOKENS = 4
/** Characters per token of text and JSON (the estimate of this module, also the summarizer's transcript budget). */
export const CHARS_PER_TOKEN = 4

/**
 * UI messages as sent to the model: a user message that invoked a prompt command has its first text part replaced by
 * the stored expansion (the transcript keeps the original text).
 */
export function applyCommandExpansions(messages: readonly HarnessUIMessage[]): HarnessUIMessage[] {
  return messages.map((message) => {
    const command = message.role === 'user' ? message.metadata?.command : undefined
    if (command?.type !== 'prompt' || command.expansion === undefined)
      return message
    const expansion = command.expansion
    let replaced = false
    const parts = message.parts.map((part): HarnessUIMessagePart => {
      if (replaced || part.type !== 'text')
        return part
      replaced = true
      return { type: 'text', text: expansion }
    })
    return { ...message, parts: replaced ? parts : [{ type: 'text', text: expansion }, ...parts] }
  })
}

function textTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function binaryTokens(mediaType: string | undefined, data: unknown): number {
  if (typeof mediaType === 'string' && mediaType.startsWith('image'))
    return IMAGE_TOKENS
  let bytes = 0
  if (data instanceof Uint8Array) {
    bytes = data.byteLength
  }
  else if (typeof data === 'string') {
    bytes = Math.floor(data.length * 0.75)
  }
  else if (typeof data === 'object' && data !== null) {
    const inner = (data as { data?: unknown, url?: unknown }).data ?? (data as { url?: unknown }).url
    if (inner instanceof Uint8Array)
      bytes = inner.byteLength
    else if (typeof inner === 'string')
      bytes = Math.floor(inner.length * 0.75)
    else if (inner instanceof URL)
      bytes = Math.floor(inner.href.length * 0.75)
  }
  return Math.max(IMAGE_TOKENS / 4, Math.ceil(bytes / BINARY_BYTES_PER_TOKEN))
}

function jsonTokens(value: unknown): number {
  try {
    return textTokens(JSON.stringify(value) ?? '')
  }
  catch {
    return 0
  }
}

/** A rough token estimate of one model message (text and JSON by length, attachments by kind and size). */
export function estimateMessageTokens(message: ModelMessage): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS
  if (typeof message.content === 'string')
    return tokens + textTokens(message.content)
  for (const part of message.content as readonly Record<string, unknown>[]) {
    switch (part.type) {
      case 'text':
      case 'reasoning':
        tokens += textTokens(typeof part.text === 'string' ? part.text : '')
        break
      case 'file':
      case 'image':
      case 'reasoning-file':
        tokens += binaryTokens(typeof part.mediaType === 'string' ? part.mediaType : undefined, part.data ?? part.image)
        break
      case 'tool-call':
        tokens += jsonTokens(part.input) + textTokens(String(part.toolName ?? ''))
        break
      case 'tool-result':
        tokens += jsonTokens(part.output)
        break
      default:
        tokens += jsonTokens(part)
    }
  }
  return tokens
}

export function estimateTokens(messages: readonly ModelMessage[], instructions?: string): number {
  let tokens = instructions === undefined ? 0 : textTokens(instructions)
  for (const message of messages)
    tokens += estimateMessageTokens(message)
  return tokens
}

/** Indexes where a turn starts (every user message; the first turn also starts at 0). */
function turnStarts(messages: readonly ModelMessage[]): number[] {
  const starts: number[] = []
  messages.forEach((message, index) => {
    if (message.role === 'user' && index > 0)
      starts.push(index)
  })
  return starts
}

export interface TrimResult {
  messages: ModelMessage[]
  /** Model messages left out. */
  removed: number
}

/**
 * Leaves out the oldest turns (a user message and the assistant / tool messages up to the next user message) while the
 * estimate is above `ratio` (default `CONTEXT_BUDGET_RATIO`) of `contextWindow`. The last turn is always kept, so tool
 * calls keep their results and an approval continuation keeps its final tool message.
 */
export function trimToContext(messages: readonly ModelMessage[], contextWindow: number | null, instructions?: string, ratio: number = CONTEXT_BUDGET_RATIO): TrimResult {
  if (contextWindow === null || contextWindow <= 0 || messages.length === 0)
    return { messages: [...messages], removed: 0 }
  const budget = Math.floor(contextWindow * ratio)
  const perMessage = messages.map(message => estimateMessageTokens(message))
  let total = (instructions === undefined ? 0 : textTokens(instructions)) + perMessage.reduce((sum, value) => sum + value, 0)
  if (total <= budget)
    return { messages: [...messages], removed: 0 }
  let start = 0
  for (const next of turnStarts(messages)) {
    if (total <= budget)
      break
    for (let index = start; index < next; index++)
      total -= perMessage[index] ?? 0
    start = next
  }
  return { messages: messages.slice(start), removed: start }
}

/** The `chat.messages` hook output when it is a valid list of model messages, else null. */
export function validModelMessages(value: unknown): ModelMessage[] | null {
  if (!Array.isArray(value))
    return null
  for (const message of value) {
    if (!modelMessageSchema.safeParse(message).success)
      return null
  }
  return value as ModelMessage[]
}
