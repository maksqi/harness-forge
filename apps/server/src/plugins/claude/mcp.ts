// MCP servers of a Claude Code plugin (Phase 12, ADR-053; W12.1-T4; server-plugins.md D9, D15): `.mcp.json` (with the
// `mcpServers` wrapper or a flat server map), the `plugin.json` MCP files and its inline server maps, merged in that
// order (a later name wins) and parsed by the shared `parseMcpJson`, then mapped to `McpServerDecl`s:
//
// - ids: one server → `<pluginId>`; several → `<pluginId>-<slug>`; longer than 32 characters (or taken) →
//   `<pluginId>-<4 hex of sha256(name)>`; still too long → skipped with a diagnostic (`MCP_SERVER_ID_PATTERN` stays ≤ 32);
// - the Claude Code name `plugin_<plugin name>_<server name>` (`mcp__plugin_…__<tool>` aliases; `[^A-Za-z0-9_-]` → `_`);
// - variables (never from `process.env`): `${user_config.KEY}` → `{{settings.KEY}}` (a declared option; inside a stdio
//   `command` the server is skipped), every other `${VAR}` / `${VAR:-default}` → `{{settings.env_VAR}}` (a setting of
//   its own; inside a stdio `command` the server is skipped), `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` stay for
//   the registration (literal at load, `register.ts`), `${CLAUDE_PROJECT_DIR}` skips the server (plugin servers are
//   global); `headersHelper`, OAuth settings, bundles and URL sources are diagnostics;
// - stdio servers run with the plugin folder as their working folder (the MCP manager) and only for a trusted plugin;
//   every stdio server declared (even a skipped one) is an executable of the trust consent.
// Values are never logged.
import type { McpServerDecl } from '@harness-forge/plugin-sdk'
import type { ClaudeDiagnostic, ClaudePluginExecutable, ClaudeUserConfigOption, McpJsonRemoteServer, McpJsonStdioServer } from '@harness-forge/shared'
import type { ClaudeMcpServerComponent } from './types.ts'
import type { McpVariableSetting } from './user-config.ts'
import { createHash } from 'node:crypto'
import { FIELD_KEY_PATTERN, httpUrlSchema, MCP_CONFIG_LIMITS, MCP_SERVER_ID_PATTERN, mcpServerIdFromName, parseMcpJson } from '@harness-forge/shared'
import { readFailureMessage, readPluginTextFile } from './files.ts'
import { envSettingKey } from './user-config.ts'

/** The stand-in of `${user_config.KEY}` while `parseMcpJson` reads a server (a valid `.mcp.json` variable name). */
const USER_CONFIG_STAND_IN = '__hfuc_'
/** `${user_config.KEY}` (unescaped is all `.mcp.json` knows: there are no escapes there). */
const USER_CONFIG_REFERENCE = /\$\{user_config\.([A-Z_]\w{0,63})\}/gi
/** Any `${user_config.…}` reference. */
const USER_CONFIG_USE = /\$\{user_config\./i
/** A `.mcp.json` variable reference: `${NAME}` or `${NAME:-default}` (the default runs to the next `}`). */
const VARIABLE_REFERENCE = /\$\{([A-Z_]\w{0,63})(?::-([^}]*))?\}/gi
/** Variables substituted at registration. */
const LOAD_VARIABLES: ReadonlySet<string> = new Set(['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA'])
/** The Claude Code name limit (`McpServerRegisterOptions.claudeName`). */
const CLAUDE_NAME_MAX_CHARS = 128
/** Hosts listed for the inspection. */
const HOSTS_MAX = 100

export interface ClaudeMcpInput {
  /** The plugin folder (canonical realpath). */
  readonly root: string
  /** The plugin id (the server id namespace). */
  readonly pluginId: string
  /** The plugin name as written (`plugin_<name>_<server>`). */
  readonly pluginName: string
  /** `.mcp.json` and the `plugin.json` MCP files, in merge order. */
  readonly files: readonly string[]
  /** The inline server maps of `plugin.json`, in merge order (after the files). */
  readonly inline: readonly Readonly<Record<string, unknown>>[]
  readonly userConfig: readonly ClaudeUserConfigOption[]
}

export interface ClaudeMcpRead {
  readonly servers: readonly ClaudeMcpServerComponent[]
  /** The other `${VAR}` references that became settings `env_<VAR>`. */
  readonly variables: readonly McpVariableSetting[]
  /** Every stdio server declared, as written (what the trust consent lists). */
  readonly executables: readonly ClaudePluginExecutable[]
  /** Hosts of the http / sse servers (defaults of the options filled in). */
  readonly hosts: readonly string[]
  readonly diagnostics: readonly ClaudeDiagnostic[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The server map of a parsed MCP file: its `mcpServers` object, or the file itself as a flat map. */
function serverMapOf(value: Record<string, unknown>): Record<string, unknown> | null {
  if (Object.hasOwn(value, 'mcpServers'))
    return isRecord(value.mcpServers) ? value.mcpServers : null
  return value
}

/** Every string a server can hold references in (command, args, env values, url, header values). */
function serverStrings(server: Record<string, unknown>): string[] {
  const strings: unknown[] = [server.command, server.url]
  if (Array.isArray(server.args))
    strings.push(...server.args)
  if (isRecord(server.env))
    strings.push(...Object.values(server.env))
  if (isRecord(server.headers))
    strings.push(...Object.values(server.headers))
  return strings.filter((value): value is string => typeof value === 'string')
}

/** `server` with `fn` applied to every string field that can hold references. */
function mapServerStrings(server: Record<string, unknown>, fn: (value: string) => string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...server }
  if (typeof copy.command === 'string')
    copy.command = fn(copy.command)
  if (typeof copy.url === 'string')
    copy.url = fn(copy.url)
  if (Array.isArray(copy.args))
    copy.args = copy.args.map(arg => typeof arg === 'string' ? fn(arg) : arg)
  if (isRecord(copy.env))
    copy.env = Object.fromEntries(Object.entries(copy.env).map(([key, value]) => [key, typeof value === 'string' ? fn(value) : value]))
  if (isRecord(copy.headers))
    copy.headers = Object.fromEntries(Object.entries(copy.headers).map(([key, value]) => [key, typeof value === 'string' ? fn(value) : value]))
  return copy
}

/** The command line of a stdio server as written (`command` and its arguments). */
function commandLine(server: Record<string, unknown>): string | null {
  if (typeof server.command !== 'string' || server.command.trim() === '')
    return null
  const args = Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === 'string') : []
  return [server.command.trim(), ...args].join(' ').slice(0, 4096)
}

/** `plugin_<plugin>_<server>` with every character other than letters, digits, `_` and `-` replaced by `_`. */
export function claudeMcpName(pluginName: string, serverName: string): string {
  return `plugin_${pluginName}_${serverName}`.replace(/[^\w-]/g, '_')
}

function shortHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 4)
}

/** The harness id of a server (see the module comment), or null when none fits. */
function serverId(pluginId: string, name: string, single: boolean, taken: ReadonlySet<string>): string | null {
  const candidates = single
    ? [pluginId, `${pluginId}-${shortHash(name)}`]
    : [`${pluginId}-${mcpServerIdFromName(name, new Set())}`, `${pluginId}-${shortHash(name)}`]
  for (const candidate of candidates) {
    if (candidate.length <= MCP_CONFIG_LIMITS.idMaxChars && MCP_SERVER_ID_PATTERN.test(candidate) && !taken.has(candidate))
      return candidate
  }
  return null
}

/** The URL with the options' defaults in place of their placeholders (for the inspection's hosts). */
function hostOf(url: string, defaults: Readonly<Record<string, string>>): string | null {
  const filled = url.replace(/\{\{settings\.(\w+)\}\}/g, (_match, key: string) => defaults[key] ?? '')
  if (!httpUrlSchema.safeParse(filled).success)
    return null
  try {
    return new URL(filled).hostname.slice(0, 253) || null
  }
  catch {
    return null
  }
}

/** Reads and merges the MCP servers of a Claude Code plugin (see the module comment). Never throws. */
export async function readClaudeMcpServers(input: ClaudeMcpInput): Promise<ClaudeMcpRead> {
  const diagnostics: ClaudeDiagnostic[] = []
  const merged = new Map<string, unknown>()
  for (const file of input.files) {
    const read = await readPluginTextFile(input.root, file, MCP_CONFIG_LIMITS.fileBytes)
    if (!read.ok) {
      diagnostics.push({ level: 'error', code: 'read-failed', message: readFailureMessage(file, read.reason, MCP_CONFIG_LIMITS.fileBytes), component: 'mcpServers', path: file })
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(read.text.startsWith('\uFEFF') ? read.text.slice(1) : read.text)
    }
    catch {
      diagnostics.push({ level: 'error', code: 'invalid-json', message: `${file} is not valid JSON; its servers are not used.`, component: 'mcpServers', path: file })
      continue
    }
    const map = isRecord(parsed) ? serverMapOf(parsed) : null
    if (map === null) {
      diagnostics.push({ level: 'error', code: 'not-an-object', message: `${file} must hold an object of servers (with or without the "mcpServers" wrapper).`, component: 'mcpServers', path: file })
      continue
    }
    for (const [name, server] of Object.entries(map))
      merged.set(name, server)
  }
  for (const map of input.inline) {
    for (const [name, server] of Object.entries(map))
      merged.set(name, server)
  }

  const executables: ClaudePluginExecutable[] = []
  const options = new Map(input.userConfig.map(option => [option.key, option]))
  const defaults: Record<string, string> = {}
  for (const option of input.userConfig) {
    if (!option.sensitive && typeof option.default === 'string')
      defaults[option.key] = option.default
  }
  const prepared: Record<string, unknown> = {}
  for (const [name, raw] of merged) {
    const component = `mcpServers.${name.slice(0, 64)}`
    if (!isRecord(raw)) {
      diagnostics.push({ level: 'error', code: 'invalid-server', message: 'The server must be an object; it is skipped.', component })
      continue
    }
    const line = commandLine(raw)
    if (line !== null)
      executables.push({ kind: 'mcp', label: name.slice(0, 200), command: line })
    const server: Record<string, unknown> = { ...raw }
    if (server.headersHelper !== undefined) {
      diagnostics.push({ level: 'info', code: 'unsupported-component', message: 'headersHelper is not supported; the server connects without it.', component })
      delete server.headersHelper
    }
    if (server.oauth !== undefined) {
      diagnostics.push({ level: 'info', code: 'unsupported-component', message: 'OAuth settings of MCP servers are not supported; the server connects without them.', component })
      delete server.oauth
    }
    const strings = serverStrings(server)
    if (strings.some(value => /\$\{CLAUDE_PROJECT_DIR\}/.test(value))) {
      diagnostics.push({ level: 'warning', code: 'unsupported-component', message: `The server uses \${CLAUDE_PROJECT_DIR}; plugin MCP servers are global, so it is skipped.`, component })
      continue
    }
    if (typeof server.command === 'string' && USER_CONFIG_USE.test(server.command)) {
      diagnostics.push({ level: 'warning', code: 'invalid-server', message: 'The server command uses a user_config value; only its arguments and environment may. It is skipped.', component })
      continue
    }
    const undeclared = strings.flatMap(value => [...value.matchAll(USER_CONFIG_REFERENCE)].map(match => match[1] as string))
      .filter(key => !options.has(key) || !FIELD_KEY_PATTERN.test(key) || key.length + USER_CONFIG_STAND_IN.length > 64)
    if (undeclared.length > 0) {
      diagnostics.push({ level: 'warning', code: 'invalid-server', message: `The server uses the option ${undeclared[0]}, which the plugin does not declare as a setting; it is skipped.`, component })
      continue
    }
    prepared[name] = mapServerStrings(server, value => value.replace(USER_CONFIG_REFERENCE, (_match, key: string) => `\${${USER_CONFIG_STAND_IN}${key}}`))
  }

  const parsed = parseMcpJson(JSON.stringify({ mcpServers: prepared }))
  for (const item of parsed.diagnostics)
    diagnostics.push({ level: item.level, code: item.code, message: item.message, component: item.server === undefined ? 'mcpServers' : `mcpServers.${item.server.slice(0, 64)}` })

  const variables = new Map<string, string | null>()
  const ready: { name: string, transport: McpServerDecl['transport'] }[] = []
  for (const server of parsed.servers) {
    const component = `mcpServers.${server.name.slice(0, 64)}`
    let skipped = false
    const convert = (value: string, inCommand: boolean): string => value.replace(VARIABLE_REFERENCE, (match: string, variable: string, fallback: string | undefined) => {
      if (variable.startsWith(USER_CONFIG_STAND_IN))
        return `{{settings.${variable.slice(USER_CONFIG_STAND_IN.length)}}}`
      if (LOAD_VARIABLES.has(variable))
        return match
      if (variable.startsWith('CLAUDE_')) {
        diagnostics.push({ level: 'info', code: 'invalid-variable', message: `\${${variable}} is not known to MCP servers; it stays as written.`, component })
        return match
      }
      const key = envSettingKey(variable)
      if (inCommand || key === null) {
        skipped = true
        return match
      }
      const known = variables.get(variable)
      if (!variables.has(variable) || (known === null && fallback !== undefined && fallback !== ''))
        variables.set(variable, fallback !== undefined && fallback !== '' ? fallback : known ?? null)
      return `{{settings.${key}}}`
    })
    let transport: McpServerDecl['transport']
    if (server.transport.type === 'stdio') {
      const stdio = server.transport as McpJsonStdioServer
      const command = convert(stdio.command, true)
      const args = stdio.args.map(arg => convert(arg, false))
      const env = Object.fromEntries(Object.entries(stdio.env).map(([key, value]) => [key, convert(value, false)]))
      transport = { type: 'stdio', command, ...(args.length === 0 ? {} : { args }), ...(Object.keys(env).length === 0 ? {} : { env }) }
    }
    else {
      const remote = server.transport as McpJsonRemoteServer
      const headers = Object.fromEntries(Object.entries(remote.headers).map(([key, value]) => [key, convert(value, false)]))
      transport = { type: remote.type, url: convert(remote.url, false), ...(Object.keys(headers).length === 0 ? {} : { headers }) }
    }
    if (skipped) {
      diagnostics.push({ level: 'warning', code: 'invalid-variable', message: 'The server command uses a variable that only arguments and the environment may use; it is skipped.', component })
      continue
    }
    ready.push({ name: server.name, transport })
  }

  const taken = new Set<string>()
  const servers: ClaudeMcpServerComponent[] = []
  const hosts: string[] = []
  for (const { name, transport } of ready) {
    const component = `mcpServers.${name.slice(0, 64)}`
    const id = serverId(input.pluginId, name, ready.length === 1, taken)
    if (id === null) {
      diagnostics.push({ level: 'warning', code: 'invalid-server', message: `No MCP server id of at most ${MCP_CONFIG_LIMITS.idMaxChars} characters fits the plugin id; the server is skipped.`, component })
      continue
    }
    taken.add(id)
    const claudeName = claudeMcpName(input.pluginName, name)
    if (claudeName.length > CLAUDE_NAME_MAX_CHARS)
      diagnostics.push({ level: 'info', code: 'invalid-server', message: 'The Claude Code tool names of this server are too long; its tools are only known by their harness names.', component })
    const decl: McpServerDecl = { id, name: name.trim().slice(0, 64) || id, transport }
    servers.push({ name, id, claudeName: claudeName.length > CLAUDE_NAME_MAX_CHARS ? '' : claudeName, decl })
    if (transport.type !== 'stdio') {
      const host = hostOf(transport.url, defaults)
      if (host !== null && !hosts.includes(host) && hosts.length < HOSTS_MAX)
        hosts.push(host)
    }
  }
  return {
    servers,
    variables: [...variables].map(([name, defaultValue]) => ({ name, defaultValue })),
    executables,
    hosts,
    diagnostics,
  }
}
