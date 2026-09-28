// Slash commands of the composer (docs/UI.md 7.8): the menu items, the token being typed, and the client-only
// commands (`/new`, `/model`, `/effort`, `/mode`, `/help`), which run in the browser and never reach the server.
// Server commands (`GET /api/commands`) are sent as typed; the server expands them.
import type { ClientCommand, CommandSummary, ReasoningEffort, ToolMode } from '@harness-forge/shared'
import { CLIENT_COMMANDS, isClientCommand, toolModeSchema } from '@harness-forge/shared'
import { EFFORT_LABELS } from './effort'

/** One row of the slash menu (docs/UI.md 10.4). */
export interface SlashItem {
  name: string
  description: string
  kind: 'client' | 'server'
  /** Server commands: the name of the plugin that contributes the command. */
  source?: string
}

export const CLIENT_COMMAND_DESCRIPTIONS: Readonly<Record<ClientCommand, string>> = {
  new: 'Start a new chat',
  model: 'Switch model',
  effort: 'Set reasoning effort',
  mode: 'Set permission mode',
  help: 'Show shortcuts and commands',
}

/** The App group: every client command, in the documented order. */
export function clientSlashItems(): SlashItem[] {
  return CLIENT_COMMANDS.map(name => ({ name, description: CLIENT_COMMAND_DESCRIPTIONS[name], kind: 'client' as const }))
}

/**
 * The Commands group: server commands with the contributing plugin's name. A server command can never shadow a
 * client command (plugins cannot register those names; this is a second guard).
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
      source: pluginName(command.pluginId) ?? command.pluginId,
    }))
}

/** Items whose name starts with `query` (case-insensitive), App group first; the order inside a group is kept. */
export function filterSlashItems(items: readonly SlashItem[], query: string): SlashItem[] {
  const needle = query.toLowerCase()
  const matches = items.filter(item => item.name.toLowerCase().startsWith(needle))
  return [...matches.filter(item => item.kind === 'client'), ...matches.filter(item => item.kind === 'server')]
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

export interface ClientCommandContext {
  /** Resolves a typed model (ref, id or name) to a model ref, or null when unknown. */
  resolveModel: (query: string) => string | null
  /** Efforts offered for the current model (`auto` first); empty when the model has no effort control. */
  efforts: readonly ReasoningEffort[]
  /** The permission menu applies: tools exist and the model can call them. */
  toolsAvailable: boolean
}

function listOf(values: readonly string[]): string {
  if (values.length <= 1)
    return values.join('')
  return `${values.slice(0, -1).join(', ')} or ${values.at(-1)}`
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
      const mode = toolModeSchema.safeParse(value.toLowerCase())
      if (mode.success)
        return { type: 'set-mode', mode: mode.data }
      return { type: 'error', message: `Unknown mode "${value}". Use ${listOf(toolModeSchema.options)}.` }
    }
  }
}
