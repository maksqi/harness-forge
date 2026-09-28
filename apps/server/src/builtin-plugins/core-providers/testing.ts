// Test helpers of `core-providers`: a `ProviderRuntime` whose `fetch` records requests and answers from a route
// function, so tests never touch the network.
import type { ProviderRuntime } from '@harness-forge/plugin-sdk'
import { APICallError } from '@ai-sdk/provider'

export interface RecordedRequest {
  url: string
  method: string
  /** Lowercase header names. */
  headers: Record<string, string>
  /** Parsed JSON body, `undefined` without a body. */
  body: unknown
}

export type FakeRoute = (request: RecordedRequest) => Response | Promise<Response>

export interface FakeRuntime {
  rt: ProviderRuntime
  requests: RecordedRequest[]
}

/** A runtime with resolved `credentials`; without a route every request fails the test. */
export function fakeRuntime(credentials: Record<string, string> = {}, route?: FakeRoute): FakeRuntime {
  const requests: RecordedRequest[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const text = await request.text()
    const recorded: RecordedRequest = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: text ? JSON.parse(text) as unknown : undefined,
    }
    requests.push(recorded)
    if (!route)
      throw new Error(`Unexpected request: ${recorded.method} ${recorded.url}`)
    return route(recorded)
  }
  return { rt: { credentials, fetch }, requests }
}

/** A JSON response. */
export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/** An `APICallError` as the AI SDK packages throw it for a failed HTTP call. */
export function apiError(options: {
  status?: number
  body?: unknown
  headers?: Record<string, string>
  url?: string
  model?: string
  message?: string
  cause?: unknown
}): APICallError {
  const responseBody = options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
  return new APICallError({
    message: options.message ?? 'Request failed',
    url: options.url ?? 'https://api.example.com/v1/chat/completions',
    requestBodyValues: options.model === undefined ? {} : { model: options.model },
    statusCode: options.status,
    responseHeaders: options.headers,
    responseBody,
    cause: options.cause,
  })
}

/** An OpenAI Chat Completions response (Groq, OpenRouter, Ollama, Z.ai). */
export function chatCompletion(model: string, content = 'pong'): Record<string, unknown> {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1_790_000_000,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  }
}

/** An Anthropic Messages response (Anthropic, MiniMax). */
export function anthropicMessage(model: string, text = 'pong'): Record<string, unknown> {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 1 },
  }
}
