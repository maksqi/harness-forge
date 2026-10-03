// `GET /commands` (API.md 5.14). Owner: W2.1 (W2.1-T11). Server-side slash commands from the registry (active plugins
// only: a disabled plugin's registrations are disposed), sorted by name; client-only commands never appear. Phase 9
// (C26, ADR-040): the harness command `compact` is listed too (`pluginId: 'core-agent'`); a registered command with a
// harness command name is left out (the server runs its own).
import type { CommandSummary, ListResponse } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, isClientCommand, isHarnessCommand } from '@harness-forge/shared'
import { Hono } from 'hono'
import { HARNESS_COMMAND_SUMMARIES } from '../../chat/commands.ts'

export function listCommands(deps: Pick<AppDeps, 'registry'>): CommandSummary[] {
  const registered = deps.registry.commands
    .list()
    .filter(entry => !isClientCommand(entry.definition.name) && !isHarnessCommand(entry.definition.name))
    .map(entry => ({ name: entry.definition.name, description: entry.definition.description, pluginId: entry.pluginId }))
  return [...HARNESS_COMMAND_SUMMARIES.map(summary => ({ ...summary })), ...registered]
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
