// Registration of a Claude Code plugin's contributions (Phase 12, ADR-053; W12.1-T6): what the host runs instead of
// `registerDeclaredContributions` when a `claude` plugin loads (enabled, and trusted when it runs anything), through the
// plugin's own `ctx` and runtime, so its `DisposableStore` removes everything on disable / reload / uninstall.
//
// `registerClaudeContributions(ctx, read, runtime)` substitutes the plugin variables with the loaded plugin's values
// (`variables.ts`; never `process.env`): commands (`syntax: 'markdown'`, their body outside its `!` spans), agents,
// skills (with `baseDir` and `${CLAUDE_SKILL_DIR}`) and styles under their qualified names; the MCP servers with their
// Claude Code names (`${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` literal; a URL whose placeholder makes it no URL
// gets the non-sensitive option values literally, the plugin reloads when its settings are saved; every other option
// stays a `{{settings.KEY}}` placeholder that only the MCP manager's in-memory transport resolves); the hooks once, with
// the exec-form handlers' `command` / `args` substituted for the plugin folders only and the environment
// `CLAUDE_PLUGIN_DATA` + `CLAUDE_PLUGIN_OPTION_<KEY>` (shell-form handlers read `CLAUDE_PLUGIN_ROOT` from the runner).
// W12.16: every `${user_config.KEY}` of an exec-form word (an escaped `\${…}` too) stays as written in the registered
// handler: the hook runner substitutes the option values from that environment at spawn
// (`services/hooks/exec-form.ts`), so no option value, a sensitive one above all, is ever part of what `GET /hooks`, the
// `data-hook` records or the run log show. A name another plugin took (`conflict`) or a definition the registry refuses
// (`validation_error`) is skipped with a `warn` log entry naming it; any other failure fails the load. Bodies, commands,
// prompts and option values are never logged.
import type { HooksConfig, McpServerDecl, PluginContext } from '@harness-forge/plugin-sdk'
import type { PluginVariables } from '@harness-forge/shared'
import type { PluginRuntime } from '../context.ts'
import type { ClaudePluginRead } from './types.ts'
import type { LoadedPluginVariables } from './variables.ts'
import { join } from 'node:path'
import { httpUrlSchema, isHarnessError, mcpServerDeclSchema } from '@harness-forge/shared'
import { optionEnvironment, userConfigValues } from './user-config.ts'
import { pluginVariables, substituteCommandBody, substituteExec, substituteMarkdown } from './variables.ts'

/** What the registration needs of the plugin runtime (`PluginRuntime`). */
export type ClaudeRegistrationRuntime = Pick<PluginRuntime, 'registerHookCommands' | 'registerMcpServer'>

/** Runs one registration; a name another plugin took or a refused definition is skipped with a `warn` entry. */
function registerOrSkip(ctx: PluginContext, what: string, register: () => void): void {
  try {
    register()
  }
  catch (error) {
    if (!isHarnessError(error) || (error.code !== 'conflict' && error.code !== 'validation_error'))
      throw error
    ctx.logger.warn(`${what} was skipped: ${error.message}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The plugin folders of `vars` (`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`): what is substituted at load. */
function folderVariables(vars: PluginVariables): PluginVariables {
  return {
    ...(vars.pluginRoot === undefined ? {} : { pluginRoot: vars.pluginRoot }),
    ...(vars.pluginData === undefined ? {} : { pluginData: vars.pluginData }),
  }
}

/** A `${user_config.KEY}` reference, escaped (`\${…}`) or not (the keys `substitutePluginVariables` knows). */
const OPTION_REFERENCE = /\\?\$\{user_config\.[A-Z_]\w{0,63}\}/gi

/**
 * An exec-form hook word (`command` or one of `args`) with the plugin folders substituted and every `${user_config.KEY}`
 * reference (an escaped `\${user_config.KEY}` too) kept byte for byte: the hook runner substitutes the option values
 * at spawn from the registration's environment (`CLAUDE_PLUGIN_OPTION_<KEY>`), so no option value is ever stored in the
 * registered handler. The rest of the word is substituted exactly as `substituteExec` would (the references are whole
 * `${…}` tokens, so splitting around them changes no other match).
 */
export function substituteHookWord(word: string, vars: PluginVariables): string {
  const folders = folderVariables(vars)
  let output = ''
  let cursor = 0
  for (const match of word.matchAll(OPTION_REFERENCE)) {
    output += substituteExec(word.slice(cursor, match.index), folders) + match[0]
    cursor = match.index + match[0].length
  }
  return output + substituteExec(word.slice(cursor), folders)
}

/**
 * The hooks object with the exec-form handlers' `command` and `args` substituted by `substituteHookWord` (the plugin
 * folders; the `${user_config.KEY}` references stay for the runner); shell-form handlers unchanged.
 */
export function substituteHookConfig(config: HooksConfig, vars: PluginVariables): HooksConfig {
  const result: Record<string, unknown> = {}
  for (const [event, groups] of Object.entries(config as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      result[event] = groups
      continue
    }
    result[event] = groups.map((group: unknown) => {
      if (!isRecord(group) || !Array.isArray(group.hooks))
        return group
      return {
        ...group,
        hooks: group.hooks.map((handler: unknown) => {
          if (!isRecord(handler) || handler.type !== 'command' || !Array.isArray(handler.args) || typeof handler.command !== 'string')
            return handler
          return {
            ...handler,
            command: substituteHookWord(handler.command, vars),
            args: handler.args.map((arg: unknown) => typeof arg === 'string' ? substituteHookWord(arg, vars) : arg),
          }
        }),
      }
    })
  }
  return result as HooksConfig
}

/** True when the hooks object holds at least one event list. */
function hasHooks(config: HooksConfig): boolean {
  return Object.values(config as Record<string, unknown>).some(groups => Array.isArray(groups) && groups.length > 0)
}

/**
 * A server declaration with `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` substituted; a URL that is no URL because
 * of a placeholder gets the non-sensitive option values literally. Null when the URL still is no URL.
 */
export function loadedMcpDecl(decl: McpServerDecl, vars: PluginVariables): McpServerDecl | null {
  const folders = folderVariables(vars)
  const literal = (value: string): string => substituteExec(value, folders)
  const transport = decl.transport
  if (transport.type === 'stdio') {
    return {
      ...decl,
      transport: {
        type: 'stdio',
        command: literal(transport.command),
        ...(transport.args === undefined ? {} : { args: transport.args.map(literal) }),
        ...(transport.env === undefined ? {} : { env: Object.fromEntries(Object.entries(transport.env).map(([key, value]) => [key, literal(value)])) }),
      },
    }
  }
  let url = literal(transport.url)
  if (!mcpServerDeclSchema.safeParse({ ...decl, transport: { ...transport, url } }).success) {
    const sensitive = vars.sensitiveKeys ?? new Set<string>()
    const values = vars.userConfig ?? {}
    url = url.replace(/\{\{settings\.(\w+)\}\}/g, (match, key: string) => !sensitive.has(key) && Object.hasOwn(values, key) ? values[key] as string : match)
    if (!httpUrlSchema.safeParse(url.replace(/\{\{settings\.\w+\}\}/g, 'x')).success)
      return null
  }
  return {
    ...decl,
    transport: {
      type: transport.type,
      url,
      ...(transport.headers === undefined ? {} : { headers: Object.fromEntries(Object.entries(transport.headers).map(([key, value]) => [key, literal(value)])) }),
    },
  }
}

/** Registers the contributions of a read Claude Code plugin through its `ctx` and runtime (see the module comment). */
export function registerClaudeContributions(ctx: PluginContext, read: ClaudePluginRead, runtime: ClaudeRegistrationRuntime): void {
  const settings = ctx.settings.get<Record<string, unknown>>()
  const values = userConfigValues(read.userConfig, settings)
  const loaded: LoadedPluginVariables = { pluginRoot: ctx.plugin.dir, pluginData: ctx.plugin.dataDir, userConfig: values }
  const vars = pluginVariables(loaded)

  for (const server of read.mcpServers) {
    const decl = loadedMcpDecl(server.decl, vars)
    if (decl === null) {
      ctx.logger.warn(`The MCP server "${server.id}" was skipped: its URL needs a plugin setting that is not set.`)
      continue
    }
    registerOrSkip(ctx, `The MCP server "${server.id}"`, () => {
      runtime.registerMcpServer(decl, server.claudeName === '' ? undefined : { claudeName: server.claudeName })
    })
  }
  for (const command of read.commands) {
    registerOrSkip(ctx, `The command "/${command.name}"`, () => {
      ctx.commands.register({ ...command.definition, template: substituteCommandBody(command.definition.template ?? '', vars) })
    })
  }
  for (const agent of read.agents) {
    registerOrSkip(ctx, `The agent "${agent.name}"`, () => {
      ctx.agents.register({ ...agent.definition, instructions: substituteMarkdown(agent.definition.instructions, vars) })
    })
  }
  for (const skill of read.skills) {
    const skillDir = skill.baseDir === '.' ? ctx.plugin.dir : join(ctx.plugin.dir, ...skill.baseDir.split('/'))
    registerOrSkip(ctx, `The skill "${skill.name}"`, () => {
      ctx.skills.register({ ...skill.definition, content: substituteMarkdown(skill.definition.content, pluginVariables(loaded, skillDir)) })
    })
  }
  for (const style of read.styles) {
    registerOrSkip(ctx, `The output style "${style.name}"`, () => {
      ctx.outputStyles.register({ ...style.definition, content: substituteMarkdown(style.definition.content, vars) })
    })
  }
  if (hasHooks(read.hooks.config)) {
    const env = { CLAUDE_PLUGIN_DATA: ctx.plugin.dataDir, ...optionEnvironment(values) }
    runtime.registerHookCommands(substituteHookConfig(read.hooks.config, vars), { env })
  }
}
