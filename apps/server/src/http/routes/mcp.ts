// MCP server routes (API.md 5.13). Owner: W3.5 (W3.5-T2). Creating a stdio server, or changing a server's transport to
// a (different) stdio one, requires fresh auth (ADR-017): the route checks it up front for stdio creations and passes
// `requireFreshAuth` so the manager decides for updates (it knows the stored transport).
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, mcpServerInputSchema, mcpServerParamsSchema, mcpServerUpdateSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { freshAuthOptions, requireFreshAuth } from '../middleware/fresh-auth.ts'
import { validate } from '../validate.ts'

export function createMcpRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['mcp.list'].path, async c => c.json({ items: await deps.mcp.list() }))

  app.post(apiRoutes['mcp.create'].path, validate('json', mcpServerInputSchema), async (c) => {
    const input = c.req.valid('json')
    if (input.transport.type === 'stdio')
      requireFreshAuth(c)
    return c.json(await deps.mcp.create(input, freshAuthOptions(c)), 201)
  })

  app.patch(apiRoutes['mcp.update'].path, validate('param', mcpServerParamsSchema), validate('json', mcpServerUpdateSchema), async (c) => {
    const { id } = c.req.valid('param')
    return c.json(await deps.mcp.update(id, c.req.valid('json'), freshAuthOptions(c)))
  })

  app.delete(apiRoutes['mcp.remove'].path, validate('param', mcpServerParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    await deps.mcp.remove(id)
    return c.body(null, 204)
  })

  app.post(apiRoutes['mcp.reconnect'].path, validate('param', mcpServerParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    return c.json(await deps.mcp.reconnect(id))
  })

  return app
}
