// Test helper (not production code): an in-process fake LLM API on an ephemeral 127.0.0.1 port that speaks enough of
// the OpenAI Chat Completions and Anthropic Messages wire formats for draft tests and created providers:
//   GET  /v1/models            -> `{ data: [{ id }] }` (Bearer or `x-api-key` checked when a key is configured)
//   POST /v1/chat/completions  -> a completion (JSON, or SSE with `stream: true`) whose text is "pong"
//   POST /v1/messages          -> an Anthropic message whose text is "pong"
// Requests are recorded (lowercase headers, parsed JSON bodies) so tests can assert the wire format.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpManager } from '../../mcp/types.ts'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { HarnessError } from '@harness-forge/shared'

export interface FakeLlmRequest {
  method: string
  /** Path with the query string. */
  url: string
  headers: Record<string, string>
  body: unknown
}

export interface FakeLlmServerOptions {
  /** Required key (`Authorization: Bearer <key>` or `x-api-key: <key>`); none = no auth. */
  apiKey?: string
  models?: string[]
  /** Text of every completion. */
  reply?: string
}

export interface FakeLlmServer {
  /** `http://127.0.0.1:<port>/v1` */
  baseURL: string
  requests: FakeLlmRequest[]
  close: () => Promise<void>
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request)
    chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) as unknown : undefined
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

export async function startFakeLlmServer(options: FakeLlmServerOptions = {}): Promise<FakeLlmServer> {
  const requests: FakeLlmRequest[] = []
  const models = options.models ?? ['fake-small', 'fake-large']
  const reply = options.reply ?? 'pong'

  const server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request)
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === 'string')
          headers[name.toLowerCase()] = value
      }
      requests.push({ method: request.method ?? 'GET', url: request.url ?? '/', headers, body })
      const path = (request.url ?? '/').split('?')[0]
      if (options.apiKey !== undefined) {
        const presented = headers.authorization?.replace(/^Bearer /, '') ?? headers['x-api-key']
        if (presented !== options.apiKey) {
          sendJson(response, 401, { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } })
          return
        }
      }
      const model = typeof body === 'object' && body !== null ? (body as { model?: unknown }).model : undefined
      if (request.method === 'GET' && path === '/v1/models') {
        sendJson(response, 200, { object: 'list', data: models.map(id => ({ id, object: 'model', owned_by: 'fake', context_length: 32_768 })), has_more: false })
        return
      }
      if (request.method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/messages') && typeof model === 'string' && !models.includes(model)) {
        sendJson(response, 404, { error: { message: `The model ${model} does not exist.`, type: 'invalid_request_error', code: 'model_not_found' } })
        return
      }
      if (request.method === 'POST' && path === '/v1/chat/completions') {
        if ((body as { stream?: unknown }).stream === true) {
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
            id: 'chatcmpl-fake',
            object: 'chat.completion.chunk',
            created: 1_790_000_000,
            model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })
          response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: reply }, null))}\n\n`)
          response.write(`data: ${JSON.stringify({ ...chunk({}, 'stop'), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
          response.end('data: [DONE]\n\n')
          return
        }
        sendJson(response, 200, {
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          created: 1_790_000_000,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
        return
      }
      if (request.method === 'POST' && path === '/v1/messages') {
        sendJson(response, 200, {
          id: 'msg_fake',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: reply }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        })
        return
      }
      sendJson(response, 404, { error: { message: 'Not found' } })
    })().catch((error: unknown) => {
      sendJson(response, 500, { error: { message: error instanceof Error ? error.message : 'error' } })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

/** A 1x1 transparent PNG. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

/** An MCP manager that never connects anything (no process is spawned for stdio declarations in tests). */
export function createInertMcpManager(): McpManager {
  const unavailable = async (): Promise<never> => {
    throw new HarnessError({ code: 'not_implemented', message: 'The MCP manager is inert in this test.' })
  }
  return {
    start: async () => {},
    stop: async () => {},
    list: async () => [],
    get: unavailable,
    create: unavailable,
    update: unavailable,
    remove: unavailable,
    reconnect: unavailable,
  }
}
