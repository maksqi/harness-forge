// Test harness of the MCP tests: a test app with the real plugin host (only the builtins asked for), the MCP manager
// with short retry delays, a recording event bus, the echo MCP server fixture over stdio or an in-process Streamable
// HTTP endpoint on 127.0.0.1 (no other network access), and polling helpers. Phase 11 (C38-T3): the dependency-free
// stdio fixture `mcp-min.mjs` (and its grandchild `grandchild.mjs`) for the process-group checks and `.mcp.json` tests.
import type { ToolCallContext } from '@harness-forge/plugin-sdk'
import type { BuiltinPluginId } from '@harness-forge/shared'
import type { IncomingHttpHeaders, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { RecordingEventBus } from '../../testing/fakes.ts'
import type { McpManagerOptions } from '../index.ts'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { BUILTIN_PLUGINS } from '../../builtin-plugins/index.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createRecordingEventBus } from '../../testing/fakes.ts'
import { createMcpManagerCore } from '../index.ts'
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
}

export async function createMcpTestApp(options: McpTestAppOptions = {}): Promise<McpTestApp> {
  const events = createRecordingEventBus()
  const wanted = new Set<string>(options.builtins ?? ['core-mcp'])
  const t = await createTestApp({
    env: options.env,
    start: false,
    builtins: BUILTIN_PLUGINS.filter(plugin => wanted.has(plugin.id)),
    overrides: { events },
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

/** Executes a registered tool like the chat pipeline would (without guard and hooks). */
export async function callTool(t: TestApp, name: string, input: Record<string, unknown> = {}): Promise<unknown> {
  const tool = t.deps.registry.tools.get(name)
  if (!tool)
    throw new Error(`The tool "${name}" is not registered.`)
  return tool.definition.execute(input, toolContext())
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
