// The command line and the environment of one command hook process (Phase 12, ADR-057; ARCHITECTURE.md 6.37 "Handler
// fields"). Owner: W12.5.
//
// - Shell form (no `args`): the command as configured, run by `runShellCommand` (`<sh> -c <command>`); the shell expands
//   `$CLAUDE_PROJECT_DIR` / `${CLAUDE_PLUGIN_ROOT}` from the environment below.
// - Exec form (`args`): `execFormCommand(command, args, vars)` of the shared `util/hooks.ts` substitutes the known
//   `${NAME}` placeholders as plain text (`CLAUDE_PROJECT_DIR` / `HARNESS_PROJECT_DIR` = the hook's working folder at
//   spawn, the plugin root and data folder of a plugin hook) and single-quotes every word, so no argument is ever parsed
//   by the shell (`;`, `$( )`, quotes and newlines stay literal). The string still runs through `runShellCommand`, the
//   only shell-string spawn. An unknown placeholder stays as written (never read from the server environment).
// - Plugin options (W12.16): a Claude Code plugin's handler keeps every `${user_config.KEY}` as written (its
//   registration substitutes the plugin folders only), so `GET /hooks`, the records and the run log never hold an
//   option value. They are substituted here, at spawn, before the placeholders above: `${user_config.KEY}` becomes
//   `CLAUDE_PLUGIN_OPTION_<KEY>` of the plugin's extra environment (the exact key; an option without a value stays as
//   written, as it did when the reader substituted at load), an escaped `\${user_config.KEY}` the literal text. Only a
//   plugin hook with an extra environment (every Claude Code plugin has `CLAUDE_PLUGIN_DATA`) is touched. The command and
//   its arguments keep the reader's cap (`HOOK_LIMITS.commandMaxChars` together) after the substitution, else the hook
//   does not start (a NUL in a value: the same). The line with the values is never logged: `commandHookLogLine` is the
//   one with the references as written.
// - Environment: `HARNESS_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` (the working folder), for a plugin hook
//   `HARNESS_PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` and the plugin's extra variables (`RegisteredHookCommands.env`:
//   `CLAUDE_PLUGIN_DATA`, `CLAUDE_PLUGIN_OPTION_<KEY>`). The fixed variables win over the extra ones; an extra name the
//   shell runner reserves (`SHELL_ENV_RESERVED`), an invalid name or a value with a NUL is dropped (the runner would
//   refuse the whole spawn). Never `process.env`.
import { execFormCommand, HOOK_LIMITS } from '@harness-forge/shared'
import { OPTION_ENV_PREFIX } from '../../plugins/claude/user-config.ts'
import { SHELL_ENV_RESERVED } from '../../workspace/shell.ts'

/** What the command line and the environment of a command hook are built from. */
export interface CommandHookSpawn {
  /** The shell command, or the program of the exec form. */
  readonly command: string
  /** Exec form: one literal argument each. */
  readonly args?: readonly string[]
  /** A plugin hook: the plugin folder. */
  readonly pluginRoot?: string
  /** A plugin hook: its extra environment (`RegisteredHookCommands.env`). */
  readonly pluginEnv?: Readonly<Record<string, string>>
}

const RESERVED: ReadonlySet<string> = new Set(SHELL_ENV_RESERVED)
const ENV_NAME = /^[A-Z_]\w*$/i
/** Variables the hook service sets itself (never taken from a plugin's extra environment). */
const FIXED_NAMES: ReadonlySet<string> = new Set(['HARNESS_PROJECT_DIR', 'CLAUDE_PROJECT_DIR', 'HARNESS_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT'])

/** The plugin's extra variables the shell runner accepts (see the module comment). */
export function pluginHookEnv(env: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (typeof env !== 'object' || env === null)
    return result
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME.test(name) || RESERVED.has(name) || FIXED_NAMES.has(name) || typeof value !== 'string' || value.includes('\0'))
      continue
    result[name] = value
  }
  return result
}

/** The environment of a command hook run in `cwd` (see the module comment). */
export function commandHookEnv(spawn: CommandHookSpawn, cwd: string): Record<string, string> {
  const env: Record<string, string> = { ...pluginHookEnv(spawn.pluginEnv), HARNESS_PROJECT_DIR: cwd, CLAUDE_PROJECT_DIR: cwd }
  if (spawn.pluginRoot !== undefined && spawn.pluginRoot !== '') {
    env.HARNESS_PLUGIN_ROOT = spawn.pluginRoot
    env.CLAUDE_PLUGIN_ROOT = spawn.pluginRoot
  }
  return env
}

/** The `${NAME}` values of an exec-form hook run in `cwd`. */
export function execFormVars(spawn: CommandHookSpawn, cwd: string): Record<string, string> {
  const vars: Record<string, string> = { CLAUDE_PROJECT_DIR: cwd, HARNESS_PROJECT_DIR: cwd }
  if (spawn.pluginRoot !== undefined && spawn.pluginRoot !== '') {
    vars.CLAUDE_PLUGIN_ROOT = spawn.pluginRoot
    vars.HARNESS_PLUGIN_ROOT = spawn.pluginRoot
  }
  const data = spawn.pluginEnv?.CLAUDE_PLUGIN_DATA
  if (typeof data === 'string' && data !== '' && !data.includes('\0'))
    vars.CLAUDE_PLUGIN_DATA = data
  return vars
}

/** `${user_config.KEY}`, escaped (`\${…}`, group 1) or not; the key is group 2. */
const OPTION_REFERENCE = /(\\?)\$\{user_config\.([A-Z_]\w{0,63})\}/gi

/**
 * An exec-form word of a plugin hook with its option references substituted from `pluginEnv` (see the module comment):
 * `${user_config.KEY}` → `CLAUDE_PLUGIN_OPTION_<KEY>` (as written without a value), `\${user_config.KEY}` → the literal
 * `${user_config.KEY}`. Never `process.env`.
 */
export function substituteHookOptions(word: string, pluginEnv: Readonly<Record<string, string>>): string {
  return word.replace(OPTION_REFERENCE, (match: string, escape: string, key: string) => {
    if (escape === '\\')
      return match.slice(1)
    const name = `${OPTION_ENV_PREFIX}${key}`
    const value = Object.hasOwn(pluginEnv, name) ? pluginEnv[name] : undefined
    return typeof value === 'string' ? value : match
  })
}

/**
 * The program and the arguments of an exec-form hook with the plugin options substituted (a plugin hook with an extra
 * environment; others as configured); null when they are longer than the reader allows.
 */
function execWords(spawn: CommandHookSpawn & { readonly args: readonly string[] }): { command: string, args: readonly string[] } | null {
  const env = spawn.pluginEnv
  if (typeof env !== 'object' || env === null)
    return { command: spawn.command, args: spawn.args }
  const command = substituteHookOptions(spawn.command, env)
  const args = spawn.args.map(arg => substituteHookOptions(arg, env))
  const length = args.reduce((total, arg) => total + arg.length, command.trim().length)
  return length > HOOK_LIMITS.commandMaxChars ? null : { command, args }
}

/**
 * The shell text `runShellCommand` runs for a command hook in `cwd`: the command itself (shell form) or the quoted exec
 * form with the plugin options substituted; null when the exec form cannot be built (an empty program, a NUL in an
 * argument, longer than the reader allows): the hook does not start. Holds option values: never log it.
 */
export function commandHookLine(spawn: CommandHookSpawn, cwd: string): string | null {
  if (spawn.args === undefined)
    return spawn.command
  const words = execWords({ ...spawn, args: spawn.args })
  return words === null ? null : execFormCommand(words.command, words.args, execFormVars(spawn, cwd))
}

/**
 * The shell text of a command hook as the debug log shows it: like `commandHookLine`, but the `${user_config.KEY}`
 * references stay as written (no option value), and a form that cannot be built is the command as configured.
 */
export function commandHookLogLine(spawn: CommandHookSpawn, cwd: string): string {
  if (spawn.args === undefined)
    return spawn.command
  return execFormCommand(spawn.command, spawn.args, execFormVars(spawn, cwd)) ?? spawn.command
}
