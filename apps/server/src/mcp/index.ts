// Phase 0 stub. Owner: W3.5 (W3.5-T1, T2). Implement `McpManager` (./types.ts) and keep the export name and
// signature: `createMcpManager(deps: AppDeps): McpManager`. `start` / `stop` are no-ops until then.
import type { AppDeps } from '../types.ts'
import type { McpManager } from './types.ts'
import { noopAsync, rejectsNotImplemented } from '../not-implemented.ts'

export function createMcpManager(_deps: AppDeps): McpManager {
  return {
    start: noopAsync,
    stop: noopAsync,
    list: rejectsNotImplemented('mcp.list'),
    get: rejectsNotImplemented('mcp.get'),
    create: rejectsNotImplemented('mcp.create'),
    update: rejectsNotImplemented('mcp.update'),
    remove: rejectsNotImplemented('mcp.remove'),
    reconnect: rejectsNotImplemented('mcp.reconnect'),
  }
}
