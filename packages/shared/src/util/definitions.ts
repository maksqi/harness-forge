/**
 * Customization definition files (Phase 10, ADR-044 / ADR-045): agents, commands and skills are markdown files with YAML
 * frontmatter (`---` at byte 0, BOM allowed). This module is the ONLY parser and formatter (server and web): `yaml`
 * core schema, no aliases, unique keys, byte caps applied before parsing; it never throws — every problem is a
 * diagnostic. Contract skeleton written by the coordinator in P10-0a (K1); implemented by C29.
 *
 * Name rule (all kinds): the frontmatter `name`, else the file stem (agents, commands) or the folder name (skills),
 * else an `error` diagnostic `missing-field`.
 *
 * Parsing, in order: the UTF-8 byte cap, a NUL probe of the first 8 KiB, BOM strip and CRLF / CR → LF; frontmatter only
 * when the text starts with `---\n`, closed by the next line that is exactly `---` or `...` (≤ 8 KiB); `yaml` with the
 * core schema, unique keys and no aliases (`maxAliasCount: 0`); a document that is not a mapping or fails falls back
 * to a line reader (`key: value`, `- item` lists, `|` / `>` blocks; a `warning`). A top-level `argument-hint:` whose
 * raw value starts with `[` or `{` (Claude Code's `[pr-number] [priority]`) is taken as raw text, so it never makes
 * the YAML fail. Messages start with `Line N: ` when the line is known and never quote file contents (only key names
 * and reserved names).
 */
import { isMap, parseDocument, stringify } from 'yaml'
import { AGENT_NAME_PATTERN, COMMAND_NAME_PATTERN, isClientCommand, isHarnessCommand, isReservedAgentName, safeParseModelRef } from '../ids.ts'
import { normalizeToolList } from './tool-names.ts'

export const CUSTOMIZATION_KINDS = ['agent', 'command', 'skill'] as const
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
  /** `argument-hint`. */
  argumentHintMaxChars: 100,
  /** Entries of a `tools` / `allowed-tools` list. */
  toolsMax: 64,
} as const

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

export interface AgentDefinitionFields {
  readonly name: string
  readonly description: string
  /** Harness tool names (Claude Code names mapped, `mcp__*` kept); null = every tool the parent's mode allows. */
  readonly tools: readonly string[] | null
  /** `provider:model`, `inherit`, or null (the default sub-agent model). */
  readonly model: string | null
  /** The markdown body: the child's instructions. */
  readonly instructions: string
}

export interface CommandDefinitionFields {
  readonly name: string
  readonly description: string
  readonly argumentHint: string | null
  /** `provider:model` or null (the chat's model). */
  readonly model: string | null
  /** Harness tool names that narrow the turn; null = no restriction. */
  readonly allowedTools: readonly string[] | null
  /** The prompt template (`$ARGUMENTS`, `$1` … `$9`, `{{input}}`). */
  readonly body: string
}

export interface SkillDefinitionFields {
  readonly name: string
  readonly description: string
  /** The SKILL.md body. */
  readonly content: string
}

export type ParsedDefinition
  = | { readonly kind: 'agent', readonly fields: AgentDefinitionFields }
    | { readonly kind: 'command', readonly fields: CommandDefinitionFields }
    | { readonly kind: 'skill', readonly fields: SkillDefinitionFields }

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
  agent: ['name', 'description', 'tools', 'model'],
  command: ['name', 'description', 'argument-hint', 'model', 'allowed-tools'],
  skill: ['name', 'description'],
}

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
/** Claude Code model names without a provider (`sonnet`, `opus`, `haiku`, `opusplan`, `claude-…`), lowercased. */
const CLAUDE_MODEL_NAME = /^(?:(?:sonnet|opus|haiku|opusplan)(?:\[1m\])?|claude-.*)$/s
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

function readModel(kind: 'agent' | 'command', front: Frontmatter | null, diagnostics: DefinitionDiagnostic[]): string | null {
  const field = fieldOf(front, 'model')
  if (field === null || isAbsent(field))
    return null
  const fallback = kind === 'agent' ? 'the default sub-agent model is used' : 'the chat\'s model is used'
  const invalid = (): null => {
    diagnostics.push(diagnostic('warning', 'invalid-model', `The model must be "provider:model"; ${fallback}.`, field.line))
    return null
  }
  if (typeof field.value !== 'string')
    return invalid()
  const value = field.value.trim()
  if (value === '')
    return null
  const lower = value.toLowerCase()
  if (lower === 'inherit') {
    if (kind === 'agent')
      return 'inherit'
    diagnostics.push(diagnostic('info', 'invalid-model', 'Only agents inherit a model; the chat\'s model is used.', field.line))
    return null
  }
  if (value.includes(':'))
    return !/\s/.test(value) && safeParseModelRef(value) !== null ? value : invalid()
  if (CLAUDE_MODEL_NAME.test(lower)) {
    diagnostics.push(diagnostic('info', 'model-alias', `Claude model names need a provider ("provider:model"); ${fallback}.`, field.line))
    return null
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

function readTools(key: 'tools' | 'allowed-tools', front: Frontmatter | null, diagnostics: DefinitionDiagnostic[]): readonly string[] | null {
  const field = fieldOf(front, key)
  if (field === null)
    return null
  const normalized = normalizeToolList(field.value)
  for (const entry of normalized.diagnostics)
    diagnostics.push(withLine(entry, field.line))
  return normalized.tools
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
    else if (kind === 'command' && key === 'tools')
      hint = '; commands use "allowed-tools"'
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
  const name = readName(kind, front, options, diagnostics)
  const description = readDescription(kind, front, body, diagnostics)
  let definition: ParsedDefinition | null = null
  switch (kind) {
    case 'agent': {
      const tools = readTools('tools', front, diagnostics)
      const model = readModel('agent', front, diagnostics)
      if (name !== null && description !== null)
        definition = { kind, fields: { name, description, tools, model, instructions: body } }
      break
    }
    case 'command': {
      const argumentHint = readArgumentHint(front, diagnostics)
      const model = readModel('command', front, diagnostics)
      const allowedTools = readTools('allowed-tools', front, diagnostics)
      if (body === '')
        diagnostics.push(diagnostic('error', 'missing-field', 'Add the prompt below the frontmatter.'))
      if (name !== null && description !== null)
        definition = { kind, fields: { name, description, argumentHint, model, allowedTools, body } }
      break
    }
    case 'skill': {
      if (body === '')
        diagnostics.push(diagnostic('warning', 'missing-field', 'The skill has no instructions below the frontmatter.'))
      if (name !== null && description !== null)
        definition = { kind, fields: { name, description, content: body } }
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

/**
 * Formats a definition as markdown with frontmatter; `parseDefinition(formatDefinition(d))` round-trips the fields.
 * Keys in order: `name`, `description`, then `tools`, `model` (agents) or `argument-hint`, `model`, `allowed-tools`
 * (commands); null values are omitted; tool lists are YAML lists. The body follows after a blank line (leading blank
 * lines and trailing whitespace removed, as the parser reads it) and ends with a newline.
 */
export function formatDefinition(definition: ParsedDefinition): string {
  const front: Record<string, unknown> = {}
  const set = (key: string, value: unknown): void => {
    if (value !== null && value !== undefined)
      front[key] = value
  }
  let body: string
  switch (definition.kind) {
    case 'agent': {
      const fields = definition.fields
      set('name', fields.name)
      set('description', fields.description)
      set('tools', fields.tools === null ? null : [...fields.tools])
      set('model', fields.model)
      body = fields.instructions
      break
    }
    case 'command': {
      const fields = definition.fields
      set('name', fields.name)
      set('description', fields.description)
      set('argument-hint', fields.argumentHint)
      set('model', fields.model)
      set('allowed-tools', fields.allowedTools === null ? null : [...fields.allowedTools])
      body = fields.body
      break
    }
    case 'skill': {
      const fields = definition.fields
      set('name', fields.name)
      set('description', fields.description)
      body = fields.content
      break
    }
  }
  const frontmatter = stringify(front, YAML_STRINGIFY_OPTIONS)
  const text = normalizeBody(typeof body === 'string' ? body : '')
  return text === '' ? `---\n${frontmatter}---\n` : `---\n${frontmatter}---\n\n${text}\n`
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
