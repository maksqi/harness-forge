/**
 * Claude Code plugins and marketplaces (Phase 12, ADR-053 / ADR-054): the only parser of a Claude Code plugin's
 * `.claude-plugin/plugin.json` and of a marketplace's `.claude-plugin/marketplace.json`, the plugin id rule, the
 * marketplace-entry overlay (`strict`), the plugin variables (`${CLAUDE_PLUGIN_ROOT}`, `${user_config.KEY}`, …), the
 * `userConfig` → plugin settings mapping and the "Add marketplace" shorthand. The server reads files and builds the
 * plugin from these results (`S/plugins/claude/**`, `S/plugins/marketplaces/**`); the web uses the shorthand parser.
 * Pure and isomorphic: no I/O, no zod, never throws on any input (problems are diagnostics).
 * Contract skeleton written by the coordinator in P12-0a; implemented by C41. Adding members is fine; renaming or
 * removing one is a CCR.
 *
 * Import note: never import `limits.ts` or `enums.ts` here (`CLAUDE_PLUGIN_LIMITS` is mirrored by the Phase 12 group of
 * `LIMITS`).
 *
 * `plugin.json` reading (Claude Code `plugins/manifest-reference`): `name` is the only required field (no blanks, `@`,
 * `:`, `/`, `\` or control characters; not kebab-case and the names Claude Code reserves (`claude-…`, `anthropic-…`,
 * `cc-plugin-…`, "official") are warnings). Metadata fields are type-checked and cut; a bad one is dropped with an
 * `invalid-field` warning. Component path fields take a path, a list, or (commands, hooks, mcpServers) inline objects;
 * every path must start with `./` (`invalid-path` warning, dropped) and must not contain a `..` segment
 * (`path-outside-root` error, dropped); paths are stored normalized without the leading `./` (the root is `.`).
 * Unknown top-level keys are dropped with an `unknown-field` warning (Claude Code does the same); the keys Claude Code
 * knows but this harness does not run (`lspServers`, `channels`, `themes`, `monitors`, `workflows`, `settings`,
 * `dependencies`, `experimental`, `types`) are listed in `unsupported` with an `unsupported-component` info.
 * Directory-only fields (`$schema`, `metadata`, `icon`, `documentationUrl`, …) are ignored silently.
 * A manifest is null only when the file itself is unusable: too large, not JSON, not an object, no usable `name`.
 */
import { FIELD_KEY_PATTERN } from '../ids.ts'
import { fnv1a32Hex } from './hash.ts'
import { isHttpUrl, parseHttpUrl } from './url.ts'

/** Mirrored by the Phase 12 group of `LIMITS`. */
export const CLAUDE_PLUGIN_LIMITS = {
  /** `plugin.json` and `marketplace.json` bytes, checked before `JSON.parse`. */
  manifestBytes: 262_144,
  marketplaceJsonBytes: 1_048_576,
  marketplaceEntriesMax: 1000,
  /** Components of one kind a plugin may register (output styles: `outputStylesMax`). */
  componentsPerKindMax: 100,
  outputStylesMax: 20,
  /** `userConfig` options mapped to plugin settings (`SETTINGS_PROPERTIES_MAX`). */
  userConfigMax: 50,
  /** Plugin ids (`PLUGIN_ID_PATTERN`). */
  pluginIdMaxChars: 40,
  /** Qualified catalog names `<pluginId>:<seg>…:<name>` (`QUALIFIED_NAME_PATTERN`). */
  qualifiedNameMaxChars: 128,
  qualifiedSegmentsMax: 3,
  diagnosticsMax: 200,
} as const

export const CLAUDE_PLUGIN_DIAGNOSTIC_CODES = [
  'invalid-json',
  'too-large',
  'not-an-object',
  'missing-name',
  'invalid-name',
  'invalid-field',
  'unknown-field',
  'invalid-path',
  'path-outside-root',
  'unsupported-component',
  'unsupported-source',
  'invalid-source',
  'invalid-user-config',
  'conflicting-manifests',
  'reserved-name',
  'too-many',
] as const
export type ClaudePluginDiagnosticCode = (typeof CLAUDE_PLUGIN_DIAGNOSTIC_CODES)[number]

export interface ClaudePluginDiagnostic {
  readonly level: 'error' | 'warning' | 'info'
  readonly code: ClaudePluginDiagnosticCode
  /** One English sentence; never quotes secret values. */
  readonly message: string
  /** The JSON field or component the diagnostic is about (`commands`, `plugins[3].source`, …). */
  readonly field?: string
}

export interface ClaudePluginAuthor {
  readonly name: string
  readonly email?: string
  readonly url?: string
}

export const CLAUDE_USER_CONFIG_TYPES = ['string', 'number', 'boolean', 'directory', 'file'] as const
export type ClaudeUserConfigType = (typeof CLAUDE_USER_CONFIG_TYPES)[number]

export interface ClaudeUserConfigOption {
  /** The key as referenced by `${user_config.KEY}` and `CLAUDE_PLUGIN_OPTION_<KEY>`. */
  readonly key: string
  readonly type: ClaudeUserConfigType
  readonly title: string
  readonly description?: string
  readonly required: boolean
  readonly default?: string | number | boolean | readonly string[]
  readonly options?: readonly string[]
  readonly multiple: boolean
  readonly sensitive: boolean
  readonly min?: number
  readonly max?: number
}

/**
 * A component path field of `plugin.json` (`skills`, `agents`, `outputStyles`, the file forms of `commands`, `hooks`,
 * `mcpServers`): plugin-relative paths that start with `./` and stay inside the root (validated, normalized POSIX).
 * Stored without the leading `./` (`commands/extra`, `agents/reviewer.md`); the plugin root itself is `.`.
 */
export type ClaudeComponentPaths = readonly string[]

/** One entry of the object form of `commands` (`{ "about": { "source" | "content", … } }`). */
export interface ClaudeInlineCommand {
  readonly name: string
  readonly source?: string
  readonly content?: string
  readonly description?: string
  readonly argumentHint?: string
  readonly model?: string
  readonly allowedTools?: readonly string[]
}

/** The component fields whose paths replace the default folder scan (`commands/`, `agents/`, `output-styles/`). */
export const CLAUDE_REPLACING_COMPONENTS = ['commands', 'agents', 'outputStyles'] as const
export type ClaudeReplacingComponent = (typeof CLAUDE_REPLACING_COMPONENTS)[number]

export interface ClaudePluginManifest {
  readonly name: string
  readonly displayName?: string
  /** The raw version string (any string; not necessarily semver). */
  readonly version?: string
  readonly description?: string
  readonly author?: ClaudePluginAuthor
  readonly homepage?: string
  readonly repository?: string
  readonly license?: string
  readonly keywords: readonly string[]
  /** Default true; false installs the plugin disabled. */
  readonly defaultEnabled: boolean
  /** Replace the default `commands/` scan when present (the paths, and the inline commands of the object form). */
  readonly commands?: { readonly paths: ClaudeComponentPaths, readonly inline: readonly ClaudeInlineCommand[] }
  /** Replace the default `agents/` scan when present. */
  readonly agents?: ClaudeComponentPaths
  /** Added to the default `skills/` scan. */
  readonly skills?: ClaudeComponentPaths
  /** Replace the default `output-styles/` scan when present. */
  readonly outputStyles?: ClaudeComponentPaths
  /** Merged with `hooks/hooks.json`: files (each with the `{ "hooks": … }` wrapper) and inline event maps. */
  readonly hooks?: { readonly files: ClaudeComponentPaths, readonly inline: readonly unknown[] }
  /** Merged with `.mcp.json`: files (wrapper or flat map) and inline server maps; bundles / URLs are unsupported. */
  readonly mcpServers?: { readonly files: ClaudeComponentPaths, readonly inline: readonly Readonly<Record<string, unknown>>[] }
  readonly userConfig: readonly ClaudeUserConfigOption[]
  /** Top-level fields that are known to Claude Code but not supported here (`lspServers`, `channels`, …). */
  readonly unsupported: readonly string[]
  /**
   * Set by `mergeEntryOverlay` only: replacing component fields (`commands`, `agents`, `outputStyles`) whose paths are
   * ADDED to the default folder scan instead of replacing it (a `strict: true` marketplace entry appended its list to a
   * `plugin.json` that did not declare the field). Absent = every present field replaces its default scan.
   */
  readonly appendToDefault?: readonly ClaudeReplacingComponent[]
}

export interface ParseClaudePluginManifestResult {
  /** Null when the file is unusable (an `error` diagnostic says why). */
  readonly manifest: ClaudePluginManifest | null
  readonly diagnostics: readonly ClaudePluginDiagnostic[]
}

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

type Level = ClaudePluginDiagnostic['level']

interface Collector {
  readonly list: ClaudePluginDiagnostic[]
  dropped: number
}

/** Field names shown in diagnostics are cut to this many characters. */
const FIELD_SHOWN_MAX = 80
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/gu
const HAS_CONTROL = /[\p{Cc}\p{Cf}]/u

function newCollector(): Collector {
  return { list: [], dropped: 0 }
}

function shown(text: string): string {
  const clean = text.replace(CONTROL_CHARACTERS, '?')
  return clean.length > FIELD_SHOWN_MAX ? `${clean.slice(0, FIELD_SHOWN_MAX)}...` : clean
}

function report(collector: Collector, level: Level, code: ClaudePluginDiagnosticCode, message: string, field?: string): void {
  if (collector.list.length >= CLAUDE_PLUGIN_LIMITS.diagnosticsMax - 1) {
    collector.dropped++
    return
  }
  collector.list.push(field === undefined ? { level, code, message } : { level, code, message, field: shown(field) })
}

function finish(collector: Collector): ClaudePluginDiagnostic[] {
  if (collector.dropped === 0)
    return collector.list
  return [...collector.list, { level: 'info', code: 'too-many', message: `${collector.dropped} more problems were found.` }]
}

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
  if (bytes % 1_048_576 === 0)
    return `${bytes / 1_048_576} MiB`
  return bytes % 1024 === 0 ? `${bytes / 1024} KiB` : `${bytes} bytes`
}

/** `text` cut to `max` UTF-16 units (never inside a surrogate pair). */
function cut(text: string, max: number): string {
  if (text.length <= max)
    return text
  let end = max
  const last = text.charCodeAt(end - 1)
  if (last >= 0xD800 && last <= 0xDBFF)
    end--
  return text.slice(0, end)
}

function clampMaxBytes(requested: unknown, limit: number): number {
  return typeof requested === 'number' && !Number.isNaN(requested) ? Math.max(0, Math.min(Math.floor(requested), limit)) : limit
}

/** Byte cap, BOM strip, `JSON.parse`, object check; null after an `error` diagnostic. */
function readJsonObject(text: unknown, maxBytes: number, what: string, collector: Collector): Record<string, unknown> | null {
  const source = typeof text === 'string' ? text : ''
  if (utf8LengthUpTo(source, maxBytes) > maxBytes) {
    report(collector, 'error', 'too-large', `${what} is larger than ${formatBytes(maxBytes)}.`)
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source.startsWith('\uFEFF') ? source.slice(1) : source)
  }
  catch {
    report(collector, 'error', 'invalid-json', `${what} is not valid JSON.`)
    return null
  }
  if (!isRecord(parsed)) {
    report(collector, 'error', 'not-an-object', `${what} must hold a JSON object.`)
    return null
  }
  return parsed
}

/** A trimmed text without control characters (tab and newline allowed when `multiline`), cut to `max`; else undefined. */
function readText(collector: Collector, value: unknown, field: string, max: number, options?: { readonly multiline?: boolean }): string | undefined {
  if (value === undefined || value === null)
    return undefined
  if (typeof value !== 'string') {
    report(collector, 'warning', 'invalid-field', 'The field must be text; it is ignored.', field)
    return undefined
  }
  const cleaned = options?.multiline === true ? value.replace(/[^\P{Cc}\t\n]/gu, '') : value.replace(CONTROL_CHARACTERS, '')
  const trimmed = cleaned.trim()
  if (trimmed === '')
    return undefined
  if (trimmed.length > max) {
    report(collector, 'warning', 'invalid-field', `The field is longer than ${max} characters; it was cut.`, field)
    return cut(trimmed, max).trimEnd()
  }
  return trimmed
}

function readBoolean(collector: Collector, value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null)
    return undefined
  if (typeof value !== 'boolean') {
    report(collector, 'warning', 'invalid-field', 'The field must be true or false; it is ignored.', field)
    return undefined
  }
  return value
}

// ---------------------------------------------------------------------------------------------------------------------
// Names

/** Characters of a plugin or entry name. */
const PLUGIN_NAME_MAX_CHARS = 128
const KEBAB_CASE = /^[\da-z]+(?:-[\da-z]+)*$/
/** Blanks, `@`, `:`, `/`, `\` (Claude Code refuses the first four; a backslash is a path separator). */
const NAME_FORBIDDEN = /[\s@:/\\]/
const RESERVED_NAME_PREFIXES = ['claude-', 'anthropic-', 'anthropics-', 'cc-plugin-'] as const

/** True for names Claude Code's `plugin validate` refuses as reserved (`claude-…`, `anthropic-…`, "official" + claude). */
function isReservedPluginName(name: string): boolean {
  const lower = name.toLowerCase()
  if (RESERVED_NAME_PREFIXES.some(prefix => lower.startsWith(prefix)))
    return true
  return lower.includes('official') && (lower.includes('claude') || lower.includes('anthropic'))
}

/**
 * A plugin name (`plugin.json` `name`, a marketplace entry `name`); null after a diagnostic of `level` (`error` for
 * `plugin.json`, `warning` for an entry, which is then dropped).
 */
function readPluginName(collector: Collector, value: unknown, field: string, level: 'error' | 'warning'): string | null {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    report(collector, level, 'missing-name', 'Add a name.', field)
    return null
  }
  if (typeof value !== 'string') {
    report(collector, level, 'invalid-name', 'The name must be text.', field)
    return null
  }
  const name = value.trim()
  if (name.length > PLUGIN_NAME_MAX_CHARS) {
    report(collector, level, 'invalid-name', `The name is longer than ${PLUGIN_NAME_MAX_CHARS} characters.`, field)
    return null
  }
  if (NAME_FORBIDDEN.test(name) || HAS_CONTROL.test(name)) {
    report(collector, level, 'invalid-name', 'Names cannot contain blanks, "@", ":", "/", "\\" or control characters.', field)
    return null
  }
  if (!KEBAB_CASE.test(name))
    report(collector, 'warning', 'invalid-name', 'Use kebab-case for plugin names (lowercase letters, digits and "-").', field)
  if (isReservedPluginName(name))
    report(collector, 'warning', 'reserved-name', 'Claude Code reserves names that start with "claude-", "anthropic-" or "cc-plugin-" or pair "official" with Claude or Anthropic.', field)
  return name
}

/** Marketplace names: letters, digits, `.`, `_`, `-`, a letter or digit first, no `..`, at most 64 characters. */
const MARKETPLACE_NAME_PATTERN = /^[\dA-Z][\w.-]{0,63}$/i

/** Marketplace names only `anthropics/*` repositories may use (plan "Marketplaces"). */
export const OFFICIAL_MARKETPLACE_NAMES = ['claude-plugins-official', 'claude-code-plugins', 'claude-community'] as const

/**
 * True for a marketplace name the server accepts only from an `anthropics/*` GitHub repository (impersonation guard):
 * `claude-plugins-official`, `claude-code-plugins`, `claude-community` and every `anthropic-…` name (case-insensitive).
 */
export function isOfficialMarketplaceName(name: string): boolean {
  if (typeof name !== 'string')
    return false
  const lower = name.trim().toLowerCase()
  return (OFFICIAL_MARKETPLACE_NAMES as readonly string[]).includes(lower) || lower.startsWith('anthropic-')
}

// ---------------------------------------------------------------------------------------------------------------------
// Paths

const PATH_MAX_CHARS = 512
const PATH_SEGMENTS_MAX = 32

type PathResult
  = | { readonly ok: true, readonly path: string }
    | { readonly ok: false, readonly code: 'invalid-path' | 'path-outside-root', readonly message: string }

/**
 * A relative POSIX path normalized: `.` and empty segments removed, no `..` (`path-outside-root`), no absolute path,
 * backslash, NUL or control character (`invalid-path`). `requireDotSlash`: the text must start with `./` (or be `.`
 * when `allowRoot`). Returns `.` for the root when `allowRoot`.
 */
function normalizeRelativePath(raw: string, options: { readonly requireDotSlash: boolean, readonly allowRoot: boolean }): PathResult {
  if (raw === '' || raw.length > PATH_MAX_CHARS)
    return { ok: false, code: 'invalid-path', message: `Paths must have 1 to ${PATH_MAX_CHARS} characters.` }
  if (raw.includes('\\') || HAS_CONTROL.test(raw))
    return { ok: false, code: 'invalid-path', message: 'Paths cannot contain backslashes or control characters.' }
  if (raw.startsWith('/') || raw.startsWith('~') || /^[a-z]:/i.test(raw))
    return { ok: false, code: 'invalid-path', message: 'Paths must be relative to the plugin folder and start with "./".' }
  const segments = raw.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.includes('..'))
    return { ok: false, code: 'path-outside-root', message: 'Paths must stay inside the folder; ".." is not allowed.' }
  if (options.requireDotSlash && !(raw.startsWith('./') || (options.allowRoot && raw === '.')))
    return { ok: false, code: 'invalid-path', message: 'Paths must start with "./".' }
  if (segments.length > PATH_SEGMENTS_MAX)
    return { ok: false, code: 'invalid-path', message: `Paths can have at most ${PATH_SEGMENTS_MAX} segments.` }
  if (segments.length === 0)
    return options.allowRoot ? { ok: true, path: '.' } : { ok: false, code: 'invalid-path', message: 'The path names no file or folder.' }
  return { ok: true, path: segments.join('/') }
}

/** Reads a path field value (`./x` or a list of them); invalid entries are dropped with a diagnostic. */
function readPathList(
  collector: Collector,
  value: unknown,
  field: string,
  options: { readonly allowRoot?: boolean, readonly extension?: string, readonly max: number },
): string[] | undefined {
  if (value === undefined || value === null)
    return undefined
  const entries: unknown[] = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
  if (typeof value !== 'string' && !Array.isArray(value)) {
    report(collector, 'warning', 'invalid-field', 'The field must be a path or a list of paths; it is ignored.', field)
    return undefined
  }
  const paths: string[] = []
  entries.forEach((entry, index) => {
    const at = typeof value === 'string' ? field : `${field}[${index}]`
    const path = readOnePath(collector, entry, at, options)
    if (path !== null && !paths.includes(path))
      paths.push(path)
  })
  if (paths.length > options.max) {
    report(collector, 'warning', 'too-many', `Only the first ${options.max} paths are used.`, field)
    paths.length = options.max
  }
  return paths
}

function readOnePath(collector: Collector, entry: unknown, field: string, options: { readonly allowRoot?: boolean, readonly extension?: string }): string | null {
  if (typeof entry !== 'string') {
    report(collector, 'warning', 'invalid-field', 'Paths must be text; the entry is ignored.', field)
    return null
  }
  const result = normalizeRelativePath(entry, { requireDotSlash: true, allowRoot: options.allowRoot === true })
  if (!result.ok) {
    report(collector, result.code === 'path-outside-root' ? 'error' : 'warning', result.code, `${result.message} The entry is ignored.`, field)
    return null
  }
  if (options.extension !== undefined && !result.path.toLowerCase().endsWith(options.extension)) {
    report(collector, 'warning', 'invalid-path', `The path must name a ${options.extension} file; the entry is ignored.`, field)
    return null
  }
  return result.path
}

// ---------------------------------------------------------------------------------------------------------------------
// Manifest fields

const METADATA_KEYS: ReadonlySet<string> = new Set([
  'displayName',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'defaultEnabled',
])
const COMPONENT_KEYS: ReadonlySet<string> = new Set(['commands', 'agents', 'skills', 'outputStyles', 'hooks', 'mcpServers'])
/** Known to Claude Code, never run here (listed in `unsupported`). */
const UNSUPPORTED_KEYS: ReadonlySet<string> = new Set([
  'lspServers',
  'channels',
  'themes',
  'monitors',
  'workflows',
  'settings',
  'dependencies',
  'experimental',
  'types',
])
/** Directory-only or free-form fields Claude Code ignores too. */
const IGNORED_KEYS: ReadonlySet<string> = new Set([
  '$schema',
  'metadata',
  'icon',
  'documentationUrl',
  'supportUrl',
  'privacyPolicyUrl',
  'termsOfServiceUrl',
])
/** The component fields that take part in the `strict: false` conflict check. */
const CONFLICT_COMPONENTS: ReadonlySet<string> = new Set(['lspServers', 'themes', 'monitors', 'workflows', 'channels', 'experimental'])

const UNSUPPORTED_MESSAGES: Readonly<Record<string, string>> = {
  lspServers: 'LSP servers are not supported; they are never started.',
  channels: 'Channels are not supported.',
  themes: 'Themes are not supported.',
  monitors: 'Monitors are not supported; they are never run.',
  workflows: 'Workflows are not supported; they are never run.',
  settings: 'Plugin settings files are not supported.',
  dependencies: 'Plugin dependencies are not installed automatically.',
  experimental: 'Experimental components are not supported.',
  types: 'The types field is not supported.',
}

interface ManifestDraft {
  displayName?: string
  version?: string
  description?: string
  author?: ClaudePluginAuthor
  homepage?: string
  repository?: string
  license?: string
  keywords?: string[]
  defaultEnabled?: boolean
  commands?: { paths: string[], inline: ClaudeInlineCommand[] }
  agents?: string[]
  skills?: string[]
  outputStyles?: string[]
  hooks?: { files: string[], inline: unknown[] }
  mcpServers?: { files: string[], inline: Record<string, unknown>[] }
  userConfig?: ClaudeUserConfigOption[]
  unsupported: string[]
  /** The raw JSON values of the known fields that were read (an entry's overlay). */
  accepted: Record<string, unknown>
}

const KEYWORDS_MAX = 50
const KEYWORD_MAX_CHARS = 64
const INLINE_CONTENT_BYTES = 65_536
const COMMAND_NAME_MAX_CHARS = 64
const ARGUMENT_HINT_MAX_CHARS = 100
const MODEL_MAX_CHARS = 256
const DESCRIPTION_MAX_CHARS = 2000
const ALLOWED_TOOLS_MAX = 64

function readAuthor(collector: Collector, value: unknown, field: string): ClaudePluginAuthor | undefined {
  if (value === undefined || value === null)
    return undefined
  if (typeof value === 'string') {
    const name = readText(collector, value, field, 256)
    return name === undefined ? undefined : { name }
  }
  if (!isRecord(value)) {
    report(collector, 'warning', 'invalid-field', 'The author must be an object with a name; it is ignored.', field)
    return undefined
  }
  const name = readText(collector, value.name, `${field}.name`, 256)
  if (name === undefined) {
    report(collector, 'warning', 'invalid-field', 'The author needs a name; it is ignored.', field)
    return undefined
  }
  const email = readText(collector, value.email, `${field}.email`, 256)
  let url = readText(collector, value.url, `${field}.url`, 2048)
  if (url !== undefined && !isHttpUrl(url)) {
    report(collector, 'warning', 'invalid-field', 'The author URL must be an http or https URL; it is ignored.', `${field}.url`)
    url = undefined
  }
  return { name, ...(email === undefined ? {} : { email }), ...(url === undefined ? {} : { url }) }
}

function readKeywords(collector: Collector, value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null)
    return undefined
  if (!Array.isArray(value)) {
    report(collector, 'warning', 'invalid-field', 'Keywords must be a list of text values; they are ignored.', field)
    return undefined
  }
  const keywords: string[] = []
  let invalid = 0
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '' || HAS_CONTROL.test(entry)) {
      invalid++
      continue
    }
    const keyword = cut(entry.trim(), KEYWORD_MAX_CHARS)
    if (!keywords.includes(keyword))
      keywords.push(keyword)
  }
  if (invalid > 0)
    report(collector, 'warning', 'invalid-field', `${invalid} keywords are not text; they are ignored.`, field)
  if (keywords.length > KEYWORDS_MAX) {
    report(collector, 'warning', 'too-many', `Only the first ${KEYWORDS_MAX} keywords are kept.`, field)
    keywords.length = KEYWORDS_MAX
  }
  return keywords
}

function readStringList(collector: Collector, value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null)
    return undefined
  const entries = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null
  if (entries === null || entries.some(entry => typeof entry !== 'string')) {
    report(collector, 'warning', 'invalid-field', 'The field must be a list of text values; it is ignored.', field)
    return undefined
  }
  const list = (entries as string[]).map(entry => entry.trim()).filter(entry => entry !== '' && !HAS_CONTROL.test(entry))
  return list.slice(0, ALLOWED_TOOLS_MAX)
}

const INLINE_COMMAND_KEYS: ReadonlySet<string> = new Set(['source', 'content', 'description', 'argumentHint', 'model', 'allowedTools'])

function readInlineCommands(collector: Collector, map: Record<string, unknown>, field: string, into: ClaudeInlineCommand[]): void {
  for (const [key, value] of Object.entries(map)) {
    const at = `${field}.${key}`
    const name = key.trim()
    if (name === '' || name.length > COMMAND_NAME_MAX_CHARS || HAS_CONTROL.test(name) || /[\s/:\\]/.test(name)) {
      report(collector, 'warning', 'invalid-field', `Inline command names need 1 to ${COMMAND_NAME_MAX_CHARS} characters without blanks, "/", ":" or "\\"; the command is ignored.`, at)
      continue
    }
    if (!isRecord(value)) {
      report(collector, 'warning', 'invalid-field', 'An inline command must be an object with "source" or "content"; it is ignored.', at)
      continue
    }
    const hasSource = value.source !== undefined && value.source !== null
    const hasContent = value.content !== undefined && value.content !== null
    if (hasSource === hasContent) {
      report(collector, 'warning', 'invalid-field', 'An inline command needs exactly one of "source" and "content"; it is ignored.', at)
      continue
    }
    let source: string | undefined
    let content: string | undefined
    if (hasSource) {
      const path = readOnePath(collector, value.source, `${at}.source`, {})
      if (path === null)
        continue
      source = path
    }
    else {
      if (typeof value.content !== 'string') {
        report(collector, 'warning', 'invalid-field', 'The command content must be text; the command is ignored.', `${at}.content`)
        continue
      }
      if (utf8LengthUpTo(value.content, INLINE_CONTENT_BYTES) > INLINE_CONTENT_BYTES) {
        report(collector, 'warning', 'too-large', `The command content is larger than ${formatBytes(INLINE_CONTENT_BYTES)}; the command is ignored.`, `${at}.content`)
        continue
      }
      content = value.content
    }
    const description = readText(collector, value.description, `${at}.description`, DESCRIPTION_MAX_CHARS)
    const argumentHint = readText(collector, value.argumentHint, `${at}.argumentHint`, ARGUMENT_HINT_MAX_CHARS)
    const model = readText(collector, value.model, `${at}.model`, MODEL_MAX_CHARS)
    const allowedTools = readStringList(collector, value.allowedTools, `${at}.allowedTools`)
    for (const extra of Object.keys(value)) {
      if (!INLINE_COMMAND_KEYS.has(extra))
        report(collector, 'warning', 'unknown-field', `The field "${shown(extra)}" is not known; it is ignored.`, at)
    }
    if (into.some(entry => entry.name === name)) {
      report(collector, 'warning', 'invalid-field', 'The command is listed twice; the first one is used.', at)
      continue
    }
    into.push({
      name,
      ...(source === undefined ? {} : { source }),
      ...(content === undefined ? {} : { content }),
      ...(description === undefined ? {} : { description }),
      ...(argumentHint === undefined ? {} : { argumentHint }),
      ...(model === undefined ? {} : { model }),
      ...(allowedTools === undefined ? {} : { allowedTools }),
    })
  }
}

function readCommands(collector: Collector, value: unknown, field: string): ManifestDraft['commands'] | undefined {
  if (value === undefined || value === null)
    return undefined
  const result = { paths: [] as string[], inline: [] as ClaudeInlineCommand[] }
  const entries: unknown[] = Array.isArray(value) ? value : [value]
  if (!Array.isArray(value) && typeof value !== 'string' && !isRecord(value)) {
    report(collector, 'warning', 'invalid-field', 'Commands must be a path, a list of paths or an object of inline commands; they are ignored.', field)
    return undefined
  }
  entries.forEach((entry, index) => {
    const at = Array.isArray(value) ? `${field}[${index}]` : field
    if (isRecord(entry)) {
      readInlineCommands(collector, entry, at, result.inline)
      return
    }
    const path = readOnePath(collector, entry, at, {})
    if (path !== null && !result.paths.includes(path))
      result.paths.push(path)
  })
  const max = CLAUDE_PLUGIN_LIMITS.componentsPerKindMax
  if (result.paths.length + result.inline.length > max) {
    report(collector, 'warning', 'too-many', `Only the first ${max} commands are used.`, field)
    result.paths.length = Math.min(result.paths.length, max)
    result.inline.length = Math.min(result.inline.length, max - result.paths.length)
  }
  return result
}

function readHooksField(collector: Collector, value: unknown, field: string): ManifestDraft['hooks'] | undefined {
  if (value === undefined || value === null)
    return undefined
  if (!Array.isArray(value) && typeof value !== 'string' && !isRecord(value)) {
    report(collector, 'warning', 'invalid-field', 'Hooks must be a path, an inline hooks object or a list of them; they are ignored.', field)
    return undefined
  }
  const result = { files: [] as string[], inline: [] as unknown[] }
  const entries: unknown[] = Array.isArray(value) ? value : [value]
  entries.forEach((entry, index) => {
    const at = Array.isArray(value) ? `${field}[${index}]` : field
    if (isRecord(entry)) {
      result.inline.push(entry)
      return
    }
    const path = readOnePath(collector, entry, at, {})
    if (path !== null && !result.files.includes(path))
      result.files.push(path)
  })
  const max = CLAUDE_PLUGIN_LIMITS.componentsPerKindMax
  if (result.files.length + result.inline.length > max) {
    report(collector, 'warning', 'too-many', `Only the first ${max} hook sources are used.`, field)
    result.files.length = Math.min(result.files.length, max)
    result.inline.length = Math.min(result.inline.length, max - result.files.length)
  }
  return result
}

function readMcpField(collector: Collector, value: unknown, field: string): ManifestDraft['mcpServers'] | undefined {
  if (value === undefined || value === null)
    return undefined
  if (!Array.isArray(value) && typeof value !== 'string' && !isRecord(value)) {
    report(collector, 'warning', 'invalid-field', 'MCP servers must be a path, an inline server map or a list of them; they are ignored.', field)
    return undefined
  }
  const result = { files: [] as string[], inline: [] as Record<string, unknown>[] }
  const entries: unknown[] = Array.isArray(value) ? value : [value]
  entries.forEach((entry, index) => {
    const at = Array.isArray(value) ? `${field}[${index}]` : field
    if (isRecord(entry)) {
      result.inline.push(entry)
      return
    }
    if (typeof entry === 'string') {
      const lower = entry.trim().toLowerCase()
      if (/^[a-z][\d+.a-z-]*:/.test(lower)) {
        report(collector, 'warning', 'unsupported-component', 'MCP servers from a URL are not supported; the entry is ignored.', at)
        return
      }
      if (lower.endsWith('.mcpb') || lower.endsWith('.dxt')) {
        report(collector, 'warning', 'unsupported-component', 'MCP bundles (.mcpb, .dxt) are not supported; the entry is ignored.', at)
        return
      }
    }
    const path = readOnePath(collector, entry, at, {})
    if (path !== null && !result.files.includes(path))
      result.files.push(path)
  })
  const max = CLAUDE_PLUGIN_LIMITS.componentsPerKindMax
  if (result.files.length + result.inline.length > max) {
    report(collector, 'warning', 'too-many', `Only the first ${max} MCP server sources are used.`, field)
    result.files.length = Math.min(result.files.length, max)
    result.inline.length = Math.min(result.inline.length, max - result.files.length)
  }
  return result
}

const USER_CONFIG_KEY_PATTERN = /^[A-Z_]\w{0,63}$/i
const USER_CONFIG_FIELDS: ReadonlySet<string> = new Set(['type', 'title', 'description', 'required', 'default', 'options', 'multiple', 'sensitive', 'min', 'max'])
const USER_CONFIG_TYPE_SET: ReadonlySet<string> = new Set(CLAUDE_USER_CONFIG_TYPES)
const USER_CONFIG_OPTIONS_MAX = 100
const USER_CONFIG_TEXT_MAX = 4096

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readUserConfigDefault(collector: Collector, value: unknown, type: ClaudeUserConfigType, multiple: boolean, field: string): ClaudeUserConfigOption['default'] {
  if (value === undefined || value === null)
    return undefined
  const textual = type === 'string' || type === 'directory' || type === 'file'
  if (multiple && textual) {
    if (Array.isArray(value) && value.every(entry => typeof entry === 'string' && entry.length <= USER_CONFIG_TEXT_MAX))
      return [...value] as string[]
    if (typeof value === 'string' && value.length <= USER_CONFIG_TEXT_MAX)
      return [value]
  }
  else if (textual && typeof value === 'string' && value.length <= USER_CONFIG_TEXT_MAX) {
    return value
  }
  else if (type === 'number' && finiteNumber(value) !== undefined) {
    return value as number
  }
  else if (type === 'boolean' && typeof value === 'boolean') {
    return value
  }
  report(collector, 'warning', 'invalid-user-config', 'The default does not match the option type; it is ignored.', field)
  return undefined
}

function readUserConfig(collector: Collector, value: unknown, field: string): ClaudeUserConfigOption[] | undefined {
  if (value === undefined || value === null)
    return undefined
  if (!isRecord(value)) {
    report(collector, 'warning', 'invalid-user-config', 'userConfig must be an object of options keyed by name; it is ignored.', field)
    return undefined
  }
  const options: ClaudeUserConfigOption[] = []
  const keys = Object.keys(value)
  for (const key of keys) {
    const at = `${field}.${key}`
    if (options.length >= CLAUDE_PLUGIN_LIMITS.userConfigMax) {
      report(collector, 'warning', 'too-many', `Only the first ${CLAUDE_PLUGIN_LIMITS.userConfigMax} options are used.`, field)
      break
    }
    if (!USER_CONFIG_KEY_PATTERN.test(key)) {
      report(collector, 'warning', 'invalid-user-config', 'Option keys use letters, digits and "_" (a letter or "_" first, at most 64 characters); the option is ignored.', at)
      continue
    }
    const option = value[key]
    if (!isRecord(option)) {
      report(collector, 'warning', 'invalid-user-config', 'An option must be an object with a type and a title; it is ignored.', at)
      continue
    }
    const type = option.type
    if (typeof type !== 'string' || !USER_CONFIG_TYPE_SET.has(type)) {
      report(collector, 'warning', 'invalid-user-config', 'The option type must be string, number, boolean, directory or file; the option is ignored.', `${at}.type`)
      continue
    }
    const kind = type as ClaudeUserConfigType
    for (const extra of Object.keys(option)) {
      if (!USER_CONFIG_FIELDS.has(extra))
        report(collector, 'warning', 'invalid-user-config', `The option field "${shown(extra)}" is not known; it is ignored.`, at)
    }
    let title = readText(collector, option.title, `${at}.title`, 200)
    if (title === undefined) {
      report(collector, 'warning', 'invalid-user-config', 'The option has no title; its key is used.', at)
      title = key
    }
    const description = readText(collector, option.description, `${at}.description`, DESCRIPTION_MAX_CHARS, { multiline: true })
    const required = readBoolean(collector, option.required, `${at}.required`) ?? false
    const multiple = readBoolean(collector, option.multiple, `${at}.multiple`) ?? false
    const sensitive = readBoolean(collector, option.sensitive, `${at}.sensitive`) ?? false
    let choices: string[] | undefined
    if (option.options !== undefined && option.options !== null) {
      const list = Array.isArray(option.options) ? option.options : null
      if (list === null || list.length === 0 || list.length > USER_CONFIG_OPTIONS_MAX || list.some(entry => typeof entry !== 'string' || entry === '' || entry.length > USER_CONFIG_TEXT_MAX)) {
        report(collector, 'warning', 'invalid-user-config', `Options must be a list of 1 to ${USER_CONFIG_OPTIONS_MAX} text values; they are ignored.`, `${at}.options`)
      }
      else {
        choices = [...new Set(list as string[])]
      }
    }
    const min = finiteNumber(option.min)
    const max = finiteNumber(option.max)
    if ((option.min !== undefined && option.min !== null && min === undefined) || (option.max !== undefined && option.max !== null && max === undefined))
      report(collector, 'warning', 'invalid-user-config', 'min and max must be numbers; they are ignored.', at)
    const defaultValue = readUserConfigDefault(collector, option.default, kind, multiple, `${at}.default`)
    options.push({
      key,
      type: kind,
      title,
      ...(description === undefined ? {} : { description }),
      required,
      ...(defaultValue === undefined ? {} : { default: defaultValue }),
      ...(choices === undefined ? {} : { options: choices }),
      multiple,
      sensitive,
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
    })
  }
  return options
}

/**
 * Reads the plugin.json fields of `object` (every key but `name` and the keys in `skip`). `prefix` is prepended to
 * field names in diagnostics (`plugins[3].`).
 */
function readManifestBody(collector: Collector, object: Record<string, unknown>, prefix: string, skip: ReadonlySet<string>): ManifestDraft {
  const draft: ManifestDraft = { unsupported: [], accepted: {} }
  for (const key of Object.keys(object)) {
    if (key === 'name' || skip.has(key))
      continue
    const value = object[key]
    const field = `${prefix}${key}`
    if (IGNORED_KEYS.has(key))
      continue
    if (UNSUPPORTED_KEYS.has(key)) {
      if (!draft.unsupported.includes(key))
        draft.unsupported.push(key)
      draft.accepted[key] = value
      report(collector, 'info', 'unsupported-component', UNSUPPORTED_MESSAGES[key] ?? 'The field is not supported.', field)
      continue
    }
    if (!METADATA_KEYS.has(key) && !COMPONENT_KEYS.has(key) && key !== 'userConfig') {
      report(collector, 'warning', 'unknown-field', `The field "${shown(key)}" is not known; it is ignored.`, field)
      continue
    }
    const read = readKnownField(collector, draft, key, value, field)
    if (read)
      draft.accepted[key] = value
  }
  return draft
}

/** Reads one known field into `draft`; true when something usable was read. */
function readKnownField(collector: Collector, draft: ManifestDraft, key: string, value: unknown, field: string): boolean {
  switch (key) {
    case 'displayName':
      draft.displayName = readText(collector, value, field, 128)
      return draft.displayName !== undefined
    case 'version':
      draft.version = readText(collector, value, field, 128)
      return draft.version !== undefined
    case 'description':
      draft.description = readText(collector, value, field, DESCRIPTION_MAX_CHARS, { multiline: true })
      return draft.description !== undefined
    case 'license':
      draft.license = readText(collector, value, field, 128)
      return draft.license !== undefined
    case 'author':
      draft.author = readAuthor(collector, value, field)
      return draft.author !== undefined
    case 'homepage': {
      const homepage = readText(collector, value, field, 2048)
      if (homepage !== undefined && !isHttpUrl(homepage)) {
        report(collector, 'warning', 'invalid-field', 'The homepage must be an http or https URL; it is ignored.', field)
        return false
      }
      draft.homepage = homepage
      return homepage !== undefined
    }
    case 'repository': {
      const raw = isRecord(value) && typeof value.url === 'string' ? value.url : value
      draft.repository = readText(collector, raw, field, 2048)
      return draft.repository !== undefined
    }
    case 'keywords':
      draft.keywords = readKeywords(collector, value, field)
      return draft.keywords !== undefined
    case 'defaultEnabled':
      draft.defaultEnabled = readBoolean(collector, value, field)
      return draft.defaultEnabled !== undefined
    case 'commands':
      draft.commands = readCommands(collector, value, field)
      return draft.commands !== undefined
    case 'agents':
      draft.agents = readPathList(collector, value, field, { extension: '.md', max: CLAUDE_PLUGIN_LIMITS.componentsPerKindMax })
      return draft.agents !== undefined
    case 'skills':
      draft.skills = readPathList(collector, value, field, { allowRoot: true, max: CLAUDE_PLUGIN_LIMITS.componentsPerKindMax })
      return draft.skills !== undefined
    case 'outputStyles':
      draft.outputStyles = readPathList(collector, value, field, { max: CLAUDE_PLUGIN_LIMITS.outputStylesMax })
      return draft.outputStyles !== undefined
    case 'hooks':
      draft.hooks = readHooksField(collector, value, field)
      return draft.hooks !== undefined
    case 'mcpServers':
      draft.mcpServers = readMcpField(collector, value, field)
      return draft.mcpServers !== undefined
    case 'userConfig':
      draft.userConfig = readUserConfig(collector, value, field)
      return draft.userConfig !== undefined
    default:
      return false
  }
}

function buildManifest(name: string, draft: ManifestDraft, appendToDefault?: readonly ClaudeReplacingComponent[]): ClaudePluginManifest {
  return {
    name,
    ...(draft.displayName === undefined ? {} : { displayName: draft.displayName }),
    ...(draft.version === undefined ? {} : { version: draft.version }),
    ...(draft.description === undefined ? {} : { description: draft.description }),
    ...(draft.author === undefined ? {} : { author: draft.author }),
    ...(draft.homepage === undefined ? {} : { homepage: draft.homepage }),
    ...(draft.repository === undefined ? {} : { repository: draft.repository }),
    ...(draft.license === undefined ? {} : { license: draft.license }),
    keywords: draft.keywords ?? [],
    defaultEnabled: draft.defaultEnabled ?? true,
    ...(draft.commands === undefined ? {} : { commands: draft.commands }),
    ...(draft.agents === undefined ? {} : { agents: draft.agents }),
    ...(draft.skills === undefined ? {} : { skills: draft.skills }),
    ...(draft.outputStyles === undefined ? {} : { outputStyles: draft.outputStyles }),
    ...(draft.hooks === undefined ? {} : { hooks: draft.hooks }),
    ...(draft.mcpServers === undefined ? {} : { mcpServers: draft.mcpServers }),
    userConfig: draft.userConfig ?? [],
    unsupported: draft.unsupported,
    ...(appendToDefault === undefined || appendToDefault.length === 0 ? {} : { appendToDefault }),
  }
}

/** Parses `.claude-plugin/plugin.json` text; unknown top-level keys are dropped with a warning (Claude Code does too). */
export function parseClaudePluginManifest(text: string, options?: { readonly maxBytes?: number }): ParseClaudePluginManifestResult {
  const collector = newCollector()
  try {
    const object = readJsonObject(text, clampMaxBytes(options?.maxBytes, CLAUDE_PLUGIN_LIMITS.manifestBytes), 'plugin.json', collector)
    if (object === null)
      return { manifest: null, diagnostics: finish(collector) }
    const name = readPluginName(collector, object.name, 'name', 'error')
    const draft = readManifestBody(collector, object, '', new Set())
    if (name === null)
      return { manifest: null, diagnostics: finish(collector) }
    return { manifest: buildManifest(name, draft), diagnostics: finish(collector) }
  }
  catch {
    return { manifest: null, diagnostics: [{ level: 'error', code: 'invalid-json', message: 'plugin.json could not be read.' }] }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Marketplaces

export const CLAUDE_ENTRY_SOURCE_KINDS = ['relative', 'github', 'git', 'git-subdir', 'url', 'archive', 'npm', 'command', 'unknown'] as const
export type ClaudeEntrySourceKind = (typeof CLAUDE_ENTRY_SOURCE_KINDS)[number]

/** A marketplace entry's source after classification (a github.com git URL is reported as `github`). */
export type ClaudeEntrySource
  = | { readonly kind: 'relative', readonly path: string }
    | { readonly kind: 'github', readonly repo: string, readonly ref?: string, readonly sha?: string, readonly path?: string }
    | { readonly kind: 'git' | 'url', readonly url: string, readonly ref?: string, readonly sha?: string }
    | { readonly kind: 'git-subdir', readonly url: string, readonly path: string, readonly ref?: string, readonly sha?: string }
    | { readonly kind: 'archive', readonly url: string, readonly sha256?: string }
    | { readonly kind: 'npm', readonly package: string, readonly version?: string, readonly registry?: string }
    | { readonly kind: 'command' | 'unknown' }

export interface ClaudeMarketplaceEntry {
  readonly name: string
  readonly source: ClaudeEntrySource
  /** Whether this harness can install the source (relative, github, archive, npm without a custom registry). */
  readonly supported: boolean
  /** One English sentence when `supported` is false. */
  readonly unsupportedReason?: string
  readonly description?: string
  readonly version?: string
  readonly category?: string
  readonly tags: readonly string[]
  /** Default true. */
  readonly strict: boolean
  /** The plugin.json fields given inline in the entry (component lists, metadata), validated like `plugin.json`. */
  readonly overlay: Readonly<Record<string, unknown>>
}

export interface ClaudeMarketplace {
  readonly name: string
  readonly owner: ClaudePluginAuthor
  readonly description?: string
  readonly version?: string
  /** `metadata.pluginRoot`: joined in front of bare relative sources. */
  readonly pluginRoot?: string
  readonly plugins: readonly ClaudeMarketplaceEntry[]
}

export interface ParseMarketplaceJsonResult {
  readonly marketplace: ClaudeMarketplace | null
  readonly diagnostics: readonly ClaudePluginDiagnostic[]
}

/** GitHub owner (user or organization) and repository names. */
const GITHUB_OWNER_PATTERN = /^[\dA-Z][\dA-Z-]{0,38}$/i
const GITHUB_REPO_PATTERN = /^[\w.-]{1,100}$/
const GIT_SHA_PATTERN = /^[\da-f]{40}$/i
const SHA256_PATTERN = /^[\da-f]{64}$/i
const GIT_REF_PATTERN = /^[\w./+-]{1,255}$/
/** npm package names (scoped or not), at most 214 characters. */
const NPM_PACKAGE_PATTERN = /^(?:@[\da-z~-][\w.~-]*\/)?[\da-z~-][\w.~-]*$/
const NPM_VERSION_PATTERN = /^[\w.*+<=>^|~ -]{1,256}$/
const DEFAULT_NPM_REGISTRY_HOSTS: ReadonlySet<string> = new Set(['registry.npmjs.org', 'registry.npmjs.com'])

const UNSUPPORTED_GIT_REASON = 'Only GitHub repositories, archives, npm packages and relative paths can be installed; other git hosts are not supported.'
const UNSUPPORTED_REASONS = {
  git: UNSUPPORTED_GIT_REASON,
  registry: 'npm packages from a custom registry are not supported.',
  command: 'Command sources run a program to fetch the plugin; they are not supported.',
  unknown: 'The source type is not supported.',
  invalid: 'The source is not valid.',
  outside: 'The source path leaves the marketplace folder.',
  http: 'Archive sources must use an https URL.',
} as const

/** `owner/repo` (a trailing `.git` removed); null when either part is not a GitHub name. */
function parseGithubRepo(text: string): string | null {
  const parts = text.split('/')
  if (parts.length !== 2)
    return null
  const owner = parts[0] ?? ''
  let repo = parts[1] ?? ''
  if (repo.toLowerCase().endsWith('.git'))
    repo = repo.slice(0, -4)
  if (!GITHUB_OWNER_PATTERN.test(owner) || !GITHUB_REPO_PATTERN.test(repo) || repo === '.' || repo === '..')
    return null
  return `${owner}/${repo}`
}

/** A git ref (`main`, `v2.1.0`, `feature/x`): no `..`, `//`, `@{`, leading `/` or `-`, trailing `/`, `.` or `.lock`. */
function isGitRef(text: string): boolean {
  return GIT_REF_PATTERN.test(text)
    && !text.includes('..')
    && !text.includes('//')
    && !text.startsWith('/')
    && !text.startsWith('-')
    && !text.endsWith('/')
    && !text.endsWith('.')
    && !text.toLowerCase().endsWith('.lock')
}

/**
 * The GitHub repository of a git URL: `https://github.com/o/r(.git)`, `http://…`, `git+https://…`, `www.github.com`,
 * `ssh://git@github.com/o/r.git`, `git@github.com:o/r.git`; null for any other host or a deeper path.
 */
function githubRepoFromGitUrl(url: string): string | null {
  const text = url.trim()
  const scp = text.match(/^git@github\.com:([^/]+\/[^/]+)\/?$/i)
  if (scp !== null)
    return parseGithubRepo(scp[1] ?? '')
  const withoutPrefix = text.replace(/^git\+/i, '')
  let parsed: URL
  try {
    if (!URL.canParse(withoutPrefix))
      return null
    parsed = new URL(withoutPrefix)
  }
  catch {
    return null
  }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol))
    return null
  const host = parsed.hostname.toLowerCase()
  if (host !== 'github.com' && host !== 'www.github.com')
    return null
  if (parsed.search !== '' || parsed.hash !== '')
    return null
  const path = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
  return parseGithubRepo(path)
}

interface SourceReading {
  readonly source: ClaudeEntrySource
  readonly supported: boolean
  readonly reason?: string
}

function unsupportedSource(source: ClaudeEntrySource, reason: string): SourceReading {
  return { source, supported: false, reason }
}

function readOptionalRef(collector: Collector, value: unknown, field: string): string | null | undefined {
  if (value === undefined || value === null)
    return undefined
  if (typeof value !== 'string' || !isGitRef(value.trim())) {
    report(collector, 'warning', 'invalid-source', 'The ref is not a valid git ref.', field)
    return null
  }
  return value.trim()
}

function readOptionalSha(collector: Collector, value: unknown, field: string): string | null | undefined {
  if (value === undefined || value === null)
    return undefined
  if (typeof value !== 'string' || !GIT_SHA_PATTERN.test(value.trim())) {
    report(collector, 'warning', 'invalid-source', 'The sha must be a 40-character commit hash.', field)
    return null
  }
  return value.trim().toLowerCase()
}

function invalidSource(collector: Collector, field: string, message: string): SourceReading {
  report(collector, 'warning', 'invalid-source', message, field)
  return unsupportedSource({ kind: 'unknown' }, UNSUPPORTED_REASONS.invalid)
}

function readRelativeSource(collector: Collector, value: string, field: string, pluginRoot: string | undefined): SourceReading {
  const dotted = value === '.' || value.startsWith('./')
  if (!dotted && (/^[a-z][\d+.a-z-]*:/i.test(value) || value.startsWith('/') || value.startsWith('~')))
    return invalidSource(collector, field, 'A text source must be a relative path such as "./plugins/name".')
  const result = normalizeRelativePath(value, { requireDotSlash: false, allowRoot: true })
  if (!result.ok) {
    if (result.code === 'path-outside-root') {
      report(collector, 'warning', 'path-outside-root', 'The source path leaves the marketplace folder.', field)
      return unsupportedSource({ kind: 'unknown' }, UNSUPPORTED_REASONS.outside)
    }
    return invalidSource(collector, field, result.message)
  }
  if (dotted)
    return { source: { kind: 'relative', path: result.path }, supported: true }
  if (pluginRoot === undefined) {
    report(collector, 'info', 'invalid-path', 'Relative sources should start with "./"; the path is read from the marketplace folder.', field)
    return { source: { kind: 'relative', path: result.path }, supported: true }
  }
  const joined = pluginRoot === '.' ? result.path : result.path === '.' ? pluginRoot : `${pluginRoot}/${result.path}`
  return { source: { kind: 'relative', path: joined }, supported: true }
}

function readObjectSource(collector: Collector, value: Record<string, unknown>, field: string): SourceReading {
  const kind = value.source
  const git = kind === 'github' || kind === 'url' || kind === 'git' || kind === 'git-subdir'
  const ref = git ? readOptionalRef(collector, value.ref, `${field}.ref`) : undefined
  const sha = git ? readOptionalSha(collector, value.sha, `${field}.sha`) : undefined
  if (ref === null || sha === null)
    return unsupportedSource({ kind: 'unknown' }, UNSUPPORTED_REASONS.invalid)
  const refs = { ...(ref === undefined ? {} : { ref }), ...(sha === undefined ? {} : { sha }) }
  switch (kind) {
    case 'github': {
      const repo = typeof value.repo === 'string' ? parseGithubRepo(value.repo.trim()) : null
      if (repo === null)
        return invalidSource(collector, `${field}.repo`, 'The repository must be "owner/repo".')
      let path: string | undefined
      if (value.path !== undefined && value.path !== null) {
        const sub = typeof value.path === 'string' ? normalizeRelativePath(value.path, { requireDotSlash: false, allowRoot: true }) : null
        if (sub === null || !sub.ok)
          return invalidSource(collector, `${field}.path`, 'The path must be a relative folder inside the repository.')
        path = sub.path === '.' ? undefined : sub.path
      }
      return { source: { kind: 'github', repo, ...refs, ...(path === undefined ? {} : { path }) }, supported: true }
    }
    case 'url':
    case 'git': {
      if (typeof value.url !== 'string' || value.url.trim() === '' || HAS_CONTROL.test(value.url) || value.url.length > 2048)
        return invalidSource(collector, `${field}.url`, 'The source needs a git URL.')
      const repo = githubRepoFromGitUrl(value.url)
      if (repo !== null)
        return { source: { kind: 'github', repo, ...refs }, supported: true }
      report(collector, 'info', 'unsupported-source', UNSUPPORTED_GIT_REASON, field)
      return unsupportedSource({ kind, url: value.url.trim(), ...refs }, UNSUPPORTED_GIT_REASON)
    }
    case 'git-subdir': {
      if (typeof value.url !== 'string' || value.url.trim() === '' || HAS_CONTROL.test(value.url) || value.url.length > 2048)
        return invalidSource(collector, `${field}.url`, 'The source needs a repository ("owner/repo") or a git URL.')
      const sub = typeof value.path === 'string' ? normalizeRelativePath(value.path, { requireDotSlash: false, allowRoot: false }) : null
      if (sub === null || !sub.ok)
        return invalidSource(collector, `${field}.path`, 'The path must be a relative folder inside the repository.')
      const url = value.url.trim()
      const repo = parseGithubRepo(url) ?? githubRepoFromGitUrl(url)
      if (repo !== null)
        return { source: { kind: 'github', repo, ...refs, path: sub.path }, supported: true }
      report(collector, 'info', 'unsupported-source', UNSUPPORTED_GIT_REASON, field)
      return unsupportedSource({ kind: 'git-subdir', url, path: sub.path, ...refs }, UNSUPPORTED_GIT_REASON)
    }
    case 'npm': {
      const name = typeof value.package === 'string' ? value.package.trim() : ''
      if (name.length > 214 || !NPM_PACKAGE_PATTERN.test(name))
        return invalidSource(collector, `${field}.package`, 'The source needs a valid npm package name.')
      let version: string | undefined
      if (value.version !== undefined && value.version !== null) {
        if (typeof value.version !== 'string' || !NPM_VERSION_PATTERN.test(value.version.trim()))
          return invalidSource(collector, `${field}.version`, 'The npm version or range is not valid.')
        version = value.version.trim()
      }
      const source = { kind: 'npm' as const, package: name, ...(version === undefined ? {} : { version }) }
      if (value.registry === undefined || value.registry === null)
        return { source, supported: true }
      const registryText = typeof value.registry === 'string' ? value.registry.trim() : ''
      const registry = parseHttpUrl(registryText)
      if (registry === null)
        return invalidSource(collector, `${field}.registry`, 'The npm registry must be an http or https URL.')
      const withRegistry = { ...source, registry: registryText }
      if (registry.protocol === 'https:' && DEFAULT_NPM_REGISTRY_HOSTS.has(registry.hostname.toLowerCase()) && (registry.pathname === '/' || registry.pathname === ''))
        return { source: withRegistry, supported: true }
      report(collector, 'info', 'unsupported-source', UNSUPPORTED_REASONS.registry, field)
      return unsupportedSource(withRegistry, UNSUPPORTED_REASONS.registry)
    }
    case 'archive': {
      const url = typeof value.url === 'string' ? parseHttpUrl(value.url.trim()) : null
      if (url === null)
        return invalidSource(collector, `${field}.url`, 'The archive source needs an http or https URL.')
      let sha256: string | undefined
      if (value.sha256 !== undefined && value.sha256 !== null) {
        if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256.trim()))
          return invalidSource(collector, `${field}.sha256`, 'The sha256 must be 64 hexadecimal characters.')
        sha256 = value.sha256.trim().toLowerCase()
      }
      const source = { kind: 'archive' as const, url: url.href, ...(sha256 === undefined ? {} : { sha256 }) }
      if (url.protocol !== 'https:') {
        report(collector, 'info', 'unsupported-source', UNSUPPORTED_REASONS.http, field)
        return unsupportedSource(source, UNSUPPORTED_REASONS.http)
      }
      return { source, supported: true }
    }
    case 'command':
      report(collector, 'info', 'unsupported-source', UNSUPPORTED_REASONS.command, field)
      return unsupportedSource({ kind: 'command' }, UNSUPPORTED_REASONS.command)
    default:
      report(collector, 'info', 'unsupported-source', UNSUPPORTED_REASONS.unknown, field)
      return unsupportedSource({ kind: 'unknown' }, UNSUPPORTED_REASONS.unknown)
  }
}

function readEntrySource(collector: Collector, value: unknown, field: string, pluginRoot: string | undefined): SourceReading {
  if (typeof value === 'string') {
    if (value.trim() === '' || HAS_CONTROL.test(value))
      return invalidSource(collector, field, 'The source must not be empty.')
    return readRelativeSource(collector, value.trim(), field, pluginRoot)
  }
  if (isRecord(value))
    return readObjectSource(collector, value, field)
  return invalidSource(collector, field, 'The source must be a relative path or a source object.')
}

/** Entry keys that are not `plugin.json` fields. */
const ENTRY_OWN_KEYS: ReadonlySet<string> = new Set(['name', 'source', 'category', 'tags', 'strict'])
/** Entry keys Claude Code knows that are not used here. */
const ENTRY_IGNORED_KEYS: ReadonlySet<string> = new Set(['relevance', 'headers', 'headersHelper'])
const TAGS_MAX = 20

function readEntry(collector: Collector, value: unknown, index: number, pluginRoot: string | undefined, names: Set<string>): ClaudeMarketplaceEntry | null {
  const field = `plugins[${index}]`
  if (!isRecord(value)) {
    report(collector, 'warning', 'invalid-field', 'A plugin entry must be an object with a name and a source; it is ignored.', field)
    return null
  }
  const name = readPluginName(collector, value.name, `${field}.name`, 'warning')
  if (name === null)
    return null
  if (names.has(name)) {
    report(collector, 'warning', 'invalid-field', 'Another entry already uses this name; the entry is ignored.', `${field}.name`)
    return null
  }
  if (value.source === undefined || value.source === null) {
    report(collector, 'warning', 'invalid-source', 'The entry has no source; it is ignored.', `${field}.source`)
    return null
  }
  names.add(name)
  const source = readEntrySource(collector, value.source, `${field}.source`, pluginRoot)
  const category = readText(collector, value.category, `${field}.category`, 64)
  const tags = readKeywords(collector, value.tags, `${field}.tags`) ?? []
  if (tags.length > TAGS_MAX)
    tags.length = TAGS_MAX
  const strict = readBoolean(collector, value.strict, `${field}.strict`) ?? true
  for (const key of Object.keys(value)) {
    if (ENTRY_IGNORED_KEYS.has(key))
      report(collector, 'info', 'unknown-field', `The field "${shown(key)}" is not used.`, `${field}.${key}`)
  }
  const overlayDraft = readManifestBody(collector, value, `${field}.`, new Set([...ENTRY_OWN_KEYS, ...ENTRY_IGNORED_KEYS]))
  return {
    name,
    source: source.source,
    supported: source.supported,
    ...(source.reason === undefined ? {} : { unsupportedReason: source.reason }),
    ...(overlayDraft.description === undefined ? {} : { description: overlayDraft.description }),
    ...(overlayDraft.version === undefined ? {} : { version: overlayDraft.version }),
    ...(category === undefined ? {} : { category }),
    tags,
    strict,
    overlay: overlayDraft.accepted,
  }
}

const MARKETPLACE_KEYS: ReadonlySet<string> = new Set([
  'name',
  'owner',
  'plugins',
  'description',
  'version',
  'metadata',
  '$schema',
  'forceRemoveDeletedPlugins',
  'allowCrossMarketplaceDependenciesOn',
  'renames',
])

function parseMarketplaceUnchecked(text: string, maxBytes: number, collector: Collector): ClaudeMarketplace | null {
  const object = readJsonObject(text, maxBytes, 'marketplace.json', collector)
  if (object === null)
    return null
  const rawName = object.name
  let name: string | null = null
  if (rawName === undefined || rawName === null || (typeof rawName === 'string' && rawName.trim() === ''))
    report(collector, 'error', 'missing-name', 'Add a marketplace name.', 'name')
  else if (typeof rawName !== 'string' || !MARKETPLACE_NAME_PATTERN.test(rawName.trim()) || rawName.includes('..'))
    report(collector, 'error', 'invalid-name', 'Marketplace names use 1 to 64 letters, digits, ".", "_" and "-", a letter or digit first, without "..".', 'name')
  else
    name = rawName.trim()
  let owner = readAuthor(collector, object.owner, 'owner')
  if (owner === undefined) {
    report(collector, 'warning', 'invalid-field', 'The marketplace has no owner with a name.', 'owner')
    owner = { name: '' }
  }
  const metadata = isRecord(object.metadata) ? object.metadata : {}
  const description = readText(collector, object.description ?? metadata.description, 'description', DESCRIPTION_MAX_CHARS, { multiline: true })
  const version = readText(collector, object.version ?? metadata.version, 'version', 128)
  let pluginRoot: string | undefined
  if (metadata.pluginRoot !== undefined && metadata.pluginRoot !== null) {
    const root = typeof metadata.pluginRoot === 'string' ? normalizeRelativePath(metadata.pluginRoot.trim(), { requireDotSlash: false, allowRoot: true }) : null
    if (root === null || !root.ok)
      report(collector, 'warning', root !== null && !root.ok ? root.code : 'invalid-field', 'metadata.pluginRoot must be a relative folder inside the marketplace; it is ignored.', 'metadata.pluginRoot')
    else
      pluginRoot = root.path
  }
  for (const key of Object.keys(object)) {
    if (!MARKETPLACE_KEYS.has(key))
      report(collector, 'warning', 'unknown-field', `The field "${shown(key)}" is not known; it is ignored.`, key)
  }
  if (!Array.isArray(object.plugins)) {
    report(collector, 'error', 'invalid-field', 'The marketplace needs a "plugins" list.', 'plugins')
    return null
  }
  if (name === null)
    return null
  const entries: ClaudeMarketplaceEntry[] = []
  const names = new Set<string>()
  const max = CLAUDE_PLUGIN_LIMITS.marketplaceEntriesMax
  object.plugins.slice(0, max).forEach((value: unknown, index: number) => {
    const entry = readEntry(collector, value, index, pluginRoot, names)
    if (entry !== null)
      entries.push(entry)
  })
  if (object.plugins.length > max)
    report(collector, 'warning', 'too-many', `The marketplace lists more than ${max} plugins; the rest are ignored.`, 'plugins')
  return {
    name,
    owner,
    ...(description === undefined ? {} : { description }),
    ...(version === undefined ? {} : { version }),
    ...(pluginRoot === undefined ? {} : { pluginRoot }),
    plugins: entries,
  }
}

/** Parses `.claude-plugin/marketplace.json` text; invalid entries are dropped with a diagnostic, never the whole file. */
export function parseMarketplaceJson(text: string, options?: { readonly maxBytes?: number }): ParseMarketplaceJsonResult {
  const collector = newCollector()
  try {
    const marketplace = parseMarketplaceUnchecked(typeof text === 'string' ? text : '', clampMaxBytes(options?.maxBytes, CLAUDE_PLUGIN_LIMITS.marketplaceJsonBytes), collector)
    return { marketplace, diagnostics: finish(collector) }
  }
  catch {
    return { marketplace: null, diagnostics: [{ level: 'error', code: 'invalid-json', message: 'marketplace.json could not be read.' }] }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Plugin ids

const HEX8 = /^[\da-f]{8}$/

/** The first 8 lowercase hex characters of `digest(text)`, or FNV-1a when the digest is unusable. */
function shortDigest(text: string, digest: (text: string) => string): string {
  try {
    const value = typeof digest === 'function' ? digest(text) : ''
    const hex = typeof value === 'string' ? value.slice(0, 8).toLowerCase() : ''
    if (HEX8.test(hex))
      return hex
  }
  catch {
    // fall through
  }
  return fnv1a32Hex(text)
}

/**
 * The harness plugin id of a Claude Code plugin name: lowercase slug (`[^a-z0-9-]` → `-`, repeats collapsed, ends
 * trimmed); longer than 40 → the first 31 characters + `-` + 8 hex of sha256(name) (the caller passes `digest`);
 * a reserved id gets the prefix `cc-`; an empty slug → `plugin-<8 hex>`.
 */
export function claudePluginId(name: string, options: { readonly digest: (text: string) => string, readonly isReserved: (id: string) => boolean }): string {
  const raw = typeof name === 'string' ? name.slice(0, 4096) : ''
  const digest = options?.digest
  const isReserved = (id: string): boolean => {
    try {
      return typeof options?.isReserved === 'function' && options.isReserved(id) === true
    }
    catch {
      return false
    }
  }
  const max = CLAUDE_PLUGIN_LIMITS.pluginIdMaxChars
  const hex = (): string => shortDigest(raw, digest as (text: string) => string)
  const shorten = (id: string): string => id.length <= max ? id : `${id.slice(0, max - 9).replace(/-+$/, '')}-${hex()}`
  const slug = raw.toLowerCase().replace(/[^\da-z-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
  let id = slug === '' ? `plugin-${hex()}` : shorten(slug)
  if (isReserved(id))
    id = shorten(`cc-${id}`)
  if (isReserved(id))
    id = `plugin-${hex()}`
  return id
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry overlay

export interface MergeEntryOverlayResult {
  /** The effective manifest (null when the plugin has neither a `plugin.json` nor a usable entry). */
  readonly manifest: ClaudePluginManifest | null
  readonly diagnostics: readonly ClaudePluginDiagnostic[]
}

function declaresComponents(manifest: ClaudePluginManifest): boolean {
  return manifest.commands !== undefined
    || manifest.agents !== undefined
    || manifest.skills !== undefined
    || manifest.outputStyles !== undefined
    || manifest.hooks !== undefined
    || manifest.mcpServers !== undefined
    || manifest.unsupported.some(key => CONFLICT_COMPONENTS.has(key))
}

function union(first: readonly string[] | undefined, second: readonly string[] | undefined): string[] {
  return [...new Set([...(first ?? []), ...(second ?? [])])]
}

/** Inline hook maps of `base` without the events `replacing` defines (an entry's hooks replace per event). */
function hooksWithoutEvents(base: readonly unknown[], replacing: readonly unknown[]): unknown[] {
  const events = new Set<string>()
  for (const map of replacing) {
    if (isRecord(map))
      Object.keys(map).forEach(event => events.add(event))
  }
  const result: unknown[] = []
  for (const map of base) {
    if (!isRecord(map)) {
      result.push(map)
      continue
    }
    const kept = Object.fromEntries(Object.entries(map).filter(([event]) => !events.has(event)))
    if (Object.keys(kept).length > 0)
      result.push(kept)
  }
  return result
}

/** The entry's overlay read as a manifest draft (name = entry name; version / description fall back to the entry). */
function overlayDraft(collector: Collector, entry: ClaudeMarketplaceEntry): ManifestDraft {
  const overlay = isRecord(entry.overlay) ? entry.overlay : {}
  const draft = readManifestBody(collector, overlay, 'overlay.', new Set())
  if (draft.version === undefined && typeof entry.version === 'string')
    draft.version = entry.version
  if (draft.description === undefined && typeof entry.description === 'string')
    draft.description = entry.description
  return draft
}

function draftOf(manifest: ClaudePluginManifest): ManifestDraft {
  return {
    ...(manifest.displayName === undefined ? {} : { displayName: manifest.displayName }),
    ...(manifest.version === undefined ? {} : { version: manifest.version }),
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    ...(manifest.author === undefined ? {} : { author: manifest.author }),
    ...(manifest.homepage === undefined ? {} : { homepage: manifest.homepage }),
    ...(manifest.repository === undefined ? {} : { repository: manifest.repository }),
    ...(manifest.license === undefined ? {} : { license: manifest.license }),
    keywords: [...manifest.keywords],
    defaultEnabled: manifest.defaultEnabled,
    ...(manifest.commands === undefined ? {} : { commands: { paths: [...manifest.commands.paths], inline: [...manifest.commands.inline] } }),
    ...(manifest.agents === undefined ? {} : { agents: [...manifest.agents] }),
    ...(manifest.skills === undefined ? {} : { skills: [...manifest.skills] }),
    ...(manifest.outputStyles === undefined ? {} : { outputStyles: [...manifest.outputStyles] }),
    ...(manifest.hooks === undefined ? {} : { hooks: { files: [...manifest.hooks.files], inline: [...manifest.hooks.inline] } }),
    ...(manifest.mcpServers === undefined ? {} : { mcpServers: { files: [...manifest.mcpServers.files], inline: [...manifest.mcpServers.inline] } }),
    userConfig: [...manifest.userConfig],
    unsupported: [...manifest.unsupported],
    accepted: {},
  }
}

/**
 * Applies a marketplace entry to a plugin's own manifest: `strict: true` (default) appends the entry's component lists
 * and lets `plugin.json` win metadata; `strict: false` makes the entry the whole manifest (a `plugin.json` that also
 * declares components → `conflicting-manifests` error).
 *
 * Details: without a `plugin.json` the entry is the manifest (either mode). `strict: true` with a `plugin.json`:
 * metadata from `plugin.json`, else from the entry; `defaultEnabled` is false when either says false; commands / agents /
 * output styles / skills paths and inline commands are appended (a replacing field the manifest did not declare is
 * listed in `appendToDefault`, so the default folder scan stays); hook files are appended and the entry's inline hook
 * maps replace the manifest's inline maps per event; MCP files and inline maps are appended (a later server name wins
 * when the server reads them); `userConfig` options with new keys are appended; `unsupported` is the union.
 * `strict: false` with a `plugin.json` without components: the entry's fields, `plugin.json` filling missing metadata,
 * the `plugin.json` name. The version is `plugin.json`'s, else the entry's, in both modes (plan "Version").
 */
export function mergeEntryOverlay(manifest: ClaudePluginManifest | null, entry: ClaudeMarketplaceEntry): MergeEntryOverlayResult {
  const collector = newCollector()
  try {
    if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name === '') {
      report(collector, 'error', 'missing-name', 'The marketplace entry has no name.')
      return { manifest: manifest ?? null, diagnostics: finish(collector) }
    }
    const overlay = overlayDraft(collector, entry)
    if (manifest === null || manifest === undefined)
      return { manifest: buildManifest(entry.name, overlay), diagnostics: finish(collector) }
    if (entry.strict === false) {
      if (declaresComponents(manifest)) {
        report(collector, 'error', 'conflicting-manifests', 'The marketplace entry sets "strict": false, so it must define the plugin alone, but plugin.json also declares components.')
        return { manifest: null, diagnostics: finish(collector) }
      }
      const own = draftOf(manifest)
      const merged: ManifestDraft = {
        ...overlay,
        displayName: overlay.displayName ?? own.displayName,
        version: own.version ?? overlay.version,
        description: overlay.description ?? own.description,
        author: overlay.author ?? own.author,
        homepage: overlay.homepage ?? own.homepage,
        repository: overlay.repository ?? own.repository,
        license: overlay.license ?? own.license,
        keywords: overlay.keywords ?? own.keywords,
        defaultEnabled: overlay.defaultEnabled ?? own.defaultEnabled,
        userConfig: overlay.userConfig ?? own.userConfig,
        unsupported: union(own.unsupported, overlay.unsupported),
      }
      return { manifest: buildManifest(manifest.name, merged), diagnostics: finish(collector) }
    }
    const own = draftOf(manifest)
    const appendToDefault: ClaudeReplacingComponent[] = []
    const merged: ManifestDraft = {
      ...own,
      displayName: own.displayName ?? overlay.displayName,
      version: own.version ?? overlay.version,
      description: own.description ?? overlay.description,
      author: own.author ?? overlay.author,
      homepage: own.homepage ?? overlay.homepage,
      repository: own.repository ?? overlay.repository,
      license: own.license ?? overlay.license,
      keywords: own.keywords !== undefined && own.keywords.length > 0 ? own.keywords : overlay.keywords ?? [],
      defaultEnabled: own.defaultEnabled !== false && overlay.defaultEnabled !== false,
      unsupported: union(own.unsupported, overlay.unsupported),
    }
    if (overlay.commands !== undefined) {
      if (own.commands === undefined)
        appendToDefault.push('commands')
      const inline = [...(own.commands?.inline ?? [])]
      for (const command of overlay.commands.inline) {
        if (!inline.some(entry => entry.name === command.name))
          inline.push(command)
      }
      merged.commands = { paths: union(own.commands?.paths, overlay.commands.paths), inline }
    }
    if (overlay.agents !== undefined) {
      if (own.agents === undefined)
        appendToDefault.push('agents')
      merged.agents = union(own.agents, overlay.agents)
    }
    if (overlay.outputStyles !== undefined) {
      if (own.outputStyles === undefined)
        appendToDefault.push('outputStyles')
      merged.outputStyles = union(own.outputStyles, overlay.outputStyles)
    }
    if (overlay.skills !== undefined)
      merged.skills = union(own.skills, overlay.skills)
    if (overlay.hooks !== undefined) {
      merged.hooks = {
        files: union(own.hooks?.files, overlay.hooks.files),
        inline: [...hooksWithoutEvents(own.hooks?.inline ?? [], overlay.hooks.inline), ...overlay.hooks.inline],
      }
    }
    if (overlay.mcpServers !== undefined) {
      merged.mcpServers = {
        files: union(own.mcpServers?.files, overlay.mcpServers.files),
        inline: [...(own.mcpServers?.inline ?? []), ...overlay.mcpServers.inline],
      }
    }
    if (overlay.userConfig !== undefined) {
      const options = [...(own.userConfig ?? [])]
      for (const option of overlay.userConfig) {
        if (!options.some(entry => entry.key === option.key) && options.length < CLAUDE_PLUGIN_LIMITS.userConfigMax)
          options.push(option)
      }
      merged.userConfig = options
    }
    return { manifest: buildManifest(manifest.name, merged, appendToDefault), diagnostics: finish(collector) }
  }
  catch {
    return { manifest: null, diagnostics: [{ level: 'error', code: 'invalid-field', message: 'The marketplace entry could not be applied.' }] }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Variables

export interface PluginVariables {
  /** Absolute plugin folder (`${CLAUDE_PLUGIN_ROOT}`). */
  readonly pluginRoot?: string
  /** Absolute plugin data folder (`${CLAUDE_PLUGIN_DATA}`). */
  readonly pluginData?: string
  /** Absolute project folder (`${CLAUDE_PROJECT_DIR}`); absent outside a project. */
  readonly projectDir?: string
  /** Absolute skill folder (`${CLAUDE_SKILL_DIR}`). */
  readonly skillDir?: string
  /** `${user_config.KEY}` values (already stringified). */
  readonly userConfig?: Readonly<Record<string, string>>
  /** Keys whose values are secret: never substituted in `markdown` mode (replaced by '' with an `unresolved` entry). */
  readonly sensitiveKeys?: ReadonlySet<string>
}

export interface SubstitutePluginVariablesResult {
  readonly text: string
  /** Variable references left unresolved (names only, e.g. `CLAUDE_PROJECT_DIR`, `user_config.TOKEN`). */
  readonly unresolved: readonly string[]
}

/** The plugin variables `substitutePluginVariables` knows (besides `user_config.KEY`). */
export const CLAUDE_PLUGIN_VARIABLE_NAMES = ['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR', 'CLAUDE_SKILL_DIR'] as const

/** `${…}` with an optional backslash before it; the inner text is one line without braces (≤ 200 characters). */
const VARIABLE_REFERENCE = /(\\?)\$\{([^\n{}]{0,200})\}/g
const USER_CONFIG_REFERENCE = /^user_config\.([A-Z_]\w{0,63})$/i
/** Inner texts reported when they stay unresolved: a variable name (`VAR`, `VAR:-default`, `user_config.KEY`). */
const REPORTABLE_NAME = /^([A-Z_]\w{0,63}(?:\.[A-Z_]\w{0,63})?)(?::-.*)?$/is
const UNRESOLVED_MAX = 50

/**
 * Substitutes the plugin variables in a markdown body (`markdown`) or an exec-form hook argument / MCP field (`exec`).
 * Never reads the server environment; unknown `${…}` references stay literal.
 *
 * Rules: `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SKILL_DIR}` and
 * `${user_config.KEY}` (an own key of `vars.userConfig`) are replaced by their value; a sensitive key in `markdown` mode
 * becomes '' and is reported; a known variable without a value and any other `${NAME}` / `${NAME:-default}` stay as
 * written and are reported (names only, first-seen order, at most 50); `\${…}` of a known variable is the literal text
 * (the backslash is removed); every other backslash and `$` stays as written.
 */
export function substitutePluginVariables(text: string, vars: PluginVariables, options: { readonly mode: 'markdown' | 'exec' }): SubstitutePluginVariablesResult {
  const source = typeof text === 'string' ? text : ''
  const unresolved: string[] = []
  const note = (name: string): void => {
    if (!unresolved.includes(name) && unresolved.length < UNRESOLVED_MAX)
      unresolved.push(name)
  }
  try {
    const values: PluginVariables = typeof vars === 'object' && vars !== null ? vars : {}
    const markdown = options?.mode !== 'exec'
    const fixed: Readonly<Record<string, string | undefined>> = {
      CLAUDE_PLUGIN_ROOT: values.pluginRoot,
      CLAUDE_PLUGIN_DATA: values.pluginData,
      CLAUDE_PROJECT_DIR: values.projectDir,
      CLAUDE_SKILL_DIR: values.skillDir,
    }
    const userConfig = typeof values.userConfig === 'object' && values.userConfig !== null ? values.userConfig : {}
    const keys = values.sensitiveKeys
    const sensitive: ReadonlySet<string> = typeof keys === 'object' && keys !== null && typeof keys.has === 'function' ? keys : new Set<string>()
    const output = source.replace(VARIABLE_REFERENCE, (match: string, escape: string, inner: string) => {
      const configKey = inner.match(USER_CONFIG_REFERENCE)?.[1]
      const known = Object.hasOwn(fixed, inner) || configKey !== undefined
      if (escape === '\\')
        return known ? match.slice(1) : match
      if (Object.hasOwn(fixed, inner)) {
        const value = fixed[inner]
        if (typeof value === 'string')
          return value
        note(inner)
        return match
      }
      if (configKey !== undefined) {
        const value = Object.hasOwn(userConfig, configKey) ? (userConfig as Record<string, unknown>)[configKey] : undefined
        if (markdown && sensitive.has(configKey)) {
          note(`user_config.${configKey}`)
          return ''
        }
        if (typeof value === 'string')
          return value
        note(`user_config.${configKey}`)
        return match
      }
      const name = inner.match(REPORTABLE_NAME)?.[1]
      if (name !== undefined)
        note(name)
      return match
    })
    return { text: output, unresolved }
  }
  catch {
    return { text: source, unresolved }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// userConfig → plugin settings

export interface UserConfigSettingsResult {
  /** A plugin `settings` JSON schema (`PluginSettingsSchema` shape: `type: 'object'`, `properties`, `required`). */
  readonly schema: Readonly<Record<string, unknown>>
  readonly diagnostics: readonly ClaudePluginDiagnostic[]
}

/** `SETTINGS_ENUM_MAX` of `schemas/plugin-settings.ts`. */
const SETTINGS_ENUM_MAX = 100
const SETTINGS_TITLE_MAX = 100
const SETTINGS_DESCRIPTION_MAX = 1000
const ABSOLUTE_PATH_PATTERN = '^/'
const ABSOLUTE_PATH_NOTE = ' (absolute path on the server)'
const ABSOLUTE_PATHS_NOTE = ' (absolute paths on the server)'

function settingsDescription(description: string | undefined, note: string): string | undefined {
  const text = description === undefined ? '' : description
  if (text === '' && note === '')
    return undefined
  const room = SETTINGS_DESCRIPTION_MAX - note.length
  return `${cut(text, room).trimEnd()}${note}`.trim()
}

function uniqueStrings(values: readonly unknown[]): string[] | null {
  if (!values.every(value => typeof value === 'string'))
    return null
  const list = values as string[]
  return new Set(list).size === list.length ? [...list] : null
}

/** One property of the settings schema for `option`; null when it cannot be mapped (reported). */
function settingsProperty(collector: Collector, option: ClaudeUserConfigOption, field: string): Record<string, unknown> | null {
  const title = cut((typeof option.title === 'string' && option.title.trim() !== '' ? option.title : option.key).trim(), SETTINGS_TITLE_MAX)
  const description = typeof option.description === 'string' ? option.description : undefined
  const choices = Array.isArray(option.options) ? uniqueStrings(option.options.filter(choice => typeof choice === 'string' && choice !== '')) : null
  const usableChoices = choices !== null && choices.length > 0 && choices.length <= SETTINGS_ENUM_MAX ? choices : null
  const hasDefault = option.default !== undefined && option.default !== null
  const dropDefault = (why: string): void => report(collector, 'warning', 'invalid-user-config', `The default ${why}; it is not used.`, field)
  const textual = option.type === 'string' || option.type === 'directory' || option.type === 'file'
  if (option.sensitive === true) {
    if (!textual)
      report(collector, 'warning', 'invalid-user-config', 'A sensitive option becomes a secret text setting.', field)
    if (hasDefault)
      report(collector, 'warning', 'invalid-user-config', 'Secret settings cannot have a default; it is not used.', field)
    if (option.multiple === true || usableChoices !== null)
      report(collector, 'warning', 'invalid-user-config', 'A secret setting holds one text value; "multiple" and "options" are ignored.', field)
    const text = settingsDescription(description, '')
    return { type: 'string', title, ...(text === undefined ? {} : { description: text }), format: 'secret' }
  }
  if (option.type !== 'string' && Array.isArray(option.options))
    report(collector, 'warning', 'invalid-user-config', 'Only text options can list choices; "options" is ignored.', field)
  else if (Array.isArray(option.options) && usableChoices === null)
    report(collector, 'warning', 'invalid-user-config', `Choices must be 1 to ${SETTINGS_ENUM_MAX} unique text values; "options" is ignored.`, field)
  switch (option.type) {
    case 'string':
    case 'directory':
    case 'file': {
      const paths = option.type !== 'string'
      const enumValues = option.type === 'string' ? usableChoices : null
      if (option.multiple === true) {
        const items = { type: 'string', ...(enumValues === null ? {} : { enum: enumValues }) }
        const text = settingsDescription(description, paths ? ABSOLUTE_PATHS_NOTE : '')
        const property: Record<string, unknown> = { type: 'array', title, ...(text === undefined ? {} : { description: text }), items }
        if (hasDefault) {
          const list = Array.isArray(option.default) ? uniqueStrings(option.default) : typeof option.default === 'string' ? [option.default] : null
          const valid = list !== null
            && list.every(value => value.trim() !== '' && (enumValues === null || enumValues.includes(value)) && (!paths || value.startsWith('/')))
          if (valid)
            property.default = list
          else
            dropDefault('is not a list of allowed values')
        }
        return property
      }
      const text = settingsDescription(description, paths ? ABSOLUTE_PATH_NOTE : '')
      const property: Record<string, unknown> = {
        type: 'string',
        title,
        ...(text === undefined ? {} : { description: text }),
        ...(enumValues === null ? {} : { enum: enumValues }),
        ...(paths ? { pattern: ABSOLUTE_PATH_PATTERN } : {}),
      }
      if (hasDefault) {
        const value = option.default
        if (typeof value === 'string' && (enumValues === null || enumValues.includes(value)) && (!paths || value.startsWith('/')))
          property.default = value
        else
          dropDefault(paths ? 'is not an absolute path' : 'is not one of the allowed values')
      }
      return property
    }
    case 'number': {
      if (option.multiple === true)
        report(collector, 'warning', 'invalid-user-config', 'A number option holds one value; "multiple" is ignored.', field)
      let minimum = finiteNumber(option.min)
      let maximum = finiteNumber(option.max)
      if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
        report(collector, 'warning', 'invalid-user-config', 'min is greater than max; both are ignored.', field)
        minimum = undefined
        maximum = undefined
      }
      const text = settingsDescription(description, '')
      const property: Record<string, unknown> = {
        type: 'number',
        title,
        ...(text === undefined ? {} : { description: text }),
        ...(minimum === undefined ? {} : { minimum }),
        ...(maximum === undefined ? {} : { maximum }),
      }
      if (hasDefault) {
        const value = finiteNumber(option.default)
        if (value !== undefined && (minimum === undefined || value >= minimum) && (maximum === undefined || value <= maximum))
          property.default = value
        else
          dropDefault('is not a number in range')
      }
      return property
    }
    case 'boolean': {
      const text = settingsDescription(description, '')
      const property: Record<string, unknown> = { type: 'boolean', title, ...(text === undefined ? {} : { description: text }) }
      if (hasDefault) {
        if (typeof option.default === 'boolean')
          property.default = option.default
        else
          dropDefault('is not true or false')
      }
      return property
    }
    default:
      report(collector, 'warning', 'invalid-user-config', 'The option type is not supported; the option is skipped.', field)
      return null
  }
}

/** Maps `userConfig` options to a plugin settings schema (`sensitive` → `format: 'secret'`, `directory` / `file` → absolute path strings). */
export function userConfigToSettings(options: readonly ClaudeUserConfigOption[]): UserConfigSettingsResult {
  const collector = newCollector()
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  try {
    const list = Array.isArray(options) ? options : []
    let count = 0
    for (const entry of list as readonly unknown[]) {
      if (!isRecord(entry) || typeof entry.key !== 'string') {
        report(collector, 'warning', 'invalid-user-config', 'An option without a key is skipped.', 'userConfig')
        continue
      }
      const option = entry as unknown as ClaudeUserConfigOption
      const field = `userConfig.${option.key}`
      if (!FIELD_KEY_PATTERN.test(option.key)) {
        report(collector, 'warning', 'invalid-user-config', 'Setting keys start with a letter and use up to 64 letters, digits and "_"; the option is skipped.', field)
        continue
      }
      if (Object.hasOwn(properties, option.key)) {
        report(collector, 'warning', 'invalid-user-config', 'The key is used twice; the first option is kept.', field)
        continue
      }
      if (count >= CLAUDE_PLUGIN_LIMITS.userConfigMax) {
        report(collector, 'warning', 'too-many', `Only the first ${CLAUDE_PLUGIN_LIMITS.userConfigMax} options become settings.`, 'userConfig')
        break
      }
      const property = settingsProperty(collector, option, field)
      if (property === null)
        continue
      Object.defineProperty(properties, option.key, { value: property, enumerable: true, writable: true, configurable: true })
      count++
      if (option.required === true)
        required.push(option.key)
    }
  }
  catch {
    report(collector, 'warning', 'invalid-user-config', 'The options could not be read completely.')
  }
  const schema: Record<string, unknown> = { type: 'object', properties, ...(required.length === 0 ? {} : { required }) }
  return { schema, diagnostics: finish(collector) }
}

// ---------------------------------------------------------------------------------------------------------------------
// "Add marketplace" input

export type MarketplaceShorthand
  = | { readonly kind: 'github', readonly repo: string, readonly ref?: string }
    | { readonly kind: 'url', readonly url: string }
    | { readonly kind: 'path', readonly path: string }

const SHORTHAND_MAX_CHARS = 2048

/**
 * Parses the "Add marketplace" input: `owner/repo`, `owner/repo#ref`, `owner/repo@ref`, a `https://github.com/o/r`
 * URL (optionally `.git`), an `https://…/marketplace.json` URL or an absolute server path. Null when unusable.
 *
 * Also accepted: `https://github.com/o/r/tree/<ref>` (a ref without `/`), `#ref` after a GitHub URL,
 * `git@github.com:o/r.git`. Refused: other git hosts, `http:` URLs, relative paths, `~`, paths with `..` segments.
 */
export function parseMarketplaceShorthand(input: string): MarketplaceShorthand | null {
  try {
    if (typeof input !== 'string')
      return null
    const text = input.trim()
    if (text === '' || text.length > SHORTHAND_MAX_CHARS || HAS_CONTROL.test(text) || /\s/.test(text))
      return null
    if (text.startsWith('/')) {
      if (text.includes('\\') || text.split('/').some(segment => segment === '..' || segment === '.'))
        return null
      const path = text.length > 1 ? text.replace(/\/+$/, '') : text
      return { kind: 'path', path: path === '' ? '/' : path.replace(/\/{2,}/g, '/') }
    }
    const withRef = (repo: string | null, ref: string | undefined): MarketplaceShorthand | null => {
      if (repo === null)
        return null
      if (ref === undefined)
        return { kind: 'github', repo }
      return isGitRef(ref) ? { kind: 'github', repo, ref } : null
    }
    const hash = text.indexOf('#')
    const beforeHash = hash === -1 ? text : text.slice(0, hash)
    const hashRef = hash === -1 ? undefined : text.slice(hash + 1)
    if (/^git@github\.com:/i.test(beforeHash))
      return withRef(githubRepoFromGitUrl(beforeHash), hashRef)
    if (/^[a-z][\d+.a-z-]*:/i.test(beforeHash)) {
      const url = parseHttpUrl(beforeHash, { credentials: false })
      if (url === null || url.protocol !== 'https:')
        return null
      const host = url.hostname.toLowerCase()
      if (host === 'github.com' || host === 'www.github.com') {
        const segments = url.pathname.split('/').filter(segment => segment !== '')
        if (url.search !== '')
          return null
        if (segments.length === 2)
          return withRef(parseGithubRepo(`${segments[0]}/${segments[1]}`), hashRef)
        if (segments.length === 4 && segments[2] === 'tree' && hashRef === undefined)
          return withRef(parseGithubRepo(`${segments[0]}/${segments[1]}`), decodeURIComponent(segments[3] ?? ''))
        return null
      }
      if (hash !== -1 || !url.pathname.toLowerCase().endsWith('.json'))
        return null
      return { kind: 'url', url: url.href }
    }
    const at = beforeHash.indexOf('@')
    if (at !== -1 && hashRef !== undefined)
      return null
    const repoText = at === -1 ? beforeHash : beforeHash.slice(0, at)
    const ref = at === -1 ? hashRef : beforeHash.slice(at + 1)
    return withRef(parseGithubRepo(repoText), ref)
  }
  catch {
    return null
  }
}
