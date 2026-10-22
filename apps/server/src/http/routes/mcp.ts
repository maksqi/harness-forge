// MCP server routes (API.md 5.13). Owner: W3.5 (W3.5-T2). Creating a stdio server, or changing a server's transport to
// a (different) stdio one, requires fresh auth (ADR-017): the route checks it up front for stdio creations and passes
// `requireFreshAuth` so the manager decides for updates (it knows the stored transport).
//
// Phase 14 (ADR-059, W14.1-T7 / T8): personal http / sse servers take `oauth { clientId?, scopes?, clientSecret? }` in
// their transport (validated by the shared schemas; the client secret is stored by `mcp/user-servers.ts` and answered
// only as a `SecretState`). The answers show a plugin server's `transport.oauth.clientId` with its `{{settings.x}}`
// placeholders filled from the plugin's non-secret settings (`presentMcpServer`; a secret setting is never shown).
import type { McpServer } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, mcpServerInputSchema, mcpServerParamsSchema, mcpServerUpdateSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { CORE_MCP_PLUGIN_ID } from '../../mcp/internal.ts'
import { displayDeclOAuthClientId } from '../../mcp/templating.ts'
import { freshAuthOptions, requireFreshAuth } from '../middleware/fresh-auth.ts'
import { validate } from '../validate.ts'

/** Plugin ids → their settings view, for one answer (several servers of one plugin read it once). */
type SettingsCache = Map<string, Promise<{ values: Record<string, unknown>, secrets: ReadonlySet<string> } | null>>

/**
 * The DTO as answered: a plugin server's OAuth client id with its placeholders filled from the plugin's non-secret
 * setting values (`displayDeclOAuthClientId`). Every other DTO is answered as built by the manager.
 */
export async function presentMcpServer(deps: AppDeps, server: McpServer, cache: SettingsCache = new Map()): Promise<McpServer> {
  if (server.editable || server.pluginId === CORE_MCP_PLUGIN_ID || server.transport.type === 'stdio')
    return server
  const oauth = server.transport.oauth
  if (oauth === null || oauth.clientId === null || !oauth.clientId.includes('{{'))
    return server
  let view = cache.get(server.pluginId)
  if (view === undefined) {
    view = deps.plugins.getSettings(server.pluginId)
      .then(settings => ({ values: settings.values, secrets: new Set(Object.keys(settings.secrets)) }))
      .catch(() => null)
    cache.set(server.pluginId, view)
  }
  const settings = await view
  const clientId = settings === null ? null : displayDeclOAuthClientId(oauth.clientId, settings.values, settings.secrets)
  return { ...server, transport: { ...server.transport, oauth: { ...oauth, clientId } } }
}

export function createMcpRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['mcp.list'].path, async (c) => {
    const cache: SettingsCache = new Map()
    const items = await deps.mcp.list()
    return c.json({ items: await Promise.all(items.map(server => presentMcpServer(deps, server, cache))) })
  })

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
    return c.json(await presentMcpServer(deps, await deps.mcp.reconnect(id)))
  })

  return app
}
