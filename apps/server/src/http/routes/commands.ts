// `GET /commands` (API.md 5.14). Owner: W2.1 (W2.1-T11). Server-side slash commands from the registry (active plugins
// only: a disabled plugin's registrations are disposed), sorted by name; client-only commands never appear.
import type { CommandSummary, ListResponse } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, isClientCommand } from '@harness-forge/shared'
import { Hono } from 'hono'

export function listCommands(deps: Pick<AppDeps, 'registry'>): CommandSummary[] {
  return deps.registry.commands
    .list()
    .filter(entry => !isClientCommand(entry.definition.name))
    .map(entry => ({ name: entry.definition.name, description: entry.definition.description, pluginId: entry.pluginId }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

export function createCommandsRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['commands.list'].path, (c) => {
    const body: ListResponse<CommandSummary> = { items: listCommands(deps) }
    return c.json(body)
  })
  return app
}
