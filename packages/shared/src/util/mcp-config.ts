/**
 * Project `.mcp.json` (Phase 11, ADR-050): `{ "mcpServers": { "<name>": { "type"?, "command", "args"?, "env"? } |
 * { "type": "http" | "sse", "url", "headers"? } } }`. The type is inferred (`command` → `stdio`, else `type ?? http`);
 * only `http:` / `https:` URLs are accepted. `${VAR}` / `${VAR:-default}` references in `command`, `args`, `env`
 * values, `url` and `headers` values are expanded only from values the user stored for the project — this module
 * never reads the server environment, and any other `$…` stays literal. Pure and isomorphic; never throws.
 * Contract skeleton written by the coordinator in P11-0a (K1); implemented by C35.
 *
 * Variable grammar: `${NAME}` or `${NAME:-default}`, `NAME` matching `MCP_VARIABLE_NAME_PATTERN`; a default is literal
 * text up to the next `}` (no nesting, no escapes; `${A:-${B}}` is `A` with the default `${B` followed by a literal
 * `}`); `$NAME`, `$$`, `${}` and any other `${…}` stay literal. Like `${VAR:-default}` in a POSIX shell, an empty value
 * uses the default.
 *
 * URL rule: a `url` without variables must parse as an `http:` / `https:` URL; a `url` with variables must start with
 * `http://` / `https://` or with a variable (`${BASE:-https://example.invalid}/mcp`), and the server checks the
 * expanded URL again with `isAllowedMcpUrl` before it connects.
 */

export const MCP_JSON_TRANSPORTS = ['stdio', 'http', 'sse'] as const
export type McpJsonTransport = (typeof MCP_JSON_TRANSPORTS)[number]

/** Names of `.mcp.json` variables (`${NAME}`). */
export const MCP_VARIABLE_NAME_PATTERN = /^[A-Z_]\w{0,63}$/i

/** Mirrored by the Phase 11 group of `LIMITS`. */
export const MCP_CONFIG_LIMITS = {
  fileBytes: 262_144,
  serversMax: 20,
  argsMax: 64,
  envMax: 64,
  headersMax: 32,
  valueMaxChars: 4096,
  variablesMax: 50,
  /** Server ids are cut to this many characters. */
  idMaxChars: 32,
} as const

export const MCP_CONFIG_DIAGNOSTIC_CODES = [
  'invalid-json',
  'not-an-object',
  'too-large',
  'missing-servers',
  'invalid-server',
  'invalid-url',
  'unsupported-type',
  'invalid-variable',
  'too-many',
  'id-collision',
  'ignored-field',
] as const
export type McpConfigDiagnosticCode = (typeof MCP_CONFIG_DIAGNOSTIC_CODES)[number]

export interface McpConfigDiagnostic {
  readonly level: 'error' | 'warning' | 'info'
  readonly code: McpConfigDiagnosticCode
  /** One English sentence; never quotes values. */
  readonly message: string
  /** The `.mcp.json` server name, when the diagnostic is about one server. */
  readonly server?: string
}

export interface McpJsonStdioServer {
  readonly type: 'stdio'
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

export interface McpJsonRemoteServer {
  readonly type: 'http' | 'sse'
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

export interface McpJsonServer {
  /** The name as written in `.mcp.json` (used in Claude Code tool names `mcp__<name>__<tool>`). */
  readonly name: string
  /** The harness server id (`mcpServerIdFromName`). */
  readonly id: string
  /** The normalized transport, still with `${VAR}` references. */
  readonly transport: McpJsonStdioServer | McpJsonRemoteServer
  /** The raw server object as parsed (hashed by `trustHashInput`). */
  readonly raw: unknown
}

export interface ParseMcpJsonResult {
  readonly servers: readonly McpJsonServer[]
  readonly diagnostics: readonly McpConfigDiagnostic[]
}

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

/** Server names longer than this are invalid (Claude Code tool names embed them). */
const SERVER_NAME_MAX_CHARS = 64
/** Environment variable names of a stdio server. */
const ENV_NAME_PATTERN = /^[A-Z_]\w{0,127}$/i
/** HTTP header names (RFC 9110 tokens). */
const HEADER_NAME_PATTERN = /^[\w!#$%&'*+.^`|~-]{1,128}$/
/** `ignored-field` diagnostics reported one by one per server. */
const IGNORED_FIELDS_SHOWN_MAX = 10

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** UTF-8 length of `text`; stops counting once it passes `limit`. */
function utf8LengthUpTo(text: string, limit: number): number {
  let bytes = 0
  for (let index = 0; index < text.length && bytes <= limit; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
    }
    else if (code < 0x800) {
      bytes += 2
    }
    else if (code >= 0xD800 && code <= 0xDBFF && (text.charCodeAt(index + 1) & 0xFC00) === 0xDC00) {
      bytes += 4
      index++
    }
    else {
      bytes += 3
    }
  }
  return bytes
}

function formatBytes(bytes: number): string {
  return bytes % 1024 === 0 ? `${bytes / 1024} KiB` : `${bytes} bytes`
}

/** True for C0 control characters, DEL and the C1 range. */
function hasControl(value: string, allowed = ''): boolean {
  for (let index = 0; index < value.length; index++) {
    const char = value[index] as string
    const code = value.charCodeAt(index)
    if (((code < 0x20 || (code >= 0x7F && code <= 0x9F)) && !allowed.includes(char)))
      return true
  }
  return false
}

function diagnostic(level: McpConfigDiagnostic['level'], code: McpConfigDiagnosticCode, message: string, server?: string): McpConfigDiagnostic {
  return server === undefined ? { level, code, message } : { level, code, message, server }
}

/** A variable reference found by `scanTemplate`. */
interface TemplateRef {
  readonly start: number
  /** Exclusive end (after the `}`). */
  readonly end: number
  readonly name: string
  readonly defaultValue: string | null
}

interface TemplateScan {
  readonly refs: readonly TemplateRef[]
  /** `${` sequences that are not a valid reference (they stay literal). */
  readonly invalid: number
}

/** Finds the `${NAME}` / `${NAME:-default}` references of a string in one pass (see the module comment). */
function scanTemplate(template: string): TemplateScan {
  const refs: TemplateRef[] = []
  let invalid = 0
  let index = template.indexOf('${')
  while (index !== -1) {
    const close = template.indexOf('}', index + 2)
    if (close === -1) {
      invalid++
      break
    }
    const inner = template.slice(index + 2, close)
    const separator = inner.indexOf(':-')
    const name = separator === -1 ? inner : inner.slice(0, separator)
    if (MCP_VARIABLE_NAME_PATTERN.test(name)) {
      refs.push({ start: index, end: close + 1, name, defaultValue: separator === -1 ? null : inner.slice(separator + 2) })
      index = template.indexOf('${', close + 1)
    }
    else {
      invalid++
      index = template.indexOf('${', index + 2)
    }
  }
  return { refs, invalid }
}

// ---------------------------------------------------------------------------------------------------------------------
// Variables

export interface McpVariableRef {
  readonly name: string
  /** The `:-default` value; null = no default. */
  readonly defaultValue: string | null
}

/** The `${VAR}` / `${VAR:-default}` references of one string, in order, without duplicates. */
export function extractVariables(template: string): McpVariableRef[] {
  if (typeof template !== 'string')
    return []
  const seen = new Set<string>()
  const result: McpVariableRef[] = []
  for (const ref of scanTemplate(template).refs) {
    const key = `${ref.name}\u0000${ref.defaultValue ?? '\u0001'}`
    if (seen.has(key))
      continue
    seen.add(key)
    result.push({ name: ref.name, defaultValue: ref.defaultValue })
  }
  return result
}

/** The strings of a transport that may hold references, in order: command, args, env values, url, header values. */
function templatesOf(transport: McpJsonStdioServer | McpJsonRemoteServer): string[] {
  if (!isRecord(transport))
    return []
  const strings: unknown[] = []
  if (transport.type === 'stdio') {
    strings.push(transport.command)
    if (Array.isArray(transport.args))
      strings.push(...transport.args)
    if (isRecord(transport.env))
      strings.push(...Object.values(transport.env))
  }
  else {
    strings.push(transport.url)
    if (isRecord(transport.headers))
      strings.push(...Object.values(transport.headers))
  }
  return strings.filter((value): value is string => typeof value === 'string')
}

/**
 * Every variable a server references (command, args, env values, url, header values), one entry per name in first-use
 * order; the entry has no default (`defaultValue: null`) when any use of the name has none.
 */
export function serverVariables(transport: McpJsonStdioServer | McpJsonRemoteServer): McpVariableRef[] {
  const byName = new Map<string, McpVariableRef>()
  for (const template of templatesOf(transport)) {
    for (const ref of scanTemplate(template).refs) {
      const known = byName.get(ref.name)
      if (known === undefined)
        byName.set(ref.name, { name: ref.name, defaultValue: ref.defaultValue })
      else if (known.defaultValue !== null && ref.defaultValue === null)
        byName.set(ref.name, { name: ref.name, defaultValue: null })
    }
  }
  return [...byName.values()]
}

export type ExpandVariablesResult
  = | { readonly ok: true, readonly value: string }
    | { readonly ok: false, readonly missing: readonly string[] }

/**
 * Expands `${VAR}` / `${VAR:-default}` from `values` only (own string properties); a reference with neither a value
 * nor a default is missing. An empty value uses the default when there is one.
 */
export function expandVariables(template: string, values: Readonly<Record<string, string>>): ExpandVariablesResult {
  if (typeof template !== 'string')
    return { ok: true, value: '' }
  const source = typeof values === 'object' && values !== null ? values : {}
  const missing: string[] = []
  let value = ''
  let cursor = 0
  for (const ref of scanTemplate(template).refs) {
    value += template.slice(cursor, ref.start)
    cursor = ref.end
    const own = Object.hasOwn(source, ref.name) ? (source as Record<string, unknown>)[ref.name] : undefined
    const stored = typeof own === 'string' ? own : null
    if (stored !== null && (stored !== '' || ref.defaultValue === null))
      value += stored
    else if (ref.defaultValue !== null)
      value += ref.defaultValue
    else if (!missing.includes(ref.name))
      missing.push(ref.name)
  }
  if (missing.length > 0)
    return { ok: false, missing }
  return { ok: true, value: value + template.slice(cursor) }
}

/** True when `url` (already expanded) is an absolute `http:` / `https:` URL with a host. */
export function isAllowedMcpUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length > MCP_CONFIG_LIMITS.valueMaxChars || hasControl(url) || /\s/.test(url))
    return false
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== ''
  }
  catch {
    return false
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Ids

/** Lowercase, `[\s_.]` → `-`, other characters dropped, ≤ 32 characters, `server` when empty, `-2` … when taken. */
export function mcpServerIdFromName(name: string, taken: ReadonlySet<string>): string {
  const max = MCP_CONFIG_LIMITS.idMaxChars
  const raw = typeof name === 'string' ? name.slice(0, 1024) : ''
  let base = raw
    .toLowerCase()
    .replace(/[\s_.]+/g, '-')
    .replace(/[^\da-z-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, max)
    .replace(/-+$/, '')
  if (base === '')
    base = 'server'
  const used: ReadonlySet<string> = typeof taken === 'object' && taken !== null && typeof taken.has === 'function' ? taken : new Set()
  if (!used.has(base))
    return base
  for (let counter = 2; ; counter++) {
    const suffix = `-${counter}`
    const head = base.slice(0, max - suffix.length).replace(/-+$/, '')
    const candidate = `${head === '' ? 'server' : head}${suffix}`
    if (!used.has(candidate))
      return candidate
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Parsing

interface ServerReading {
  readonly transport: McpJsonStdioServer | McpJsonRemoteServer | null
  readonly diagnostics: McpConfigDiagnostic[]
}

const STDIO_FIELDS = new Set(['type', 'command', 'args', 'env'])
const REMOTE_FIELDS = new Set(['type', 'url', 'headers'])

function checkValue(value: string, what: string, name: string, diagnostics: McpConfigDiagnostic[], allowedControl = ''): boolean {
  if (value.length > MCP_CONFIG_LIMITS.valueMaxChars) {
    diagnostics.push(diagnostic('error', 'invalid-server', `The ${what} is longer than ${MCP_CONFIG_LIMITS.valueMaxChars} characters.`, name))
    return false
  }
  if (value.includes('\0') || hasControl(value, allowedControl)) {
    diagnostics.push(diagnostic('error', 'invalid-server', `The ${what} contains a control character.`, name))
    return false
  }
  const invalid = scanTemplate(value).invalid
  if (invalid > 0)
    diagnostics.push(diagnostic('warning', 'invalid-variable', `The ${what} holds a "\${" that is not a variable reference; it stays as written.`, name))
  return true
}

function readStringMap(value: unknown, what: 'env' | 'headers', name: string, diagnostics: McpConfigDiagnostic[]): Record<string, string> | null {
  if (value === undefined || value === null)
    return {}
  if (!isRecord(value)) {
    diagnostics.push(diagnostic('error', 'invalid-server', `The ${what === 'env' ? 'environment' : 'headers'} must be an object of text values.`, name))
    return null
  }
  const entries = Object.entries(value)
  const max = what === 'env' ? MCP_CONFIG_LIMITS.envMax : MCP_CONFIG_LIMITS.headersMax
  if (entries.length > max) {
    diagnostics.push(diagnostic('error', 'too-many', `The ${what === 'env' ? 'environment has' : 'headers have'} more than ${max} entries.`, name))
    return null
  }
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, entry] of entries) {
    const pattern = what === 'env' ? ENV_NAME_PATTERN : HEADER_NAME_PATTERN
    if (!pattern.test(key)) {
      diagnostics.push(diagnostic('error', 'invalid-server', what === 'env' ? 'An environment variable name is not valid.' : 'A header name is not valid.', name))
      return null
    }
    if (typeof entry !== 'string') {
      diagnostics.push(diagnostic('error', 'invalid-server', what === 'env' ? 'Environment values must be text.' : 'Header values must be text.', name))
      return null
    }
    if (!checkValue(entry, what === 'env' ? 'environment value' : 'header value', name, diagnostics, what === 'env' ? '\t\n' : '\t'))
      return null
    result[key] = entry
  }
  return { ...result }
}

function reportIgnored(server: Record<string, unknown>, known: ReadonlySet<string>, name: string, diagnostics: McpConfigDiagnostic[]): void {
  let shown = 0
  for (const key of Object.keys(server)) {
    if (known.has(key))
      continue
    shown++
    if (shown <= IGNORED_FIELDS_SHOWN_MAX)
      diagnostics.push(diagnostic('info', 'ignored-field', `The field "${key.slice(0, 64).replace(/[\p{Cc}\p{Cf}]/gu, '?')}" is ignored.`, name))
  }
}

function readStdio(server: Record<string, unknown>, name: string): ServerReading {
  const diagnostics: McpConfigDiagnostic[] = []
  if (server.type !== undefined && server.type !== 'stdio')
    diagnostics.push(diagnostic('warning', 'ignored-field', 'A server with a command runs as a stdio server; its type is ignored.', name))
  const command = server.command
  if (typeof command !== 'string' || command.trim() === '') {
    diagnostics.push(diagnostic('error', 'invalid-server', 'The command must be non-empty text.', name))
    return { transport: null, diagnostics }
  }
  if (!checkValue(command, 'command', name, diagnostics))
    return { transport: null, diagnostics }
  let args: string[] = []
  if (server.args !== undefined && server.args !== null) {
    if (!Array.isArray(server.args)) {
      diagnostics.push(diagnostic('error', 'invalid-server', 'The arguments must be a list of text values.', name))
      return { transport: null, diagnostics }
    }
    if (server.args.length > MCP_CONFIG_LIMITS.argsMax) {
      diagnostics.push(diagnostic('error', 'too-many', `The server has more than ${MCP_CONFIG_LIMITS.argsMax} arguments.`, name))
      return { transport: null, diagnostics }
    }
    for (const arg of server.args) {
      if (typeof arg !== 'string') {
        diagnostics.push(diagnostic('error', 'invalid-server', 'The arguments must be a list of text values.', name))
        return { transport: null, diagnostics }
      }
      if (!checkValue(arg, 'argument', name, diagnostics, '\t\n'))
        return { transport: null, diagnostics }
    }
    args = [...server.args] as string[]
  }
  const env = readStringMap(server.env, 'env', name, diagnostics)
  if (env === null)
    return { transport: null, diagnostics }
  reportIgnored(server, STDIO_FIELDS, name, diagnostics)
  return { transport: { type: 'stdio', command: command.trim(), args, env }, diagnostics }
}

function checkUrlTemplate(url: string): boolean {
  if (scanTemplate(url).refs.length === 0)
    return isAllowedMcpUrl(url)
  if (/\s/.test(url))
    return false
  return /^https?:\/\//i.test(url) || url.startsWith('${')
}

function readRemote(server: Record<string, unknown>, name: string): ServerReading {
  const diagnostics: McpConfigDiagnostic[] = []
  const type = server.type ?? 'http'
  if (type !== 'http' && type !== 'sse') {
    const message = type === 'stdio'
      ? 'A stdio server needs a command.'
      : 'The server type is not supported; use "stdio", "http" or "sse".'
    diagnostics.push(diagnostic('error', type === 'stdio' ? 'invalid-server' : 'unsupported-type', message, name))
    return { transport: null, diagnostics }
  }
  const url = server.url
  if (typeof url !== 'string' || url.trim() === '') {
    diagnostics.push(diagnostic('error', 'invalid-url', 'The server needs a URL.', name))
    return { transport: null, diagnostics }
  }
  if (!checkValue(url, 'URL', name, diagnostics))
    return { transport: null, diagnostics }
  if (!checkUrlTemplate(url.trim())) {
    diagnostics.push(diagnostic('error', 'invalid-url', 'The URL must be an http or https URL.', name))
    return { transport: null, diagnostics }
  }
  const headers = readStringMap(server.headers, 'headers', name, diagnostics)
  if (headers === null)
    return { transport: null, diagnostics }
  reportIgnored(server, REMOTE_FIELDS, name, diagnostics)
  return { transport: { type, url: url.trim(), headers }, diagnostics }
}

function readServer(name: string, value: unknown): ServerReading {
  if (name.trim() === '' || name.length > SERVER_NAME_MAX_CHARS || hasControl(name)) {
    const message = name.length > SERVER_NAME_MAX_CHARS
      ? `A server name is longer than ${SERVER_NAME_MAX_CHARS} characters.`
      : 'A server name is empty or contains a control character.'
    return { transport: null, diagnostics: [diagnostic('error', 'invalid-server', message)] }
  }
  if (!isRecord(value))
    return { transport: null, diagnostics: [diagnostic('error', 'invalid-server', 'The server must be an object.', name)] }
  return value.command !== undefined ? readStdio(value, name) : readRemote(value, name)
}

function parseUnchecked(text: string, maxBytes: number): ParseMcpJsonResult {
  if (utf8LengthUpTo(text, maxBytes) > maxBytes)
    return { servers: [], diagnostics: [diagnostic('error', 'too-large', `The file is larger than ${formatBytes(maxBytes)}.`)] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text)
  }
  catch {
    return { servers: [], diagnostics: [diagnostic('error', 'invalid-json', 'The file is not valid JSON.')] }
  }
  if (!isRecord(parsed))
    return { servers: [], diagnostics: [diagnostic('error', 'not-an-object', 'The file must hold a JSON object.')] }
  const diagnostics: McpConfigDiagnostic[] = []
  for (const key of Object.keys(parsed)) {
    if (key !== 'mcpServers')
      diagnostics.push(diagnostic('info', 'ignored-field', `The top-level field "${key.slice(0, 64).replace(/[\p{Cc}\p{Cf}]/gu, '?')}" is ignored.`))
  }
  const servers = parsed.mcpServers
  if (!isRecord(servers)) {
    const message = servers === undefined ? 'The file has no "mcpServers" object.' : '"mcpServers" must be an object.'
    diagnostics.push(diagnostic('error', 'missing-servers', message))
    return { servers: [], diagnostics }
  }
  const result: McpJsonServer[] = []
  const taken = new Set<string>()
  const names = Object.keys(servers)
  if (names.length > MCP_CONFIG_LIMITS.serversMax) {
    const more = names.length - MCP_CONFIG_LIMITS.serversMax
    diagnostics.push(diagnostic('warning', 'too-many', `The file has more than ${MCP_CONFIG_LIMITS.serversMax} servers; ${more} ${more === 1 ? 'was' : 'were'} skipped.`))
  }
  const variables = new Set<string>()
  for (const name of names.slice(0, MCP_CONFIG_LIMITS.serversMax)) {
    const raw = servers[name]
    const reading = readServer(name, raw)
    diagnostics.push(...reading.diagnostics)
    if (reading.transport === null)
      continue
    const id = mcpServerIdFromName(name, taken)
    const preferred = mcpServerIdFromName(name, new Set())
    if (id !== preferred)
      diagnostics.push(diagnostic('info', 'id-collision', `Another server already uses the id "${preferred}"; this one uses "${id}".`, name))
    taken.add(id)
    for (const ref of serverVariables(reading.transport))
      variables.add(ref.name)
    result.push({ name, id, transport: reading.transport, raw })
  }
  if (variables.size > MCP_CONFIG_LIMITS.variablesMax)
    diagnostics.push(diagnostic('warning', 'too-many', `The servers use more than ${MCP_CONFIG_LIMITS.variablesMax} variables.`))
  return { servers: result, diagnostics }
}

/** Parses a `.mcp.json` text (byte cap before `JSON.parse`; `maxBytes` may only lower `MCP_CONFIG_LIMITS.fileBytes`). */
export function parseMcpJson(text: string, options?: { readonly maxBytes?: number }): ParseMcpJsonResult {
  const requested = options?.maxBytes
  const maxBytes = typeof requested === 'number' && !Number.isNaN(requested)
    ? Math.max(0, Math.min(Math.floor(requested), MCP_CONFIG_LIMITS.fileBytes))
    : MCP_CONFIG_LIMITS.fileBytes
  try {
    return parseUnchecked(typeof text === 'string' ? text : '', maxBytes)
  }
  catch {
    return { servers: [], diagnostics: [diagnostic('error', 'invalid-json', 'The file could not be read.')] }
  }
}
