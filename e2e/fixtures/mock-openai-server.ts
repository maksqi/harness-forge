// Mock OpenAI-compatible HTTP server for the plugin e2e specs (W3.6-T1). A declarative provider created in a spec
// (wizard, zip, `POST /api/plugins`) points its `baseURL` at `<origin>/v1`; the harness server then talks to this
// process exactly as it would to a real OpenAI-compatible API:
//
//   GET  /v1/models            -> `{ object: 'list', data: [...] }` (the configured models)
//   POST /v1/chat/completions  -> a streamed (SSE) or plain chat completion, chosen from the request:
//     1. a title request (system message "You name chat conversations") -> the text `E2E chat`;
//     2. the last message is a tool result (role `tool`) -> the text `Tool result: <content>` (echoes it back);
//     3. the last user message contains `[[tool:<name> <json arguments>]]` -> a call of that tool when the request
//        offers it (arguments default to `{}`), else a text naming the offered tools;
//     4. anything else -> `Mock reply: <user text>` (a 1-token ping gets `pong`).
//   `[[slow]]` in the last user message streams one word every 200 ms (to observe the streaming state).
//
// Every request is recorded (`requests`) so specs can assert what the harness sent (auth header, tools, stream).
// With `apiKeys`, a request without `Authorization: Bearer <one of them>` gets an OpenAI-style 401.
// Runs inside the Playwright worker (`startMockOpenAI()` in `beforeAll`), or standalone for debugging:
// `node e2e/fixtures/mock-openai-server.ts [port]`.
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

/** Port of the mock in the W3.6 slot (docs/DECISIONS.md "Ports"); `E2E_MOCK_OPENAI_PORT` overrides it. */
export const DEFAULT_MOCK_OPENAI_PORT = 8894

/** One entry of `GET /v1/models`. */
export interface MockModel {
  id: string
  name?: string
  context_length?: number
}

export const DEFAULT_MOCK_MODELS: readonly MockModel[] = [
  { id: 'mock-gpt', name: 'Mock GPT', context_length: 32_000 },
  { id: 'mock-gpt-mini', name: 'Mock GPT mini', context_length: 16_000 },
]

export interface MockOpenAIOptions {
  /** Default: `E2E_MOCK_OPENAI_PORT`, else 8894; an ephemeral port when it stays busy for 5 s; 0 = ephemeral. */
  port?: number
  /** Default 127.0.0.1. */
  host?: string
  models?: readonly MockModel[]
  /** Accepted bearer keys; unset = no auth check. */
  apiKeys?: readonly string[]
  /** Delay between streamed chunks (default 10 ms). */
  chunkDelayMs?: number
}

export type RecordedKind = 'models' | 'chat' | 'title' | 'ping' | 'other'

export interface RecordedRequest {
  method: string
  path: string
  kind: RecordedKind
  /** The `Authorization` header, or null. */
  authorization: string | null
  /** Parsed JSON body of a chat completion, else null. */
  body: ChatCompletionRequest | null
  stream: boolean
  /** Names of the tools offered by the request. */
  toolNames: string[]
  /** What the mock answered: the text, or `tool:<name>` for a tool call, or `error:<status>`. */
  reply: string
}

export interface MockOpenAIServer {
  port: number
  /** `http://127.0.0.1:<port>` */
  origin: string
  /** `http://127.0.0.1:<port>/v1`, the `baseURL` of a provider. */
  baseURL: string
  readonly requests: RecordedRequest[]
  /** Recorded chat completions (title requests and pings excluded). */
  chatRequests: () => RecordedRequest[]
  /** Forgets the recorded requests. */
  reset: () => void
  close: () => Promise<void>
}

interface ChatMessage {
  role: string
  content?: unknown
  tool_call_id?: string
  tool_calls?: unknown
}

interface ChatTool {
  type?: string
  function?: { name?: string }
}

export interface ChatCompletionRequest {
  model?: string
  messages?: ChatMessage[]
  tools?: ChatTool[]
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  max_tokens?: number
  max_completion_tokens?: number
}

type Reply
  = | { type: 'text', text: string, slow: boolean }
    | { type: 'tool', name: string, args: string }

const TITLE_MARKER = 'You name chat conversations'
const TOOL_DIRECTIVE = /\[\[tool:([\w-]{1,64})(?:\s+(\{[\s\S]*?\}))?\]\]/
const SLOW_DIRECTIVE = '[[slow]]'
const SLOW_CHUNK_DELAY_MS = 200

/** Plain text of an OpenAI message `content` (a string or an array of parts). */
export function contentText(content: unknown): string {
  if (typeof content === 'string')
    return content
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('')
  }
  return ''
}

function toolNamesOf(body: ChatCompletionRequest): string[] {
  return (body.tools ?? []).map(tool => tool.function?.name).filter((name): name is string => typeof name === 'string')
}

function isTitleRequest(body: ChatCompletionRequest): boolean {
  return (body.messages ?? []).some(message => (message.role === 'system' || message.role === 'developer') && contentText(message.content).includes(TITLE_MARKER))
}

function isPing(body: ChatCompletionRequest): boolean {
  return body.max_tokens === 1 || body.max_completion_tokens === 1
}

/** The answer to a chat completion request (see the header). */
export function planReply(body: ChatCompletionRequest): Reply {
  const messages = body.messages ?? []
  if (isTitleRequest(body))
    return { type: 'text', text: 'E2E chat', slow: false }
  const last = messages.at(-1)
  if (last?.role === 'tool')
    return { type: 'text', text: `Tool result: ${contentText(last.content)}`, slow: false }
  const userText = contentText([...messages].reverse().find(message => message.role === 'user')?.content)
  const directive = userText.match(TOOL_DIRECTIVE)
  if (directive) {
    const name = directive[1] ?? ''
    const offered = toolNamesOf(body)
    if (!offered.includes(name))
      return { type: 'text', text: `The tool ${name} was not offered. Offered tools: ${offered.join(', ') || 'none'}.`, slow: false }
    return { type: 'tool', name, args: directive[2] ?? '{}' }
  }
  if (isPing(body))
    return { type: 'text', text: 'pong', slow: false }
  const slow = userText.includes(SLOW_DIRECTIVE)
  const text = userText.replace(SLOW_DIRECTIVE, '').replace(/\s+/g, ' ').trim()
  return { type: 'text', text: `Mock reply: ${text}`, slow }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

function openAIError(response: ServerResponse, status: number, message: string, code: string): void {
  sendJson(response, status, { error: { message, type: 'invalid_request_error', param: null, code } })
}

/** Word-sized pieces of a text (keeps the spaces), so a reply streams as several deltas. */
function pieces(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [text]
}

let completionCounter = 0

function usageOf(body: ChatCompletionRequest, completion: string) {
  const prompt = (body.messages ?? []).reduce((sum, message) => sum + Math.ceil(contentText(message.content).length / 4), 0)
  const output = Math.max(1, Math.ceil(completion.length / 4))
  return { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output }
}

async function streamReply(response: ServerResponse, body: ChatCompletionRequest, reply: Reply, chunkDelayMs: number): Promise<void> {
  completionCounter += 1
  const id = `chatcmpl-e2e-${completionCounter}`
  const created = Math.floor(Date.now() / 1000)
  const model = body.model ?? 'mock-gpt'
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' })
  const send = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`)
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })

  chunk({ role: 'assistant', content: '' })
  let completion = ''
  if (reply.type === 'text') {
    for (const piece of pieces(reply.text)) {
      await delay(reply.slow ? SLOW_CHUNK_DELAY_MS : chunkDelayMs)
      completion += piece
      chunk({ content: piece })
    }
    chunk({}, 'stop')
  }
  else {
    const callId = `call_e2e_${completionCounter}`
    chunk({ tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: reply.name, arguments: '' } }] })
    const half = Math.ceil(reply.args.length / 2)
    for (const part of [reply.args.slice(0, half), reply.args.slice(half)]) {
      await delay(chunkDelayMs)
      chunk({ tool_calls: [{ index: 0, function: { arguments: part } }] })
    }
    completion = reply.args
    chunk({}, 'tool_calls')
  }
  if (body.stream_options?.include_usage)
    send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageOf(body, completion) })
  response.write('data: [DONE]\n\n')
  response.end()
}

function completeReply(response: ServerResponse, body: ChatCompletionRequest, reply: Reply): void {
  completionCounter += 1
  const message = reply.type === 'text'
    ? { role: 'assistant', content: reply.text }
    : { role: 'assistant', content: null, tool_calls: [{ id: `call_e2e_${completionCounter}`, type: 'function', function: { name: reply.name, arguments: reply.args } }] }
  sendJson(response, 200, {
    id: `chatcmpl-e2e-${completionCounter}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model ?? 'mock-gpt',
    choices: [{ index: 0, message, finish_reason: reply.type === 'text' ? 'stop' : 'tool_calls' }],
    usage: usageOf(body, reply.type === 'text' ? reply.text : reply.args),
  })
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    function onError(error: Error): void {
      server.off('listening', onListening)
      reject(error)
    }
    function onListening(): void {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/** Listens on `port`, retrying while it is busy (a previous worker may still be closing it), then on any free port. */
async function listenWithRetry(server: Server, port: number, host: string): Promise<number> {
  const deadline = Date.now() + 5000
  let target = port
  for (;;) {
    try {
      await listen(server, target, host)
      return (server.address() as AddressInfo).port
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || target === 0)
        throw error
      if (Date.now() > deadline)
        target = 0
      else
        await delay(250)
    }
  }
}

function configuredPort(): number {
  const raw = process.env.E2E_MOCK_OPENAI_PORT
  const parsed = raw === undefined || raw === '' ? Number.NaN : Number(raw)
  return Number.isInteger(parsed) && parsed >= 0 && parsed < 65536 ? parsed : DEFAULT_MOCK_OPENAI_PORT
}

/** Starts the mock (see the header). Close it in `afterAll`. */
export async function startMockOpenAI(options: MockOpenAIOptions = {}): Promise<MockOpenAIServer> {
  const host = options.host ?? '127.0.0.1'
  const models = options.models ?? DEFAULT_MOCK_MODELS
  const chunkDelayMs = options.chunkDelayMs ?? 10
  const requests: RecordedRequest[] = []

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://mock.invalid')
      const path = url.pathname.replace(/\/+$/, '')
      const record: RecordedRequest = {
        method: request.method ?? 'GET',
        path,
        kind: 'other',
        authorization: request.headers.authorization ?? null,
        body: null,
        stream: false,
        toolNames: [],
        reply: '',
      }
      requests.push(record)
      const raw = await readBody(request)

      if (options.apiKeys && !options.apiKeys.some(key => record.authorization === `Bearer ${key}`)) {
        record.reply = 'error:401'
        openAIError(response, 401, 'Incorrect API key provided.', 'invalid_api_key')
        return
      }
      if (record.method === 'GET' && path === '/v1/models') {
        record.kind = 'models'
        sendJson(response, 200, { object: 'list', data: models.map(model => ({ object: 'model', owned_by: 'e2e', created: 0, ...model })) })
        return
      }
      if (record.method === 'POST' && path === '/v1/chat/completions') {
        let body: ChatCompletionRequest
        try {
          body = JSON.parse(raw) as ChatCompletionRequest
        }
        catch {
          record.reply = 'error:400'
          openAIError(response, 400, 'The request body is not valid JSON.', 'invalid_json')
          return
        }
        record.body = body
        record.stream = body.stream === true
        record.toolNames = toolNamesOf(body)
        record.kind = isTitleRequest(body) ? 'title' : isPing(body) ? 'ping' : 'chat'
        const reply = planReply(body)
        record.reply = reply.type === 'text' ? reply.text : `tool:${reply.name}`
        if (record.stream)
          await streamReply(response, body, reply, chunkDelayMs)
        else
          completeReply(response, body, reply)
        return
      }
      record.reply = 'error:404'
      openAIError(response, 404, `Unknown route ${record.method} ${path}.`, 'not_found')
    })().catch((error: unknown) => {
      if (!response.headersSent)
        openAIError(response, 500, error instanceof Error ? error.message : 'Mock failure.', 'mock_error')
      else
        response.destroy()
    })
  })

  const port = await listenWithRetry(server, options.port ?? configuredPort(), host)
  const origin = `http://${host}:${port}`
  return {
    port,
    origin,
    baseURL: `${origin}/v1`,
    requests,
    chatRequests: () => requests.filter(request => request.kind === 'chat'),
    reset: () => {
      requests.length = 0
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

// Standalone: `node e2e/fixtures/mock-openai-server.ts [port]` (Node strips the types).
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const port = process.argv[2] === undefined ? undefined : Number(process.argv[2])
  void startMockOpenAI(port === undefined ? {} : { port }).then((mock) => {
    process.stdout.write(`mock OpenAI server on ${mock.baseURL}\n`)
  })
}
