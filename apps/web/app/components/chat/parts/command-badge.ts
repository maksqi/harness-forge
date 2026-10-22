// Pure helpers of CommandBadge (docs/UI.md 7.28; ADR-045): the source line of a command ("Project command", "Personal
// command", "From {plugin}", "Built-in command") and the tool limit of a command file ("Tools limited to a, b and 2
// more"). Phase 11 (ADR-052, W11.12): a skill invocation reads "Project skill", "Personal skill", "From {plugin}",
// "Built-in skill"; what a trusted command inlined (`inlined`): "Ran {n} shell commands" and "Included {paths}". No Vue,
// no stores.
// Phase 14 (ADR-061; W14.9, open point 14): an MCP prompt (`source: 'mcp'`) reads "MCP · {server}" (the server's name,
// else its id from the command name `mcp__<serverId>__<prompt>`, else "an MCP server").
import type { CommandInvocation, CommandSource } from '@harness-forge/shared'
import { mcpPromptServerId } from '@harness-forge/shared'

/** Tool names listed in "Tools limited to …" before "and {n} more". */
export const COMMAND_TOOLS_LISTED_MAX = 8

/** + Phase 11: paths listed in "Included …" before "and {n} more". */
export const COMMAND_FILES_LISTED_MAX = 5

/**
 * The source line of a command badge; the plugin's name when known, else "a plugin". + Phase 11: `kind` 'skill' says
 * "skill" instead of "command". + Phase 14: an MCP prompt reads "MCP · {server}" (`serverName`).
 */
export function commandSourceText(
  source: CommandSource,
  pluginName: string | null = null,
  kind: 'command' | 'skill' = 'command',
  serverName: string | null = null,
): string {
  switch (source) {
    case 'project':
      return `Project ${kind}`
    case 'user':
      return `Personal ${kind}`
    case 'plugin':
      return `From ${pluginName ?? 'a plugin'}`
    case 'harness':
      return `Built-in ${kind}`
    // Phase 14 (ADR-061): an MCP prompt.
    case 'mcp':
      return `MCP · ${serverName ?? 'an MCP server'}`
  }
}

/**
 * + Phase 11: what a trusted command file inlined before the model call (`inlined`): "Ran 2 shell commands" ("Ran 1
 * shell command") and "Included README.md, docs/a.md" (at most 5 paths, then "and {n} more"); empty without either.
 */
export function commandInlinedLines(inlined: CommandInvocation['inlined']): string[] {
  if (!inlined)
    return []
  const lines: string[] = []
  if (inlined.shell > 0)
    lines.push(`Ran ${inlined.shell} shell command${inlined.shell === 1 ? '' : 's'}`)
  if (inlined.files.length > 0) {
    const listed = inlined.files.slice(0, COMMAND_FILES_LISTED_MAX).join(', ')
    const more = inlined.files.length - COMMAND_FILES_LISTED_MAX
    lines.push(`Included ${listed}${more > 0 ? ` and ${more} more` : ''}`)
  }
  return lines
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
 * The lines of a command badge's tooltip, in order: the source (absent on messages before v1.6), "Runs on {model}",
 * the tool limit and (+ Phase 11) what the command inlined; empty when the command carries none of them. `kind` names
 * a skill invocation (default: the invocation's own `kind`). + Phase 14: `names.server` = the MCP server's name of an
 * MCP prompt.
 */
export function commandBadgeLines(
  command: Pick<CommandInvocation, 'source' | 'modelRef' | 'allowedTools' | 'kind' | 'inlined'>,
  names: { plugin: string | null, model: string | null, server?: string | null },
  kind: 'command' | 'skill' = command.kind ?? 'command',
): { source: string | null, model: string | null, tools: string | null, inlined: string[] } {
  return {
    source: command.source ? commandSourceText(command.source, names.plugin, kind, names.server ?? null) : null,
    model: command.modelRef ? `Runs on ${names.model ?? command.modelRef}` : null,
    tools: command.allowedTools && command.allowedTools.length > 0 ? commandToolsText(command.allowedTools) : null,
    inlined: commandInlinedLines(command.inlined),
  }
}

/**
 * + Phase 14: the server named by an MCP prompt's badge: its listed name (`GET /commands`' `mcpServer.name`, else the
 * MCP server list's name of the id in the command name), else that id; null for a name that is not an MCP prompt's.
 */
export function mcpCommandServerName(
  name: string,
  listed: { commands: readonly { name: string, source: CommandSource, mcpServer?: { id: string, name: string } }[], servers: readonly { id: string, name: string }[] },
): string | null {
  const command = listed.commands.find(item => item.name === name && item.source === 'mcp')
  if (command?.mcpServer?.name)
    return command.mcpServer.name
  const serverId = mcpPromptServerId(name)
  if (!serverId)
    return null
  return listed.servers.find(server => server.id === serverId)?.name || serverId
}
