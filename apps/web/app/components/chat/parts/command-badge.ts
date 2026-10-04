// Pure helpers of CommandBadge (docs/UI.md 7.28; ADR-045): the source line of a command ("Project command", "Personal
// command", "From {plugin}", "Built-in command") and the tool limit of a command file ("Tools limited to a, b and 2
// more"). No Vue, no stores.
import type { CommandInvocation, CommandSource } from '@harness-forge/shared'

/** Tool names listed in "Tools limited to …" before "and {n} more". */
export const COMMAND_TOOLS_LISTED_MAX = 8

/** The source line of a command badge; the plugin's name when known, else "a plugin". */
export function commandSourceText(source: CommandSource, pluginName: string | null = null): string {
  switch (source) {
    case 'project':
      return 'Project command'
    case 'user':
      return 'Personal command'
    case 'plugin':
      return `From ${pluginName ?? 'a plugin'}`
    case 'harness':
      return 'Built-in command'
  }
}

/** "Tools limited to read_file, search_files" (at most 8 names, then "and {n} more"); '' without tools. */
export function commandToolsText(tools: readonly string[]): string {
  if (tools.length === 0)
    return ''
  const listed = tools.slice(0, COMMAND_TOOLS_LISTED_MAX).join(', ')
  const more = tools.length - COMMAND_TOOLS_LISTED_MAX
  return `Tools limited to ${listed}${more > 0 ? ` and ${more} more` : ''}`
}

/**
 * The lines of a command badge's tooltip, in order: the source (absent on messages before v1.6), "Runs on {model}"
 * and the tool limit; empty when the command carries none of them.
 */
export function commandBadgeLines(
  command: Pick<CommandInvocation, 'source' | 'modelRef' | 'allowedTools'>,
  names: { plugin: string | null, model: string | null },
): { source: string | null, model: string | null, tools: string | null } {
  return {
    source: command.source ? commandSourceText(command.source, names.plugin) : null,
    model: command.modelRef ? `Runs on ${names.model ?? command.modelRef}` : null,
    tools: command.allowedTools && command.allowedTools.length > 0 ? commandToolsText(command.allowedTools) : null,
  }
}
