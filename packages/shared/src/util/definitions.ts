/**
 * Customization definition files (Phase 10, ADR-044 / ADR-045): agents, commands and skills are markdown files with YAML
 * frontmatter (`---` at byte 0, BOM allowed); Phase 11 (ADR-051, ADR-052) adds output styles (kind `style`) and the
 * skill keys `user-invocable`, `disable-model-invocation` and `argument-hint`. This module is the ONLY parser and
 * formatter (server and web): `yaml` core schema, no aliases, unique keys, byte caps applied before parsing; it never
 * throws — every problem is a diagnostic. Contract skeleton written by the coordinator in P10-0a (K1); implemented by
 * C29; Phase 11 additions by C35.
 *
 * Name rule (all kinds): the frontmatter `name`, else the file stem (agents, commands, styles) or the folder name
 * (skills), else an `error` diagnostic `missing-field`. Styles (Claude Code writes `name: My Style`) keep the name as
 * written as their `label` and use its slug as the name (`styleNameFromLabel`); the builtin style names `default`,
 * `explanatory` and `learning` are reserved.
 *
 * Parsing, in order: the UTF-8 byte cap, a NUL probe of the first 8 KiB, BOM strip and CRLF / CR → LF; frontmatter only
 * when the text starts with `---\n`, closed by the next line that is exactly `---` or `...` (≤ 8 KiB); `yaml` with the
 * core schema, unique keys and no aliases (`maxAliasCount: 0`); a document that is not a mapping or fails falls back
 * to a line reader (`key: value`, `- item` lists, `|` / `>` blocks; a `warning`). A top-level `argument-hint:` whose
 * raw value starts with `[` or `{` (Claude Code's `[pr-number] [priority]`) is taken as raw text, so it never makes
 * the YAML fail. Messages start with `Line N: ` when the line is known and never quote file contents (only key names
 * and reserved names).
 *
 * Phase 12 (ADR-058, C42): Claude Code's newer keys, present in the parsed fields only when the file sets them (so every
 * earlier definition parses to the same fields): agents `disallowedTools`, `maxTurns` (1–200), `color` (`AGENT_COLORS`),
 * `skills` (≤ 5 names); commands and skills `when_to_use`, `arguments` (≤ 9 names), `disallowed-tools`, `context: fork`
 * with `agent`; skills also `allowed-tools` and `model`. A Claude model name (`sonnet`, `opus`, `haiku`, `fable`,
 * `opusplan`, a `claude-…` id, `[1m]` dropped) leaves `model` null and is kept as `modelAlias` (resolved by the server
 * through the `modelAliases` setting). Keys Claude Code supports and the harness does not (`permissionMode`, `hooks`,
 * `mcpServers`, …; `CLAUDE_UNSUPPORTED_DEFINITION_KEYS`) are `ignored-key` infos. `setDefinitionName` inserts or replaces
 * the `name:` line of a file and keeps every other line byte for byte.
 */
import { isMap, parseDocument, stringify } from 'yaml'
import { AGENT_NAME_PATTERN, COMMAND_NAME_PATTERN, isClientCommand, isHarnessCommand, isReservedAgentName, safeParseModelRef } from '../ids.ts'
import { isBuiltinOutputStyle } from './output-styles.ts'
import { normalizeToolList } from './tool-names.ts'

export const CUSTOMIZATION_KINDS = ['agent', 'command', 'skill', 'style'] as const
export type CustomizationKind = (typeof CUSTOMIZATION_KINDS)[number]

/** Where a catalog entry comes from (ADR-044); precedence, lowest first: builtin < plugin < user < project. */
export const CUSTOMIZATION_SOURCES = ['builtin', 'plugin', 'user', 'project'] as const
export type CustomizationSource = (typeof CUSTOMIZATION_SOURCES)[number]

/** Project definition folders, lowest precedence first (`.harness` wins over `.claude`). */
export const DEFINITION_FOLDERS = ['.claude', '.harness'] as const
export type DefinitionFolder = (typeof DEFINITION_FOLDERS)[number]

/** Byte caps (mirrored by `LIMITS.customizationContentBytes` / `LIMITS.customizationFrontmatterBytes`). */
export const DEFINITION_LIMITS = {
  /** Whole file / stored content. */
  contentBytes: 65_536,
  /** The frontmatter block between the `---` lines. */
  frontmatterBytes: 8192,
  /** `description` is cut to this many characters (warning). */
  descriptionMaxChars: 1024,
  /** A style's `label` (the name as written; Phase 11). */
  labelMaxChars: 128,
  /** `argument-hint`. */
  argumentHintMaxChars: 100,
  /** Entries of a `tools` / `allowed-tools` list. */
  toolsMax: 64,
  /** `when_to_use` (Phase 12) is cut to this many characters (warning). */
  whenToUseMaxChars: 1024,
  /** Names of an `arguments` list (Phase 12; `$name` placeholders). */
  argumentsMax: 9,
  /** Skill names of an agent's `skills` list (Phase 12; preloaded into the child's instructions). */
  agentSkillsMax: 5,
  /** Largest agent `maxTurns` (Phase 12). */
  maxTurnsMax: 200,
} as const

/** The agent colors of Claude Code's `color` key (Phase 12, ADR-058). */
export const AGENT_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'] as const
export type AgentColor = (typeof AGENT_COLORS)[number]

/** A named argument of an `arguments` list (Phase 12): `$name` in the body. */
export const ARGUMENT_NAME_PATTERN = /^[a-z_][\da-z_]{0,31}$/

/**
 * Frontmatter keys Claude Code supports and the harness reads but does not use (Phase 12, ADR-058): each one is an
 * `ignored-key` info.
 */
export const CLAUDE_UNSUPPORTED_DEFINITION_KEYS = [
  'permissionMode',
  'mcpServers',
  'hooks',
  'memory',
  'background',
  'effort',
  'isolation',
  'initialPrompt',
  'paths',
  'shell',
  'metadata',
  'license',
  'compatibility',
] as const

/** `error` = the definition cannot be used (catalog state `invalid`); `warning` = used, something dropped; `info` = ignored. */
export const DEFINITION_DIAGNOSTIC_LEVELS = ['error', 'warning', 'info'] as const
export type DefinitionDiagnosticLevel = (typeof DEFINITION_DIAGNOSTIC_LEVELS)[number]

export const DEFINITION_DIAGNOSTIC_CODES = [
  'invalid-frontmatter',
  'missing-field',
  'invalid-field',
  'invalid-name',
  'reserved-name',
  'duplicate-name',
  'shadowed',
  'too-large',
  'binary',
  'link',
  'unknown-tool',
  'tool-pattern',
  'ignored-key',
  'model-alias',
  'invalid-model',
  'read-failed',
  'limit',
  'project-unavailable',
] as const
export type DefinitionDiagnosticCode = (typeof DEFINITION_DIAGNOSTIC_CODES)[number]

export interface DefinitionDiagnostic {
  readonly level: DefinitionDiagnosticLevel
  readonly code: DefinitionDiagnosticCode
  /** One English sentence for the UI ("Line 2: Add a description."). Never contains file contents. */
  readonly message: string
  /** 1-based line in the file, when known. */
  readonly line?: number
  /** Project-relative path (catalog diagnostics only). */
  readonly path?: string
  readonly kind?: CustomizationKind
  readonly name?: string
}

/**
 * Agent fields. The Phase 12 keys (`disallowedTools`, `maxTurns`, `color`, `skills`, `modelAlias`) are present only when
 * the file sets them.
 */
export interface AgentDefinitionFields {
  readonly name: string
  readonly description: string
  /** Harness tool names (Claude Code names mapped, `mcp__*` kept); null = every tool the parent's mode allows. */
  readonly tools: readonly string[] | null
  /** `provider:model`, `inherit`, or null (the default sub-agent model, or `modelAlias`). */
  readonly model: string | null
  /** The markdown body: the child's instructions. */
  readonly instructions: string
  /** `disallowedTools` (Phase 12): harness tool names removed from the child's tools (applied before `tools`). */
  readonly disallowedTools?: readonly string[]
  /** `maxTurns` (Phase 12): 1 … `DEFINITION_LIMITS.maxTurnsMax`; the child runs at most this many steps. */
  readonly maxTurns?: number
  /** `color` (Phase 12): the agent's color in the chat. */
  readonly color?: AgentColor
  /** `skills` (Phase 12): ≤ `DEFINITION_LIMITS.agentSkillsMax` skill names preloaded into the child's instructions. */
  readonly skills?: readonly string[]
  /** A Claude model name (`sonnet`, `opus`, `haiku`, `fable`, `claude-…`), lowercased; `model` is null then (Phase 12). */
  readonly modelAlias?: string
}

/**
 * Command fields. The Phase 12 keys (`whenToUse`, `arguments`, `disallowedTools`, `context`, `agent`, `modelAlias`) are
 * present only when the file sets them.
 */
export interface CommandDefinitionFields {
  readonly name: string
  readonly description: string
  readonly argumentHint: string | null
  /** `provider:model` or null (the chat's model, or `modelAlias`). */
  readonly model: string | null
  /** Harness tool names that narrow the turn; null = no restriction. */
  readonly allowedTools: readonly string[] | null
  /** The prompt template (`$ARGUMENTS`, `$1` … `$9`, `{{input}}`; Phase 12: `$ARGUMENTS[N]`, `$name`, `${CLAUDE_…}`). */
  readonly body: string
  /** `when_to_use` (Phase 12): appended to the description in listings. */
  readonly whenToUse?: string
  /** `arguments` (Phase 12): ≤ 9 names (`ARGUMENT_NAME_PATTERN`), `$name` = the word at that position. */
  readonly arguments?: readonly string[]
  /** `disallowed-tools` (Phase 12): harness tool names removed from the turn (restrict-only). */
  readonly disallowedTools?: readonly string[]
  /** `context: fork` (Phase 12): the definition runs as a sub-agent of type `agent`. */
  readonly context?: 'fork'
  /** `agent` (Phase 12, only with `context: fork`): the sub-agent type, lowercased (default `general`). */
  readonly agent?: string
  /** A Claude model name, lowercased; `model` is null then (Phase 12). */
  readonly modelAlias?: string
}

/**
 * Skill fields. The Phase 11 keys are present only when the file sets a value other than the default (so a Phase 10
 * skill parses to exactly `{ name, description, content }`); read them with `skillInvocation`. The Phase 12 keys are
 * present only when the file sets them.
 */
export interface SkillDefinitionFields {
  readonly name: string
  readonly description: string
  /** The SKILL.md body. */
  readonly content: string
  /** `user-invocable` (Phase 11): absent = true (the skill runs as `/name [arguments]`). */
  readonly userInvocable?: boolean
  /** Not `disable-model-invocation` (Phase 11): absent = true (the model may load the skill). */
  readonly modelInvocable?: boolean
  /** `argument-hint` (Phase 11): absent = none. */
  readonly argumentHint?: string
  /** `when_to_use` (Phase 12): appended to the description in listings. */
  readonly whenToUse?: string
  /** `arguments` (Phase 12): ≤ 9 names (`ARGUMENT_NAME_PATTERN`). */
  readonly arguments?: readonly string[]
  /** `allowed-tools` (Phase 12): harness tool names that narrow `/name` (restrict-only, like a command's). */
  readonly allowedTools?: readonly string[]
  /** `disallowed-tools` (Phase 12): harness tool names removed (restrict-only). */
  readonly disallowedTools?: readonly string[]
  /** `model` (Phase 12): `provider:model` used by `/name`. */
  readonly model?: string
  /** A Claude model name, lowercased (Phase 12). */
  readonly modelAlias?: string
  /** `context: fork` (Phase 12): the skill runs as a sub-agent of type `agent`. */
  readonly context?: 'fork'
  /** `agent` (Phase 12, only with `context: fork`): the sub-agent type, lowercased (default `general`). */
  readonly agent?: string
}

/** Output style fields (Phase 11, ADR-051). */
export interface StyleDefinitionFields {
  /** The slug of the label (`AGENT_NAME_PATTERN`). */
  readonly name: string
  /** The name as written (`My Style`), or the file stem; at most `DEFINITION_LIMITS.labelMaxChars`. */
  readonly label: string
  readonly description: string
  /** `keep-coding-instructions` (default false). */
  readonly keepCodingInstructions: boolean
  /** The style body (the instructions block). */
  readonly content: string
}

export type ParsedDefinition
  = | { readonly kind: 'agent', readonly fields: AgentDefinitionFields }
    | { readonly kind: 'command', readonly fields: CommandDefinitionFields }
    | { readonly kind: 'skill', readonly fields: SkillDefinitionFields }
    | { readonly kind: 'style', readonly fields: StyleDefinitionFields }

export interface ParseDefinitionOptions {
  /** The file name (`reviewer.md`): its stem is the name fallback of agents and commands. */
  readonly fileName?: string
  /** The skill folder name: the name fallback of skills. */
  readonly folderName?: string
  /** Lower cap than `DEFINITION_LIMITS.contentBytes` (never higher). */
  readonly maxBytes?: number
}

export interface ParseDefinitionResult {
  /** null when the text cannot be used (an `error` diagnostic says why). */
  readonly definition: ParsedDefinition | null
  readonly diagnostics: readonly DefinitionDiagnostic[]
}

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

/** The NUL probe covers the first 8 KiB (characters; at least 8 KiB of bytes). */
const BINARY_PROBE_CHARS = 8192
/** The first line of the frontmatter is line 2 of the file (line 1 is the opening `---`). */
const FRONTMATTER_FIRST_LINE = 2
/** A command without a description uses its first body line, cut to this many characters. */
const COMMAND_DESCRIPTION_FALLBACK_MAX = 120
/** `ignored-key` diagnostics reported one by one; the rest are counted in one more diagnostic. */
const IGNORED_KEY_DIAGNOSTICS_MAX = 20
/** Key names longer than this are cut in messages. */
const KEY_NAME_SHOWN_MAX = 64

/** The frontmatter keys each kind reads; any other key is an `ignored-key` (info). */
const KIND_KEYS: Readonly<Record<CustomizationKind, readonly string[]>> = {
  agent: ['name', 'description', 'tools', 'model', 'disallowedTools', 'maxTurns', 'color', 'skills'],
  command: ['name', 'description', 'argument-hint', 'model', 'allowed-tools', 'when_to_use', 'arguments', 'disallowed-tools', 'context', 'agent'],
  skill: ['name', 'description', 'argument-hint', 'user-invocable', 'disable-model-invocation', 'when_to_use', 'arguments', 'allowed-tools', 'disallowed-tools', 'model', 'context', 'agent'],
  style: ['name', 'description', 'keep-coding-instructions'],
}
const UNSUPPORTED_KEYS: ReadonlySet<string> = new Set(CLAUDE_UNSUPPORTED_DEFINITION_KEYS)
/** A skill or agent name an agent's `skills` or a fork's `agent` names: bare or qualified (`plugin:name`), lowercased. */
const DEFINITION_REF_PATTERN = /^[\da-z][\da-z-]{0,63}(?::[\da-z][\da-z-]{0,63}){0,3}$/
/** Longest `skills` entry / fork `agent` (the qualified name limit). */
const DEFINITION_REF_MAX_CHARS = 128
/** A cleaned Claude model id (`claude-sonnet-4-5`, `claude-3-5-haiku-20241022`). */
const CLAUDE_MODEL_ID = /^claude-[\da-z][\d.a-z-]{0,99}$/

/**
 * `yaml` options (verified in `yaml@2.9.1` `dist/options.d.ts`): the YAML 1.2 core schema (a `%YAML 1.1` directive
 * does not switch to the 1.1 schema), no merge keys, explicit 1.1 tags (`!!binary`, `!!set`, `!!timestamp`, …) left as
 * plain values, duplicate keys and other spec violations are errors, nothing is logged.
 */
const YAML_PARSE_OPTIONS = {
  schema: 'core',
  version: '1.2',
  uniqueKeys: true,
  strict: true,
  prettyErrors: true,
  merge: false,
  resolveKnownTags: false,
  logLevel: 'silent',
} as const

/**
 * `stringify` options: no line folding, no `---` / `...` markers, no anchors for repeated values; double-quoted strings
 * stay on one line with JSON escapes (a multi-line double-quoted string does not survive the round trip in
 * `yaml@2.9.1` when a line holds only an escaped space).
 */
const YAML_STRINGIFY_OPTIONS = {
  schema: 'core',
  version: '1.2',
  lineWidth: 0,
  minContentWidth: 0,
  aliasDuplicateObjects: false,
  directives: false,
  doubleQuotedAsJSON: true,
} as const

/** A top-level `key: value` line of the line reader. */
const LENIENT_KEY_LINE = /^([A-Z][\w-]*)[ \t]*:(?:[ \t](.*))?$/is
/** A `- item` line of the line reader. */
const LENIENT_LIST_ITEM = /^[ \t]*-(?:[ \t](.*))?$/s
/** A block scalar header (`|`, `>-`, `|2+`, …). */
const BLOCK_SCALAR_HEADER = /^[>|](?:[+-]?\d?|\d[+-])$/
/** The raw value of a top-level `argument-hint:` line. */
const ARGUMENT_HINT_LINE = /^argument-hint[ \t]*:(.*)$/s
/** Claude Code model names without a provider (`sonnet`, `opus`, `haiku`, `fable`, `opusplan`, `claude-…`), lowercased. */
const CLAUDE_MODEL_NAME = /^(?:(?:sonnet|opus|haiku|fable|opusplan)(?:\[1m\])?|claude-.*)$/s
const MARKDOWN_HEADING = /^#{1,6}[ \t]+/
const LEADING_BLANK_LINES = /^(?:[ \t]*\n)+/
const LINE_BREAKS = /\r\n?/g
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/gu

function diagnostic(level: DefinitionDiagnosticLevel, code: DefinitionDiagnosticCode, message: string, line?: number): DefinitionDiagnostic {
  if (line === undefined)
    return { level, code, message }
  return { level, code, message: `Line ${line}: ${message}`, line }
}

function withLine(entry: DefinitionDiagnostic, line: number | undefined): DefinitionDiagnostic {
  return line === undefined ? entry : { ...entry, message: `Line ${line}: ${entry.message}`, line }
}

/** UTF-8 length of `text`; stops counting once it passes `limit`. Lone surrogates count 3 bytes (U+FFFD). */
function utf8Length(text: string, limit: number): number {
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

/** `text` cut to `max` UTF-16 units (never inside a surrogate pair), trailing whitespace removed. */
function cutText(text: string, max: number): string {
  if (text.length <= max)
    return text
  let end = max
  const last = text.charCodeAt(end - 1)
  if (last >= 0xD800 && last <= 0xDBFF)
    end--
  return text.slice(0, end).trimEnd()
}

function unquote(text: string): string {
  const first = text[0]
  if (text.length >= 2 && (first === '"' || first === '\'') && text.endsWith(first))
    return text.slice(1, -1)
  return text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function baseName(path: unknown): string {
  if (typeof path !== 'string')
    return ''
  const segments = path.split(/[/\\]/).filter(segment => segment !== '')
  return segments.at(-1) ?? ''
}

function fileStem(fileName: unknown): string {
  const base = baseName(fileName)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/** A key name for a message: control characters replaced, cut to `KEY_NAME_SHOWN_MAX`. */
function shownKey(key: string): string {
  return cutText(key.replace(CONTROL_CHARACTERS, '?'), KEY_NAME_SHOWN_MAX)
}

/** The body: CRLF / CR → LF, leading blank lines removed, trailing whitespace removed. */
function normalizeBody(text: string): string {
  return text.replace(LINE_BREAKS, '\n').replace(LEADING_BLANK_LINES, '').trimEnd()
}

/** The key of a top-level `key: value` / `"key": value` line, else null (linear; used for diagnostic lines only). */
function topLevelKey(line: string): string | null {
  const first = line[0]
  if (first === undefined || first === ' ' || first === '\t' || first === '#' || first === '-')
    return null
  const isBoundary = (char: string | undefined): boolean => char === undefined || char === ' ' || char === '\t'
  if (first === '"' || first === '\'') {
    const close = line.indexOf(first, 1)
    if (close < 0)
      return null
    const rest = line.slice(close + 1).trimStart()
    return rest.startsWith(':') && isBoundary(rest[1]) ? line.slice(1, close) : null
  }
  let colon = line.indexOf(':')
  while (colon >= 0) {
    if (isBoundary(line[colon + 1]))
      return line.slice(0, colon).trimEnd()
    colon = line.indexOf(':', colon + 1)
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------------
// Frontmatter

interface Frontmatter {
  /** Top-level keys and their values (YAML values, or strings / string lists / `{}` from the line reader). */
  readonly values: Readonly<Record<string, unknown>>
  /** The file line of each top-level key (first occurrence). */
  readonly keyLines: ReadonlyMap<string, number>
  /** The raw text after a top-level `argument-hint:` (trimmed, unquoted). */
  readonly rawArgumentHint: string | null
}

interface FieldValue {
  readonly value: unknown
  readonly line: number | undefined
}

type SplitResult
  = | { readonly ok: true, readonly frontmatter: string | null, readonly body: string }
    | { readonly ok: false, readonly diagnostic: DefinitionDiagnostic }

/** Splits the normalized text into the frontmatter (between the `---` lines) and the body. */
function splitFrontmatter(text: string): SplitResult {
  if (!text.startsWith('---\n'))
    return { ok: true, frontmatter: null, body: text }
  let start = 4
  for (;;) {
    const end = text.indexOf('\n', start)
    const line = end === -1 ? text.slice(start) : text.slice(start, end)
    if (line === '---' || line === '...') {
      const frontmatter = text.slice(4, start)
      if (utf8Length(frontmatter, DEFINITION_LIMITS.frontmatterBytes) > DEFINITION_LIMITS.frontmatterBytes) {
        const message = `The frontmatter is larger than ${formatBytes(DEFINITION_LIMITS.frontmatterBytes)}.`
        return { ok: false, diagnostic: diagnostic('error', 'too-large', message, 1) }
      }
      return { ok: true, frontmatter, body: end === -1 ? '' : text.slice(end + 1) }
    }
    if (end === -1)
      break
    start = end + 1
  }
  const message = 'The frontmatter is not closed; add a line with three dashes after it.'
  return { ok: false, diagnostic: diagnostic('error', 'invalid-frontmatter', message, 1) }
}

type YamlResult
  = | { readonly ok: true, readonly values: Readonly<Record<string, unknown>> }
    | { readonly ok: false, readonly line: number | undefined }

/** The frontmatter as a YAML mapping; any error, alias, non-mapping document or throw is a failure. */
function readYaml(source: string): YamlResult {
  try {
    const document = parseDocument(source, YAML_PARSE_OPTIONS)
    const error = document.errors[0]
    if (error !== undefined)
      return { ok: false, line: error.linePos?.[0].line }
    if (document.contents === null)
      return { ok: true, values: {} }
    if (!isMap(document.contents))
      return { ok: false, line: undefined }
    const values: unknown = document.toJS({ maxAliasCount: 0 })
    return isRecord(values) ? { ok: true, values } : { ok: false, line: undefined }
  }
  catch {
    // An alias (`maxAliasCount: 0` throws a ReferenceError) or a resource limit of the parser.
    return { ok: false, line: undefined }
  }
}

interface LenientValue {
  readonly key: string
  /** A repeated key: its lines are read and dropped (the first one wins). */
  readonly skip: boolean
  mode: 'pending' | 'list' | 'nested' | 'block' | 'plain'
  readonly folded: boolean
  readonly items: string[]
  readonly blockLines: string[]
  text: string
}

function dedent(lines: readonly string[]): string[] {
  let indent = Number.POSITIVE_INFINITY
  for (const line of lines) {
    if (line.trim() !== '')
      indent = Math.min(indent, line.length - line.trimStart().length)
  }
  return lines.map(line => line.slice(Number.isFinite(indent) ? indent : 0))
}

function storeLenient(values: Record<string, unknown>, state: LenientValue | null): void {
  if (state === null || state.skip)
    return
  let value: unknown
  switch (state.mode) {
    case 'pending':
      value = null
      break
    case 'list':
      value = state.items
      break
    case 'nested':
      value = {}
      break
    case 'block': {
      const text = dedent(state.blockLines).join('\n')
      value = state.folded ? text.replace(/([^\n])\n(?=[^\n])/g, '$1 ') : text
      break
    }
    case 'plain':
      value = state.text
      break
  }
  values[state.key] = value
}

/**
 * The line reader used when the YAML fails: top-level `key: value` lines (keys `[A-Za-z][\w-]*`, raw values with
 * matching surrounding quotes removed), `- item` lines under an empty key (a list), `|` / `>` blocks, indented
 * continuation lines of plain values (joined with a space); a repeated key keeps its first value; an indented mapping
 * under a key is read as `{}` (not a usable value).
 */
function readLenient(lines: readonly string[]): { values: Record<string, unknown>, keyLines: Map<string, number> } {
  const values: Record<string, unknown> = {}
  const keyLines = new Map<string, number>()
  let state: LenientValue | null = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const keyMatch = line.match(LENIENT_KEY_LINE)
    if (keyMatch !== null) {
      storeLenient(values, state)
      const key = keyMatch[1] ?? ''
      const raw = (keyMatch[2] ?? '').trim()
      const skip = keyLines.has(key)
      if (!skip)
        keyLines.set(key, FRONTMATTER_FIRST_LINE + index)
      const block = BLOCK_SCALAR_HEADER.test(raw)
      state = {
        key,
        skip,
        mode: raw === '' ? 'pending' : block ? 'block' : 'plain',
        folded: block && raw.startsWith('>'),
        items: [],
        blockLines: [],
        text: block ? '' : unquote(raw),
      }
      continue
    }
    if (state === null)
      continue
    const indented = line.startsWith(' ') || line.startsWith('\t')
    if (line.trim() === '') {
      if (state.mode === 'block')
        state.blockLines.push('')
      continue
    }
    if (state.mode === 'block') {
      if (indented) {
        state.blockLines.push(line)
        continue
      }
      storeLenient(values, state)
      state = null
      continue
    }
    if (line.trimStart().startsWith('#'))
      continue
    const item = line.match(LENIENT_LIST_ITEM)
    if (item !== null && (state.mode === 'pending' || state.mode === 'list')) {
      state.mode = 'list'
      state.items.push(unquote((item[1] ?? '').trim()))
      continue
    }
    if (!indented) {
      storeLenient(values, state)
      state = null
      continue
    }
    if (state.mode === 'plain')
      state.text = `${state.text} ${line.trim()}`
    else if (state.mode === 'pending')
      state.mode = 'nested'
  }
  storeLenient(values, state)
  return { values, keyLines }
}

/** Reads the frontmatter block (without the `---` lines); null after an `error` diagnostic. */
function readFrontmatter(source: string, diagnostics: DefinitionDiagnostic[]): Frontmatter | null {
  const lines = source.split('\n')
  const keyLines = new Map<string, number>()
  let rawArgumentHint: string | null = null
  const yamlLines = lines.map((line, index) => {
    const key = topLevelKey(line)
    if (key === null)
      return line
    if (!keyLines.has(key))
      keyLines.set(key, FRONTMATTER_FIRST_LINE + index)
    const hint = key === 'argument-hint' ? line.match(ARGUMENT_HINT_LINE) : null
    if (hint === null)
      return line
    const raw = (hint[1] ?? '').trim()
    rawArgumentHint ??= unquote(raw)
    // `[pr-number] [priority]` is not valid YAML; the raw text is used instead (see `readArgumentHint`).
    return raw.startsWith('[') || raw.startsWith('{') ? 'argument-hint: null' : line
  })

  const yaml = readYaml(yamlLines.join('\n'))
  if (yaml.ok)
    return { values: yaml.values, keyLines, rawArgumentHint }

  const line = yaml.line === undefined ? undefined : yaml.line + FRONTMATTER_FIRST_LINE - 1
  const lenient = readLenient(lines)
  if (Object.keys(lenient.values).length === 0) {
    diagnostics.push(diagnostic('error', 'invalid-frontmatter', 'The frontmatter is not valid YAML and has no "key: value" lines.', line))
    return null
  }
  diagnostics.push(diagnostic('warning', 'invalid-frontmatter', 'The frontmatter is not valid YAML; it was read line by line.', line))
  return { values: lenient.values, keyLines: lenient.keyLines, rawArgumentHint }
}

function fieldOf(front: Frontmatter | null, key: string): FieldValue | null {
  if (front === null || !Object.hasOwn(front.values, key))
    return null
  return { value: front.values[key], line: front.keyLines.get(key) }
}

function isAbsent(field: FieldValue | null): boolean {
  return field === null || field.value === null || field.value === undefined
}

// ---------------------------------------------------------------------------------------------------------------------
// Fields

/** The name and label of a style (the label is the name as written, or the file stem). */
function readStyleName(front: Frontmatter | null, options: ParseDefinitionOptions, diagnostics: DefinitionDiagnostic[]): { name: string, label: string } | null {
  const field = fieldOf(front, 'name')
  let raw = ''
  let line: number | undefined
  if (field !== null && !isAbsent(field)) {
    if (typeof field.value !== 'string') {
      diagnostics.push(diagnostic('error', 'invalid-field', 'The name must be text.', field.line))
      return null
    }
    raw = field.value
    line = field.line
  }
  let label = styleLabel(raw)
  const fromFile = label === ''
  if (fromFile) {
    label = styleLabel(fileStem(options.fileName))
    if (label === '') {
      diagnostics.push(diagnostic('error', 'missing-field', 'Add a name.'))
      return null
    }
  }
  const name = label.length > DEFINITION_LIMITS.labelMaxChars ? null : styleNameFromLabel(label)
  if (name === null) {
    const rule = `a letter first and at most 64 letters, digits, blanks or hyphens (${DEFINITION_LIMITS.labelMaxChars} characters as written)`
    const message = fromFile
      ? `The file name is not a valid style name; add a name with ${rule}.`
      : `Style names need ${rule}.`
    diagnostics.push(diagnostic('error', 'invalid-name', message, line))
    return null
  }
  if (isBuiltinOutputStyle(name)) {
    diagnostics.push(diagnostic('error', 'reserved-name', `${name} is a built-in name.`, line))
    return null
  }
  return { name, label }
}

function readName(kind: CustomizationKind, front: Frontmatter | null, options: ParseDefinitionOptions, diagnostics: DefinitionDiagnostic[]): string | null {
  const field = fieldOf(front, 'name')
  let raw = ''
  let line: number | undefined
  if (field !== null && !isAbsent(field)) {
    if (typeof field.value !== 'string') {
      diagnostics.push(diagnostic('error', 'invalid-field', 'The name must be text.', field.line))
      return null
    }
    raw = field.value.trim()
    line = field.line
  }
  const fromFile = raw === ''
  if (fromFile) {
    raw = (kind === 'skill' ? baseName(options.folderName) : fileStem(options.fileName)).trim()
    if (raw === '') {
      diagnostics.push(diagnostic('error', 'missing-field', 'Add a name.'))
      return null
    }
  }
  const name = raw.toLowerCase()
  const pattern = kind === 'command' ? COMMAND_NAME_PATTERN : AGENT_NAME_PATTERN
  if (!pattern.test(name)) {
    const max = kind === 'command' ? 32 : 64
    const rule = `lowercase letters, digits and hyphens (a letter first, at most ${max} characters)`
    const message = fromFile
      ? `The ${kind === 'skill' ? 'folder' : 'file'} name is not a valid name; add a name that uses ${rule}.`
      : `Names use ${rule}.`
    diagnostics.push(diagnostic('error', 'invalid-name', message, line))
    return null
  }
  const reserved = kind === 'agent' ? isReservedAgentName(name) : kind === 'command' && (isClientCommand(name) || isHarnessCommand(name))
  if (reserved) {
    diagnostics.push(diagnostic('error', 'reserved-name', `${name} is a built-in name.`, line))
    return null
  }
  return name
}

/** The first non-empty body line (a Markdown heading marker removed), cut to 120 characters. */
function firstLineDescription(body: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '')
      return cutText(trimmed.replace(MARKDOWN_HEADING, '').trim(), COMMAND_DESCRIPTION_FALLBACK_MAX)
  }
  return ''
}

function readDescription(kind: CustomizationKind, front: Frontmatter | null, body: string, diagnostics: DefinitionDiagnostic[]): string | null {
  const field = fieldOf(front, 'description')
  let text = ''
  if (field !== null && !isAbsent(field)) {
    if (typeof field.value !== 'string') {
      diagnostics.push(diagnostic('error', 'invalid-field', 'The description must be text.', field.line))
      return null
    }
    text = field.value.trim()
  }
  if (text === '') {
    if (kind === 'command')
      return firstLineDescription(body)
    if (kind === 'style' && firstLineDescription(body) !== '')
      return firstLineDescription(body)
    diagnostics.push(diagnostic('error', 'missing-field', 'Add a description.', field?.line))
    return null
  }
  const max = DEFINITION_LIMITS.descriptionMaxChars
  if (text.length > max) {
    text = cutText(text, max)
    diagnostics.push(diagnostic('warning', 'invalid-field', `The description is longer than ${max} characters; it was shortened.`, field?.line))
  }
  return text
}

/**
 * The Claude model name of `value` (Phase 12, ADR-058), normalized: lowercased, a `[1m]` suffix removed, `opusplan` →
 * `opus`; `sonnet`, `opus`, `haiku`, `fable` or a `claude-…` id. null when `value` is no Claude model name (a
 * `provider:model` ref, `inherit`, anything else).
 */
export function claudeModelAlias(value: string): string | null {
  if (typeof value !== 'string')
    return null
  const lower = value.trim().toLowerCase()
  if (lower.length > 128 || !CLAUDE_MODEL_NAME.test(lower))
    return null
  const bare = lower.endsWith('[1m]') ? lower.slice(0, -4) : lower
  if (bare === 'opusplan')
    return 'opus'
  if (bare === 'sonnet' || bare === 'opus' || bare === 'haiku' || bare === 'fable')
    return bare
  return CLAUDE_MODEL_ID.test(bare) ? bare : null
}

interface ModelValue {
  readonly model: string | null
  readonly alias: string | null
}

const NO_MODEL: ModelValue = { model: null, alias: null }

function readModel(kind: 'agent' | 'command' | 'skill', front: Frontmatter | null, diagnostics: DefinitionDiagnostic[]): ModelValue {
  const field = fieldOf(front, 'model')
  if (field === null || isAbsent(field))
    return NO_MODEL
  const fallback = kind === 'agent' ? 'the default sub-agent model is used' : 'the chat\'s model is used'
  const invalid = (): ModelValue => {
    diagnostics.push(diagnostic('warning', 'invalid-model', `The model must be "provider:model"; ${fallback}.`, field.line))
    return NO_MODEL
  }
  if (typeof field.value !== 'string')
    return invalid()
  const value = field.value.trim()
  if (value === '')
    return NO_MODEL
  const lower = value.toLowerCase()
  if (lower === 'inherit') {
    if (kind === 'agent')
      return { model: 'inherit', alias: null }
    diagnostics.push(diagnostic('info', 'invalid-model', 'Only agents inherit a model; the chat\'s model is used.', field.line))
    return NO_MODEL
  }
  if (value.includes(':'))
    return !/\s/.test(value) && safeParseModelRef(value) !== null ? { model: value, alias: null } : invalid()
  if (CLAUDE_MODEL_NAME.test(lower)) {
    const alias = claudeModelAlias(lower)
    const message = alias === null
      ? `Claude model names need a provider ("provider:model"); ${fallback}.`
      : `Claude model names use the model aliases of the settings; without one, ${fallback}.`
    diagnostics.push(diagnostic('info', 'model-alias', message, field.line))
    return { model: null, alias }
  }
  return invalid()
}

function readArgumentHint(front: Frontmatter | null, diagnostics: DefinitionDiagnostic[]): string | null {
  const field = fieldOf(front, 'argument-hint')
  if (front === null || field === null)
    return null
  let text: string
  if (typeof field.value === 'string') {
    text = field.value
  }
  else if (front.rawArgumentHint !== null) {
    text = front.rawArgumentHint
  }
  else {
    if (!isAbsent(field))
      diagnostics.push(diagnostic('warning', 'invalid-field', 'The argument hint must be text; it was dropped.', field.line))
    return null
  }
  text = text.replace(/\s+/g, ' ').trim()
  if (text === '')
    return null
  const max = DEFINITION_LIMITS.argumentHintMaxChars
  if (text.length > max) {
    text = cutText(text, max)
    diagnostics.push(diagnostic('warning', 'invalid-field', `The argument hint is longer than ${max} characters; it was shortened.`, field.line))
  }
  return text
}

/** A `true` / `false` key (YAML booleans; the line reader's `true` / `false` text); null when absent or invalid. */
function readBoolean(key: string, front: Frontmatter | null, diagnostics: DefinitionDiagnostic[]): boolean | null {
  const field = fieldOf(front, key)
  if (field === null || isAbsent(field))
    return null
  if (typeof field.value === 'boolean')
    return field.value
  if (typeof field.value === 'string') {
    const text = unquote(field.value.trim()).toLowerCase()
    if (text === 'true')
      return true
    if (text === 'false')
      return false
  }
  diagnostics.push(diagnostic('warning', 'invalid-field', `"${key}" must be true or false; the default is used.`, field.line))
  return null
}

function readTools(key: 'tools' | 'allowed-tools', front: Frontmatter | null, diagnostics: DefinitionDiagnostic[]): readonly string[] | null {
  const field = fieldOf(front, key)
  if (field === null)
    return null
  const normalized = normalizeToolList(field.value)
  for (const entry of normalized.diagnostics)
    diagnostics.push(withLine(entry, field.line))
  return normalized.tools
}

/** A `disallowedTools` / `disallowed-tools` list (Phase 12): absent, invalid or empty → null (nothing removed). */
function readDisallowedTools(key: 'disallowedTools' | 'disallowed-tools', front: Frontmatter | null, diagnostics: DefinitionDiagnostic[]): readonly string[] | null {
  const field = fieldOf(front, key)
  if (field === null)
    return null
  const normalized = normalizeToolList(field.value, { mode: 'deny' })
  for (const entry of normalized.diagnostics)
    diagnostics.push(withLine(entry, field.line))
  return normalized.tools === null || normalized.tools.length === 0 ? null : normalized.tools
}

/** The entries of a list value: a YAML list, or a text split on commas and blanks; null when it is neither. */
function listEntries(value: unknown): unknown[] | null {
  if (Array.isArray(value))
    return value
  if (typeof value === 'string')
    return value.split(/[\s,]+/).filter(entry => entry !== '')
  return null
}

/** `maxTurns` (Phase 12): a whole number from 1 to `DEFINITION_LIMITS.maxTurnsMax`; larger values are lowered. */
function readMaxTurns(front: Frontmatter | null, diagnostics: DefinitionDiagnostic[]): number | null {
  const field = fieldOf(front, 'maxTurns')
  if (field === null || isAbsent(field))
    return null
  const raw = typeof field.value === 'string' && /^\s*\d{1,9}\s*$/.test(field.value) ? Number(field.value) : field.value
  const max = DEFINITION_LIMITS.maxTurnsMax
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    diagnostics.push(diagnostic('warning', 'invalid-field', `"maxTurns" must be a whole number from 1 to ${max}; it was ignored.`, field.line))
    return null
  }
  if (raw > max) {
    diagnostics.push(diagnostic('warning', 'invalid-field', `"maxTurns" is larger than ${max}; ${max} is used.`, field.line))
    return max
  }
  return raw
}

function readColor(front: Frontmatter | null, diagnostics: DefinitionDiagnostic[]): AgentColor | null {
  const field = fieldOf(front, 'color')
  if (field === null || isAbsent(field))
    return null
  const value = typeof field.value === 'string' ? field.value.trim().toLowerCase() : null
  const color = AGENT_COLORS.find(entry => entry === value)
  if (color === undefined) {
    diagnostics.push(diagnostic('warning', 'invalid-field', `The color must be one of ${AGENT_COLORS.join(', ')}; it was ignored.`, field.line))
    return null
  }
  return color
}

/** A skill or agent reference (lowercased, bare or qualified), or null. */
function definitionRef(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  const name = value.trim().toLowerCase()
  return name.length <= DEFINITION_REF_MAX_CHARS && DEFINITION_REF_PATTERN.test(name) ? name : null
}

/** An agent's `skills` (Phase 12): ≤ `DEFINITION_LIMITS.agentSkillsMax` valid names, deduplicated; empty → null. */
function readSkillNames(front: Frontmatter | null, diagnostics: DefinitionDiagnostic[]): readonly string[] | null {
  const field = fieldOf(front, 'skills')
  if (field === null || isAbsent(field))
    return null
  const entries = listEntries(field.value)
  if (entries === null) {
    diagnostics.push(diagnostic('warning', 'invalid-field', 'The skills must be a list of skill names; they were ignored.', field.line))
    return null
  }
  const names: string[] = []
  let invalid = 0
  for (const entry of entries) {
    const name = definitionRef(entry)
    if (name === null) {
      invalid++
      continue
    }
    if (!names.includes(name))
      names.push(name)
  }
  if (invalid > 0)
    diagnostics.push(diagnostic('warning', 'invalid-field', `${invalid} ${invalid === 1 ? 'entry' : 'entries'} of the skills list ${invalid === 1 ? 'is' : 'are'} not a skill name; dropped.`, field.line))
  const max = DEFINITION_LIMITS.agentSkillsMax
  if (names.length > max) {
    names.length = max
    diagnostics.push(diagnostic('warning', 'limit', `An agent preloads at most ${max} skills; only the first ${max} are used.`, field.line))
  }
  return names.length === 0 ? null : names
}

function readWhenToUse(front: Frontmatter | null, diagnostics: DefinitionDiagnostic[]): string | null {
  const field = fieldOf(front, 'when_to_use')
  if (field === null || isAbsent(field))
    return null
  if (typeof field.value !== 'string') {
    diagnostics.push(diagnostic('warning', 'invalid-field', '"when_to_use" must be text; it was ignored.', field.line))
    return null
  }
  let text = field.value.trim()
  if (text === '')
    return null
  const max = DEFINITION_LIMITS.whenToUseMaxChars
  if (text.length > max) {
    text = cutText(text, max)
    diagnostics.push(diagnostic('warning', 'invalid-field', `"when_to_use" is longer than ${max} characters; it was shortened.`, field.line))
  }
  return text
}

/**
 * Named `arguments` (Phase 12): a list or a text of names (`ARGUMENT_NAME_PATTERN`); a name that is invalid or repeated
 * drops the whole list (positions would shift); more than `DEFINITION_LIMITS.argumentsMax` keep the first ones.
 */
function readArgumentNames(front: Frontmatter | null, diagnostics: DefinitionDiagnostic[]): readonly string[] | null {
  const field = fieldOf(front, 'arguments')
  if (field === null || isAbsent(field))
    return null
  const entries = listEntries(field.value)
  const names: string[] = []
  for (const entry of entries ?? [null]) {
    const name = typeof entry === 'string' ? entry.trim() : null
    if (name === null || !ARGUMENT_NAME_PATTERN.test(name) || names.includes(name)) {
      const message = 'The arguments must be distinct names of lowercase letters, digits and "_" (a letter or "_" first, at most 32 characters); they were ignored.'
      diagnostics.push(diagnostic('warning', 'invalid-field', message, field.line))
      return null
    }
    names.push(name)
  }
  const max = DEFINITION_LIMITS.argumentsMax
  if (names.length > max) {
    names.length = max
    diagnostics.push(diagnostic('warning', 'limit', `At most ${max} named arguments are used; the others were dropped.`, field.line))
  }
  return names.length === 0 ? null : names
}

/** `context: fork` and its `agent` (Phase 12); `agent` without `fork` is an info and dropped. */
function readFork(front: Frontmatter | null, diagnostics: DefinitionDiagnostic[]): { context: 'fork' | null, agent: string | null } {
  const contextField = fieldOf(front, 'context')
  let context: 'fork' | null = null
  if (contextField !== null && !isAbsent(contextField)) {
    if (typeof contextField.value === 'string' && contextField.value.trim().toLowerCase() === 'fork')
      context = 'fork'
    else
      diagnostics.push(diagnostic('warning', 'invalid-field', '"context" must be "fork"; it was ignored.', contextField.line))
  }
  const agentField = fieldOf(front, 'agent')
  if (agentField === null || isAbsent(agentField))
    return { context, agent: null }
  if (context === null) {
    diagnostics.push(diagnostic('info', 'ignored-key', 'The key "agent" is used only with "context: fork"; it is ignored.', agentField.line))
    return { context, agent: null }
  }
  const agent = definitionRef(agentField.value)
  if (agent === null) {
    diagnostics.push(diagnostic('warning', 'invalid-field', 'The agent must be an agent name; the general agent is used.', agentField.line))
    return { context, agent: null }
  }
  return { context, agent }
}

function reportIgnoredKeys(kind: CustomizationKind, front: Frontmatter | null, diagnostics: DefinitionDiagnostic[]): void {
  if (front === null)
    return
  const known = KIND_KEYS[kind]
  let ignored = 0
  for (const key of Object.keys(front.values)) {
    if (known.includes(key))
      continue
    ignored++
    if (ignored > IGNORED_KEY_DIAGNOSTICS_MAX)
      continue
    let hint = ''
    if (kind === 'agent' && key === 'allowed-tools')
      hint = '; agents use "tools"'
    else if (kind === 'agent' && key === 'disallowed-tools')
      hint = '; agents use "disallowedTools"'
    else if (kind === 'command' && key === 'tools')
      hint = '; commands use "allowed-tools"'
    else if ((kind === 'command' || kind === 'skill') && key === 'disallowedTools')
      hint = '; use "disallowed-tools"'
    else if (UNSUPPORTED_KEYS.has(key))
      hint = '; harness-forge does not support it'
    diagnostics.push(diagnostic('info', 'ignored-key', `The key "${shownKey(key)}" is ignored${hint}.`, front.keyLines.get(key)))
  }
  if (ignored > IGNORED_KEY_DIAGNOSTICS_MAX) {
    const more = ignored - IGNORED_KEY_DIAGNOSTICS_MAX
    diagnostics.push(diagnostic('info', 'ignored-key', `${more} more ${more === 1 ? 'key is' : 'keys are'} ignored.`))
  }
}

function byteCap(maxBytes: unknown): number {
  if (typeof maxBytes !== 'number' || Number.isNaN(maxBytes))
    return DEFINITION_LIMITS.contentBytes
  return Math.max(0, Math.min(Math.floor(maxBytes), DEFINITION_LIMITS.contentBytes))
}

function parseUnchecked(kind: CustomizationKind, text: string, options: ParseDefinitionOptions): ParseDefinitionResult {
  if (!(CUSTOMIZATION_KINDS as readonly string[]).includes(kind))
    return { definition: null, diagnostics: [diagnostic('error', 'invalid-field', 'The definition kind is unknown.')] }
  const source = typeof text === 'string' ? text : ''
  const cap = byteCap(options.maxBytes)
  if (utf8Length(source, cap) > cap)
    return { definition: null, diagnostics: [diagnostic('error', 'too-large', `The file is larger than ${formatBytes(cap)}.`)] }
  if (source.slice(0, BINARY_PROBE_CHARS).includes('\0'))
    return { definition: null, diagnostics: [diagnostic('error', 'binary', 'The file is binary (it contains a NUL character).')] }

  const normalized = (source.startsWith('\uFEFF') ? source.slice(1) : source).replace(LINE_BREAKS, '\n')
  const split = splitFrontmatter(normalized)
  if (!split.ok)
    return { definition: null, diagnostics: [split.diagnostic] }

  const diagnostics: DefinitionDiagnostic[] = []
  const front = split.frontmatter === null ? null : readFrontmatter(split.frontmatter, diagnostics)
  if (split.frontmatter !== null && front === null)
    return { definition: null, diagnostics }

  const body = normalizeBody(split.body)
  const style = kind === 'style' ? readStyleName(front, options, diagnostics) : null
  const name = kind === 'style' ? style?.name ?? null : readName(kind, front, options, diagnostics)
  const description = readDescription(kind, front, body, diagnostics)
  let definition: ParsedDefinition | null = null
  switch (kind) {
    case 'agent': {
      const tools = readTools('tools', front, diagnostics)
      const disallowedTools = readDisallowedTools('disallowedTools', front, diagnostics)
      const { model, alias } = readModel('agent', front, diagnostics)
      const maxTurns = readMaxTurns(front, diagnostics)
      const color = readColor(front, diagnostics)
      const skills = readSkillNames(front, diagnostics)
      if (name !== null && description !== null) {
        definition = {
          kind,
          fields: {
            name,
            description,
            tools,
            model,
            instructions: body,
            ...(disallowedTools !== null ? { disallowedTools } : {}),
            ...(maxTurns !== null ? { maxTurns } : {}),
            ...(color !== null ? { color } : {}),
            ...(skills !== null ? { skills } : {}),
            ...(alias !== null ? { modelAlias: alias } : {}),
          },
        }
      }
      break
    }
    case 'command': {
      const whenToUse = readWhenToUse(front, diagnostics)
      const argumentHint = readArgumentHint(front, diagnostics)
      const argumentNames = readArgumentNames(front, diagnostics)
      const { model, alias } = readModel('command', front, diagnostics)
      const allowedTools = readTools('allowed-tools', front, diagnostics)
      const disallowedTools = readDisallowedTools('disallowed-tools', front, diagnostics)
      const fork = readFork(front, diagnostics)
      if (body === '')
        diagnostics.push(diagnostic('error', 'missing-field', 'Add the prompt below the frontmatter.'))
      if (name !== null && description !== null) {
        definition = {
          kind,
          fields: {
            name,
            description,
            argumentHint,
            model,
            allowedTools,
            body,
            ...(whenToUse !== null ? { whenToUse } : {}),
            ...(argumentNames !== null ? { arguments: argumentNames } : {}),
            ...(disallowedTools !== null ? { disallowedTools } : {}),
            ...(fork.context !== null ? { context: fork.context } : {}),
            ...(fork.agent !== null ? { agent: fork.agent } : {}),
            ...(alias !== null ? { modelAlias: alias } : {}),
          },
        }
      }
      break
    }
    case 'skill': {
      const whenToUse = readWhenToUse(front, diagnostics)
      const argumentHint = readArgumentHint(front, diagnostics)
      const argumentNames = readArgumentNames(front, diagnostics)
      const userInvocable = readBoolean('user-invocable', front, diagnostics)
      const disableModelInvocation = readBoolean('disable-model-invocation', front, diagnostics)
      const { model, alias } = readModel('skill', front, diagnostics)
      const allowedTools = readTools('allowed-tools', front, diagnostics)
      const disallowedTools = readDisallowedTools('disallowed-tools', front, diagnostics)
      const fork = readFork(front, diagnostics)
      if (body === '')
        diagnostics.push(diagnostic('warning', 'missing-field', 'The skill has no instructions below the frontmatter.'))
      if (name !== null && description !== null) {
        definition = {
          kind,
          fields: {
            name,
            description,
            content: body,
            ...(userInvocable === false ? { userInvocable: false } : {}),
            ...(disableModelInvocation === true ? { modelInvocable: false } : {}),
            ...(argumentHint !== null ? { argumentHint } : {}),
            ...(whenToUse !== null ? { whenToUse } : {}),
            ...(argumentNames !== null ? { arguments: argumentNames } : {}),
            ...(allowedTools !== null ? { allowedTools } : {}),
            ...(disallowedTools !== null ? { disallowedTools } : {}),
            ...(model !== null ? { model } : {}),
            ...(alias !== null ? { modelAlias: alias } : {}),
            ...(fork.context !== null ? { context: fork.context } : {}),
            ...(fork.agent !== null ? { agent: fork.agent } : {}),
          },
        }
      }
      break
    }
    case 'style': {
      const keepCodingInstructions = readBoolean('keep-coding-instructions', front, diagnostics) ?? false
      if (body === '')
        diagnostics.push(diagnostic('warning', 'missing-field', 'The style has no instructions below the frontmatter.'))
      if (style !== null && description !== null)
        definition = { kind, fields: { name: style.name, label: style.label, description, keepCodingInstructions, content: body } }
      break
    }
  }
  reportIgnoredKeys(kind, front, diagnostics)
  const usable = !diagnostics.some(entry => entry.level === 'error')
  return { definition: usable ? definition : null, diagnostics }
}

// ---------------------------------------------------------------------------------------------------------------------
// Public API

/**
 * Parses one definition file. Never throws: a file that cannot be used has `definition: null` and at least one `error`
 * diagnostic; warnings mark dropped or shortened values, infos ignored ones.
 */
export function parseDefinition(kind: CustomizationKind, text: string, options?: ParseDefinitionOptions): ParseDefinitionResult {
  try {
    return parseUnchecked(kind, text, options ?? {})
  }
  catch {
    return { definition: null, diagnostics: [diagnostic('error', 'invalid-frontmatter', 'The file could not be read as a definition.')] }
  }
}

/** A style label as read: control characters removed, blanks collapsed, trimmed. */
function styleLabel(value: string): string {
  return value.replace(CONTROL_CHARACTERS, '').replace(/\s+/g, ' ').trim()
}

/**
 * The name of a style from its label (Phase 11): a label that is already a valid name in lower case is that name
 * (`terse`, `Terse`); otherwise accents are removed, the text is lowercased, every run of other characters becomes `-`
 * and leading / trailing `-` are dropped (`My Style!` → `my-style`). null when the result does not match
 * `AGENT_NAME_PATTERN` (empty, a digit first, longer than 64 characters).
 */
export function styleNameFromLabel(label: string): string | null {
  if (typeof label !== 'string')
    return null
  const text = styleLabel(label.slice(0, 1024))
  const lower = text.toLowerCase()
  if (AGENT_NAME_PATTERN.test(lower))
    return lower
  const slug = lower
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\da-z]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return AGENT_NAME_PATTERN.test(slug) ? slug : null
}

/** The Phase 11 skill keys with their defaults applied. */
export function skillInvocation(fields: SkillDefinitionFields): { userInvocable: boolean, modelInvocable: boolean, argumentHint: string | null } {
  const value = typeof fields === 'object' && fields !== null ? fields : ({} as Partial<SkillDefinitionFields>)
  return {
    userInvocable: value.userInvocable !== false,
    modelInvocable: value.modelInvocable !== false,
    argumentHint: typeof value.argumentHint === 'string' && value.argumentHint !== '' ? value.argumentHint : null,
  }
}

/**
 * Formats a definition as markdown with frontmatter; `parseDefinition(formatDefinition(d))` round-trips the fields.
 * Keys in order: `name`, `description`, then `tools`, `model` (agents), `argument-hint`, `model`, `allowed-tools`
 * (commands), `argument-hint`, `user-invocable` (only `false`), `disable-model-invocation` (only `true`) (skills) or
 * `keep-coding-instructions` (only `true`) (styles); a style writes its label as `name` when the label's slug is the
 * name, else the name; null values are omitted; tool lists are YAML lists. The body follows after a blank line (leading
 * blank lines and trailing whitespace removed, as the parser reads it) and ends with a newline. Phase 12 keys are
 * written only when set: agents `disallowedTools` (after `tools`), `maxTurns`, `skills`, `color` (after `model`);
 * commands and skills `when_to_use` (after `description`), `arguments` (after `argument-hint`), `disallowed-tools`
 * (after `allowed-tools`), `context` and `agent` (last); skills `model` and `allowed-tools` (after
 * `disable-model-invocation`). A `modelAlias` is written as `model` when `model` is null.
 */
export function formatDefinition(definition: ParsedDefinition): string {
  const front: Record<string, unknown> = {}
  const set = (key: string, value: unknown): void => {
    if (value !== null && value !== undefined)
      front[key] = value
  }
  /** A non-empty list copy, else null (the key is omitted). */
  const list = (value: readonly string[] | null | undefined): string[] | null => Array.isArray(value) && value.length > 0 ? [...value] : null
  const text = (value: unknown): string | null => typeof value === 'string' && value !== '' ? value : null
  let body: string
  switch (definition.kind) {
    case 'agent': {
      const fields = definition.fields
      set('name', fields.name)
      set('description', fields.description)
      set('tools', fields.tools === null ? null : [...fields.tools])
      set('disallowedTools', list(fields.disallowedTools))
      set('model', fields.model ?? text(fields.modelAlias))
      set('maxTurns', typeof fields.maxTurns === 'number' ? fields.maxTurns : null)
      set('skills', list(fields.skills))
      set('color', text(fields.color))
      body = fields.instructions
      break
    }
    case 'command': {
      const fields = definition.fields
      set('name', fields.name)
      set('description', fields.description)
      set('when_to_use', text(fields.whenToUse))
      set('argument-hint', fields.argumentHint)
      set('arguments', list(fields.arguments))
      set('model', fields.model ?? text(fields.modelAlias))
      set('allowed-tools', fields.allowedTools === null ? null : [...fields.allowedTools])
      set('disallowed-tools', list(fields.disallowedTools))
      set('context', fields.context === 'fork' ? 'fork' : null)
      set('agent', fields.context === 'fork' ? text(fields.agent) : null)
      body = fields.body
      break
    }
    case 'skill': {
      const fields = definition.fields
      set('name', fields.name)
      set('description', fields.description)
      set('when_to_use', text(fields.whenToUse))
      set('argument-hint', typeof fields.argumentHint === 'string' && fields.argumentHint !== '' ? fields.argumentHint : null)
      set('arguments', list(fields.arguments))
      set('user-invocable', fields.userInvocable === false ? false : null)
      set('disable-model-invocation', fields.modelInvocable === false ? true : null)
      set('model', text(fields.model) ?? text(fields.modelAlias))
      set('allowed-tools', Array.isArray(fields.allowedTools) ? [...fields.allowedTools] : null)
      set('disallowed-tools', list(fields.disallowedTools))
      set('context', fields.context === 'fork' ? 'fork' : null)
      set('agent', fields.context === 'fork' ? text(fields.agent) : null)
      body = fields.content
      break
    }
    case 'style': {
      const fields = definition.fields
      const label = typeof fields.label === 'string' ? styleLabel(fields.label) : ''
      set('name', label !== '' && styleNameFromLabel(label) === fields.name ? label : fields.name)
      set('description', fields.description)
      set('keep-coding-instructions', fields.keepCodingInstructions === true ? true : null)
      body = fields.content
      break
    }
  }
  const frontmatter = stringify(front, YAML_STRINGIFY_OPTIONS)
  const content = normalizeBody(typeof body === 'string' ? body : '')
  return content === '' ? `---\n${frontmatter}---\n` : `---\n${frontmatter}---\n\n${content}\n`
}

/** The `name:` line of `setDefinitionName` (a YAML scalar on one line). */
function nameLine(name: string): string {
  return `name: ${stringify(name, YAML_STRINGIFY_OPTIONS).trimEnd()}`
}

/** True for a line that may continue the value of the previous key (indented or blank). */
function isContinuationLine(line: string): boolean {
  return line.startsWith(' ') || line.startsWith('\t') || line.trim() === ''
}

/**
 * Inserts or replaces the `name:` line of a definition file (Phase 12, ADR-055 / ADR-058: imported Claude Code
 * commands usually have no `name:`, and a renamed import gets `<name>-2`). Every other line is kept byte for byte (the
 * BOM, line breaks, key order, comments and unknown keys survive): an existing top-level `name:` line (with its
 * indented continuation lines) is replaced; without one, `name:` becomes the first frontmatter line; a file without a
 * frontmatter (or with an unclosed one) gets a new `---` block on top, using the file's line break. A name that is not
 * text leaves the file unchanged.
 */
export function setDefinitionName(text: string, name: string): string {
  if (typeof text !== 'string' || typeof name !== 'string')
    return typeof text === 'string' ? text : ''
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''
  const source = text.slice(bom.length)
  const newline = /\r\n/.test(source) ? '\r\n' : /\r/.test(source) && !source.includes('\n') ? '\r' : '\n'
  const line = nameLine(name.replace(LINE_BREAKS, ' ').replace(/\n/g, ' '))
  // Lines with their own terminators, so joining them gives back the exact text.
  const lines = source.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? []
  const content = (entry: string): string => entry.replace(/(?:\r\n|\r|\n)$/, '')
  let close = -1
  if (lines.length > 0 && content(lines[0] as string) === '---') {
    for (let index = 1; index < lines.length; index++) {
      const value = content(lines[index] as string)
      if (value === '---' || value === '...') {
        close = index
        break
      }
    }
  }
  if (close === -1)
    return `${bom}---${newline}${line}${newline}---${newline}${source}`
  const first = lines[0] as string
  const terminator = first.slice(3) || newline
  for (let index = 1; index < close; index++) {
    if (topLevelKey(content(lines[index] as string)) !== 'name')
      continue
    let end = index + 1
    while (end < close && isContinuationLine(content(lines[end] as string)))
      end++
    // Blank lines after the value are kept.
    while (end > index + 1 && content(lines[end - 1] as string).trim() === '')
      end--
    const own = (lines[index] as string).slice(content(lines[index] as string).length) || terminator
    return `${bom}${lines.slice(0, index).join('')}${line}${own}${lines.slice(end).join('')}`
  }
  return `${bom}${first}${line}${terminator}${lines.slice(1).join('')}`
}

/** A catalog candidate for the precedence resolver. */
export interface RankedDefinition {
  readonly kind: CustomizationKind
  readonly name: string
  readonly source: CustomizationSource
  /** Project-relative path (project entries): decides `.harness` over `.claude`, then the first sorted path. */
  readonly path?: string
}

/** The definition folder of a project-relative path (`./` and `\` tolerated), else null. */
function projectFolder(path: string | undefined): DefinitionFolder | null {
  if (typeof path !== 'string')
    return null
  const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  return DEFINITION_FOLDERS.find(folder => normalized === folder || normalized.startsWith(`${folder}/`)) ?? null
}

/**
 * Precedence rank: builtin 0 < plugin 1 < user 2 < project `.claude` 3 < project `.harness` 4 (a project entry whose
 * path is not under `.harness/` ranks as `.claude`; an unknown source ranks -1).
 */
export function definitionRank(entry: RankedDefinition): number {
  switch (entry.source) {
    case 'builtin':
      return 0
    case 'plugin':
      return 1
    case 'user':
      return 2
    case 'project':
      return projectFolder(entry.path) === '.harness' ? 4 : 3
    default:
      return -1
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function optionalText(entry: object, key: string): string | null {
  const value = (entry as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}

/** Winner first: the higher rank, then the entry with a path, the lexicographically first path, `pluginId`, `id`. */
function compareCandidates(a: RankedDefinition, b: RankedDefinition): number {
  const rank = definitionRank(b) - definitionRank(a)
  if (rank !== 0)
    return rank
  for (const key of ['path', 'pluginId', 'id']) {
    const left = optionalText(a, key)
    const right = optionalText(b, key)
    if (left !== right) {
      if (left === null)
        return 1
      if (right === null)
        return -1
      return compareText(left, right)
    }
  }
  return 0
}

/**
 * Picks one winner per (kind, name) — the highest `definitionRank`; ties go to the lexicographically first path (then
 * `pluginId`, then `id`, read structurally) — and returns every loser with the entry that shadows it (the winner).
 * Both lists are ordered by kind (`CUSTOMIZATION_KINDS`) and name; losers follow the precedence order. The result
 * does not depend on the input order (except for entries that are equal in every compared field).
 */
export function resolvePrecedence<T extends RankedDefinition>(entries: readonly T[]): {
  readonly active: readonly T[]
  readonly shadowed: readonly { readonly entry: T, readonly by: T }[]
} {
  const groups = new Map<string, T[]>()
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = `${entry.kind}\u0000${entry.name}`
    const group = groups.get(key)
    if (group === undefined)
      groups.set(key, [entry])
    else
      group.push(entry)
  }
  const kindOrder = (kind: string): number => {
    const index = (CUSTOMIZATION_KINDS as readonly string[]).indexOf(kind)
    return index === -1 ? CUSTOMIZATION_KINDS.length : index
  }
  const ordered = [...groups.values()].sort((a, b) => {
    const left = a[0] as T
    const right = b[0] as T
    return kindOrder(left.kind) - kindOrder(right.kind) || compareText(left.name, right.name)
  })
  const active: T[] = []
  const shadowed: { entry: T, by: T }[] = []
  for (const group of ordered) {
    const [winner, ...losers] = [...group].sort(compareCandidates)
    if (winner === undefined)
      continue
    active.push(winner)
    for (const entry of losers)
      shadowed.push({ entry, by: winner })
  }
  return { active, shadowed }
}
