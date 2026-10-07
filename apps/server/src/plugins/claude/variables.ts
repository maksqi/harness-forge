// Plugin variables of a Claude Code plugin (Phase 12, ADR-053; W12.1-T3; server-plugins.md D10, the variable table).
// Every substitution goes through the shared `substitutePluginVariables`; nothing is ever read from `process.env`.
//
// | Variable                   | Shell-form hook | Exec-form hook        | stdio / http MCP          | Markdown bodies        |
// |----------------------------|-----------------|-----------------------|---------------------------|------------------------|
// | `${CLAUDE_PLUGIN_ROOT}`    | env             | literal at load       | literal at load           | absolute path          |
// | `${CLAUDE_PLUGIN_DATA}`    | env             | literal at load       | literal at load           | absolute path          |
// | `${CLAUDE_PROJECT_DIR}`    | env             | at spawn (the runner) | server skipped            | at expansion           |
// | `${CLAUDE_SKILL_DIR}`      | —               | —                     | —                         | the skill folder       |
// | `${user_config.KEY}`       | refused         | at spawn (the runner) | `{{settings.KEY}}`        | non-sensitive only     |
// | other `${VAR}`             | —               | literal               | `{{settings.env_VAR}}`    | literal                |
//
// Exec-form hooks (W12.16): `${user_config.KEY}` (an escaped `\${…}` too) stays as written in the registered handler
// (`register.ts` `substituteHookWord`); the hook runner replaces it at spawn with `CLAUDE_PLUGIN_OPTION_<KEY>` of the
// registration's environment (`services/hooks/exec-form.ts`), so `GET /hooks`, the records and the run log never hold
// an option value. An option without a value stays as written (the hook gets the literal `${user_config.KEY}`).
//
// Markdown bodies (agent instructions, skill and style contents, command bodies outside their `` !`cmd` `` spans): a
// sensitive `${user_config.KEY}` becomes '' (the reader reports it), `\${…}` of a known variable stays literal. The
// spans of a command keep their variables: they run with the plugin environment (`CLAUDE_PLUGIN_ROOT`, …).
import type { PluginVariables } from '@harness-forge/shared'
import type { UserConfigValues } from './user-config.ts'
import { planCommandExpansion, substitutePluginVariables } from '@harness-forge/shared'

/** The variables of one loaded plugin. */
export interface LoadedPluginVariables {
  /** The plugin folder (canonical realpath). */
  readonly pluginRoot: string
  /** Its private data folder (`<dataDir>/plugins/.data/<id>`). */
  readonly pluginData: string
  readonly userConfig: UserConfigValues
}

/** `PluginVariables` of a loaded plugin (the skill folder of a skill body). */
export function pluginVariables(loaded: LoadedPluginVariables, skillDir?: string): PluginVariables {
  return {
    pluginRoot: loaded.pluginRoot,
    pluginData: loaded.pluginData,
    userConfig: loaded.userConfig.values,
    sensitiveKeys: loaded.userConfig.sensitive,
    ...(skillDir === undefined ? {} : { skillDir }),
  }
}

/** A markdown body with the plugin variables substituted (sensitive options become ''). */
export function substituteMarkdown(text: string, vars: PluginVariables): string {
  return substitutePluginVariables(text, vars, { mode: 'markdown' }).text
}

/** An exec-form word (a hook `command` / `args` entry, an MCP field) with the plugin variables substituted. */
export function substituteExec(text: string, vars: PluginVariables): string {
  return substitutePluginVariables(text, vars, { mode: 'exec' }).text
}

/**
 * A command body with the plugin variables substituted outside its `` !`cmd` `` spans (the spans and the file
 * references stay byte for byte; `planCommandExpansion` finds them, its text parts are contiguous slices of the body).
 */
export function substituteCommandBody(body: string, vars: PluginVariables): string {
  if (!body.includes('!`'))
    return substituteMarkdown(body, vars)
  const plan = planCommandExpansion(body)
  if (plan.shellCommands.length === 0)
    return substituteMarkdown(body, vars)
  let cursor = 0
  let output = ''
  for (const part of plan.parts) {
    if (part.kind === 'text') {
      if (!body.startsWith(part.text, cursor))
        return body
      output += substituteMarkdown(part.text, vars)
      cursor += part.text.length
    }
    else if (part.kind === 'file') {
      if (!body.startsWith(part.raw, cursor))
        return body
      output += part.raw
      cursor += part.raw.length
    }
    else {
      // A span: `!` + backtick, the command, the closing backtick (the command holds no backtick).
      if (!body.startsWith('!`', cursor))
        return body
      const close = body.indexOf('`', cursor + 2)
      if (close === -1)
        return body
      output += body.slice(cursor, close + 1)
      cursor = close + 1
    }
  }
  return output + body.slice(cursor)
}

/** `${user_config.KEY}` references of a text (the keys, in order, unique). */
export function userConfigReferences(text: string): string[] {
  const keys: string[] = []
  for (const match of text.matchAll(/(?<!\\)\$\{user_config\.([A-Z_]\w{0,63})\}/gi)) {
    const key = match[1] as string
    if (!keys.includes(key))
      keys.push(key)
  }
  return keys
}

/** True when the text references `${CLAUDE_PROJECT_DIR}` (unescaped). */
export function referencesProjectDir(text: string): boolean {
  return /(?<!\\)\$\{CLAUDE_PROJECT_DIR\}/.test(text)
}
