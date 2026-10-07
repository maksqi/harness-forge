// `GET /commands` (API.md 5.14). Owner: W2.1 (W2.1-T11). Server-side slash commands from the registry (active plugins
// only: a disabled plugin's registrations are disposed), sorted by name; client-only commands never appear. Phase 9
// (C26, ADR-040): the harness command `compact` is listed too (`pluginId: 'core-agent'`); a registered command with a
// harness command name is left out (the server runs its own).
// Phase 10 (ADR-045, ARCHITECTURE.md 6.24): every item carries its `source` (`harness` for `/compact`, `plugin` with
// `pluginId` for plugin commands, `user` for personal commands, `project` for command files); the query `?projectId=`
// is validated (`commandsQuerySchema`; an unknown project is `404`) and adds that project's command files. The list is
// the catalog's effective commands (`listServerCommands`): a project command over a personal one over a plugin one,
// so a plugin command shadowed by a project command is shadowed only in that project's list; without `projectId` only
// the global entries (personal and plugin commands). Command files carry `namespace`, `argumentHint` and `modelRef`
// when they declare them. An unavailable project folder lists no project commands (the catalog reports it).
// Phase 11 (C37-T9, W11.5, ADR-052): every item carries `kind`: `command` for the entries above, `skill` for the scope's
// active user-invocable skills (`argumentHint`, `pluginId` of a plugin skill; names up to 64 characters), listed after
// the commands own their names (a command wins a name over a skill).
// Phase 12 (ADR-053 / ADR-058; W12.7): the names of Claude Code plugin entries are qualified (`review-kit:review`,
// `review-kit:db:migrate`) and listed as they are (a bare alias is not an item); plugin commands carry their
// `argumentHint` and model ref; a definition's `when_to_use` is appended to its description (`<description> - <when>`).
import type { CommandSummary, ListResponse } from '@harness-forge/shared'
import type { CustomizationCatalog } from '../../services/customizations/types.ts'
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, commandsQuerySchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { listServerCommands } from '../../chat/commands.ts'
import { validate } from '../validate.ts'

/**
 * The effective server-side commands of a scope, sorted by name: `/compact`, the plugin commands and, with a catalog,
 * its project and personal commands (by precedence) and its user-invocable skills. Without a catalog: the harness
 * command and the plugin commands.
 */
export function listCommands(deps: Pick<AppDeps, 'registry'>, catalog: CustomizationCatalog | null = null): CommandSummary[] {
  return listServerCommands(deps.registry, catalog)
}

export function createCommandsRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['commands.list'].path, validate('query', commandsQuerySchema), async (c) => {
    const { projectId } = c.req.valid('query')
    // An unknown project is `404 not_found` ("Project <id> not found.").
    if (projectId !== undefined)
      await deps.projects.get(projectId)
    const catalog = await deps.customizations.catalog(projectId ?? null, { signal: c.req.raw.signal })
    const body: ListResponse<CommandSummary> = { items: listCommands(deps, catalog) }
    return c.json(body)
  })
  return app
}
