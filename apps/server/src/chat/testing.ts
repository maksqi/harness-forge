// Test helpers of the chat pipeline (route and unit tests): request bodies, SSE parsing and partial reads.
import type { ChatRequestBody, HarnessUIMessage, ServerEvent } from '@harness-forge/shared'
import type { UIMessageChunk } from 'ai'
import type { TestApp } from '../testing/create-test-app.ts'
import type { ChatRunnerInternal } from './index.ts'
import { createMessageId } from '@harness-forge/shared'

export function testChatId(n: number): string {
  return `0199a8f0-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
}

export function userMessage(text: string, id: string = createMessageId()): HarnessUIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

export function chatBody(chatId: string, text: string, overrides: Partial<ChatRequestBody> = {}): ChatRequestBody {
  return {
    chatId,
    message: userMessage(text),
    trigger: 'submit-message',
    modelRef: 'mock:echo',
    reasoningEffort: 'auto',
    toolMode: 'ask',
    ...overrides,
  }
}

export function postChat(t: TestApp, body: unknown): Promise<Response> {
  return t.request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

export interface SseResult {
  chunks: UIMessageChunk[]
  done: boolean
}

/** Parses `data: <json>\n\n` events (`[DONE]` sets `done`). */
export function parseSse(text: string): SseResult {
  const chunks: UIMessageChunk[] = []
  let done = false
  for (const block of text.split('\n\n')) {
    const line = block.trim()
    if (!line.startsWith('data: '))
      continue
    const data = line.slice('data: '.length)
    if (data === '[DONE]') {
      done = true
      continue
    }
    chunks.push(JSON.parse(data) as UIMessageChunk)
  }
  return { chunks, done }
}

export async function readSse(response: Response): Promise<SseResult> {
  return parseSse(await response.text())
}

/** Reads until `predicate` matches the chunks so far (or the stream ends), then cancels the reader (a disconnect). */
export async function readUntil(response: Response, predicate: (chunks: UIMessageChunk[]) => boolean): Promise<SseResult> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done)
      break
    text += decoder.decode(value, { stream: true })
    const parsed = parseSse(text.slice(0, text.lastIndexOf('\n\n') + 2))
    if (predicate(parsed.chunks)) {
      await reader.cancel()
      return parsed
    }
  }
  return parseSse(text)
}

/** Concatenated `text-delta`s. */
export function streamedText(chunks: readonly UIMessageChunk[]): string {
  return chunks.flatMap(chunk => (chunk.type === 'text-delta' ? [chunk.delta] : [])).join('')
}

/** Text of a stored message's text parts. */
export function messageText(message: HarnessUIMessage | undefined): string {
  return message?.parts.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('') ?? ''
}

export function runnerOf(t: TestApp): ChatRunnerInternal {
  return t.deps.runs as ChatRunnerInternal
}

/** Resolves with the next event of `type` matching `predicate` (subscribe before triggering it). */
export function nextEvent<T extends ServerEvent['type']>(
  t: TestApp,
  type: T,
  predicate: (event: Extract<ServerEvent, { type: T }>) => boolean = () => true,
  timeoutMs = 5000,
): Promise<Extract<ServerEvent, { type: T }>> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const subscription = t.deps.events.subscribe((event) => {
      if (event.type === type && predicate(event as Extract<ServerEvent, { type: T }>)) {
        clearTimeout(timer)
        subscription.dispose()
        resolve(event as Extract<ServerEvent, { type: T }>)
      }
    })
    timer = setTimeout(() => {
      subscription.dispose()
      reject(new Error(`No ${type} event within ${timeoutMs} ms`))
    }, timeoutMs)
  })
}

/** `n` words (`w1 w2 ...`), for long mock streams (25 ms per word). */
export function words(n: number, prefix = 'w'): string {
  return Array.from({ length: n }, (_value, index) => `${prefix}${index + 1}`).join(' ')
}
