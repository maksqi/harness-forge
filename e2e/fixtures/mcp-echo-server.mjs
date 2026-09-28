// stdio MCP echo server for the plugin e2e specs (W3.6-T1), built on `@modelcontextprotocol/sdk` (root dev
// dependency). The MCP panel spec registers it as a stdio server (`node <this file>`); the harness spawns it without a
// shell and talks newline-delimited JSON-RPC over stdin/stdout. Deterministic, no network access.
//
// Tools (registered by the harness as `mcp__<serverId>__<tool>`):
//   echo    - read-only (policy safe): returns the given text unchanged
//   reverse - no annotations (the server's policy applies): returns the text reversed
import process from 'node:process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const TEXT_INPUT = {
  type: 'object',
  properties: { text: { type: 'string', description: 'The text to send back' } },
  required: ['text'],
}

export const ECHO_TOOLS = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Echoes the given text back unchanged.',
    inputSchema: TEXT_INPUT,
    annotations: { readOnlyHint: true },
  },
  {
    name: 'reverse',
    description: 'Returns the given text reversed.',
    inputSchema: TEXT_INPUT,
  },
]

function textResult(text) {
  return { content: [{ type: 'text', text }] }
}

const server = new Server({ name: 'e2e-echo', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ECHO_TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const text = String(request.params.arguments?.text ?? '')
  switch (request.params.name) {
    case 'echo':
      return textResult(text)
    case 'reverse':
      return textResult([...text].reverse().join(''))
    default:
      return { content: [{ type: 'text', text: `Unknown tool ${request.params.name}` }], isError: true }
  }
})

server.connect(new StdioServerTransport()).catch((error) => {
  process.stderr.write(`e2e echo server failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
