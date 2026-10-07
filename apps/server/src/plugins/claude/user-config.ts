// `userConfig` of a Claude Code plugin (Phase 12, ADR-053; W12.1-T3; server-plugins.md D11): the options become the
// plugin's settings schema through the shared `userConfigToSettings` (`sensitive` → a secret text setting, `options` →
// `enum`, `multiple` → a list, `number` with `minimum` / `maximum`, `directory` / `file` → absolute server paths),
// plus one setting `env_<VAR>` per other `${VAR}` of its MCP servers (a secret text setting; a non-secret text setting
// when a reference gives a non-empty `:-default`), at most `SETTINGS_PROPERTIES_MAX` properties. The values come back
// from the stored settings (defaults applied, secrets decrypted by the host) as text for the plugin variables
// (`${user_config.KEY}`) and the hook environment (`CLAUDE_PLUGIN_OPTION_<KEY>`). Values are never logged.
import type { SettingsSchema } from '@harness-forge/plugin-sdk'
import type { ClaudeDiagnostic, ClaudeUserConfigOption } from '@harness-forge/shared'
import { FIELD_KEY_PATTERN, SETTINGS_PROPERTIES_MAX, settingsSchemaSchema, userConfigToSettings } from '@harness-forge/shared'

/** The prefix of the settings that hold the other `${VAR}` references of the MCP servers. */
export const ENV_SETTING_PREFIX = 'env_'
/** The hook environment variable of each `userConfig` option. */
export const OPTION_ENV_PREFIX = 'CLAUDE_PLUGIN_OPTION_'

/** A `${VAR}` of the plugin's MCP servers that becomes the setting `env_<VAR>`. */
export interface McpVariableSetting {
  readonly name: string
  /** The first non-empty `:-default` of its references, or null. */
  readonly defaultValue: string | null
}

export interface ClaudeSettingsResult {
  /** The settings schema; null without options and variables (or when it could not be built). */
  readonly schema: SettingsSchema | null
  readonly diagnostics: readonly ClaudeDiagnostic[]
}

/** The settings key of a MCP variable (`env_<VAR>`), or null when it cannot be a settings key. */
export function envSettingKey(name: string): string | null {
  const key = `${ENV_SETTING_PREFIX}${name}`
  return FIELD_KEY_PATTERN.test(key) ? key : null
}

/** The settings schema of the `userConfig` options and the MCP variables. */
export function claudeSettingsSchema(options: readonly ClaudeUserConfigOption[], variables: readonly McpVariableSetting[]): ClaudeSettingsResult {
  const diagnostics: ClaudeDiagnostic[] = []
  const mapped = userConfigToSettings(options)
  for (const item of mapped.diagnostics)
    diagnostics.push({ level: item.level, code: item.code, message: item.message, component: 'userConfig', ...(item.field === undefined ? {} : { path: item.field }) })
  const properties: Record<string, unknown> = { ...(mapped.schema.properties as Record<string, unknown>) }
  const required = Array.isArray(mapped.schema.required) ? [...(mapped.schema.required as string[])] : []
  for (const variable of variables) {
    const key = envSettingKey(variable.name)
    if (key === null || Object.hasOwn(properties, key))
      continue
    if (Object.keys(properties).length >= SETTINGS_PROPERTIES_MAX) {
      diagnostics.push({ level: 'warning', code: 'too-many', message: `Only ${SETTINGS_PROPERTIES_MAX} settings are possible; the MCP variable ${variable.name} has no setting.`, component: 'mcpServers' })
      continue
    }
    const title = `Variable ${variable.name}`.slice(0, 100)
    const description = `The value of \${${variable.name}} in the plugin's MCP servers.`
    properties[key] = variable.defaultValue === null
      ? { type: 'string', title, description, format: 'secret' }
      : { type: 'string', title, description, default: variable.defaultValue }
  }
  if (Object.keys(properties).length === 0)
    return { schema: null, diagnostics }
  const candidate = { type: 'object', properties, ...(required.length === 0 ? {} : { required }) }
  const parsed = settingsSchemaSchema.safeParse(candidate)
  if (!parsed.success) {
    diagnostics.push({ level: 'warning', code: 'invalid-user-config', message: 'The plugin options could not be turned into settings; the plugin has no settings.', component: 'userConfig' })
    return { schema: null, diagnostics }
  }
  return { schema: parsed.data as SettingsSchema, diagnostics }
}

/** The text of a settings value: strings as is, numbers and booleans stringified, lists comma-joined; else ''. */
export function settingValueText(value: unknown): string {
  if (typeof value === 'string')
    return value
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  if (Array.isArray(value))
    return value.map(settingValueText).filter(item => item !== '').join(',')
  return ''
}

/** The `userConfig` values as text (empty and missing ones left out) and the keys of the sensitive options. */
export interface UserConfigValues {
  readonly values: Readonly<Record<string, string>>
  readonly sensitive: ReadonlySet<string>
}

/** The values of the `userConfig` options from the plugin settings (defaults applied, secrets decrypted). */
export function userConfigValues(options: readonly ClaudeUserConfigOption[], settings: Readonly<Record<string, unknown>>): UserConfigValues {
  const values: Record<string, string> = {}
  const sensitive = new Set<string>()
  for (const option of options) {
    if (option.sensitive)
      sensitive.add(option.key)
    const text = Object.hasOwn(settings, option.key) ? settingValueText(settings[option.key]) : ''
    if (text !== '')
      Object.defineProperty(values, option.key, { value: text, enumerable: true, writable: true, configurable: true })
  }
  return { values, sensitive }
}

/** `CLAUDE_PLUGIN_OPTION_<KEY>` of every option with a value (sensitive ones included), for the plugin's hooks. */
export function optionEnvironment(values: UserConfigValues): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(values.values)) {
    if (!value.includes('\0'))
      env[`${OPTION_ENV_PREFIX}${key}`] = value
  }
  return env
}
