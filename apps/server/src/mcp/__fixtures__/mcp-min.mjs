// Test fixture (Phase 11, C38-T3; FROZEN after Gate P11-0b): a dependency-free stdio MCP server (Node built-ins only, no
// `@modelcontextprotocol/sdk`, so it also runs from a copied folder or in the Docker image). Newline-delimited JSON-RPC
// 2.0 over stdin / stdout: `initialize` (echoes the client's protocol version), `ping`, `tools/list` and `tools/call`
// for its three tools; notifications get no answer; any other request gets a -32601 error. It exits when stdin closes.
// Modeled on the upgrade seed's `.tmp/gates/P11-0b/mcp-min.mjs` (K3S).
//
// Tools: `echo` `{ text }` -> `<name> echo: <text>`; `pid` -> `{"pid":<pid>,"grandchild":<pid>|null}`; `env`
// `{ name? }` -> `{"value":<value>|null}`, or without a name `{"names":[<every variable name, sorted>]}` (names only, never
// values).
//
// Arguments (all optional):
//   --name <name>     the serverInfo name and the echo prefix (default `mcp-min`)
//   --marker          write `.mcp-started-<pid>` (one JSON line: pid, name, start time, args, whether `TOKEN` is set,
//                     never its value) into the working folder, so a probe can prove it never started before approval
//   --grandchild      start `grandchild.mjs` (a long-lived process with no stdio) in the server's own process group
//   --pid-file <path> append "<pid> <grandchild pid>" (or just "<pid>") to <path> at start
//   --fail-init       answer `initialize` with a JSON-RPC error (a failed start)
//   --exit-on-init    exit with code 1 on `initialize` (a crashed start; the grandchild is left behind)
//   --ignore-term     ignore SIGTERM (the grandchild too), so only SIGKILL stops them
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const flag = key => args.includes(key)
function option(key) {
  const index = args.indexOf(key)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined
}

const name = option('--name') ?? 'mcp-min'
const ignoreTerm = flag('--ignore-term')
if (ignoreTerm)
  process.on('SIGTERM', () => {})

let grandchild = null
if (flag('--grandchild')) {
  const script = fileURLToPath(new URL('./grandchild.mjs', import.meta.url))
  // Not detached: the grandchild stays in this server's process group (the transport stops the whole group).
  const child = spawn(process.execPath, [script, ...(ignoreTerm ? ['--ignore-term'] : [])], { stdio: 'ignore' })
  child.on('error', () => {})
  grandchild = child.pid ?? null
}

const pidFile = option('--pid-file')
if (pidFile !== undefined)
  appendFileSync(pidFile, `${grandchild === null ? process.pid : `${process.pid} ${grandchild}`}\n`)

if (flag('--marker')) {
  try {
    const marker = { pid: process.pid, name, startedAt: new Date().toISOString(), args, token: process.env.TOKEN ? 'set' : 'unset' }
    writeFileSync(join(process.cwd(), `.mcp-started-${process.pid}`), `${JSON.stringify(marker)}\n`)
  }
  catch {
    // A read-only working folder must not stop the server.
  }
}

const EMPTY_OBJECT = { type: 'object', properties: {}, additionalProperties: false }
const TOOLS = [
  {
    name: 'echo',
    description: 'Echoes the given text back.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The text to echo.' } },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  { name: 'pid', description: 'Returns the process id of the server (and of its grandchild).', inputSchema: EMPTY_OBJECT, annotations: { readOnlyHint: true } },
  {
    name: 'env',
    description: 'Returns the value of an environment variable, or every variable name without a name.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
]

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })
const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], isError: false })

function callTool(id, params) {
  const input = params?.arguments ?? {}
  switch (params?.name) {
    case 'echo':
      return reply(id, text(`${name} echo: ${typeof input.text === 'string' ? input.text : ''}`))
    case 'pid':
      return reply(id, text({ pid: process.pid, grandchild }))
    case 'env':
      if (typeof input.name === 'string')
        return reply(id, text({ value: process.env[input.name] ?? null }))
      return reply(id, text({ names: Object.keys(process.env).sort() }))
    default:
      return fail(id, -32602, `Unknown tool: ${String(params?.name)}`)
  }
}

function handle(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message))
    return fail(null, -32600, 'Invalid request')
  const { id, method, params } = message
  // Notifications (no id) never get an answer.
  if (id === undefined || id === null)
    return
  switch (method) {
    case 'initialize':
      if (flag('--exit-on-init'))
        process.exit(1)
      if (flag('--fail-init'))
        return fail(id, -32603, 'The fixture refuses to initialize.')
      return reply(id, {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name, version: '1.0.0' },
      })
    case 'ping':
      return reply(id, {})
    case 'tools/list':
      return reply(id, { tools: TOOLS })
    case 'tools/call':
      return callTool(id, params)
    default:
      return fail(id, -32601, `Method not found: ${String(method)}`)
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  if (!line.trim())
    return
  let message
  try {
    message = JSON.parse(line)
  }
  catch {
    fail(null, -32700, 'Parse error')
    return
  }
  handle(message)
})
lines.on('close', () => process.exit(0))
process.stderr.write(`${name} ready\n`)
