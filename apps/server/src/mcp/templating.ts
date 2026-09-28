// `{{settings.<key>}}` templating of plugin-declared MCP servers (PLUGINS.md 5): `url`, header values, `args` items
// and `env` values are resolved from the plugin's settings (secrets decrypted) at connect time. An empty setting omits
// the header / env entry; an empty setting in `url` or an `args` item fails the connection with a message naming it.
// `command` is never templated (the declaration schema rejects placeholders there).
import type { McpServerDecl } from '@harness-forge/shared'
import { httpHeaderValueSchema, httpUrlSchema } from '@harness-forge/shared'
import { mcpConfigError } from './errors.ts'

/** A transport with every placeholder resolved (values may be secrets: never log or return them). */
export type ResolvedMcpTransport
  = | { type: 'http' | 'sse', url: string, headers: Record<string, string> }
    | { type: 'stdio', command: string, args: string[], env: Record<string, string> }

const PLACEHOLDER = /\{\{settings\.([a-z]\w{0,63})\}\}/gi

/** The text of a settings value: strings as is, numbers and booleans stringified, string arrays comma-joined. */
export function settingText(value: unknown): string {
  if (typeof value === 'string')
    return value
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  if (Array.isArray(value))
    return value.map(settingText).filter(item => item !== '').join(',')
  return ''
}

export interface TemplateResult {
  value: string
  /** Keys whose setting is empty or missing (in order of appearance, unique). */
  missing: string[]
}

/** Replaces every `{{settings.<key>}}` of `template`. */
export function applySettings(template: string, settings: Readonly<Record<string, unknown>>): TemplateResult {
  const missing: string[] = []
  const value = template.replace(PLACEHOLDER, (_match, key: string) => {
    const text = settingText(settings[key])
    if (text === '' && !missing.includes(key))
      missing.push(key)
    return text
  })
  return { value, missing }
}

function missingSetting(serverId: string, key: string, where: string): Error {
  return mcpConfigError(`The MCP server "${serverId}" needs the setting "${key}" (${where}): set it in the plugin's Configuration tab.`)
}

/** Resolves a plugin declaration's transport; throws `validation_error` for missing settings or invalid results. */
export function resolveDeclTransport(serverId: string, transport: McpServerDecl['transport'], settings: Readonly<Record<string, unknown>>): ResolvedMcpTransport {
  if (transport.type === 'stdio') {
    const args = (transport.args ?? []).map((template, index) => {
      const result = applySettings(template, settings)
      if (result.missing.length > 0)
        throw missingSetting(serverId, result.missing[0] as string, `argument ${index + 1}`)
      return result.value
    })
    const env: Record<string, string> = {}
    for (const [name, template] of Object.entries(transport.env ?? {})) {
      const result = applySettings(template, settings)
      if (result.missing.length === 0)
        env[name] = result.value
    }
    return { type: 'stdio', command: transport.command, args, env }
  }

  const url = applySettings(transport.url, settings)
  if (url.missing.length > 0)
    throw missingSetting(serverId, url.missing[0] as string, 'URL')
  if (!httpUrlSchema.safeParse(url.value).success)
    throw mcpConfigError(`The URL of the MCP server "${serverId}" is not an absolute http:// or https:// URL after inserting its settings.`)
  const headers: Record<string, string> = {}
  for (const [name, template] of Object.entries(transport.headers ?? {})) {
    const result = applySettings(template, settings)
    if (result.missing.length > 0)
      continue
    if (!httpHeaderValueSchema.safeParse(result.value).success)
      throw mcpConfigError(`The header "${name}" of the MCP server "${serverId}" is not a valid header value after inserting its settings.`)
    headers[name] = result.value
  }
  return { type: transport.type, url: url.value, headers }
}
