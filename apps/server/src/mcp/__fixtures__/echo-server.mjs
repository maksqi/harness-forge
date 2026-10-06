// Test fixture: a tiny MCP server built on `@modelcontextprotocol/sdk` (root dev dependency). Run as a script it serves
// the tools over stdio (spawned by the MCP manager tests); imported, `createEchoServer()` builds the same server for an
// in-test Streamable HTTP endpoint. No network access, deterministic answers.
//
// Tools: `echo` (read-only), `wipe` (destructive), `plain` (no annotations), `env` / `args` / `cwd` / `pid` (process
// introspection), `headers` (HTTP request headers), `fail` (isError result), `stderr` (writes a stderr line), `exit`
// (terminates the process), `dotted.name` (sanitized name) and a name longer than 64 characters (truncated name).
// Phase 11 (C38-T3): `env` without a `name` lists every variable name (sorted, never a value), so a `.mcp.json` probe
// can prove that no `HF_*` variable or provider key reaches a project server; `pid` reads the process id for the
// process-group checks. A dependency-free variant lives in `mcp-min.mjs`.
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

/** A tool name of 70 characters: registered as `mcp__<server>__...` truncated with a hash suffix. */
export const LONG_TOOL_NAME = `long_${'x'.repeat(65)}`

const EMPTY_OBJECT = { type: 'object', properties: {} }

export const ECHO_TOOLS = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Echoes the given text.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
  { name: 'wipe', description: 'Pretends to delete everything.', inputSchema: EMPTY_OBJECT, annotations: { destructiveHint: true } },
  { name: 'plain', description: 'A tool without annotations.', inputSchema: EMPTY_OBJECT },
  {
    name: 'env',
    description: 'Returns the value of an environment variable (or null); without a name, every variable name.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  { name: 'args', description: 'Returns the command line arguments.', inputSchema: EMPTY_OBJECT, annotations: { readOnlyHint: true } },
  { name: 'cwd', description: 'Returns the working directory.', inputSchema: EMPTY_OBJECT, annotations: { readOnlyHint: true } },
  { name: 'pid', description: 'Returns the process id.', inputSchema: EMPTY_OBJECT, annotations: { readOnlyHint: true } },
  { name: 'headers', description: 'Returns the HTTP request headers.', inputSchema: EMPTY_OBJECT, annotations: { readOnlyHint: true } },
  { name: 'fail', description: 'Always answers with an error result.', inputSchema: EMPTY_OBJECT },
  {
    name: 'stderr',
    description: 'Writes a line to stderr.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  { name: 'exit', description: 'Terminates the server process.', inputSchema: EMPTY_OBJECT },
  { name: 'dotted.name', description: 'A tool whose name contains a dot.', inputSchema: EMPTY_OBJECT },
  { name: LONG_TOOL_NAME, description: 'A tool with a very long name.', inputSchema: EMPTY_OBJECT },
]

function text(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }
}

/** The echo MCP server (not connected). */
export function createEchoServer(options = {}) {
  const server = new Server({ name: options.name ?? 'echo', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ECHO_TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = request.params.arguments ?? {}
    switch (request.params.name) {
      case 'echo':
        return text(String(args.text ?? ''))
      case 'wipe':
        return text('Nothing was deleted.')
      case 'plain':
        return text('plain')
      case 'env':
        if (typeof args.name !== 'string')
          return text({ names: Object.keys(process.env).sort() })
        return text({ value: process.env[args.name] ?? null })
      case 'args':
        return text({ args: process.argv.slice(2) })
      case 'cwd':
        return text({ cwd: process.cwd() })
      case 'pid':
        return text({ pid: process.pid })
      case 'headers':
        return text({ headers: extra.requestInfo?.headers ?? {} })
      case 'fail':
        return { content: [{ type: 'text', text: 'The echo server refused.' }], isError: true }
      case 'stderr':
        process.stderr.write(`${String(args.text ?? '')}\n`)
        return text('written')
      case 'exit':
        setTimeout(() => process.exit(3), 10)
        return text('exiting')
      case 'dotted.name':
        return text('dotted')
      case LONG_TOOL_NAME:
        return text('long')
      default:
        return { content: [{ type: 'text', text: `Unknown tool ${request.params.name}` }], isError: true }
    }
  })
  return server
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const server = createEchoServer({ name: process.env.ECHO_SERVER_NAME })
  server.connect(new StdioServerTransport()).catch(() => process.exit(1))
}
