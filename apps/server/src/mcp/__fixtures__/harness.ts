// Test harness of the MCP tests: a test app with the real plugin host (only the builtins asked for), the MCP manager
// with short retry delays, a recording event bus, the echo MCP server fixture over stdio or an in-process Streamable
// HTTP endpoint on 127.0.0.1 (no other network access), and polling helpers. Phase 11 (C38-T3): the dependency-free
// stdio fixture `mcp-min.mjs` (and its grandchild `grandchild.mjs`) for the process-group checks and `.mcp.json` tests.
// Phase 14 (C51-T7; FROZEN after P14-0b): MCP tools are async generators (`mcp-tools.ts`), so `callTool` drains the
// iteration and answers the final output; `callToolRun` / `runToolExecute` also answer the preliminary outputs (the
// elicitation card's `McpToolProgress`); `createMcpTestApp({ overrides })` installs fakes (`mcpAuth`, `elicitations`).
import type { ToolCallContext } from '@harness-forge/plugin-sdk'
import type { BuiltinPluginId } from '@harness-forge/shared'
import type { IncomingHttpHeaders, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { TestApp, TestAppOptions } from '../../testing/create-test-app.ts'
import type { RecordingEventBus } from '../../testing/fakes.ts'
import type { McpManagerOptions } from '../index.ts'
import type { McpPromptCache } from '../prompts.ts'
import type { McpResourceCache } from '../resources.ts'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Server as McpSdkServer } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { BUILTIN_PLUGINS } from '../../builtin-plugins/index.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createRecordingEventBus } from '../../testing/fakes.ts'
import { createMcpManagerCore } from '../index.ts'
import { createPromptCache } from '../prompts.ts'
import { createResourceCache } from '../resources.ts'
import { createEchoServer } from './echo-server.mjs'

export { LONG_TOOL_NAME } from './echo-server.mjs'

/** Absolute path of the echo MCP server script. */
export const ECHO_SERVER_PATH = fileURLToPath(new URL('./echo-server.mjs', import.meta.url))

/** A stdio transport input that runs the echo server with the current Node binary. */
export function echoStdio(args: string[] = [], env?: Record<string, string>) {
  return { type: 'stdio' as const, command: process.execPath, args: [ECHO_SERVER_PATH, ...args], ...(env ? { env } : {}) }
}

/** Absolute path of the dependency-free stdio MCP server (Phase 11, `mcp-min.mjs`). */
export const MCP_MIN_PATH = fileURLToPath(new URL('./mcp-min.mjs', import.meta.url))

/** Absolute path of the grandchild fixture that `mcp-min.mjs --grandchild` starts. */
export const GRANDCHILD_PATH = fileURLToPath(new URL('./grandchild.mjs', import.meta.url))

/** A stdio transport input that runs `mcp-min.mjs` with the current Node binary (arguments: see the fixture). */
export function mcpMinStdio(args: string[] = [], env?: Record<string, string>) {
  return { type: 'stdio' as const, command: process.execPath, args: [MCP_MIN_PATH, ...args], ...(env ? { env } : {}) }
}

/** Polls a `--pid-file` of `mcp-min.mjs` until it holds a line: the server's pid and its grandchild's (if any). */
export async function readMcpPids(path: string, timeoutMs = 10_000): Promise<{ pid: number, grandchild: number | null }> {
  return waitFor(async () => {
    const line = (await readFile(path, 'utf8').catch(() => '')).split('\n').find(entry => entry.trim() !== '')
    if (line === undefined)
      return null
    const [pid, grandchild] = line.trim().split(/\s+/).map(word => Number.parseInt(word, 10))
    return pid !== undefined && pid > 0 ? { pid, grandchild: grandchild !== undefined && grandchild > 0 ? grandchild : null } : null
  }, timeoutMs)
}

export interface McpTestApp {
  t: TestApp
  events: RecordingEventBus
  close: () => Promise<void>
}

export interface McpTestAppOptions {
  /** Builtins to load (default only `core-mcp`). */
  builtins?: BuiltinPluginId[]
  env?: Record<string, string | undefined>
  manager?: McpManagerOptions
  /** Runs after the app exists and before the plugin host and the MCP manager start (install fixture plugins here). */
  beforeStart?: (t: TestApp) => Promise<void>
  /** Start the MCP manager (default true). */
  startMcp?: boolean
  /** Phase 14: services to replace (e.g. `{ mcpAuth, elicitations }` fakes); the recording event bus is always set. */
  overrides?: Omit<NonNullable<TestAppOptions['overrides']>, 'events'>
}

export async function createMcpTestApp(options: McpTestAppOptions = {}): Promise<McpTestApp> {
  const events = createRecordingEventBus()
  const wanted = new Set<string>(options.builtins ?? ['core-mcp'])
  const t = await createTestApp({
    env: options.env,
    start: false,
    builtins: BUILTIN_PLUGINS.filter(plugin => wanted.has(plugin.id)),
    overrides: { ...options.overrides, events },
    factories: {
      mcp: deps => createMcpManagerCore(deps, { retryDelaysMs: [50, 100, 200], eventDelayMs: 5, killGraceMs: 1000, ...options.manager }),
    },
  })
  try {
    await options.beforeStart?.(t)
    await t.deps.plugins.start()
    if (options.startMcp ?? true)
      await t.deps.mcp.start()
  }
  catch (error) {
    await t.close()
    throw error
  }
  return { t, events, close: () => t.close() }
}

export function toolContext(signal: AbortSignal = new AbortController().signal): ToolCallContext {
  return { chatId: '0199a8f0-0000-7000-8000-000000000001', modelRef: 'mock:echo', toolCallId: 'call_1', messages: [], signal }
}

/** What one tool call produced: the preliminary outputs (in order) and the final output (the last value). */
export interface ToolRun {
  preliminary: unknown[]
  output: unknown
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value
}

/**
 * Runs the result of a tool's `execute` to its end: an async iterable (an async generator `execute`, plugin API 1.3.0)
 * is drained (every value but the last is a preliminary output, the last one the final output); anything else is
 * awaited (no preliminary output). A throw of the iteration rejects.
 */
export async function runToolExecute(result: unknown): Promise<ToolRun> {
  if (!isAsyncIterable(result))
    return { preliminary: [], output: await result }
  const values: unknown[] = []
  for await (const value of result)
    values.push(value)
  return { preliminary: values.slice(0, -1), output: values.at(-1) }
}

/** Executes a registered tool like the chat pipeline would (without guard and hooks) and answers its final output. */
export async function callTool(t: TestApp, name: string, input: Record<string, unknown> = {}, c: ToolCallContext = toolContext()): Promise<unknown> {
  return (await callToolRun(t, name, input, c)).output
}

/** `callTool` with the preliminary outputs. */
export async function callToolRun(t: TestApp, name: string, input: Record<string, unknown> = {}, c: ToolCallContext = toolContext()): Promise<ToolRun> {
  const tool = t.deps.registry.tools.get(name)
  if (!tool)
    throw new Error(`The tool "${name}" is not registered.`)
  return runToolExecute(tool.definition.execute(input, c))
}

/** The text of the first content part of an MCP tool output. */
export function outputText(output: unknown): string {
  const content = (output as { content?: Array<{ type: string, text?: string }> }).content
  const part = content?.find(item => item.type === 'text')
  if (part?.text === undefined)
    throw new Error(`No text content in ${JSON.stringify(output)}`)
  return part.text
}

export function outputJson<T>(output: unknown): T {
  return JSON.parse(outputText(output)) as T
}

/** Polls `predicate` until it returns a truthy value; fails after `timeoutMs`. */
export async function waitFor<T>(predicate: () => T | Promise<T>, timeoutMs = 10_000, intervalMs = 20): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    try {
      const value = await predicate()
      if (value)
        return value as NonNullable<T>
    }
    catch (error) {
      last = error
    }
    if (Date.now() > deadline)
      throw new Error(`waitFor timed out after ${timeoutMs} ms${last instanceof Error ? `: ${last.message}` : ''}`)
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

/** True while a process with this id exists. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface HttpEchoServer {
  url: string
  /** Headers of every request received. */
  requests: IncomingHttpHeaders[]
  close: () => Promise<void>
}

/** The echo MCP server over stateless Streamable HTTP (JSON responses) at `http://127.0.0.1:<port>/mcp`. */
export async function startHttpEchoServer(): Promise<HttpEchoServer> {
  const requests: IncomingHttpHeaders[] = []
  const server: Server = createServer((req, res) => {
    requests.push(req.headers)
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(405, { allow: 'POST' }).end()
      return
    }
    const mcp = createEchoServer({ name: 'http-echo' })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void mcp.close()
    })
    mcp.connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => {
        if (!res.headersSent)
          res.writeHead(500).end()
      })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

/** The echo MCP server over the legacy HTTP+SSE transport: `GET /sse` stream, `POST /messages?sessionId=` requests. */
export async function startSseEchoServer(): Promise<HttpEchoServer> {
  const requests: IncomingHttpHeaders[] = []
  const sessions = new Map<string, SSEServerTransport>()
  const server: Server = createServer((req, res) => {
    requests.push(req.headers)
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/messages', res)
      sessions.set(transport.sessionId, transport)
      const mcp = createEchoServer({ name: 'sse-echo' })
      res.on('close', () => {
        sessions.delete(transport.sessionId)
        void mcp.close()
      })
      mcp.connect(transport).catch(() => res.end())
      return
    }
    const transport = sessions.get(url.searchParams.get('sessionId') ?? '')
    if (req.method === 'POST' && url.pathname === '/messages' && transport) {
      transport.handlePostMessage(req, res).catch(() => {
        if (!res.headersSent)
          res.writeHead(500).end()
      })
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/sse`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

export interface StatusServer {
  url: string
  /** JSON-RPC methods of the POSTs received (`server/discover`, `initialize`, ...). */
  methods: string[]
  /** Every request path (OAuth discovery included). */
  paths: string[]
  close: () => Promise<void>
}

/** Phase 14: a loopback endpoint that answers every request with `status` (401: no OAuth metadata at all). */
export async function startStatusServer(status: number): Promise<StatusServer> {
  const methods: string[] = []
  const paths: string[] = []
  const server = createServer((req, res) => {
    paths.push(req.url ?? '')
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
    })
    req.on('end', () => {
      if (req.method === 'POST') {
        try {
          methods.push(String((JSON.parse(body) as { method?: unknown }).method))
        }
        catch {}
      }
      res.writeHead(status, { 'content-type': 'text/plain' }).end(status === 401 ? 'unauthorized secret-body-text' : 'failure')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    methods,
    paths,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

/**
 * Phase 14: a stateful Streamable HTTP MCP server (SSE answers, `@modelcontextprotocol/sdk`) whose tool `ask` elicits a
 * name and answers the `ElicitResult` as JSON text; it advertises prompts and resources (both lists empty).
 */
export async function startElicitServer(): Promise<{ url: string, close: () => Promise<void> }> {
  const transports = new Map<string, StreamableHTTPServerTransport>()
  const servers: McpSdkServer[] = []
  const http = createServer((req, res) => {
    const id = req.headers['mcp-session-id']
    let transport = typeof id === 'string' ? transports.get(id) : undefined
    const run = async (): Promise<void> => {
      if (transport === undefined) {
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sessionId) => {
            transports.set(sessionId, created)
          },
        })
        const mcp = new McpSdkServer({ name: 'elicit', version: '1.0.0' }, { capabilities: { tools: {}, prompts: {}, resources: {} } })
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'ask', description: 'Asks for a name.', inputSchema: { type: 'object', properties: {} } }] }))
        mcp.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }))
        mcp.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }))
        mcp.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
          const answer = await mcp.elicitInput(
            { message: 'Your name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
            { relatedRequestId: extra.requestId },
          )
          return { content: [{ type: 'text', text: JSON.stringify(answer) }] }
        })
        servers.push(mcp)
        await mcp.connect(created)
        transport = created
      }
      await transport.handleRequest(req, res)
    }
    run().catch(() => {
      if (!res.headersSent)
        res.writeHead(500).end()
    })
  })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      await Promise.allSettled(servers.map(server => server.close()))
      await new Promise<void>((resolve) => {
        http.closeAllConnections()
        http.close(() => resolve())
      })
    },
  }
}

/** Phase 14: cache factories (manager options) whose `refresh` calls are recorded (the C51 stubs underneath). */
export function spyMcpCaches() {
  const refreshed: Array<{ kind: 'prompts' | 'resources', key: string, serverName: string, projectId: string | null }> = []
  const prompts = (options: Parameters<typeof createPromptCache>[0]): McpPromptCache => {
    const cache = createPromptCache(options)
    return { ...cache, refresh: async (server, client, signal) => {
      refreshed.push({ kind: 'prompts', key: server.key, serverName: server.serverName, projectId: server.projectId })
      return cache.refresh(server, client, signal)
    } }
  }
  const resources = (options: Parameters<typeof createResourceCache>[0]): McpResourceCache => {
    const cache = createResourceCache(options)
    return { ...cache, refresh: async (server, client, signal) => {
      refreshed.push({ kind: 'resources', key: server.key, serverName: server.serverName, projectId: server.projectId })
      return cache.refresh(server, client, signal)
    } }
  }
  return { refreshed, prompts, resources }
}
