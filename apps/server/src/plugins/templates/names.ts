// Contribution names of a scaffolded plugin (W3.4-T1). Tool names, command names and MCP server ids are global, so the
// scaffold picks names nobody registered yet: tools and providers are namespaced by the plugin id, commands keep short
// names (`/tldr`) with a numeric suffix when taken, MCP servers use the plugin id (so its length is limited to 32).
// Reserved command names count as taken: the client-only commands (`/remember` since Phase 10) and the harness commands
// (`/compact`, Phase 9).
import type { PluginTemplateId } from '@harness-forge/shared'
import {
  COMMAND_NAME_PATTERN,
  HarnessError,
  isClientCommand,
  isHarnessCommand,
  MCP_SERVER_ID_PATTERN,
  PROVIDER_ID_PATTERN,
  TOOL_NAME_PATTERN,
} from '@harness-forge/shared'

/** Answers whether a name is already registered (by any plugin). */
export interface NameRegistry {
  tool: (name: string) => boolean
  provider: (id: string) => boolean
  mcpServer: (id: string) => boolean
  command: (name: string) => boolean
}

/** Nothing is taken (rendering outside a running host, tests). */
export const EMPTY_NAME_REGISTRY: NameRegistry = {
  tool: () => false,
  provider: () => false,
  mcpServer: () => false,
  command: () => false,
}

/** Names used by the template entries. */
export interface TemplateNames {
  /** Tool template: `<plugin_id>_text_stats`. */
  tool: string
  /** Provider template: the plugin id. */
  provider: string
  /** MCP bridge template: the plugin id (at most 32 characters). */
  mcpServer: string
  /** Command pack template: a template command and a `run` command. */
  commands: { summary: string, count: string }
}

/** The first candidate that matches `pattern` and is free; numbered suffixes `2..99` are tried after the base. */
function pickName(base: string, separator: string, pattern: RegExp, taken: (name: string) => boolean, maxLength: number): string | null {
  for (let attempt = 1; attempt < 100; attempt++) {
    const suffix = attempt === 1 ? '' : `${separator}${attempt}`
    const candidate = `${base.slice(0, maxLength - suffix.length).replace(/[-_]+$/, '')}${suffix}`
    if (pattern.test(candidate) && !taken(candidate))
      return candidate
  }
  return null
}

function unavailable(what: string): HarnessError {
  return new HarnessError({
    code: 'conflict',
    message: `No free ${what} name is left for this plugin: choose another plugin id.`,
    details: { reason: 'exists' },
  })
}

/** A command name no plugin may register: a client-only command (`/new`, `/remember`, ...) or a harness command (`/compact`). */
export function isReservedCommandName(name: string): boolean {
  return isClientCommand(name) || isHarnessCommand(name)
}

/** `^[a-z0-9-]` plugin id -> `snake_case` tool prefix. */
export function toolPrefix(pluginId: string): string {
  return pluginId.replaceAll('-', '_')
}

/** Names of a new plugin for `template`. Throws `validation_error` when the plugin id cannot carry them. */
export function pickTemplateNames(pluginId: string, template: PluginTemplateId, registry: NameRegistry = EMPTY_NAME_REGISTRY): TemplateNames {
  const names: TemplateNames = {
    tool: `${toolPrefix(pluginId)}_text_stats`,
    provider: pluginId,
    mcpServer: pluginId,
    commands: { summary: 'tldr', count: 'wordcount' },
  }
  switch (template) {
    case 'tool': {
      const tool = pickName(`${toolPrefix(pluginId)}_text_stats`, '_', TOOL_NAME_PATTERN, registry.tool, 64)
      if (tool === null)
        throw unavailable('tool')
      names.tool = tool
      break
    }
    case 'provider': {
      // Provider ids must be `<pluginId>` or `<pluginId>-<suffix>`.
      const provider = [pluginId, `${pluginId}-llm`, ...Array.from({ length: 8 }, (_, index) => `${pluginId}-${index + 2}`)]
        .find(id => PROVIDER_ID_PATTERN.test(id) && !registry.provider(id))
      if (provider === undefined)
        throw unavailable('provider')
      names.provider = provider
      break
    }
    case 'mcp-bridge': {
      const server = [pluginId, `${pluginId}-mcp`, `${pluginId}-2`]
        .find(id => MCP_SERVER_ID_PATTERN.test(id) && !registry.mcpServer(id))
      if (server === undefined) {
        if (!MCP_SERVER_ID_PATTERN.test(pluginId)) {
          throw new HarnessError({
            code: 'validation_error',
            message: 'MCP server ids are limited to 32 characters: use a plugin id of at most 32 characters.',
            details: { issues: [{ path: ['id'], message: 'Use at most 32 characters for an MCP bridge.', code: 'too_big' }] },
          })
        }
        throw unavailable('MCP server')
      }
      names.mcpServer = server
      break
    }
    case 'command-pack': {
      const taken = (name: string): boolean => isReservedCommandName(name) || registry.command(name)
      const summary = pickName('tldr', '-', COMMAND_NAME_PATTERN, taken, 32)
      const count = pickName('wordcount', '-', COMMAND_NAME_PATTERN, name => taken(name) || name === summary, 32)
      if (summary === null || count === null)
        throw unavailable('command')
      names.commands = { summary, count }
      break
    }
  }
  return names
}
