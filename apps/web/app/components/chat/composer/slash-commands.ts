// Slash commands of the composer (docs/UI.md 7.8): the menu items, the token being typed, and the client-only
// commands (`/new`, `/model`, `/effort`, `/mode`, `/help`, `/remember`), which run in the browser and never reach the
// server. Server commands (`GET /api/commands?projectId=`) are sent as typed; the server expands them.
// Phase 10 (ADR-045, ADR-047; C33 declared, W10.9 implements; signatures frozen from Gate P10-0b): every item has a
// group, shown in the order App · Project · Personal · Plugins (`SLASH_GROUPS`, `slashGroupOf`: client commands and the
// harness `/compact` are App); server items carry the command file's `argumentHint` and `namespace`; a row shows the
// namespace (project commands) or the plugin name (plugin commands) on the right (`slashItemDetail`) and is named
// "/{name}, {description}, arguments {hint}" (`slashItemLabel`); `argumentHintAt` is the ghost hint of
// SlashArgumentHint; `/remember [text]` resolves to the `remember` action (the composer opens RememberDialog).
import type { ClientCommand, CommandSummary, ReasoningEffort, ToolMode } from '@harness-forge/shared'
import { CLIENT_COMMANDS, isClientCommand } from '@harness-forge/shared'
import { EFFORT_LABELS } from './effort'
import { EDITS_NEEDS_PROJECT, isProjectOnlyMode, PLAN_NEEDS_PROJECT, TOOL_MODE_OPTIONS } from './permission'

/** The groups of the slash menu, in display order (docs/UI.md 7.8, Phase 10). */
export type SlashGroup = 'app' | 'project' | 'personal' | 'plugin'

/** The groups in display order with their headings (`data-group` = `value`). */
export const SLASH_GROUPS: readonly { value: SlashGroup, label: string }[] = [
  { value: 'app', label: 'App' },
  { value: 'project', label: 'Project' },
  { value: 'personal', label: 'Personal' },
  { value: 'plugin', label: 'Plugins' },
]

/** One row of the slash menu (docs/UI.md 10.4; Phase 10: 10.7, 11.7). */
export interface SlashItem {
  name: string
  description: string
  kind: 'client' | 'server'
  /** Server commands: the name of the plugin that contributes the command. */
  source?: string
  /** + Phase 10: the menu group (client commands and the harness `/compact`: `app`). */
  group: SlashGroup
  /** + Phase 10: the command file's `argument-hint` (`<file> [focus]`). */
  argumentHint?: string
  /** + Phase 10: the subfolder of a project command (a display label only). */
  namespace?: string
}

export const CLIENT_COMMAND_DESCRIPTIONS: Readonly<Record<ClientCommand, string>> = {
  new: 'Start a new chat',
  model: 'Switch model',
  effort: 'Set reasoning effort',
  mode: 'Set permission mode',
  help: 'Show shortcuts and commands',
  remember: 'Save a note to your instructions',
}

/**
 * The App group's client commands, in the documented order (`remember` last: since Phase 10, ADR-047, typing
 * `/remember [text]` or picking it opens RememberDialog).
 */
export function clientSlashItems(): SlashItem[] {
  return CLIENT_COMMANDS.map(name => ({ name, description: CLIENT_COMMAND_DESCRIPTIONS[name], kind: 'client' as const, group: 'app' as const }))
}

/** The menu group of a server command: harness -> App, project -> Project, user -> Personal, plugin -> Plugins. */
export function slashGroupOf(command: Pick<CommandSummary, 'source'>): SlashGroup {
  switch (command.source) {
    case 'harness':
      return 'app'
    case 'project':
      return 'project'
    case 'user':
      return 'personal'
    case 'plugin':
      return 'plugin'
  }
}

/**
 * The server items: `/compact` (App), the project's, the personal and the plugin commands, with the contributing
 * plugin's name, the argument hint and the namespace. The server already resolved the precedence (one item per name).
 * A server command can never shadow a client command (plugins and command files cannot take those names; this is a
 * second guard).
 */
export function serverSlashItems(
  commands: readonly CommandSummary[],
  pluginName: (pluginId: string) => string | undefined = () => undefined,
): SlashItem[] {
  return commands
    .filter(command => !isClientCommand(command.name))
    .map(command => ({
      name: command.name,
      description: command.description,
      kind: 'server' as const,
      // Phase 10: `pluginId` is optional (personal and project commands have none).
      ...(command.pluginId === undefined ? {} : { source: pluginName(command.pluginId) ?? command.pluginId }),
      group: slashGroupOf(command),
      ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
      ...(command.namespace === undefined ? {} : { namespace: command.namespace }),
    }))
}

const HINT_PATTERN = /^\/([a-z][\da-z-]{0,31})[ \t]+$/i

/**
 * The argument hint to show after the typed command (SlashArgumentHint, docs/UI.md 7.28): the text is exactly `/name`
 * plus one or more blanks on one line and the item named `name` has a hint; else null.
 */
export function argumentHintAt(text: string, items: readonly SlashItem[]): string | null {
  const match = text.match(HINT_PATTERN)
  if (!match)
    return null
  const name = match[1]!.toLowerCase()
  const hint = items.find(item => item.name.toLowerCase() === name)?.argumentHint
  return hint || null
}

/**
 * The muted text on the right of a row: the namespace of a command file (`frontend`), else the plugin name of a plugin
 * command; App and personal rows show none.
 */
export function slashItemDetail(item: SlashItem): string | null {
  if (item.namespace)
    return item.namespace
  return item.group === 'plugin' && item.source ? item.source : null
}

/** The accessible name of a row: "/{name}, {description}" plus ", arguments {hint}" when it has a hint. */
export function slashItemLabel(item: SlashItem): string {
  const base = item.description ? `/${item.name}, ${item.description}` : `/${item.name}`
  return item.argumentHint ? `${base}, arguments ${item.argumentHint}` : base
}

/**
 * Items whose name starts with `query` (case-insensitive), in group order (App, Project, Personal, Plugins); the order
 * inside a group is kept (client commands before `/compact` in App).
 */
export function filterSlashItems(items: readonly SlashItem[], query: string): SlashItem[] {
  const needle = query.toLowerCase()
  const matches = items.filter(item => item.name.toLowerCase().startsWith(needle))
  return SLASH_GROUPS.flatMap(group => matches.filter(item => item.group === group.value))
}

const QUERY_PATTERN = /^[\w-]{0,32}$/

/**
 * The command name being typed, or null when the slash menu should stay closed: the text starts with `/`, the caret
 * sits in the first token and the token looks like a command name (so paths like `/usr/bin` never open the menu).
 */
export function slashQueryAt(text: string, caret: number): string | null {
  if (!text.startsWith('/'))
    return null
  const end = text.search(/\s/)
  const tokenEnd = end === -1 ? text.length : end
  if (caret < 1 || caret > tokenEnd)
    return null
  const query = text.slice(1, tokenEnd)
  return QUERY_PATTERN.test(query) ? query : null
}

export interface ParsedSlashCommand {
  /** Lowercase command name. */
  name: string
  /** Trimmed text after the name. */
  args: string
}

const COMMAND_PATTERN = /^\/([a-z][\da-z-]{0,31})(?:\s([\s\S]*))?$/i

/** `/name args` -> `{ name, args }`; null when the text is not a slash command. */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const match = text.trim().match(COMMAND_PATTERN)
  if (!match)
    return null
  return { name: match[1]!.toLowerCase(), args: (match[2] ?? '').trim() }
}

/** The client command typed in `text`, or null (server commands and plain text are sent as typed). */
export function parseClientCommand(text: string): { name: ClientCommand, args: string } | null {
  const parsed = parseSlashCommand(text)
  if (!parsed || !isClientCommand(parsed.name))
    return null
  return { name: parsed.name, args: parsed.args }
}

/** What a client command does. The composer carries it out. */
export type ClientCommandAction
  = | { type: 'new' }
    | { type: 'help' }
    | { type: 'open', menu: 'model' | 'effort' | 'mode' }
    | { type: 'set-model', modelRef: string }
    | { type: 'set-effort', effort: ReasoningEffort }
    | { type: 'set-mode', mode: ToolMode }
    | { type: 'error', message: string }
    /** + Phase 10 (ADR-047): opens RememberDialog with the text after `/remember` (trimmed). */
    | { type: 'remember', text: string }

export interface ClientCommandContext {
  /** Resolves a typed model (ref, id or name) to a model ref, or null when unknown. */
  resolveModel: (query: string) => string | null
  /** Efforts offered for the current model (`auto` first); empty when the model has no effort control. */
  efforts: readonly ReasoningEffort[]
  /** The permission menu applies: tools exist and the model can call them. */
  toolsAvailable: boolean
  /** The chat belongs to a project (Phase 7): only then can `/mode edits` select Accept edits. */
  projectChat: boolean
}

function listOf(values: readonly string[]): string {
  if (values.length <= 1)
    return values.join('')
  return `${values.slice(0, -1).join(', ')} or ${values.at(-1)}`
}

/**
 * The mode typed after `/mode`: a value (`edits`) or a label (`accept edits`), case-insensitive; hyphens and runs of
 * spaces count as one space, so `accept-edits` works too. null when nothing matches.
 */
export function parseToolMode(value: string): ToolMode | null {
  const wanted = value.trim().toLowerCase().replace(/[\s-]+/g, ' ')
  return TOOL_MODE_OPTIONS.find(option => option.value === wanted || option.label.toLowerCase() === wanted)?.value ?? null
}

/**
 * Turns `/name args` into an action: no argument opens the matching menu (`/model`, `/effort`, `/mode`) or runs the
 * command (`/new`, `/help`); an argument applies the value. Invalid values yield an error message for a toast.
 */
export function resolveClientCommand(name: ClientCommand, args: string, context: ClientCommandContext): ClientCommandAction {
  const value = args.trim()
  switch (name) {
    case 'new':
      return { type: 'new' }
    case 'help':
      return { type: 'help' }
    case 'remember':
      return { type: 'remember', text: value }
    case 'model': {
      if (!value)
        return { type: 'open', menu: 'model' }
      const modelRef = context.resolveModel(value)
      return modelRef ? { type: 'set-model', modelRef } : { type: 'error', message: `Unknown model "${value}".` }
    }
    case 'effort': {
      if (context.efforts.length === 0)
        return { type: 'error', message: 'This model has no reasoning effort setting.' }
      if (!value)
        return { type: 'open', menu: 'effort' }
      const wanted = value.toLowerCase()
      const effort = context.efforts.find(item => item === wanted || EFFORT_LABELS[item].toLowerCase() === wanted)
      if (effort)
        return { type: 'set-effort', effort }
      return { type: 'error', message: `Unknown effort "${value}". Use ${listOf(context.efforts)}.` }
    }
    case 'mode': {
      if (!context.toolsAvailable)
        return { type: 'error', message: 'No tools are available for this model.' }
      if (!value)
        return { type: 'open', menu: 'mode' }
      const mode = parseToolMode(value)
      if (mode === 'edits' && !context.projectChat)
        return { type: 'error', message: EDITS_NEEDS_PROJECT }
      if (mode === 'plan' && !context.projectChat)
        return { type: 'error', message: PLAN_NEEDS_PROJECT }
      if (mode)
        return { type: 'set-mode', mode }
      const modes = TOOL_MODE_OPTIONS
        .map(option => option.value)
        .filter(item => !isProjectOnlyMode(item) || context.projectChat)
      return { type: 'error', message: `Unknown mode "${value}". Use ${listOf(modes)}.` }
    }
  }
}
