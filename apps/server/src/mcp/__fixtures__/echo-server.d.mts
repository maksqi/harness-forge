// Types of the echo MCP server fixture (`echo-server.mjs`).
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'

export interface EchoToolFixture {
  name: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean, destructiveHint?: boolean }
}

export declare const LONG_TOOL_NAME: string
export declare const ECHO_TOOLS: readonly EchoToolFixture[]
export declare function createEchoServer(options?: { name?: string }): Server
