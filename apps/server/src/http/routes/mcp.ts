// MCP server routes (API.md 5.13) - Phase 0 stubs (501). Owner: W3.5 (W3.5-T2). Keep the export name
// `createMcpRoutes`. Creating a stdio server or switching one to stdio requires fresh auth (`requireFreshAuth`).
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, mcpServerInputSchema, mcpServerParamsSchema, mcpServerUpdateSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createMcpRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['mcp.list'].path, notImplemented('mcp.list'))
  app.post(apiRoutes['mcp.create'].path, validate('json', mcpServerInputSchema), notImplemented('mcp.create'))
  app.patch(apiRoutes['mcp.update'].path, validate('param', mcpServerParamsSchema), validate('json', mcpServerUpdateSchema), notImplemented('mcp.update'))
  app.delete(apiRoutes['mcp.remove'].path, validate('param', mcpServerParamsSchema), notImplemented('mcp.remove'))
  app.post(apiRoutes['mcp.reconnect'].path, validate('param', mcpServerParamsSchema), notImplemented('mcp.reconnect'))
  return app
}
