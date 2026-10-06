/**
 * Import from a Claude Code home folder (Phase 12, ADR-055): the allowlist of files that may be read
 * (`isClaudeHomeImportPath`), the caps, and the one planner (`planClaudeImport`) that turns the collected files plus
 * the current harness state (the baseline) into an import plan: agents, commands, skills and output styles (markdown
 * definitions, a missing `name:` inserted from the file name), hooks of `settings.json`, `permissions.allow` Bash rules
 * (shell rules), whole-tool `deny` rules (tool overrides), `outputStyle`, `CLAUDE.md` (global instructions) and the
 * MCP servers of `.claude.json` (top-level and per-project `mcpServers` only; every other key is dropped).
 * The server builds the authoritative plan (upload or scan) and keeps the payloads (contents, env values) server-side;
 * the web uses the allowlist to filter a picked folder and may run the planner for labels.
 * Pure and isomorphic; never throws on any input (problems are diagnostics or `invalid` items).
 * Contract skeleton written by the coordinator in P12-0a; implemented by C41. Adding members is fine; renaming or
 * removing one is a CCR.
 *
 * Import note: never import `limits.ts` or `enums.ts` here (`CLAUDE_HOME_LIMITS` is mirrored by the Phase 12 group of
 * `LIMITS`).
 *
 * Planner rules (plan "Import statuses" / "Import rules"):
 * - Definitions are parsed only by `parseDefinition`; the name is the frontmatter `name`, else the path: the file stem
 *   (agents, styles), the folder (skills) or, for commands, every segment below `commands/` joined with `-`
 *   (`commands/db/migrate.md` → `db-migrate`), slugged (`clean_gone` → `clean-gone`, ≤ 32 / 64 characters; an `info`
 *   diagnostic `name-from-path`) and written into the frontmatter (`setDefinitionName`), so the stored content names
 *   itself. Status by (kind, name) against the baseline: byte-equal content → `unchanged`; other content → `update`
 *   (skip by default; overwrite or rename `<name>-2`); a builtin or reserved name, or a name an earlier file of this
 *   import already uses → `conflict` (rename only); parser errors → `invalid`. A command with `` !`cmd` `` spans is
 *   `executable` (`runs-commands`).
 * - `settings.json`: one `hook` item per handler (identity `claudeImportHookIdentity` against `baseline.hooks`; command
 *   handlers are `executable`; unsupported handler types and unknown events are `unsupported` items, invalid handlers
 *   `invalid` items); `permissions.allow` Bash rules → `shell-rule` items, whole-tool `deny` rules → `tool-deny` items,
 *   every other rule and permission setting → `unsupported` `permission` items; `env` → one `env` item listing the
 *   names (the values only go to `draft.env`); `outputStyle` → a `setting` item; `model`, the command-running settings
 *   (`apiKeyHelper`, `statusLine`, `awsAuthRefresh`, `awsCredentialExport`, `otelHeadersHelper`), `enabledPlugins` and
 *   `extraKnownMarketplaces` → `unsupported` items; other keys → one `info` diagnostic naming them.
 * - `CLAUDE.md` → one `instructions` item (append / replace / skip); `.claude.json` → `mcp-server` items.
 * - Summaries and diagnostics never quote values: no env or header values, no arguments, no URLs beyond the host.
 * - Items are sorted by kind (`CLAUDE_IMPORT_KINDS`), then name, then key; files are processed in path order, so the
 *   plan is deterministic for the same input.
 */
import type { CustomizationKind, DefinitionDiagnostic, ParsedDefinition, ParseDefinitionOptions, ParseDefinitionResult } from './definitions.ts'
import type { HookDiagnostic } from './hooks.ts'
import type { McpConfigDiagnostic, McpJsonRemoteServer, McpJsonStdioServer } from './mcp-config.ts'
import { AGENT_NAME_PATTERN, COMMAND_NAME_PATTERN } from '../ids.ts'
import { parseClaudePermissionRule, SHELL_RULE_FROM_PERMISSION_MESSAGES, shellRuleFromPermission, toolNamesFromPermission } from './claude-permissions.ts'
import { planCommandExpansion } from './command-template.ts'
import { parseDefinition, setDefinitionName, styleNameFromLabel } from './definitions.ts'
import { fnv1a32Hex } from './hash.ts'
import { HOOK_EVENTS, readHooksConfig } from './hooks.ts'
import { mcpServerIdFromName, parseMcpJson, serverVariables } from './mcp-config.ts'
import { parseShellRule } from './shell-command.ts'
import { canonicalJson } from './trust.ts'

/** Mirrored by the Phase 12 group of `LIMITS`. */
export const CLAUDE_HOME_LIMITS = {
  /** One definition file (agent, command, skill, output style). */
  definitionBytes: 65_536,
  definitionsPerKindMax: 200,
  /** Command subfolders below `commands/`. */
  commandDepthMax: 3,
  settingsBytes: 262_144,
  claudeMdBytes: 1_048_576,
  /** `.claude.json` is read whole (it is often large) and reduced to its `mcpServers` maps at once. */
  claudeJsonBytes: 16_777_216,
  totalBytes: 33_554_432,
  itemsMax: 1000,
  skippedMax: 200,
  /** Characters of an item summary (never values). */
  summaryMaxChars: 300,
} as const

/** The path of `~/.claude.json` in a collected file list (it sits next to the `.claude` folder, not inside it). */
export const CLAUDE_JSON_PATH = '.claude.json'

/** `LIMITS.instructionsMaxChars`: the global instructions setting (`CLAUDE.md` is imported into it). */
export const CLAUDE_IMPORT_INSTRUCTIONS_MAX_CHARS = 20_000

/** What an allowlisted path holds. */
export type ClaudeHomeFileKind = 'agent' | 'command' | 'skill' | 'style' | 'settings' | 'instructions' | 'claude-json'

/** Characters of a collected path. */
const HOME_PATH_MAX_CHARS = 1024
const HAS_CONTROL = /[\p{Cc}\p{Cf}]/u
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/gu

/**
 * The normalized form of a collected path (POSIX, relative to the `.claude` folder): `.` and empty segments removed;
 * null for an absolute path, a backslash, a control character, a `..` segment, a hidden segment (except the
 * `CLAUDE_JSON_PATH` sentinel) or more than 1024 characters.
 */
export function normalizeClaudeHomePath(path: string): string | null {
  if (typeof path !== 'string' || path === '' || path.length > HOME_PATH_MAX_CHARS)
    return null
  if (path.includes('\\') || HAS_CONTROL.test(path) || path.startsWith('/'))
    return null
  const segments = path.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.includes('..'))
    return null
  const normalized = segments.join('/')
  if (normalized === CLAUDE_JSON_PATH)
    return normalized
  if (segments.some(segment => segment.startsWith('.')))
    return null
  return normalized
}

/** What an allowlisted path holds (the path is normalized first); null when it is not on the allowlist. */
export function classifyClaudeHomePath(path: string): ClaudeHomeFileKind | null {
  const normalized = normalizeClaudeHomePath(path)
  if (normalized === null)
    return null
  if (normalized === CLAUDE_JSON_PATH)
    return 'claude-json'
  if (normalized === 'settings.json')
    return 'settings'
  if (normalized === 'CLAUDE.md')
    return 'instructions'
  const segments = normalized.split('/')
  const last = segments.at(-1) ?? ''
  const markdown = last.endsWith('.md') && last.length > 3
  switch (segments[0]) {
    case 'agents':
      return segments.length === 2 && markdown ? 'agent' : null
    case 'output-styles':
      return segments.length === 2 && markdown ? 'style' : null
    case 'commands':
      return segments.length >= 2 && segments.length <= 2 + CLAUDE_HOME_LIMITS.commandDepthMax && markdown ? 'command' : null
    case 'skills':
      return segments.length === 3 && last === 'SKILL.md' ? 'skill' : null
    default:
      return null
  }
}

/**
 * Whether a path (POSIX, relative to the `.claude` folder; `CLAUDE_JSON_PATH` for `~/.claude.json`) may be read:
 * `agents/*.md`, `commands/**\/*.md` (≤ 3 levels), `skills/<name>/SKILL.md`, `output-styles/*.md`, `settings.json`,
 * `CLAUDE.md`, `.claude.json`. Never `.credentials.json`, `projects/`, `history.jsonl`, `todos/`,
 * `shell-snapshots/`, `statsig/`, `plugins/` or `settings.local.json`.
 */
export function isClaudeHomeImportPath(path: string): boolean {
  return classifyClaudeHomePath(path) !== null
}

export interface ClaudeHomeFile {
  /** POSIX path relative to the `.claude` folder, or `CLAUDE_JSON_PATH`. */
  readonly path: string
  readonly text: string
  /** The scan reached it through a symbolic link (shown in the plan). */
  readonly linked?: boolean
}

export const CLAUDE_IMPORT_KINDS = [
  'agent',
  'command',
  'skill',
  'style',
  'hook',
  'mcp-server',
  'shell-rule',
  'tool-deny',
  'instructions',
  'setting',
  'permission',
  'env',
  'plugin',
  'marketplace',
] as const
export type ClaudeImportKind = (typeof CLAUDE_IMPORT_KINDS)[number]

export const CLAUDE_IMPORT_STATUSES = ['new', 'update', 'unchanged', 'conflict', 'unsupported', 'invalid'] as const
export type ClaudeImportStatus = (typeof CLAUDE_IMPORT_STATUSES)[number]

export const CLAUDE_IMPORT_ACTIONS = ['import', 'skip', 'overwrite', 'rename', 'append', 'replace'] as const
export type ClaudeImportAction = (typeof CLAUDE_IMPORT_ACTIONS)[number]

export const CLAUDE_IMPORT_WARNINGS = [
  /** Runs commands on this server (command hook, `!` command, stdio MCP server): imported turned off by default. */
  'runs-commands',
  /** An exact `Bash(cmd)` rule became a prefix rule. */
  'prefix-broader',
  /** A per-project server of `.claude.json`: imported as a disabled global server. */
  'project-server',
  /** Reached through a symbolic link. */
  'linked',
  /** `@path` imports in `CLAUDE.md` are kept as text. */
  'imports-kept',
  /** `${VAR}` references without a value from `settings.json` `env` (the apply body may supply them). */
  'needs-variables',
  /** A Claude model alias (`sonnet`, …) resolved through the `modelAliases` setting at run time. */
  'model-alias',
] as const
export type ClaudeImportWarning = (typeof CLAUDE_IMPORT_WARNINGS)[number]

export interface ClaudeImportDiagnostic {
  readonly level: 'error' | 'warning' | 'info'
  readonly code: string
  /** One English sentence; never quotes values. */
  readonly message: string
}

/** What the server applies for an item; never sent to the browser. */
export type ClaudeImportPayload
  = | { readonly kind: 'definition', readonly definitionKind: 'agent' | 'command' | 'skill' | 'style', readonly content: string }
    | {
      readonly kind: 'hook'
      readonly event: string
      readonly matcher: string | null
      /** The handler object as read (`type`, `command` / `prompt`, `timeout`, `args`, …), validated by `readHooksConfig`. */
      readonly handler: Readonly<Record<string, unknown>>
    }
    | {
      readonly kind: 'mcp-server'
      /** The name as written in `.claude.json`. */
      readonly name: string
      /** The harness id (`mcpServerIdFromName`). */
      readonly id: string
      /** The raw server object (still with `${VAR}` references; expanded by the server at apply time). */
      readonly raw: Readonly<Record<string, unknown>>
      /** The `projects` key it came from, for per-project servers. */
      readonly project?: string
    }
    | { readonly kind: 'shell-rule', readonly prefix: string }
    | { readonly kind: 'tool-deny', readonly tools: readonly string[] }
    | { readonly kind: 'instructions', readonly text: string }
    | { readonly kind: 'setting', readonly key: 'outputStyle', readonly value: string }
    | { readonly kind: 'none' }

export interface ClaudeImportPlanItem {
  /** Stable within a plan (`claudeImportItemKey`). */
  readonly key: string
  readonly kind: ClaudeImportKind
  readonly name: string
  readonly source: { readonly file: string, readonly project?: string }
  readonly status: ClaudeImportStatus
  /** The actions the user may pick (empty for `unchanged`, `unsupported` and `invalid`). */
  readonly actions: readonly ClaudeImportAction[]
  readonly defaultAction: ClaudeImportAction
  /** Suggested name for `rename` (`<name>-2`, …). */
  readonly renameTo?: string
  /** One line for the preview (≤ 300 characters, never values). */
  readonly summary: string
  readonly warnings: readonly ClaudeImportWarning[]
  readonly diagnostics: readonly ClaudeImportDiagnostic[]
  /** `${VAR}` names an MCP server needs (names only). */
  readonly variables?: readonly string[]
  /** True for command hooks, `!` commands and stdio MCP servers (apply needs fresh auth; imported turned off by default). */
  readonly executable: boolean
  readonly payload: ClaudeImportPayload
}

/** The current harness state the planner compares against (the server builds it; the web may pass a partial one). */
export interface ClaudeImportBaseline {
  /** Personal definitions with their raw markdown. */
  readonly definitions: readonly { readonly kind: 'agent' | 'command' | 'skill' | 'style', readonly name: string, readonly content: string }[]
  /** Builtin and reserved names that can never be taken (rename only). */
  readonly reservedNames: readonly { readonly kind: 'agent' | 'command' | 'skill' | 'style', readonly name: string }[]
  /** Canonical handler texts of personal hooks (`canonicalJson` of `{ event, matcher, handler }`). */
  readonly hooks: readonly string[]
  /** Global MCP servers: id + transport fingerprint (command, args, url, env / header names). */
  readonly mcpServers: readonly { readonly id: string, readonly fingerprint: string }[]
  /** Global shell rule prefixes. */
  readonly shellRules: readonly string[]
  /** Tool names that already have a `deny` override. */
  readonly toolDenies: readonly string[]
  /** The global instructions setting. */
  readonly instructions: string
  /** Output style names that exist (builtin, plugin, personal). */
  readonly styles: readonly string[]
  /** The global `outputStyle` setting (an `outputStyle` item naming it is `unchanged`); absent = unknown. */
  readonly outputStyle?: string | null
}

export interface ClaudeImportPlanDraft {
  readonly items: readonly ClaudeImportPlanItem[]
  /** Files that were collected but not used (too large, binary, not allowlisted, over a cap). */
  readonly skipped: readonly { readonly path: string, readonly reason: string }[]
  readonly diagnostics: readonly ClaudeImportDiagnostic[]
  /** `settings.json` `env` values used to resolve `${VAR}` in imported MCP servers (server-side only). */
  readonly env: Readonly<Record<string, string>>
}

// ---------------------------------------------------------------------------------------------------------------------
// Identities

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `HOOK_LIMITS.timeoutMaxSec`: timeouts are capped like `readHooksConfig` caps them. */
const HOOK_TIMEOUT_MAX_SEC = 600

/**
 * The normalized handler of a hook identity: `type` (`command` unless `prompt`), `command` / `prompt` (trimmed),
 * `timeout` (seconds, rounded up, ≤ 600), `args`, `if`, `statusMessage`, `model` (trimmed), `async` (also for
 * `asyncRewake`) / `continueOnBlock` (only when true); absent, null, empty and unknown fields are left out.
 */
function identityHandler(handler: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const source = isRecord(handler) ? handler : {}
  const result: Record<string, unknown> = { type: source.type === 'prompt' ? 'prompt' : 'command' }
  const text = (key: string): void => {
    const value = source[key]
    if (typeof value === 'string' && value.trim() !== '')
      result[key] = value.trim()
  }
  text('command')
  text('prompt')
  const timeout = source.timeout
  if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0)
    result.timeout = Math.min(Math.ceil(timeout), HOOK_TIMEOUT_MAX_SEC)
  if (Array.isArray(source.args) && source.args.every(arg => typeof arg === 'string'))
    result.args = [...source.args]
  if (source.async === true || source.asyncRewake === true)
    result.async = true
  text('if')
  text('statusMessage')
  text('model')
  if (source.continueOnBlock === true)
    result.continueOnBlock = true
  return result
}

/**
 * The identity of a hook handler (`baseline.hooks` holds these texts for the personal hooks): `canonicalJson` of
 * `{ event, matcher, handler }` with the matcher trimmed (empty = null) and the handler normalized (see above). The
 * server builds it from a personal hook row (`{ type, command, timeout, prompt, model, …options }`).
 */
export function claudeImportHookIdentity(event: string, matcher: string | null, handler: Readonly<Record<string, unknown>>): string {
  const trimmed = typeof matcher === 'string' ? matcher.trim() : ''
  return canonicalJson({ event: typeof event === 'string' ? event : '', matcher: trimmed === '' ? null : trimmed, handler: identityHandler(handler) })
}

/**
 * The transport fingerprint of an MCP server (`baseline.mcpServers[].fingerprint`): `canonicalJson` of the type
 * (`stdio` when there is a command, else `type ?? 'http'`), the command and arguments (stdio) or the URL (remote), and
 * the sorted env / header NAMES (never their values). Accepts a `.mcp.json` transport, a raw server object or a server
 * DTO transport (env / headers as objects keyed by name, or name lists).
 */
export function claudeImportMcpFingerprint(transport: { readonly type?: unknown, readonly command?: unknown, readonly args?: unknown, readonly url?: unknown, readonly env?: unknown, readonly headers?: unknown }): string {
  const source = isRecord(transport) ? transport : {}
  const names = (value: unknown): string[] => {
    if (Array.isArray(value))
      return [...new Set(value.filter((name): name is string => typeof name === 'string'))].sort()
    return isRecord(value) ? Object.keys(value).sort() : []
  }
  const command = typeof source.command === 'string' ? source.command.trim() : null
  if (command !== null && command !== '') {
    const args = Array.isArray(source.args) ? source.args.filter((arg): arg is string => typeof arg === 'string') : []
    return canonicalJson({ type: 'stdio', command, args, env: names(source.env) })
  }
  const type = source.type === 'sse' ? 'sse' : source.type === 'stdio' ? 'stdio' : 'http'
  const url = typeof source.url === 'string' ? source.url.trim() : null
  return canonicalJson({ type, url, headers: names(source.headers) })
}

/** Item keys longer than this are cut and end with `~` + 8 hex of the whole key. */
const ITEM_KEY_MAX_CHARS = 256

function encodeKeyPart(text: string): string {
  return text.replace(/[%:\p{Cc}\p{Cf}]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

/** The stable key of a plan item (`<kind>:<name>:<file>`, bounded). */
export function claudeImportItemKey(kind: ClaudeImportKind, name: string, file: string): string {
  const key = `${typeof kind === 'string' ? kind : ''}:${encodeKeyPart(typeof name === 'string' ? name : '')}:${encodeKeyPart(typeof file === 'string' ? file : '')}`
  if (key.length <= ITEM_KEY_MAX_CHARS)
    return key
  return `${key.slice(0, ITEM_KEY_MAX_CHARS - 9)}~${fnv1a32Hex(key)}`
}

// ---------------------------------------------------------------------------------------------------------------------
// `.claude.json`

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

/** Project paths of `.claude.json` kept (characters). */
const PROJECT_PATH_MAX_CHARS = 4096
/** Projects with servers read from `.claude.json`. */
const PROJECTS_MAX = 200

/** A plain copy of a server map (own enumerable keys; `__proto__` stays an ordinary key). */
function copyMap(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value))
    Object.defineProperty(result, key, { value: value[key], enumerable: true, writable: true, configurable: true })
  return result
}

/**
 * Reduces a `.claude.json` text to its MCP server maps (top-level `mcpServers` and `projects[<path>].mcpServers`);
 * every other key (accounts, keys, histories) is dropped before anything else reads the object.
 */
export function extractClaudeJsonMcpServers(text: string): {
  readonly servers: Readonly<Record<string, unknown>>
  readonly projects: readonly { readonly path: string, readonly servers: Readonly<Record<string, unknown>> }[]
  readonly diagnostics: readonly ClaudeImportDiagnostic[]
} {
  const fail = (code: string, message: string): ReturnType<typeof extractClaudeJsonMcpServers> => ({
    servers: {},
    projects: [],
    diagnostics: [{ level: 'error', code, message }],
  })
  try {
    const source = typeof text === 'string' ? text : ''
    if (utf8LengthUpTo(source, CLAUDE_HOME_LIMITS.claudeJsonBytes) > CLAUDE_HOME_LIMITS.claudeJsonBytes)
      return fail('too-large', `.claude.json is larger than ${formatBytes(CLAUDE_HOME_LIMITS.claudeJsonBytes)}.`)
    let parsed: unknown
    try {
      parsed = JSON.parse(source.startsWith('\uFEFF') ? source.slice(1) : source)
    }
    catch {
      return fail('invalid-json', '.claude.json is not valid JSON.')
    }
    if (!isRecord(parsed))
      return fail('not-an-object', '.claude.json must hold a JSON object.')
    const diagnostics: ClaudeImportDiagnostic[] = []
    const top = parsed.mcpServers
    const projectsValue = parsed.projects
    parsed = null
    let servers: Record<string, unknown> = {}
    if (isRecord(top))
      servers = copyMap(top)
    else if (top !== undefined && top !== null)
      diagnostics.push({ level: 'warning', code: 'not-an-object', message: 'The top-level "mcpServers" of .claude.json is not an object; it is ignored.' })
    const projects: { path: string, servers: Record<string, unknown> }[] = []
    let skippedProjects = 0
    if (isRecord(projectsValue)) {
      for (const path of Object.keys(projectsValue)) {
        const project = projectsValue[path]
        if (!isRecord(project) || !isRecord(project.mcpServers) || Object.keys(project.mcpServers).length === 0)
          continue
        if (path === '' || path.length > PROJECT_PATH_MAX_CHARS || HAS_CONTROL.test(path)) {
          skippedProjects++
          continue
        }
        projects.push({ path, servers: copyMap(project.mcpServers) })
      }
    }
    projects.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    if (skippedProjects > 0)
      diagnostics.push({ level: 'warning', code: 'invalid-project', message: `${skippedProjects} projects of .claude.json have an unusable path; their servers are ignored.` })
    if (projects.length > PROJECTS_MAX) {
      diagnostics.push({ level: 'warning', code: 'too-many', message: `Servers of more than ${PROJECTS_MAX} projects were found; only the first ${PROJECTS_MAX} projects are read.` })
      projects.length = PROJECTS_MAX
    }
    return { servers, projects, diagnostics }
  }
  catch {
    return fail('invalid-json', '.claude.json could not be read.')
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Planner state

type DefinitionKind = 'agent' | 'command' | 'skill' | 'style'

const DEFINITION_KINDS: readonly DefinitionKind[] = ['agent', 'command', 'skill', 'style']
const ITEM_DIAGNOSTICS_MAX = 20
const PLAN_DIAGNOSTICS_MAX = 200
/** Files of one collection looked at (anything beyond is skipped unread). */
const FILES_MAX = 10_000
const SKIPPED_PATH_MAX_CHARS = 256
const ENV_NAME_PATTERN = /^[A-Z_]\w{0,127}$/i
const ENV_VALUE_MAX_CHARS = 4096
const ENV_MAX = 200
const RULES_PER_LIST_MAX = 500
const PLUGIN_ITEMS_MAX = 100
/** Settings that run a command; never run by the harness. */
const COMMAND_SETTINGS = ['apiKeyHelper', 'statusLine', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'] as const
/** Settings keys the planner reads (anything else is named in one `info` diagnostic). */
const READ_SETTINGS: ReadonlySet<string> = new Set([
  '$schema',
  'hooks',
  'permissions',
  'env',
  'outputStyle',
  'model',
  'enabledPlugins',
  'extraKnownMarketplaces',
  ...COMMAND_SETTINGS,
])

interface NormalizedBaseline {
  readonly definitions: ReadonlyMap<string, string>
  readonly definitionNames: Readonly<Record<DefinitionKind, ReadonlySet<string>>>
  readonly reserved: Readonly<Record<DefinitionKind, ReadonlySet<string>>>
  readonly hooks: ReadonlySet<string>
  readonly mcpServers: ReadonlyMap<string, string>
  readonly shellRules: ReadonlySet<string>
  readonly toolDenies: ReadonlySet<string>
  readonly instructions: string
  readonly styles: ReadonlySet<string>
  readonly outputStyle: string | null
}

interface PlanState {
  readonly baseline: NormalizedBaseline
  readonly items: ClaudeImportPlanItem[]
  itemsDropped: number
  readonly keys: Set<string>
  /** Every skipped file (sorted and capped at the end, so the list does not depend on the input order). */
  readonly skipped: { path: string, reason: string }[]
  readonly diagnostics: ClaudeImportDiagnostic[]
  diagnosticsDropped: number
  readonly env: Record<string, string>
  /** Definition names this plan imports or keeps, per kind. */
  readonly planNames: Record<DefinitionKind, Set<string>>
  /** Suggested `renameTo` names, per kind. */
  readonly renameNames: Record<DefinitionKind, Set<string>>
  readonly hookIdentities: Set<string>
  readonly shellPrefixes: Set<string>
  readonly toolDenies: Set<string>
  /** MCP ids taken (baseline, plan, suggested renames). */
  readonly mcpIds: Set<string>
  /** MCP id → fingerprint of the servers this plan imports. */
  readonly planMcp: Map<string, string>
}

function definitionKey(kind: string, name: string): string {
  return `${kind}\u0000${name}`
}

function emptyKindSets(): Record<DefinitionKind, Set<string>> {
  return { agent: new Set(), command: new Set(), skill: new Set(), style: new Set() }
}

function isDefinitionKind(value: unknown): value is DefinitionKind {
  return typeof value === 'string' && (DEFINITION_KINDS as readonly string[]).includes(value)
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function canonicalPrefix(prefix: string): string {
  const parsed = parseShellRule(prefix)
  return parsed.ok ? parsed.canonical : prefix.trim()
}

function normalizeBaseline(value: ClaudeImportBaseline | undefined): NormalizedBaseline {
  const source: Partial<Record<keyof ClaudeImportBaseline, unknown>> = isRecord(value) ? value : {}
  const definitionMap = new Map<string, string>()
  const definitionNames = emptyKindSets()
  for (const entry of Array.isArray(source.definitions) ? source.definitions : []) {
    if (!isRecord(entry) || !isDefinitionKind(entry.kind) || typeof entry.name !== 'string')
      continue
    definitionMap.set(definitionKey(entry.kind, entry.name), typeof entry.content === 'string' ? entry.content : '')
    definitionNames[entry.kind].add(entry.name)
  }
  const reserved = emptyKindSets()
  for (const entry of Array.isArray(source.reservedNames) ? source.reservedNames : []) {
    if (isRecord(entry) && isDefinitionKind(entry.kind) && typeof entry.name === 'string')
      reserved[entry.kind].add(entry.name)
  }
  const mcpServers = new Map<string, string>()
  for (const entry of Array.isArray(source.mcpServers) ? source.mcpServers : []) {
    if (isRecord(entry) && typeof entry.id === 'string')
      mcpServers.set(entry.id, typeof entry.fingerprint === 'string' ? entry.fingerprint : '')
  }
  return {
    definitions: definitionMap,
    definitionNames,
    reserved,
    hooks: new Set(stringList(source.hooks)),
    mcpServers,
    shellRules: new Set(stringList(source.shellRules).map(canonicalPrefix)),
    toolDenies: new Set(stringList(source.toolDenies)),
    instructions: typeof source.instructions === 'string' ? source.instructions : '',
    styles: new Set(stringList(source.styles)),
    outputStyle: typeof source.outputStyle === 'string' ? source.outputStyle : null,
  }
}

function newState(baseline: NormalizedBaseline): PlanState {
  return {
    baseline,
    items: [],
    itemsDropped: 0,
    keys: new Set(),
    skipped: [],
    diagnostics: [],
    diagnosticsDropped: 0,
    env: {},
    planNames: emptyKindSets(),
    renameNames: emptyKindSets(),
    hookIdentities: new Set(),
    shellPrefixes: new Set(),
    toolDenies: new Set(),
    mcpIds: new Set(baseline.mcpServers.keys()),
    planMcp: new Map(),
  }
}

/** One line of text: control characters and runs of blanks become one space, cut to `max`. */
function oneLine(text: string, max: number): string {
  const line = text.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim()
  if (line.length <= max)
    return line
  let end = max - 3
  const last = line.charCodeAt(end - 1)
  if (last >= 0xD800 && last <= 0xDBFF)
    end--
  return `${line.slice(0, end).trimEnd()}...`
}

function planDiagnostic(state: PlanState, level: ClaudeImportDiagnostic['level'], code: string, message: string): void {
  if (state.diagnostics.length >= PLAN_DIAGNOSTICS_MAX - 1) {
    state.diagnosticsDropped++
    return
  }
  state.diagnostics.push({ level, code, message: oneLine(message, 1000) })
}

function skip(state: PlanState, path: string, reason: string): void {
  state.skipped.push({ path: oneLine(path, SKIPPED_PATH_MAX_CHARS), reason })
}

interface ItemSpec {
  readonly kind: ClaudeImportKind
  readonly name: string
  /** The name part of the key (default `name`). */
  readonly keyName?: string
  readonly file: string
  readonly project?: string
  readonly status: ClaudeImportStatus
  readonly actions?: readonly ClaudeImportAction[]
  readonly defaultAction?: ClaudeImportAction
  readonly renameTo?: string
  readonly summary: string
  readonly warnings?: readonly ClaudeImportWarning[]
  readonly diagnostics?: readonly ClaudeImportDiagnostic[]
  readonly variables?: readonly string[]
  readonly executable?: boolean
  readonly payload?: ClaudeImportPayload
  readonly linked?: boolean
}

function defaultActions(status: ClaudeImportStatus): readonly ClaudeImportAction[] {
  switch (status) {
    case 'new':
      return ['import', 'skip']
    case 'update':
      return ['skip', 'overwrite', 'rename']
    case 'conflict':
      return ['skip', 'rename']
    default:
      return []
  }
}

function addItem(state: PlanState, spec: ItemSpec): void {
  if (state.items.length >= CLAUDE_HOME_LIMITS.itemsMax) {
    state.itemsDropped++
    return
  }
  const file = spec.project === undefined ? spec.file : `${spec.file}#${spec.project}`
  const base = claudeImportItemKey(spec.kind, spec.keyName ?? spec.name, file)
  let key = base
  for (let counter = 2; state.keys.has(key); counter++)
    key = `${base.slice(0, ITEM_KEY_MAX_CHARS - 12)}~${counter}`
  state.keys.add(key)
  const warnings: ClaudeImportWarning[] = []
  for (const warning of [...(spec.warnings ?? []), ...(spec.linked === true ? ['linked' as const] : [])]) {
    if (!warnings.includes(warning))
      warnings.push(warning)
  }
  const actions = spec.actions ?? defaultActions(spec.status)
  const diagnostics = (spec.diagnostics ?? []).slice(0, ITEM_DIAGNOSTICS_MAX).map(entry => ({ level: entry.level, code: entry.code, message: oneLine(entry.message, 1000) }))
  state.items.push({
    key,
    kind: spec.kind,
    name: oneLine(spec.name, 256),
    source: spec.project === undefined ? { file: spec.file } : { file: spec.file, project: spec.project },
    status: spec.status,
    actions,
    defaultAction: spec.defaultAction ?? (spec.status === 'new' ? 'import' : 'skip'),
    ...(spec.renameTo === undefined ? {} : { renameTo: spec.renameTo }),
    summary: oneLine(spec.summary, CLAUDE_HOME_LIMITS.summaryMaxChars),
    warnings,
    diagnostics,
    ...(spec.variables === undefined ? {} : { variables: [...spec.variables] }),
    executable: spec.executable === true,
    payload: spec.payload ?? { kind: 'none' },
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// Collection

interface CollectedFile {
  readonly path: string
  readonly kind: ClaudeHomeFileKind
  readonly text: string
  readonly linked: boolean
}

const BYTE_CAPS: Readonly<Record<ClaudeHomeFileKind, number>> = {
  'agent': CLAUDE_HOME_LIMITS.definitionBytes,
  'command': CLAUDE_HOME_LIMITS.definitionBytes,
  'skill': CLAUDE_HOME_LIMITS.definitionBytes,
  'style': CLAUDE_HOME_LIMITS.definitionBytes,
  'settings': CLAUDE_HOME_LIMITS.settingsBytes,
  'instructions': CLAUDE_HOME_LIMITS.claudeMdBytes,
  'claude-json': CLAUDE_HOME_LIMITS.claudeJsonBytes,
}

const KIND_PLURALS: Readonly<Record<DefinitionKind, string>> = { agent: 'agents', command: 'commands', skill: 'skills', style: 'output styles' }

function collect(state: PlanState, files: readonly ClaudeHomeFile[]): CollectedFile[] {
  const list: unknown[] = Array.isArray(files) ? files : []
  if (list.length > FILES_MAX)
    planDiagnostic(state, 'warning', 'too-many', `More than ${FILES_MAX} files were collected; only the first ${FILES_MAX} are looked at.`)
  const candidates: { path: string, kind: ClaudeHomeFileKind, text: string, linked: boolean }[] = []
  for (const entry of list.slice(0, FILES_MAX)) {
    if (!isRecord(entry) || typeof entry.path !== 'string') {
      skip(state, '(unnamed)', 'not a file')
      continue
    }
    const path = normalizeClaudeHomePath(entry.path)
    const kind = path === null ? null : classifyClaudeHomePath(path)
    if (path === null || kind === null) {
      skip(state, entry.path, 'not on the import allowlist')
      continue
    }
    if (typeof entry.text !== 'string') {
      skip(state, path, 'not a text file')
      continue
    }
    candidates.push({ path, kind, text: entry.text, linked: entry.linked === true })
  }
  candidates.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const collected: CollectedFile[] = []
  const seen = new Set<string>()
  const perKind: Record<DefinitionKind, number> = { agent: 0, command: 0, skill: 0, style: 0 }
  let total = 0
  for (const candidate of candidates) {
    if (seen.has(candidate.path)) {
      skip(state, candidate.path, 'listed twice')
      continue
    }
    seen.add(candidate.path)
    if (candidate.text.includes('\u0000')) {
      skip(state, candidate.path, 'binary')
      continue
    }
    const cap = BYTE_CAPS[candidate.kind]
    const bytes = utf8LengthUpTo(candidate.text, cap)
    if (bytes > cap) {
      skip(state, candidate.path, `larger than ${formatBytes(cap)}`)
      continue
    }
    if (total + bytes > CLAUDE_HOME_LIMITS.totalBytes) {
      skip(state, candidate.path, `over the ${formatBytes(CLAUDE_HOME_LIMITS.totalBytes)} import limit`)
      continue
    }
    if (isDefinitionKind(candidate.kind)) {
      if (perKind[candidate.kind] >= CLAUDE_HOME_LIMITS.definitionsPerKindMax) {
        skip(state, candidate.path, `more than ${CLAUDE_HOME_LIMITS.definitionsPerKindMax} ${KIND_PLURALS[candidate.kind]}`)
        continue
      }
      perKind[candidate.kind]++
    }
    total += bytes
    collected.push(candidate)
  }
  return collected
}

// ---------------------------------------------------------------------------------------------------------------------
// Definitions

/** `setDefinitionName` that never throws (null when the name could not be written). */
function withDefinitionName(text: string, name: string): string | null {
  try {
    const result: unknown = setDefinitionName(text, name)
    return typeof result === 'string' ? result : null
  }
  catch {
    return null
  }
}

function namePattern(kind: DefinitionKind): RegExp {
  return kind === 'command' ? COMMAND_NAME_PATTERN : AGENT_NAME_PATTERN
}

function nameMax(kind: DefinitionKind): number {
  return kind === 'command' ? 32 : 64
}

/** `text` as a name: lowercase, every run of other characters → `-`, cut to the kind's length; null when unusable. */
function slugName(kind: DefinitionKind, text: string): string | null {
  const slug = text.toLowerCase().replace(/[^\da-z-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
  const cutSlug = slug.slice(0, nameMax(kind)).replace(/-+$/, '')
  return namePattern(kind).test(cutSlug) ? cutSlug : null
}

function isTakenName(state: PlanState, kind: DefinitionKind, name: string): boolean {
  return state.baseline.definitionNames[kind].has(name)
    || state.baseline.reserved[kind].has(name)
    || state.planNames[kind].has(name)
    || state.renameNames[kind].has(name)
}

/** `<name>-2`, `-3`, … not taken by the baseline, the reserved names or this plan; undefined when none fits. */
function freeName(state: PlanState, kind: DefinitionKind, name: string): string | undefined {
  const max = nameMax(kind)
  for (let counter = 2; counter < 1000; counter++) {
    const suffix = `-${counter}`
    const head = name.slice(0, max - suffix.length).replace(/-+$/, '')
    const candidate = `${head === '' ? kind : head}${suffix}`
    if (!namePattern(kind).test(candidate) || isTakenName(state, kind, candidate) || (kind === 'style' && state.baseline.styles.has(candidate)))
      continue
    state.renameNames[kind].add(candidate)
    return candidate
  }
  return undefined
}

function fromDefinitionDiagnostics(list: readonly DefinitionDiagnostic[]): ClaudeImportDiagnostic[] {
  return list.map(entry => ({ level: entry.level, code: entry.code, message: entry.message }))
}

function baseName(path: string): string {
  return path.split('/').at(-1) ?? path
}

function stemOf(path: string): string {
  const base = baseName(path)
  return base.toLowerCase().endsWith('.md') ? base.slice(0, -3) : base
}

/** The name a file gets when its frontmatter has none (before parsing), and whether the path changed it. */
function pathName(file: CollectedFile): { hint: string, nested: boolean, changed: boolean, options: ParseDefinitionOptions } {
  const kind = file.kind as DefinitionKind
  const segments = file.path.split('/')
  switch (kind) {
    case 'skill': {
      const folder = segments[1] ?? ''
      const hint = slugName(kind, folder) ?? folder
      return { hint, nested: false, changed: hint !== folder.toLowerCase(), options: { folderName: hint } }
    }
    case 'style':
      return { hint: stemOf(file.path), nested: false, changed: false, options: { fileName: baseName(file.path) } }
    case 'command': {
      const parts = [...segments.slice(1, -1), stemOf(file.path)]
      const joined = parts.join('-')
      const hint = slugName(kind, joined) ?? joined
      return { hint, nested: parts.length > 1, changed: hint !== joined.toLowerCase(), options: { fileName: `${hint}.md` } }
    }
    default: {
      const stem = stemOf(file.path)
      const hint = slugName(kind, stem) ?? stem
      return { hint, nested: false, changed: hint !== stem.toLowerCase(), options: { fileName: `${hint}.md` } }
    }
  }
}

/** The display name of a parsed definition (the label for styles). */
function displayName(definition: ParsedDefinition): string {
  return definition.kind === 'style' ? definition.fields.label : definition.fields.name
}

/** The reserved name a `reserved-name` error is about: the frontmatter line it points at, else the path name. */
function reservedName(file: CollectedFile, result: ParseDefinitionResult, hint: string): string {
  const entry = result.diagnostics.find(diagnostic => diagnostic.code === 'reserved-name')
  if (entry?.line !== undefined) {
    const line = file.text.replace(/^\uFEFF/, '').split(/\r\n?|\n/)[entry.line - 1] ?? ''
    const value = line.slice(line.indexOf(':') + 1).trim().replace(/^(["'])(.*)\1$/, '$2').trim().toLowerCase()
    if (value !== '')
      return file.kind === 'style' ? styleNameFromLabel(value) ?? value : value
  }
  return file.kind === 'style' ? styleNameFromLabel(hint) ?? hint.toLowerCase() : hint.toLowerCase()
}

function descriptionOf(definition: ParsedDefinition): string {
  return definition.fields.description
}

function definitionSummary(definition: ParsedDefinition, executable: boolean): string {
  const description = descriptionOf(definition)
  const tail = description === '' ? '' : `: ${description}`
  switch (definition.kind) {
    case 'agent':
      return `Agent ${definition.fields.name}${tail}`
    case 'command':
      return `Command /${definition.fields.name}${tail}${executable ? ' (runs shell commands when used)' : ''}`
    case 'skill':
      return `Skill ${definition.fields.name}${tail}`
    case 'style':
      return `Output style ${definition.fields.label}${tail}`
  }
}

function processDefinition(state: PlanState, file: CollectedFile): void {
  const kind = file.kind as DefinitionKind
  const named = pathName(file)
  const linked = file.linked
  const extra: ClaudeImportDiagnostic[] = []
  const probe = parseDefinition(kind as CustomizationKind, file.text)
  let result: ParseDefinitionResult = probe
  let content = file.text
  if (probe.definition === null && !probe.diagnostics.some(entry => entry.code === 'reserved-name')) {
    const withPath = parseDefinition(kind as CustomizationKind, file.text, named.options)
    result = withPath
    if (withPath.definition !== null) {
      const written = withDefinitionName(file.text, displayName(withPath.definition))
      const check = written === null ? null : parseDefinition(kind as CustomizationKind, written)
      if (written === null || check === null || check.definition === null || check.definition.fields.name !== withPath.definition.fields.name) {
        addItem(state, {
          kind,
          name: withPath.definition.fields.name,
          file: file.path,
          status: 'invalid',
          summary: `The name could not be written into ${file.path}.`,
          diagnostics: [{ level: 'error', code: 'name-not-written', message: 'The file has no name in its frontmatter and the name from its path could not be added.' }],
          linked,
        })
        return
      }
      content = written
      result = check
      if (named.nested || named.changed)
        extra.push({ level: 'info', code: 'name-from-path', message: `The name ${withPath.definition.fields.name} comes from the path ${file.path}.` })
    }
  }
  const definition = result.definition
  if (definition === null) {
    if (result.diagnostics.some(entry => entry.code === 'reserved-name')) {
      processReserved(state, file, result, named.hint)
      return
    }
    addItem(state, {
      kind,
      name: named.hint,
      file: file.path,
      status: 'invalid',
      summary: `${file.path} cannot be imported: ${result.diagnostics.find(entry => entry.level === 'error')?.message ?? 'the file is not a valid definition.'}`,
      diagnostics: [...extra, ...fromDefinitionDiagnostics(result.diagnostics)],
      linked,
    })
    return
  }
  const name = definition.fields.name
  const executable = definition.kind === 'command' && planCommandExpansion(definition.fields.body).shellCommands.length > 0
  const warnings: ClaudeImportWarning[] = []
  if (executable)
    warnings.push('runs-commands')
  if (result.diagnostics.some(entry => entry.code === 'model-alias') || Object.hasOwn(definition.fields, 'modelAlias'))
    warnings.push('model-alias')
  const diagnostics = [...extra, ...fromDefinitionDiagnostics(result.diagnostics)]
  const payload: ClaudeImportPayload = { kind: 'definition', definitionKind: kind, content }
  const summary = definitionSummary(definition, executable)
  const base = { kind, name, file: file.path, summary, warnings, executable, payload, linked } as const
  const key = definitionKey(kind, name)
  if (state.baseline.reserved[kind].has(name)) {
    const renameTo = freeName(state, kind, name)
    addItem(state, {
      ...base,
      status: 'conflict',
      ...(renameTo === undefined ? { actions: ['skip'] as const } : { renameTo }),
      diagnostics: [...diagnostics, { level: 'warning', code: 'reserved-name', message: `${name} is a built-in or reserved name; import it under another name.` }],
    })
    return
  }
  if (state.planNames[kind].has(name)) {
    const renameTo = freeName(state, kind, name)
    addItem(state, {
      ...base,
      status: 'conflict',
      ...(renameTo === undefined ? { actions: ['skip'] as const } : { renameTo }),
      diagnostics: [...diagnostics, { level: 'warning', code: 'duplicate-name', message: `Another file of this import already uses the name ${name}.` }],
    })
    return
  }
  state.planNames[kind].add(name)
  const existing = state.baseline.definitions.get(key)
  if (existing === undefined) {
    addItem(state, { ...base, status: 'new', diagnostics })
    return
  }
  if (existing === content) {
    addItem(state, { ...base, status: 'unchanged', diagnostics })
    return
  }
  const renameTo = freeName(state, kind, name)
  addItem(state, {
    ...base,
    status: 'update',
    ...(renameTo === undefined ? { actions: ['skip', 'overwrite'] as const } : { renameTo }),
    diagnostics: [...diagnostics, { level: 'info', code: 'changed', message: `A personal ${kind} named ${name} exists with other content.` }],
  })
}

/** A definition whose name is builtin (`reserved-name` from the parser): `conflict`, importable only renamed. */
function processReserved(state: PlanState, file: CollectedFile, result: ParseDefinitionResult, hint: string): void {
  const kind = file.kind as DefinitionKind
  const name = reservedName(file, result, hint)
  const diagnostics = fromDefinitionDiagnostics(result.diagnostics)
  const renameTo = freeName(state, kind, slugName(kind, name) ?? kind)
  const renamed = renameTo === undefined ? null : withDefinitionName(file.text, renameTo)
  const check = renamed === null ? null : parseDefinition(kind as CustomizationKind, renamed)
  if (renameTo === undefined || check === null || check.definition === null) {
    addItem(state, {
      kind,
      name,
      file: file.path,
      status: 'invalid',
      summary: `${file.path} cannot be imported: ${name} is a built-in name and the file does not parse under another name.`,
      diagnostics: [...diagnostics, ...fromDefinitionDiagnostics(check?.diagnostics ?? [])],
      linked: file.linked,
    })
    return
  }
  const executable = check.definition.kind === 'command' && planCommandExpansion(check.definition.fields.body).shellCommands.length > 0
  addItem(state, {
    kind,
    name,
    file: file.path,
    status: 'conflict',
    renameTo,
    summary: `${definitionSummary(check.definition, executable).replace(renameTo, name)} (a built-in name; rename to import)`,
    warnings: executable ? ['runs-commands'] : [],
    diagnostics,
    executable,
    payload: { kind: 'definition', definitionKind: kind, content: file.text },
    linked: file.linked,
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// settings.json

function hookName(event: string, matcher: string | null): string {
  return matcher === null ? event : `${event} (${matcher})`
}

/** A `NAME=value` word (its value is never shown). */
const ASSIGNMENT_WORD = /^[A-Z_]\w*=/i
/** Leading `NAME=value` assignments of a command line (values may be quoted). */
const LEADING_ASSIGNMENTS = /^(?:[A-Z_]\w*=(?:"[^"]*"|'[^']*'|[^\s"']*)\s+)+/i

/** The program of a command line (after any `NAME=value` assignments, quotes removed), cut; never its arguments. */
function programOf(command: string): string {
  const rest = command.trim().replace(LEADING_ASSIGNMENTS, '')
  const quoted = rest.match(/^(["'])([^"']*)\1/)
  const word = quoted === null ? rest.split(/\s+/)[0] ?? '' : quoted[2] ?? ''
  if (word === '' || ASSIGNMENT_WORD.test(word))
    return 'a command'
  return oneLine(word, 80)
}

/** The matcher of a hook group as written (trimmed), or null. */
function rawMatcher(hooks: unknown, event: string, groupIndex: number): string | null {
  const groups = isRecord(hooks) ? hooks[event] : undefined
  const group: unknown = Array.isArray(groups) ? groups[groupIndex] : undefined
  const matcher = isRecord(group) ? group.matcher : undefined
  return typeof matcher === 'string' && matcher.trim() !== '' ? oneLine(matcher, 200) : null
}

function rawHandler(hooks: unknown, event: string, position: readonly [number, number]): Record<string, unknown> {
  if (!isRecord(hooks))
    return {}
  const groups = hooks[event]
  const group: unknown = Array.isArray(groups) ? groups[position[0]] : undefined
  const handlers: unknown = isRecord(group) ? group.hooks : undefined
  const handler: unknown = Array.isArray(handlers) ? handlers[position[1]] : undefined
  return isRecord(handler) ? copyMap(handler) : {}
}

function positionKey(event: string, position: readonly [number, number] | undefined): string {
  return position === undefined ? `${event}` : `${event}\u0000${position[0]}\u0000${position[1]}`
}

function fromHookDiagnostics(list: readonly HookDiagnostic[]): ClaudeImportDiagnostic[] {
  return list.map(entry => ({ level: entry.level, code: entry.code, message: entry.message }))
}

function processHooks(state: PlanState, value: unknown, file: CollectedFile): void {
  const result = readHooksConfig(value, { source: 'personal', file: file.path, prompts: true })
  const byPosition = new Map<string, HookDiagnostic[]>()
  const loose: HookDiagnostic[] = []
  for (const entry of result.diagnostics) {
    if (entry.event !== undefined && entry.position !== undefined) {
      const key = positionKey(entry.event, entry.position)
      byPosition.set(key, [...(byPosition.get(key) ?? []), entry])
    }
    else if (entry.code !== 'unknown-event') {
      loose.push(entry)
    }
  }
  const handled = new Set<string>()
  const addHook = (event: string, matcher: string | null, position: readonly [number, number], prompt: boolean): void => {
    const key = positionKey(event, position)
    handled.add(key)
    const handler = rawHandler(value, event, position)
    const identity = claudeImportHookIdentity(event, matcher, handler)
    const diagnostics = fromHookDiagnostics(byPosition.get(key) ?? [])
    const duplicate = state.hookIdentities.has(identity)
    const status: ClaudeImportStatus = state.baseline.hooks.has(identity) || duplicate ? 'unchanged' : 'new'
    if (duplicate)
      diagnostics.push({ level: 'info', code: 'duplicate', message: 'The same hook is listed earlier in this file.' })
    state.hookIdentities.add(identity)
    const target = matcher === null ? '' : ` for ${matcher}`
    const command = typeof handler.command === 'string' ? handler.command : ''
    addItem(state, {
      kind: 'hook',
      name: hookName(event, matcher),
      keyName: `${event}[${position[0]}][${position[1]}]`,
      file: file.path,
      status,
      summary: prompt ? `Asks a model on ${event}${target}.` : `Runs a command on ${event}${target}: ${programOf(command)}`,
      warnings: prompt ? [] : ['runs-commands'],
      diagnostics,
      executable: !prompt,
      payload: { kind: 'hook', event, matcher, handler },
      linked: file.linked,
    })
  }
  for (const spec of result.items)
    addHook(spec.event, spec.matcher, spec.position, false)
  for (const spec of result.prompts)
    addHook(spec.event, spec.matcher, spec.position, true)
  for (const [key, list] of byPosition) {
    if (handled.has(key))
      continue
    const first = list.find(entry => entry.level !== 'info') ?? list[0]
    if (first === undefined || first.event === undefined || first.position === undefined)
      continue
    if (list.every(entry => entry.level === 'info')) {
      loose.push(...list)
      continue
    }
    const unsupported = list.some(entry => entry.code === 'unsupported-type')
    const handler = rawHandler(value, first.event, first.position)
    const type = typeof handler.type === 'string' ? oneLine(handler.type, 32) : ''
    addItem(state, {
      kind: 'hook',
      name: hookName(first.event, rawMatcher(value, first.event, first.position[0])),
      keyName: `${first.event}[${first.position[0]}][${first.position[1]}]`,
      file: file.path,
      status: unsupported ? 'unsupported' : 'invalid',
      summary: unsupported && type !== '' ? `A ${type} hook on ${first.event} is not supported.` : first.message,
      diagnostics: fromHookDiagnostics(list),
      linked: file.linked,
    })
  }
  if (isRecord(value)) {
    const known: ReadonlySet<string> = new Set(HOOK_EVENTS)
    for (const event of Object.keys(value)) {
      if (known.has(event))
        continue
      addItem(state, {
        kind: 'hook',
        name: oneLine(event, 64),
        keyName: `${event}`,
        file: file.path,
        status: 'unsupported',
        summary: `The event ${oneLine(event, 64)} is not supported; its hooks are not imported.`,
        diagnostics: [{ level: 'info', code: 'unknown-event', message: 'The event is not supported by harness-forge.' }],
        linked: file.linked,
      })
    }
  }
  for (const entry of loose)
    planDiagnostic(state, entry.level, entry.code, `${file.path}: ${entry.message}`)
}

function processAllowRule(state: PlanState, raw: string, file: CollectedFile): void {
  const rule = parseClaudePermissionRule(raw)
  if (rule === null) {
    addItem(state, { kind: 'permission', name: raw, keyName: `allow:${raw}`, file: file.path, status: 'invalid', summary: 'The allow rule could not be read.', linked: file.linked })
    return
  }
  if (rule.tool !== 'Bash') {
    addItem(state, {
      kind: 'permission',
      name: rule.raw,
      keyName: `allow:${rule.raw}`,
      file: file.path,
      status: 'unsupported',
      summary: `Allow rule ${rule.raw} is not imported: only Bash allow rules become shell rules.`,
      linked: file.linked,
    })
    return
  }
  const mapped = shellRuleFromPermission(rule)
  if (!mapped.ok) {
    addItem(state, {
      kind: 'permission',
      name: rule.raw,
      keyName: `allow:${rule.raw}`,
      file: file.path,
      status: 'unsupported',
      summary: `Allow rule ${rule.raw} is not imported: ${SHELL_RULE_FROM_PERMISSION_MESSAGES[mapped.reason]}`,
      diagnostics: [{ level: 'info', code: mapped.reason, message: SHELL_RULE_FROM_PERMISSION_MESSAGES[mapped.reason] }],
      linked: file.linked,
    })
    return
  }
  const duplicate = state.shellPrefixes.has(mapped.prefix)
  const status: ClaudeImportStatus = state.baseline.shellRules.has(mapped.prefix) || duplicate ? 'unchanged' : 'new'
  state.shellPrefixes.add(mapped.prefix)
  addItem(state, {
    kind: 'shell-rule',
    name: mapped.prefix,
    keyName: `allow:${rule.raw}`,
    file: file.path,
    status,
    summary: `Run commands that start with ${mapped.prefix} without asking (from ${rule.raw}).`,
    warnings: mapped.warning === undefined ? [] : [mapped.warning],
    diagnostics: duplicate ? [{ level: 'info', code: 'duplicate', message: 'Another rule of this file maps to the same shell rule.' }] : [],
    payload: { kind: 'shell-rule', prefix: mapped.prefix },
    linked: file.linked,
  })
}

function processDenyRule(state: PlanState, raw: string, file: CollectedFile): void {
  const rule = parseClaudePermissionRule(raw)
  if (rule === null) {
    addItem(state, { kind: 'permission', name: raw, keyName: `deny:${raw}`, file: file.path, status: 'invalid', summary: 'The deny rule could not be read.', linked: file.linked })
    return
  }
  const tools = toolNamesFromPermission(rule)
  if (rule.specifier !== null || tools.length === 0) {
    const reason = rule.specifier !== null
      ? 'only whole-tool deny rules are imported.'
      : 'the tool has no harness-forge equivalent.'
    addItem(state, {
      kind: 'permission',
      name: rule.raw,
      keyName: `deny:${rule.raw}`,
      file: file.path,
      status: 'unsupported',
      summary: `Deny rule ${rule.raw} is not imported: ${reason}`,
      linked: file.linked,
    })
    return
  }
  const known = tools.every(tool => state.baseline.toolDenies.has(tool) || state.toolDenies.has(tool))
  tools.forEach(tool => state.toolDenies.add(tool))
  addItem(state, {
    kind: 'tool-deny',
    name: rule.tool,
    keyName: `deny:${rule.raw}`,
    file: file.path,
    status: known ? 'unchanged' : 'new',
    summary: `Never run the ${tools.join(', ')} tool${tools.length === 1 ? '' : 's'} (from ${rule.raw}).`,
    payload: { kind: 'tool-deny', tools: [...tools] },
    linked: file.linked,
  })
}

function processPermissions(state: PlanState, value: unknown, file: CollectedFile): void {
  if (!isRecord(value)) {
    planDiagnostic(state, 'warning', 'not-an-object', `${file.path}: "permissions" must be an object; it is ignored.`)
    return
  }
  for (const list of ['allow', 'ask', 'deny'] as const) {
    const rules = value[list]
    if (rules === undefined || rules === null)
      continue
    if (!Array.isArray(rules)) {
      planDiagnostic(state, 'warning', 'not-an-object', `${file.path}: "permissions.${list}" must be a list of rules; it is ignored.`)
      continue
    }
    const seen = new Set<string>()
    let invalid = 0
    if (rules.length > RULES_PER_LIST_MAX)
      planDiagnostic(state, 'warning', 'too-many', `${file.path}: only the first ${RULES_PER_LIST_MAX} ${list} rules are read.`)
    for (const raw of rules.slice(0, RULES_PER_LIST_MAX)) {
      if (typeof raw !== 'string' || raw.trim() === '') {
        invalid++
        continue
      }
      const text = raw.trim()
      if (seen.has(text))
        continue
      seen.add(text)
      if (list === 'allow') {
        processAllowRule(state, text, file)
      }
      else if (list === 'deny') {
        processDenyRule(state, text, file)
      }
      else {
        addItem(state, {
          kind: 'permission',
          name: oneLine(text, 200),
          keyName: `ask:${text}`,
          file: file.path,
          status: 'unsupported',
          summary: `Ask rule ${oneLine(text, 200)} is not imported: harness-forge already asks for tools that need approval.`,
          linked: file.linked,
        })
      }
    }
    if (invalid > 0)
      planDiagnostic(state, 'warning', 'invalid-rule', `${file.path}: ${invalid} ${list} rules are not text; they are ignored.`)
  }
  for (const key of Object.keys(value)) {
    if (key === 'allow' || key === 'ask' || key === 'deny')
      continue
    addItem(state, {
      kind: 'permission',
      name: `permissions.${oneLine(key, 64)}`,
      file: file.path,
      status: 'unsupported',
      summary: `The permission setting ${oneLine(key, 64)} is not imported.`,
      linked: file.linked,
    })
  }
}

function processEnv(state: PlanState, value: unknown, file: CollectedFile): void {
  if (!isRecord(value)) {
    planDiagnostic(state, 'warning', 'not-an-object', `${file.path}: "env" must be an object; it is ignored.`)
    return
  }
  const names: string[] = []
  let invalid = 0
  for (const name of Object.keys(value)) {
    const raw = value[name]
    const text = typeof raw === 'string' ? raw : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : null
    if (!ENV_NAME_PATTERN.test(name) || text === null || text.length > ENV_VALUE_MAX_CHARS || text.includes('\u0000') || names.length >= ENV_MAX) {
      invalid++
      continue
    }
    Object.defineProperty(state.env, name, { value: text, enumerable: true, writable: true, configurable: true })
    names.push(name)
  }
  if (invalid > 0)
    planDiagnostic(state, 'warning', 'invalid-env', `${file.path}: ${invalid} environment entries are not usable; they are ignored.`)
  if (names.length === 0)
    return
  const shown = names.slice(0, 10).join(', ')
  const more = names.length > 10 ? ` and ${names.length - 10} more` : ''
  addItem(state, {
    kind: 'env',
    name: 'env',
    file: file.path,
    status: 'unsupported',
    summary: `Environment variables ${shown}${more} are not imported; their values only fill the variable references of imported MCP servers.`,
    linked: file.linked,
  })
}

function processOutputStyle(state: PlanState, value: unknown, file: CollectedFile): void {
  const label = typeof value === 'string' ? value.trim() : ''
  const name = label === '' ? null : styleNameFromLabel(label)
  if (name === null) {
    addItem(state, {
      kind: 'setting',
      name: 'outputStyle',
      file: file.path,
      status: 'invalid',
      summary: 'The outputStyle setting does not name a usable output style.',
      linked: file.linked,
    })
    return
  }
  const exists = state.baseline.styles.has(name)
  const imported = state.planNames.style.has(name)
  if (!exists && !imported) {
    addItem(state, {
      kind: 'setting',
      name: 'outputStyle',
      file: file.path,
      status: 'invalid',
      summary: `The output style ${name} does not exist; import or create it first.`,
      diagnostics: [{ level: 'error', code: 'missing-style', message: `No output style is named ${name}.` }],
      linked: file.linked,
    })
    return
  }
  addItem(state, {
    kind: 'setting',
    name: 'outputStyle',
    file: file.path,
    status: state.baseline.outputStyle === name ? 'unchanged' : 'new',
    summary: `Use the output style ${name} by default.`,
    diagnostics: exists ? [] : [{ level: 'info', code: 'style-in-plan', message: `The style ${name} comes from this import; import it too.` }],
    payload: { kind: 'setting', key: 'outputStyle', value: name },
    linked: file.linked,
  })
}

const SAFE_MODEL = /^[\w.:/[\]-]{1,100}$/
const SAFE_REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/

function processSettings(state: PlanState, file: CollectedFile): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(file.text.startsWith('\uFEFF') ? file.text.slice(1) : file.text)
  }
  catch {
    planDiagnostic(state, 'error', 'invalid-json', `${file.path} is not valid JSON; nothing is imported from it.`)
    return
  }
  if (!isRecord(parsed)) {
    planDiagnostic(state, 'error', 'not-an-object', `${file.path} must hold a JSON object; nothing is imported from it.`)
    return
  }
  const settings = parsed
  if (Object.hasOwn(settings, 'hooks'))
    processHooks(state, settings.hooks, file)
  if (Object.hasOwn(settings, 'permissions'))
    processPermissions(state, settings.permissions, file)
  if (Object.hasOwn(settings, 'env'))
    processEnv(state, settings.env, file)
  if (Object.hasOwn(settings, 'outputStyle'))
    processOutputStyle(state, settings.outputStyle, file)
  if (Object.hasOwn(settings, 'model')) {
    const model = typeof settings.model === 'string' ? settings.model.trim() : ''
    addItem(state, {
      kind: 'setting',
      name: 'model',
      file: file.path,
      status: 'unsupported',
      summary: `The default model${SAFE_MODEL.test(model) ? ` ${model}` : ''} is not imported; pick a model in Settings (Claude aliases resolve through the model aliases setting).`,
      linked: file.linked,
    })
  }
  for (const key of COMMAND_SETTINGS) {
    if (!Object.hasOwn(settings, key))
      continue
    addItem(state, {
      kind: 'setting',
      name: key,
      file: file.path,
      status: 'unsupported',
      summary: `${key} runs a command; harness-forge never runs it.`,
      linked: file.linked,
    })
  }
  if (isRecord(settings.enabledPlugins)) {
    for (const id of Object.keys(settings.enabledPlugins).slice(0, PLUGIN_ITEMS_MAX)) {
      addItem(state, {
        kind: 'plugin',
        name: oneLine(id, 200),
        file: file.path,
        status: 'unsupported',
        summary: `Plugin ${oneLine(id, 200)} is not installed by the import. Install plugins from Plugins → Marketplaces.`,
        linked: file.linked,
      })
    }
  }
  if (isRecord(settings.extraKnownMarketplaces)) {
    for (const name of Object.keys(settings.extraKnownMarketplaces).slice(0, PLUGIN_ITEMS_MAX)) {
      const entry = settings.extraKnownMarketplaces[name]
      const source = isRecord(entry) && isRecord(entry.source) ? entry.source : {}
      const repo = source.source === 'github' && typeof source.repo === 'string' && SAFE_REPO.test(source.repo) ? ` (GitHub ${source.repo})` : ''
      addItem(state, {
        kind: 'marketplace',
        name: oneLine(name, 200),
        file: file.path,
        status: 'unsupported',
        summary: `Marketplace ${oneLine(name, 200)}${repo} is not added by the import. Install plugins from Plugins → Marketplaces.`,
        linked: file.linked,
      })
    }
  }
  const ignored = Object.keys(settings).filter(key => !READ_SETTINGS.has(key))
  if (ignored.length > 0) {
    const shown = ignored.slice(0, 20).map(key => oneLine(key, 64)).join(', ')
    const more = ignored.length > 20 ? ` and ${ignored.length - 20} more` : ''
    planDiagnostic(state, 'info', 'ignored-settings', `${file.path}: these settings are not imported: ${shown}${more}.`)
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// CLAUDE.md

/** An `@path` import of `CLAUDE.md` (a mention at a line start or after a blank, holding `.` or `/`). */
const IMPORT_REFERENCE = /(?:^|[\s(])@([\w~./-]+)/gm

function hasImports(text: string): boolean {
  for (const match of text.matchAll(IMPORT_REFERENCE)) {
    if (/[./]/.test(match[1] ?? ''))
      return true
  }
  return false
}

function processInstructions(state: PlanState, file: CollectedFile): void {
  const text = file.text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
  const max = CLAUDE_IMPORT_INSTRUCTIONS_MAX_CHARS
  const base = { kind: 'instructions' as const, name: 'CLAUDE.md', file: file.path, linked: file.linked }
  if (text === '') {
    addItem(state, { ...base, status: 'unchanged', summary: 'CLAUDE.md is empty; there is nothing to import.' })
    return
  }
  const lines = text.split('\n').length
  const size = `${lines} line${lines === 1 ? '' : 's'}, ${text.length} characters`
  if (text.length > max) {
    addItem(state, {
      ...base,
      status: 'invalid',
      summary: `CLAUDE.md (${size}) is longer than the ${max} characters the global instructions hold.`,
      diagnostics: [{ level: 'error', code: 'too-long', message: `CLAUDE.md has more than ${max} characters.` }],
    })
    return
  }
  const warnings: ClaudeImportWarning[] = hasImports(text) ? ['imports-kept'] : []
  const current = state.baseline.instructions
  if (current.includes(text)) {
    addItem(state, { ...base, status: 'unchanged', summary: `CLAUDE.md (${size}) is already part of the global instructions.`, warnings })
    return
  }
  const empty = current.trim() === ''
  const appendFits = empty || current.trimEnd().length + 2 + text.length <= max
  addItem(state, {
    ...base,
    status: empty ? 'new' : 'update',
    actions: appendFits ? ['append', 'replace', 'skip'] : ['replace', 'skip'],
    defaultAction: appendFits ? 'append' : 'skip',
    summary: `CLAUDE.md (${size}) becomes part of the global instructions.`,
    warnings,
    diagnostics: appendFits ? [] : [{ level: 'warning', code: 'append-too-long', message: `Appending would pass the ${max} character limit; replace the instructions or skip.` }],
    payload: { kind: 'instructions', text },
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// .claude.json

function fromMcpDiagnostics(list: readonly McpConfigDiagnostic[]): ClaudeImportDiagnostic[] {
  return list.map(entry => ({ level: entry.level, code: entry.code, message: entry.message }))
}

function hostOf(url: string): string | null {
  if (url.includes('${'))
    return null
  try {
    return URL.canParse(url) ? new URL(url).host : null
  }
  catch {
    return null
  }
}

function serverSummary(transport: McpJsonStdioServer | McpJsonRemoteServer, project: string | undefined): string {
  const where = project === undefined ? '' : ` (from the project ${oneLine(baseName(project.replace(/\/+$/, '')) || project, 80)}; imported turned off)`
  if (transport.type === 'stdio')
    return `Starts ${programOf(transport.command)} on this server (stdio)${where}.`
  const host = hostOf(transport.url)
  return `Connects to ${host === null ? 'a URL with variables' : host} (${transport.type})${where}.`
}

function processMcpServer(state: PlanState, name: string, raw: unknown, file: CollectedFile, project: string | undefined): void {
  let text: string
  try {
    text = JSON.stringify({ mcpServers: { [name]: raw } })
  }
  catch {
    text = ''
  }
  const result = parseMcpJson(text)
  const diagnostics = fromMcpDiagnostics(result.diagnostics.filter(entry => entry.code !== 'id-collision'))
  const server = result.servers[0]
  const base = { kind: 'mcp-server' as const, name, file: file.path, ...(project === undefined ? {} : { project }), linked: file.linked }
  const projectWarnings: ClaudeImportWarning[] = project === undefined ? [] : ['project-server']
  if (server === undefined || !isRecord(raw)) {
    const unsupported = result.diagnostics.some(entry => entry.code === 'unsupported-type')
    const first = result.diagnostics.find(entry => entry.level === 'error')
    addItem(state, {
      ...base,
      status: unsupported ? 'unsupported' : 'invalid',
      summary: `The MCP server ${oneLine(name, 64)} cannot be imported: ${first?.message ?? 'it is not a valid server.'}`,
      warnings: projectWarnings,
      diagnostics,
    })
    return
  }
  const transport = server.transport
  const fingerprint = claudeImportMcpFingerprint(transport)
  const preferred = mcpServerIdFromName(name, new Set())
  const variables = serverVariables(transport)
    .filter(ref => ref.defaultValue === null && !Object.hasOwn(state.env, ref.name))
    .map(ref => ref.name)
  const warnings: ClaudeImportWarning[] = [...(transport.type === 'stdio' ? ['runs-commands' as const] : []), ...projectWarnings]
  if (variables.length > 0)
    warnings.push('needs-variables')
  const common = {
    ...base,
    summary: serverSummary(transport, project),
    warnings,
    ...(variables.length === 0 ? {} : { variables }),
    executable: transport.type === 'stdio',
  }
  const payloadFor = (id: string): ClaudeImportPayload => ({ kind: 'mcp-server', name, id, raw: copyMap(raw), ...(project === undefined ? {} : { project }) })
  const planned = state.planMcp.get(preferred)
  if (planned !== undefined) {
    if (planned === fingerprint) {
      addItem(state, {
        ...common,
        status: 'unchanged',
        diagnostics: [...diagnostics, { level: 'info', code: 'duplicate', message: 'The same server is imported by an earlier item of this plan.' }],
        payload: payloadFor(preferred),
      })
      return
    }
    const id = mcpServerIdFromName(name, state.mcpIds)
    state.mcpIds.add(id)
    state.planMcp.set(id, fingerprint)
    addItem(state, {
      ...common,
      status: 'new',
      diagnostics: [...diagnostics, { level: 'info', code: 'id-collision', message: `Another server of this import uses the id ${preferred}; this one uses ${id}.` }],
      payload: payloadFor(id),
    })
    return
  }
  const existing = state.baseline.mcpServers.get(preferred)
  state.planMcp.set(preferred, fingerprint)
  state.mcpIds.add(preferred)
  if (existing === undefined) {
    addItem(state, { ...common, status: 'new', diagnostics, payload: payloadFor(preferred) })
    return
  }
  if (existing === fingerprint) {
    addItem(state, { ...common, status: 'unchanged', diagnostics, payload: payloadFor(preferred) })
    return
  }
  const renameTo = mcpServerIdFromName(name, state.mcpIds)
  state.mcpIds.add(renameTo)
  addItem(state, {
    ...common,
    status: 'conflict',
    actions: ['skip', 'overwrite', 'rename'],
    renameTo,
    diagnostics: [...diagnostics, { level: 'info', code: 'changed', message: `A server with the id ${preferred} exists with another command or URL.` }],
    payload: payloadFor(preferred),
  })
}

function processClaudeJson(state: PlanState, file: CollectedFile): void {
  const extracted = extractClaudeJsonMcpServers(file.text)
  for (const entry of extracted.diagnostics)
    planDiagnostic(state, entry.level, entry.code, entry.message)
  for (const name of Object.keys(extracted.servers))
    processMcpServer(state, name, extracted.servers[name], file, undefined)
  for (const project of extracted.projects) {
    for (const name of Object.keys(project.servers))
      processMcpServer(state, name, project.servers[name], file, project.path)
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Planner

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function planUnchecked(files: readonly ClaudeHomeFile[], baseline: ClaudeImportBaseline): ClaudeImportPlanDraft {
  const state = newState(normalizeBaseline(baseline))
  const collected = collect(state, files)
  for (const kind of DEFINITION_KINDS) {
    for (const file of collected) {
      if (file.kind === kind)
        processDefinition(state, file)
    }
  }
  for (const file of collected) {
    if (file.kind === 'settings')
      processSettings(state, file)
  }
  for (const file of collected) {
    if (file.kind === 'instructions')
      processInstructions(state, file)
  }
  for (const file of collected) {
    if (file.kind === 'claude-json')
      processClaudeJson(state, file)
  }
  if (state.itemsDropped > 0)
    planDiagnostic(state, 'warning', 'too-many', `The import has more than ${CLAUDE_HOME_LIMITS.itemsMax} items; ${state.itemsDropped} were left out.`)
  const skipped = [...state.skipped].sort((a, b) => compareText(a.path, b.path) || compareText(a.reason, b.reason))
  if (skipped.length > CLAUDE_HOME_LIMITS.skippedMax) {
    planDiagnostic(state, 'info', 'too-many', `${skipped.length - CLAUDE_HOME_LIMITS.skippedMax} more files were skipped.`)
    skipped.length = CLAUDE_HOME_LIMITS.skippedMax
  }
  const diagnostics = state.diagnosticsDropped === 0
    ? state.diagnostics
    : [...state.diagnostics, { level: 'info' as const, code: 'too-many', message: `${state.diagnosticsDropped} more problems were found.` }]
  const kindIndex = (kind: ClaudeImportKind): number => CLAUDE_IMPORT_KINDS.indexOf(kind)
  const items = [...state.items].sort((a, b) => kindIndex(a.kind) - kindIndex(b.kind) || compareText(a.name, b.name) || compareText(a.key, b.key))
  return { items, skipped, diagnostics, env: { ...state.env } }
}

/**
 * Builds the plan; deterministic for the same input (items sorted by kind, then name). `options.digest` is accepted for
 * the server's convenience; the planner compares contents byte for byte and needs no digest.
 */
export function planClaudeImport(
  files: readonly ClaudeHomeFile[],
  baseline: ClaudeImportBaseline,
  options?: { readonly digest?: (text: string) => string },
): ClaudeImportPlanDraft {
  void options
  try {
    return planUnchecked(files, baseline)
  }
  catch {
    return { items: [], skipped: [], diagnostics: [{ level: 'error', code: 'failed', message: 'The import plan could not be built.' }], env: {} }
  }
}
