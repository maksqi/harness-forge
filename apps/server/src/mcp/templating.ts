// `{{settings.<key>}}` templating of plugin-declared MCP servers (PLUGINS.md 5): `url`, header values, `args` items
// and `env` values are resolved from the plugin's settings (secrets decrypted) at connect time. An empty setting omits
// the header / env entry; an empty setting in `url` or an `args` item fails the connection with a message naming it.
// `command` is never templated (the declaration schema rejects placeholders there).
// Phase 14 (ADR-059, W14.1-T8): `transport.oauth.clientId` may hold placeholders too (`resolveDeclOAuth`; an empty
// setting leaves the client id unresolved: the sign-in names the setting, a connection is not affected); the resolved
// OAuth settings ride along in `ResolvedMcpTransport.oauth`. `displayDeclOAuthClientId` resolves the client id of a
// declaration for its DTO from the plugin's non-secret values only (a secret setting is never shown).
import type { McpServerDecl } from '@harness-forge/shared'
import { httpHeaderValueSchema, httpUrlSchema } from '@harness-forge/shared'
import { mcpConfigError } from './errors.ts'

/** The OAuth settings of a resolved http / sse transport (Phase 14): null = not configured. */
export interface ResolvedMcpOAuth {
  clientId: string | null
  scopes: string | null
}

/** A transport with every placeholder resolved (values may be secrets: never log or return them). */
export type ResolvedMcpTransport
  = | { type: 'http' | 'sse', url: string, headers: Record<string, string>, oauth?: ResolvedMcpOAuth }
    | { type: 'stdio', command: string, args: string[], env: Record<string, string> }

/** `transport.oauth` of a declaration (http / sse). */
type DeclOAuth = Extract<McpServerDecl['transport'], { type: 'http' | 'sse' }>['oauth']

/** The client ids the OAuth settings accept (printable ASCII, 1-256 characters). */
const CLIENT_ID_PATTERN = /^[\x20-\x7E]{1,256}$/

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
  const oauth = resolveDeclOAuth(serverId, transport.oauth, settings)
  return {
    type: transport.type,
    url: url.value,
    headers,
    ...(transport.oauth === undefined ? {} : { oauth: { clientId: oauth.clientId, scopes: oauth.scopes } }),
  }
}

/**
 * The OAuth settings of a declaration with the placeholders of its client id resolved (Phase 14, ADR-059): `clientId`
 * null when none is declared or the result is unusable; `missing` = the empty settings the client id needs (the
 * sign-in refuses with a message naming the first one).
 */
export function resolveDeclOAuth(_serverId: string, oauth: DeclOAuth, settings: Readonly<Record<string, unknown>>): ResolvedMcpOAuth & { missing: string[] } {
  const scopes = oauth?.scopes?.replace(/\s+/g, ' ').trim() || null
  if (oauth?.clientId === undefined)
    return { clientId: null, scopes, missing: [] }
  const result = applySettings(oauth.clientId, settings)
  if (result.missing.length > 0)
    return { clientId: null, scopes, missing: result.missing }
  const clientId = result.value.trim()
  return { clientId: CLIENT_ID_PATTERN.test(clientId) ? clientId : null, scopes, missing: [] }
}

/**
 * The client id of a declaration as its DTO shows it (Phase 14): the placeholders filled from the plugin's non-secret
 * setting values (`PluginSettingsView.values`); a placeholder of a secret setting stays as written (a secret value is
 * never shown); null when a non-secret setting is empty. Without placeholders the client id as declared.
 */
export function displayDeclOAuthClientId(template: string | null, values: Readonly<Record<string, unknown>>, secretKeys: ReadonlySet<string> = new Set()): string | null {
  if (template === null)
    return null
  let empty = false
  const shown = template.replace(PLACEHOLDER, (match: string, key: string) => {
    if (secretKeys.has(key))
      return match
    const text = settingText(values[key])
    if (text === '')
      empty = true
    return text
  }).trim()
  return empty || shown === '' ? null : shown
}
