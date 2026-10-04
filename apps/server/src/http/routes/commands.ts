// `GET /commands` (API.md 5.14). Owner: W2.1 (W2.1-T11). Server-side slash commands from the registry (active plugins
// only: a disabled plugin's registrations are disposed), sorted by name; client-only commands never appear. Phase 9
// (C26, ADR-040): the harness command `compact` is listed too (`pluginId: 'core-agent'`); a registered command with a
// harness command name is left out (the server runs its own).
// Phase 10 (C31-T7, ADR-045): every item carries its `source` (`harness` for `/compact`, `plugin` with `pluginId` for
// plugin commands); the query `?projectId=` is validated (`commandsQuerySchema`) and an unknown project is `404`. The
// command files of the project and the personal commands (`source: 'project' | 'user'`, by the catalog's precedence)
// are listed by W10.2.
import type { CommandSummary, ListResponse } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, commandsQuerySchema, isClientCommand, isHarnessCommand } from '@harness-forge/shared'
import { Hono } from 'hono'
import { HARNESS_COMMAND_SUMMARIES } from '../../chat/commands.ts'
import { validate } from '../validate.ts'

/**
 * The effective server-side commands of a chat of `projectId` (null = no project), sorted by name. P10-0b: the harness
 * command and the plugin commands (the project's command files and the personal commands: W10.2).
 */
export function listCommands(deps: Pick<AppDeps, 'registry'>, projectId: string | null = null): CommandSummary[] {
  void projectId
  const registered = deps.registry.commands
    .list()
    .filter(entry => !isClientCommand(entry.definition.name) && !isHarnessCommand(entry.definition.name))
    .map((entry): CommandSummary => ({ name: entry.definition.name, description: entry.definition.description, source: 'plugin', pluginId: entry.pluginId }))
  return [...HARNESS_COMMAND_SUMMARIES.map(summary => ({ ...summary })), ...registered]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

export function createCommandsRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['commands.list'].path, validate('query', commandsQuerySchema), async (c) => {
    const { projectId } = c.req.valid('query')
    // An unknown project is `404 not_found` ("Project <id> not found.").
    if (projectId !== undefined)
      await deps.projects.get(projectId)
    const body: ListResponse<CommandSummary> = { items: listCommands(deps, projectId ?? null) }
    return c.json(body)
  })
  return app
}
