/**
 * Command hooks (Phase 11, ADR-048): the Claude Code `hooks` format (`{ <Event>: [{ matcher?, hooks: [{ type:
 * 'command', command, timeout? }] }] }`), the safe matcher subset, the stdin payload, the exit-code / JSON output
 * contract and the combination of several hooks' outcomes. This module is the ONLY reader of hook configurations
 * (personal rows, project `.harness` / `.claude` `settings{,.local}.json`, plugin `contributes.hooks`) on the server and
 * the web. Pure and isomorphic; it never throws (every problem is a diagnostic) and never builds a `RegExp` from input.
 * Contract skeleton written by the coordinator in P11-0a (K1); implemented by C35.
 *
 * Matcher grammar: alternatives separated by `|`; each alternative uses only `[A-Za-z0-9_.\- *]`; `*` and `.*` are
 * wildcards, any other `.` is a literal; an alternative matches the whole name, case-sensitively; an empty, missing or
 * `*` matcher matches everything; any of `^ $ [ ( + ? \ {` makes the matcher invalid (it never runs). A matcher is
 * tested against every name of `hookTargetNames` (the harness tool name, its Claude Code aliases, and
 * `mcp__<claudeName>__<tool>` for project MCP tools). Blanks around an alternative are ignored; empty alternatives
 * (`Edit||Write`, `Edit|`) are skipped, a matcher with no alternative left is invalid.
 *
 * Output contract: exit 0 → a JSON object on stdout decides (else plain stdout, which is context for
 * `UserPromptSubmit` and `SessionStart`); exit 2 → block with stderr as the reason; any other exit code or a timeout →
 * a non-blocking error. JSON fields: `continue`, `stopReason`, `systemMessage`, `suppressOutput`, `decision` (`block`;
 * the legacy `approve` = allow), `reason`, `hookSpecificOutput.{hookEventName (must match the event),
 * permissionDecision, permissionDecisionReason, updatedInput, additionalContext}`; each event honors only its own
 * fields (anything else is a diagnostic).
 *
 * Per event (`readHookOutput`):
 * - PreToolUse: exit 2 / `decision: block` / `permissionDecision: deny` → `blocked` + decision `deny`;
 *   `permissionDecision` `allow` / `ask` (legacy `decision: approve` = allow; `permissionDecision` wins over
 *   `decision`), `permissionDecisionReason` (else `reason`), `updatedInput` (an object ≤ 64 KiB; dropped on deny).
 * - PostToolUse: exit 2 / `decision: block` → `blocked` (the reason is fed back to the model); `additionalContext`.
 * - UserPromptSubmit: exit 2 / `decision: block` → `blocked` (the turn is refused); `additionalContext`, or plain stdout
 *   as context.
 * - Stop / SubagentStop: exit 2 / `decision: block` → `blocked` (the agent continues with the reason).
 * - SessionStart: `additionalContext`, or plain stdout as context; exit 2 is a non-blocking error (stderr becomes the
 *   reason shown to the user).
 * - PreCompact / Notification: observe only; exit 2 is a non-blocking error, `continue: false` is ignored.
 * - Every event: `continue: false` (+ `stopReason`), `systemMessage`, `suppressOutput`.
 */
import { CLAUDE_TOOL_ALIASES } from './tool-names.ts'

export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'SessionStart',
] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

/** Events whose matcher is matched against tool names (the other events ignore the matcher, except as noted). */
export const TOOL_HOOK_EVENTS = ['PreToolUse', 'PostToolUse'] as const

/**
 * What the matcher of an event is tested against (Claude Code parity): tool names (`hookTargetNames`), the
 * SessionStart `source` (`startup` / `compact`), the PreCompact `trigger` (`manual` / `auto`), the Notification type
 * (`permission_prompt`); null = the matcher is ignored (the hook always runs).
 */
export const HOOK_MATCHER_SUBJECTS: Readonly<Record<HookEvent, 'tool' | 'source' | 'trigger' | 'notification' | null>> = {
  PreToolUse: 'tool',
  PostToolUse: 'tool',
  UserPromptSubmit: null,
  Notification: 'notification',
  Stop: null,
  SubagentStop: null,
  PreCompact: 'trigger',
  SessionStart: 'source',
}

/** Where a hook comes from; the combination order of `updatedInput` is personal, then plugin, then project. */
export const HOOK_SOURCES = ['personal', 'project', 'plugin'] as const
export type HookSource = (typeof HOOK_SOURCES)[number]

/** Mirrored by the Phase 11 group of `LIMITS` (`packages/shared/src/limits.ts`). */
export const HOOK_LIMITS = {
  /** A settings file (`settings.json`) read for its `hooks` key. */
  configBytes: 262_144,
  /** Hook handlers of one configuration (personal rows, one project, one plugin). */
  itemsMax: 100,
  commandMaxChars: 4096,
  matcherMaxChars: 200,
  /** Default and maximum handler timeout, in seconds. */
  timeoutDefaultSec: 60,
  timeoutMaxSec: 600,
  /** The stdin payload (`tool_response`, then `tool_input` are cut to fit). */
  payloadBytes: 262_144,
  /** Model-visible context of one event (joined over every handler). */
  contextMaxChars: 10_000,
  reasonMaxChars: 2000,
  systemMessageMaxChars: 2000,
  updatedInputBytes: 65_536,
} as const

export const HOOK_DIAGNOSTIC_CODES = [
  'invalid-json',
  'not-an-object',
  'too-large',
  'unknown-event',
  'unsupported-type',
  'invalid-matcher',
  'invalid-command',
  'invalid-timeout',
  'too-many',
  'too-long',
  'invalid-output',
  'ignored-field',
  'conflict',
] as const
export type HookDiagnosticCode = (typeof HOOK_DIAGNOSTIC_CODES)[number]

export interface HookDiagnostic {
  readonly level: 'error' | 'warning' | 'info'
  readonly code: HookDiagnosticCode
  /** One English sentence for the UI; never quotes a command, a payload or an output. */
  readonly message: string
  /** Project-relative settings file, when the hook came from one. */
  readonly file?: string
  readonly event?: HookEvent
  /** `[group index, handler index]` inside the event's list. */
  readonly position?: readonly [number, number]
}

/** One command hook handler of a configuration. */
export interface HookSpec {
  readonly event: HookEvent
  /** null = every target. */
  readonly matcher: string | null
  readonly command: string
  /** Seconds; null = `HOOK_LIMITS.timeoutDefaultSec`. */
  readonly timeoutSec: number | null
  readonly position: readonly [number, number]
  readonly file?: string
}

export interface ReadHooksResult {
  readonly items: readonly HookSpec[]
  readonly diagnostics: readonly HookDiagnostic[]
}

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

/** Diagnostics kept per reading; the rest are counted in one more diagnostic. */
const DIAGNOSTICS_MAX = 200
/** Key names shown in messages are cut to this many characters. */
const KEY_SHOWN_MAX = 64
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/gu

const EVENT_SET: ReadonlySet<string> = new Set(HOOK_EVENTS)
/** Events a hook can block (exit 2 / `decision: block`). */
const BLOCKING_EVENTS: ReadonlySet<HookEvent> = new Set(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop'])
/** Events whose plain stdout (exit 0, not JSON) is model-visible context. */
const PLAIN_CONTEXT_EVENTS: ReadonlySet<HookEvent> = new Set(['UserPromptSubmit', 'SessionStart'])
/** Events that read `hookSpecificOutput.additionalContext`. */
const CONTEXT_EVENTS: ReadonlySet<HookEvent> = new Set(['PostToolUse', 'UserPromptSubmit', 'SessionStart'])
/** Events that can stop the agent with `continue: false`. */
const STOPPABLE_EVENTS: ReadonlySet<HookEvent> = new Set(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'SessionStart'])
/** Combination order of the sources (`updatedInput`, contexts, reasons). */
const SOURCE_ORDER: Readonly<Record<string, number>> = { personal: 0, plugin: 1, project: 2 }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === 'string' && EVENT_SET.has(value)
}

function shownKey(key: string): string {
  const clean = key.replace(CONTROL_CHARACTERS, '?')
  return clean.length > KEY_SHOWN_MAX ? `${clean.slice(0, KEY_SHOWN_MAX)}...` : clean
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

function utf8Length(text: string): number {
  return utf8LengthUpTo(text, Number.POSITIVE_INFINITY)
}

function formatBytes(bytes: number): string {
  return bytes % 1024 === 0 ? `${bytes / 1024} KiB` : `${bytes} bytes`
}

/** A trimmed, capped text, or null when empty. */
function cappedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string')
    return null
  const trimmed = value.trim()
  return trimmed === '' ? null : cutText(trimmed, max)
}

/** JSON with object keys sorted (any depth; `JSON.stringify` does the walking); null when it cannot be serialized. */
function stableStringify(value: unknown): string | null {
  try {
    const text = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint')
        return item.toString()
      if (isRecord(item)) {
        const sorted: Record<string, unknown> = {}
        for (const key of Object.keys(item).sort())
          Object.defineProperty(sorted, key, { value: item[key], enumerable: true, writable: true, configurable: true })
        return sorted
      }
      return item
    })
    return typeof text === 'string' ? text : null
  }
  catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Configurations

interface Collector {
  readonly items: HookSpec[]
  readonly diagnostics: HookDiagnostic[]
  readonly file: string | undefined
  dropped: number
  overflow: boolean
}

function report(collector: Collector, entry: Omit<HookDiagnostic, 'file'>): void {
  if (collector.diagnostics.length >= DIAGNOSTICS_MAX) {
    collector.dropped++
    return
  }
  collector.diagnostics.push(collector.file === undefined ? entry : { ...entry, file: collector.file })
}

/** The matcher of a group: null (every target), a valid matcher, or false (invalid, reported). */
function readMatcher(collector: Collector, event: HookEvent, group: Record<string, unknown>, groupIndex: number, handlers: number): string | null | false {
  const raw = group.matcher
  if (raw === undefined || raw === null)
    return null
  const invalid = (code: HookDiagnosticCode, message: string): false => {
    for (let handler = 0; handler < Math.max(1, handlers); handler++)
      report(collector, { level: 'error', code, message, event, position: [groupIndex, handler] })
    return false
  }
  if (typeof raw !== 'string')
    return invalid('invalid-matcher', 'The matcher must be text; the hooks of this group never run.')
  const trimmed = raw.trim()
  if (trimmed === '')
    return null
  if (trimmed.length > HOOK_LIMITS.matcherMaxChars)
    return invalid('too-long', `The matcher is longer than ${HOOK_LIMITS.matcherMaxChars} characters; the hooks of this group never run.`)
  const compiled = compileMatcher(trimmed)
  if (!compiled.ok)
    return invalid('invalid-matcher', `${compiled.reason} The hooks of this group never run.`)
  return trimmed
}

function readTimeout(collector: Collector, event: HookEvent, value: unknown, position: [number, number]): number | null {
  if (value === undefined || value === null)
    return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    report(collector, { level: 'warning', code: 'invalid-timeout', message: 'The timeout must be a positive number of seconds; the default is used.', event, position })
    return null
  }
  if (value > HOOK_LIMITS.timeoutMaxSec) {
    report(collector, { level: 'warning', code: 'invalid-timeout', message: `The timeout is longer than ${HOOK_LIMITS.timeoutMaxSec} seconds; ${HOOK_LIMITS.timeoutMaxSec} seconds are used.`, event, position })
    return HOOK_LIMITS.timeoutMaxSec
  }
  return Math.ceil(value)
}

const HANDLER_KEYS: ReadonlySet<string> = new Set(['type', 'command', 'timeout'])
const GROUP_KEYS: ReadonlySet<string> = new Set(['matcher', 'hooks'])

function readHandler(collector: Collector, event: HookEvent, handler: unknown, matcher: string | null, position: [number, number]): void {
  if (!isRecord(handler)) {
    report(collector, { level: 'error', code: 'not-an-object', message: 'A hook must be an object with a type and a command.', event, position })
    return
  }
  if (handler.type !== 'command') {
    const message = handler.type === 'prompt'
      ? 'Prompt hooks are not supported; only command hooks run.'
      : 'Only hooks of type "command" are supported.'
    report(collector, { level: 'warning', code: 'unsupported-type', message, event, position })
    return
  }
  const command = handler.command
  if (typeof command !== 'string' || command.trim() === '') {
    report(collector, { level: 'error', code: 'invalid-command', message: 'The command must be non-empty text.', event, position })
    return
  }
  if (command.includes('\0')) {
    report(collector, { level: 'error', code: 'invalid-command', message: 'The command contains a NUL character.', event, position })
    return
  }
  const trimmed = command.trim()
  if (trimmed.length > HOOK_LIMITS.commandMaxChars) {
    report(collector, { level: 'error', code: 'too-long', message: `The command is longer than ${HOOK_LIMITS.commandMaxChars} characters.`, event, position })
    return
  }
  const timeoutSec = readTimeout(collector, event, handler.timeout, position)
  for (const key of Object.keys(handler)) {
    if (!HANDLER_KEYS.has(key))
      report(collector, { level: 'info', code: 'ignored-field', message: `The field "${shownKey(key)}" is ignored.`, event, position })
  }
  if (collector.items.length >= HOOK_LIMITS.itemsMax) {
    if (!collector.overflow) {
      collector.overflow = true
      report(collector, { level: 'warning', code: 'too-many', message: `Only the first ${HOOK_LIMITS.itemsMax} hooks are used.`, event, position })
    }
    return
  }
  const spec: HookSpec = collector.file === undefined
    ? { event, matcher, command: trimmed, timeoutSec, position }
    : { event, matcher, command: trimmed, timeoutSec, position, file: collector.file }
  collector.items.push(spec)
}

function readEvent(collector: Collector, event: HookEvent, groups: unknown): void {
  if (!Array.isArray(groups)) {
    report(collector, { level: 'error', code: 'not-an-object', message: `The ${event} hooks must be a list of matcher groups.`, event })
    return
  }
  groups.forEach((group: unknown, groupIndex: number) => {
    if (!isRecord(group)) {
      report(collector, { level: 'error', code: 'not-an-object', message: 'A matcher group must be an object with a "hooks" list.', event, position: [groupIndex, 0] })
      return
    }
    const handlers = group.hooks
    if (!Array.isArray(handlers)) {
      report(collector, { level: 'error', code: 'not-an-object', message: 'A matcher group needs a "hooks" list.', event, position: [groupIndex, 0] })
      return
    }
    for (const key of Object.keys(group)) {
      if (!GROUP_KEYS.has(key))
        report(collector, { level: 'info', code: 'ignored-field', message: `The field "${shownKey(key)}" is ignored.`, event, position: [groupIndex, 0] })
    }
    const matcher = readMatcher(collector, event, group, groupIndex, handlers.length)
    if (matcher === false)
      return
    handlers.forEach((handler: unknown, handlerIndex: number) => readHandler(collector, event, handler, matcher, [groupIndex, handlerIndex]))
  })
}

function readUnchecked(value: unknown, file: string | undefined): ReadHooksResult {
  const collector: Collector = { items: [], diagnostics: [], file, dropped: 0, overflow: false }
  if (value === undefined || value === null)
    return { items: [], diagnostics: [] }
  if (!isRecord(value)) {
    report(collector, { level: 'error', code: 'not-an-object', message: 'The hooks must be an object keyed by event name.' })
    return { items: [], diagnostics: collector.diagnostics }
  }
  for (const key of Object.keys(value)) {
    if (!isHookEvent(key)) {
      report(collector, { level: 'info', code: 'unknown-event', message: `The event "${shownKey(key)}" is not supported; its hooks are ignored.` })
      continue
    }
    readEvent(collector, key, value[key])
  }
  if (collector.dropped > 0) {
    const entry: HookDiagnostic = { level: 'info', code: 'too-many', message: `${collector.dropped} more problems were found.` }
    collector.diagnostics.push(file === undefined ? entry : { ...entry, file })
  }
  return { items: collector.items, diagnostics: collector.diagnostics }
}

/** Reads a `hooks` object (the value of a settings file's `hooks` key, a plugin's `contributes.hooks`). */
export function readHooksConfig(value: unknown, options: { readonly source: HookSource, readonly file?: string }): ReadHooksResult {
  const file = typeof options?.file === 'string' && options.file !== '' ? options.file : undefined
  try {
    return readUnchecked(value, file)
  }
  catch {
    const entry: HookDiagnostic = { level: 'error', code: 'not-an-object', message: 'The hooks could not be read.' }
    return { items: [], diagnostics: [file === undefined ? entry : { ...entry, file }] }
  }
}

/** Reads a whole settings file: byte cap, `JSON.parse`, then only its `hooks` key (every other key is ignored). */
export function readSettingsHooks(text: string, options: { readonly file: string, readonly maxBytes?: number }): ReadHooksResult {
  const file = typeof options?.file === 'string' && options.file !== '' ? options.file : undefined
  const fail = (code: HookDiagnosticCode, message: string): ReadHooksResult => {
    const entry: HookDiagnostic = { level: 'error', code, message }
    return { items: [], diagnostics: [file === undefined ? entry : { ...entry, file }] }
  }
  const requested = options?.maxBytes
  const maxBytes = typeof requested === 'number' && !Number.isNaN(requested)
    ? Math.max(0, Math.min(Math.floor(requested), HOOK_LIMITS.configBytes))
    : HOOK_LIMITS.configBytes
  const source = typeof text === 'string' ? text : ''
  if (utf8LengthUpTo(source, maxBytes) > maxBytes)
    return fail('too-large', `The settings file is larger than ${formatBytes(maxBytes)}.`)
  let parsed: unknown
  try {
    parsed = JSON.parse(source.startsWith('\uFEFF') ? source.slice(1) : source)
  }
  catch {
    return fail('invalid-json', 'The settings file is not valid JSON.')
  }
  if (!isRecord(parsed))
    return fail('not-an-object', 'The settings file must hold a JSON object.')
  if (!Object.hasOwn(parsed, 'hooks'))
    return { items: [], diagnostics: [] }
  return readHooksConfig(parsed.hooks, { source: 'project', ...(file === undefined ? {} : { file }) })
}

// ---------------------------------------------------------------------------------------------------------------------
// Matchers

export type CompiledMatcher
  = | { readonly ok: true, readonly test: (name: string) => boolean }
    | { readonly ok: false, readonly reason: string }

/** One alternative: literal pieces between wildcards (`a*b` → `['a', 'b']`, `*` → `['', '']`). */
type Alternative = readonly string[]

/** Full-match of `name` against literal pieces separated by wildcards (linear backtracking on the last wildcard). */
function matchPieces(pieces: Alternative, name: string): boolean {
  if (pieces.length === 1)
    return name === pieces[0]
  const first = pieces[0] as string
  const last = pieces[pieces.length - 1] as string
  if (name.length < first.length + last.length || !name.startsWith(first) || !name.endsWith(last))
    return false
  let cursor = first.length
  const end = name.length - last.length
  for (let index = 1; index < pieces.length - 1; index++) {
    const piece = pieces[index] as string
    const found = name.indexOf(piece, cursor)
    if (found === -1 || found + piece.length > end)
      return false
    cursor = found + piece.length
  }
  return true
}

const MATCH_EVERYTHING: CompiledMatcher = { ok: true, test: () => true }
const MATCHER_FORBIDDEN = '^$[(+?\\{'
const MATCHER_ALLOWED = /^[\w.\- *|]*$/

/** Compiles a matcher of the safe subset (see the module comment). */
export function compileMatcher(matcher: string | null | undefined): CompiledMatcher {
  if (matcher === null || matcher === undefined)
    return MATCH_EVERYTHING
  if (typeof matcher !== 'string')
    return { ok: false, reason: 'The matcher must be text.' }
  const trimmed = matcher.trim()
  if (trimmed === '' || trimmed === '*')
    return MATCH_EVERYTHING
  if (trimmed.length > HOOK_LIMITS.matcherMaxChars)
    return { ok: false, reason: `The matcher is longer than ${HOOK_LIMITS.matcherMaxChars} characters.` }
  for (const char of trimmed) {
    if (MATCHER_FORBIDDEN.includes(char))
      return { ok: false, reason: 'The matcher uses regular-expression syntax; use tool names, "|" and "*" only.' }
  }
  if (!MATCHER_ALLOWED.test(trimmed))
    return { ok: false, reason: 'The matcher may use only letters, digits, "_", "-", ".", "*" and "|".' }
  const alternatives: Alternative[] = []
  for (const part of trimmed.split('|')) {
    const alternative = part.trim()
    if (alternative === '')
      continue
    if (alternative.includes(' '))
      return { ok: false, reason: 'A tool name in the matcher contains a blank.' }
    // `.*` and `*` are wildcards; every other `.` is literal.
    alternatives.push(alternative.replace(/\.\*/g, '*').split('*'))
  }
  if (alternatives.length === 0)
    return { ok: false, reason: 'The matcher has no tool name.' }
  if (alternatives.some(pieces => pieces.every(piece => piece === '')))
    return MATCH_EVERYTHING
  return {
    ok: true,
    test: (name: string) => typeof name === 'string' && alternatives.some(pieces => matchPieces(pieces, name)),
  }
}

/** Harness tool → Claude Code names (the reverse of `CLAUDE_TOOL_ALIASES`, plus the agent tools Claude Code names). */
const HOOK_TOOL_ALIASES: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>()
  for (const [claude, harness] of Object.entries(CLAUDE_TOOL_ALIASES)) {
    const list = map.get(harness) ?? []
    list.push(claude)
    map.set(harness, list)
  }
  for (const [harness, claude] of [['task', 'Task'], ['todo_write', 'TodoWrite'], ['exit_plan_mode', 'ExitPlanMode'], ['skill', 'Skill']] as const) {
    if (!map.has(harness))
      map.set(harness, [claude])
  }
  return map
})()

const MCP_PREFIX = 'mcp__'

/**
 * The names a tool is matched under: the harness name, its Claude Code aliases (`shell` → `Bash`, `edit_file` →
 * `Edit` and `MultiEdit`, `task` → `Task`, …) and, for an MCP tool of a project server, `mcp__<claudeName>__<tool>`.
 */
export function hookTargetNames(tool: string, options?: { readonly mcpServerName?: string }): string[] {
  if (typeof tool !== 'string' || tool === '')
    return []
  const names = [tool, ...(HOOK_TOOL_ALIASES.get(tool) ?? [])]
  const serverName = options?.mcpServerName
  if (typeof serverName === 'string' && serverName !== '' && tool.startsWith(MCP_PREFIX)) {
    const rest = tool.slice(MCP_PREFIX.length)
    const separator = rest.indexOf('__')
    if (separator > 0 && separator + 2 < rest.length)
      names.push(`${MCP_PREFIX}${serverName}__${rest.slice(separator + 2)}`)
  }
  return names.filter((name, index) => names.indexOf(name) === index)
}

/** The Claude Code name of a harness tool (`shell` → `Bash`), or null when there is none. */
export function claudeToolName(tool: string): string | null {
  if (typeof tool !== 'string')
    return null
  return HOOK_TOOL_ALIASES.get(tool)?.[0] ?? null
}

export type HookPermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions'

/** `ask` / `off` → `default`, `plan` → `plan`, `edits` → `acceptEdits`, `auto` → `bypassPermissions`. */
export function hookPermissionMode(toolMode: string): HookPermissionMode {
  switch (toolMode) {
    case 'plan':
      return 'plan'
    case 'edits':
      return 'acceptEdits'
    case 'auto':
      return 'bypassPermissions'
    default:
      return 'default'
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Payload

/** Everything the payload of one event may carry (fields that do not apply to the event are left out). */
export interface HookPayloadInput {
  readonly chatId: string
  readonly projectId: string | null
  readonly messageId?: string | null
  readonly modelRef: string
  /** `run.started.origin` of the run (`request`, `queue`, `task`, `hook`). */
  readonly origin: string
  /** The hook's working folder. */
  readonly cwd: string
  /** The harness tool mode (mapped by `hookPermissionMode`). */
  readonly toolMode: string
  readonly source: HookSource
  readonly tool?: { readonly name: string, readonly callId: string, readonly input: unknown, readonly output?: unknown }
  readonly prompt?: string
  readonly stopHookActive?: boolean
  readonly trigger?: 'manual' | 'auto'
  readonly customInstructions?: string | null
  readonly sessionSource?: 'startup' | 'compact'
  readonly message?: string
  readonly notificationType?: string
}

export interface HookPayload {
  /** The stdin JSON (Claude Code field names + a `harness` object). */
  readonly json: string
  /** True when `tool_response` or `tool_input` was cut to fit the cap. */
  readonly truncated: boolean
}

/** One top-level field of the payload: its key and its serialized value. */
interface PayloadField {
  readonly key: string
  value: string
  /** The raw value, for fields that may be cut. */
  readonly raw?: unknown
  /** What the field becomes when cutting its strings is not enough. */
  readonly empty?: string
}

/** Fields cut (in this order) when the payload is too large. */
const SHRINK_ORDER = ['tool_response', 'tool_input', 'prompt', 'custom_instructions', 'message'] as const

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** JSON of `value` with strings cut to `cap` UTF-16 units; `fallback` when it cannot be serialized. */
function serialize(value: unknown, cap: number | null, fallback: string): string {
  try {
    const json = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint')
        return item.toString()
      if (cap !== null && typeof item === 'string' && item.length > cap)
        return cutText(item, cap)
      return item
    })
    return typeof json === 'string' ? json : fallback
  }
  catch {
    return fallback
  }
}

function assemble(fields: readonly PayloadField[]): string {
  return `{${fields.map(field => `${JSON.stringify(field.key)}:${field.value}`).join(',')}}`
}

/**
 * Cuts the strings of one field (binary search on the longest string kept) so the payload fits; when even empty strings
 * do not fit, the field keeps empty strings (its structure) and false is returned, so the next field is cut too.
 */
function shrinkField(fields: PayloadField[], field: PayloadField, maxBytes: number): boolean {
  const empty = field.empty ?? 'null'
  const fixed = utf8Length(assemble(fields)) - utf8Length(field.value)
  const fits = (value: string): boolean => fixed + utf8LengthUpTo(value, maxBytes) <= maxBytes
  const bare = serialize(field.raw, 0, empty)
  if (!fits(bare)) {
    field.value = bare
    return false
  }
  let low = 0
  // The serialized length bounds the length of every string of the value.
  let high = field.value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(serialize(field.raw, middle, empty)))
      low = middle
    else
      high = middle - 1
  }
  field.value = serialize(field.raw, low, empty)
  return true
}

/** Builds the stdin payload of an event; never larger than `maxBytes` (default `HOOK_LIMITS.payloadBytes`). */
export function buildHookPayload(event: HookEvent, input: HookPayloadInput, options?: { readonly maxBytes?: number }): HookPayload {
  const requested = options?.maxBytes
  const maxBytes = typeof requested === 'number' && !Number.isNaN(requested) ? Math.max(0, Math.floor(requested)) : HOOK_LIMITS.payloadBytes
  try {
    return buildUnchecked(event, isRecord(input) ? input as unknown as HookPayloadInput : ({} as HookPayloadInput), maxBytes)
  }
  catch {
    return { json: '{}', truncated: true }
  }
}

function buildUnchecked(event: HookEvent, input: HookPayloadInput, maxBytes: number): HookPayload {
  const fields: PayloadField[] = []
  const add = (key: string, value: unknown, empty?: string): void => {
    fields.push(empty === undefined ? { key, value: serialize(value, null, 'null') } : { key, value: serialize(value, null, empty), raw: value, empty })
  }
  add('session_id', text(input.chatId))
  add('cwd', text(input.cwd))
  add('permission_mode', hookPermissionMode(text(input.toolMode)))
  add('hook_event_name', event)
  const tool = isRecord(input.tool) ? input.tool : null
  const toolName = tool === null ? '' : text(tool.name)
  switch (event) {
    case 'PreToolUse':
    case 'PostToolUse':
      if (tool !== null) {
        add('tool_name', claudeToolName(toolName) ?? toolName)
        add('tool_input', tool.input ?? {}, '{}')
        if (event === 'PostToolUse')
          add('tool_response', tool.output ?? null, 'null')
        add('tool_use_id', text(tool.callId))
      }
      break
    case 'UserPromptSubmit':
      add('prompt', text(input.prompt), '""')
      break
    case 'Notification':
      add('message', text(input.message), '""')
      if (typeof input.notificationType === 'string')
        add('notification_type', input.notificationType)
      break
    case 'Stop':
    case 'SubagentStop':
      add('stop_hook_active', input.stopHookActive === true)
      break
    case 'PreCompact':
      add('trigger', input.trigger === 'manual' ? 'manual' : 'auto')
      add('custom_instructions', text(input.customInstructions), '""')
      break
    case 'SessionStart':
      add('source', input.sessionSource === 'compact' ? 'compact' : 'startup')
      break
  }
  const harness: Record<string, unknown> = {
    version: 1,
    chatId: text(input.chatId),
    projectId: typeof input.projectId === 'string' ? input.projectId : null,
  }
  if (typeof input.messageId === 'string')
    harness.messageId = input.messageId
  harness.modelRef = text(input.modelRef)
  harness.origin = text(input.origin)
  if (tool !== null && (event === 'PreToolUse' || event === 'PostToolUse'))
    harness.tool = toolName
  harness.source = text(input.source)
  const harnessField: PayloadField = { key: 'harness', value: serialize(harness, null, '{}') }
  fields.push(harnessField)

  let json = assemble(fields)
  if (utf8LengthUpTo(json, maxBytes) <= maxBytes)
    return { json, truncated: false }

  // Too large: mark the payload, then cut the strings of the fields in order until it fits; when that is not enough,
  // the fields are replaced by empty values in the same order.
  harnessField.value = serialize({ ...harness, truncated: true }, null, '{}')
  const shrinkable = SHRINK_ORDER
    .map(key => fields.find(entry => entry.key === key))
    .filter((field): field is PayloadField => field !== undefined && Object.hasOwn(field, 'raw'))
  for (const field of shrinkable) {
    if (shrinkField(fields, field, maxBytes))
      return { json: assemble(fields), truncated: true }
  }
  for (const field of shrinkable) {
    field.value = field.empty ?? 'null'
    json = assemble(fields)
    if (utf8LengthUpTo(json, maxBytes) <= maxBytes)
      return { json, truncated: true }
  }
  const minimal = `{"hook_event_name":${JSON.stringify(event)},"harness":{"version":1,"truncated":true}}`
  return { json: utf8LengthUpTo(minimal, maxBytes) <= maxBytes ? minimal : '{}', truncated: true }
}

// ---------------------------------------------------------------------------------------------------------------------
// Output

/** What the runner observed of one hook run. */
export interface HookProcessResult {
  /** null when the process did not exit normally (killed, failed to start). */
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly stdout: string
  readonly stdoutTruncated: boolean
  readonly stderr: string
}

export type HookPermissionDecision = 'allow' | 'deny' | 'ask'

/** The reading of one hook process for one event. */
export interface HookOutcome {
  /** `ok` = exit 0; `blocked` = exit 2 or `decision: block` / `permissionDecision: deny`; `error` = anything else. */
  readonly status: 'ok' | 'blocked' | 'error'
  /** PreToolUse only. */
  readonly decision: HookPermissionDecision | null
  /** A block or decision reason (≤ `HOOK_LIMITS.reasonMaxChars`). */
  readonly reason: string | null
  /** Model-visible context (`additionalContext`, or plain stdout for UserPromptSubmit / SessionStart). */
  readonly context: string | null
  /** PreToolUse only; undefined = unchanged. */
  readonly updatedInput?: unknown
  /** false when the hook asked to stop (`continue: false`). */
  readonly continue: boolean
  readonly stopReason: string | null
  readonly systemMessage: string | null
  readonly suppressOutput: boolean
  /** A short description of a non-blocking error (exit code, timeout, invalid output); never the raw stderr. */
  readonly error: string | null
  readonly diagnostics: readonly HookDiagnostic[]
}

interface OutcomeDraft {
  status: HookOutcome['status']
  decision: HookPermissionDecision | null
  reason: string | null
  context: string | null
  updatedInput?: unknown
  continue: boolean
  stopReason: string | null
  systemMessage: string | null
  suppressOutput: boolean
  error: string | null
  diagnostics: HookDiagnostic[]
}

function finish(draft: OutcomeDraft): HookOutcome {
  const { updatedInput, ...rest } = draft
  return updatedInput === undefined ? rest : { ...rest, updatedInput }
}

const OUTPUT_KEYS: ReadonlySet<string> = new Set(['continue', 'stopReason', 'systemMessage', 'suppressOutput', 'decision', 'reason', 'hookSpecificOutput'])

/** Reads the `hookSpecificOutput` object of a JSON output. */
function readSpecific(event: HookEvent, specific: unknown, draft: OutcomeDraft, note: (level: HookDiagnostic['level'], code: HookDiagnosticCode, message: string) => void): {
  permissionDecision?: HookPermissionDecision
  permissionReason?: string | null
  updatedInput?: unknown
} {
  if (!isRecord(specific)) {
    note('warning', 'invalid-output', 'hookSpecificOutput must be an object; it was ignored.')
    return {}
  }
  if (specific.hookEventName !== event) {
    note('warning', 'invalid-output', `hookSpecificOutput.hookEventName must be "${event}"; it was ignored.`)
    return {}
  }
  const result: { permissionDecision?: HookPermissionDecision, permissionReason?: string | null, updatedInput?: unknown } = {}
  for (const key of Object.keys(specific)) {
    const value = specific[key]
    if (key === 'hookEventName')
      continue
    if (event === 'PreToolUse' && key === 'permissionDecision') {
      if (value === 'allow' || value === 'deny' || value === 'ask')
        result.permissionDecision = value
      else
        note('warning', 'invalid-output', 'permissionDecision must be "allow", "deny" or "ask"; it was ignored.')
      continue
    }
    if (event === 'PreToolUse' && key === 'permissionDecisionReason') {
      if (typeof value === 'string')
        result.permissionReason = cappedText(value, HOOK_LIMITS.reasonMaxChars)
      else
        note('warning', 'invalid-output', 'permissionDecisionReason must be text; it was ignored.')
      continue
    }
    if (event === 'PreToolUse' && key === 'updatedInput') {
      if (!isRecord(value)) {
        note('warning', 'invalid-output', 'updatedInput must be an object; it was ignored.')
        continue
      }
      const json = stableStringify(value)
      if (json === null || utf8LengthUpTo(json, HOOK_LIMITS.updatedInputBytes) > HOOK_LIMITS.updatedInputBytes) {
        note('warning', 'too-large', `updatedInput is larger than ${formatBytes(HOOK_LIMITS.updatedInputBytes)}; it was ignored.`)
        continue
      }
      result.updatedInput = JSON.parse(json) as unknown
      continue
    }
    if (CONTEXT_EVENTS.has(event) && key === 'additionalContext') {
      if (typeof value === 'string')
        draft.context = cappedText(value, HOOK_LIMITS.contextMaxChars)
      else
        note('warning', 'invalid-output', 'additionalContext must be text; it was ignored.')
      continue
    }
    note('info', 'ignored-field', `hookSpecificOutput.${shownKey(key)} is not used for ${event} hooks.`)
  }
  return result
}

function readJsonOutput(event: HookEvent, output: Record<string, unknown>, draft: OutcomeDraft, note: (level: HookDiagnostic['level'], code: HookDiagnosticCode, message: string) => void): void {
  for (const key of Object.keys(output)) {
    if (!OUTPUT_KEYS.has(key))
      note('info', 'ignored-field', `The output field "${shownKey(key)}" is not used.`)
  }
  if (output.continue !== undefined) {
    if (typeof output.continue !== 'boolean') {
      note('warning', 'invalid-output', '"continue" must be true or false; it was ignored.')
    }
    else if (!output.continue) {
      if (STOPPABLE_EVENTS.has(event)) {
        draft.continue = false
        if (output.stopReason !== undefined && typeof output.stopReason !== 'string')
          note('warning', 'invalid-output', '"stopReason" must be text; it was ignored.')
        draft.stopReason = cappedText(output.stopReason, HOOK_LIMITS.reasonMaxChars)
      }
      else {
        note('info', 'ignored-field', `${event} hooks cannot stop the agent; "continue: false" was ignored.`)
      }
    }
  }
  if (output.systemMessage !== undefined) {
    if (typeof output.systemMessage === 'string')
      draft.systemMessage = cappedText(output.systemMessage, HOOK_LIMITS.systemMessageMaxChars)
    else
      note('warning', 'invalid-output', '"systemMessage" must be text; it was ignored.')
  }
  if (output.suppressOutput !== undefined) {
    if (typeof output.suppressOutput === 'boolean')
      draft.suppressOutput = output.suppressOutput
    else
      note('warning', 'invalid-output', '"suppressOutput" must be true or false; it was ignored.')
  }
  if (output.reason !== undefined && typeof output.reason !== 'string')
    note('warning', 'invalid-output', '"reason" must be text; it was ignored.')
  const reason = cappedText(output.reason, HOOK_LIMITS.reasonMaxChars)

  let legacy: 'block' | 'approve' | null = null
  if (output.decision !== undefined && output.decision !== null) {
    if (output.decision === 'block' && BLOCKING_EVENTS.has(event))
      legacy = 'block'
    else if (output.decision === 'approve' && event === 'PreToolUse')
      legacy = 'approve'
    else if (output.decision === 'block' || output.decision === 'approve')
      note('info', 'ignored-field', `"decision: ${output.decision}" is not used for ${event} hooks.`)
    else
      note('warning', 'invalid-output', '"decision" must be "block" (or "approve" for PreToolUse); it was ignored.')
  }

  const specific = output.hookSpecificOutput === undefined || output.hookSpecificOutput === null
    ? {}
    : readSpecific(event, output.hookSpecificOutput, draft, note)

  if (event === 'PreToolUse') {
    const decision: HookPermissionDecision | null = specific.permissionDecision ?? (legacy === 'block' ? 'deny' : legacy === 'approve' ? 'allow' : null)
    draft.decision = decision
    if (decision !== null)
      draft.reason = specific.permissionReason ?? reason
    if (decision === 'deny')
      draft.status = 'blocked'
    if (specific.updatedInput !== undefined) {
      if (decision === 'deny')
        note('info', 'ignored-field', 'updatedInput is not used when the hook denies the tool call.')
      else
        draft.updatedInput = specific.updatedInput
    }
    return
  }
  if (legacy === 'block') {
    draft.status = 'blocked'
    draft.reason = reason
    if (reason === null && (event === 'Stop' || event === 'SubagentStop'))
      note('warning', 'invalid-output', 'A block decision of a Stop hook needs a reason that tells the agent how to continue.')
  }
}

/** Reads the exit code and outputs of one hook process for an event. */
export function readHookOutput(event: HookEvent, result: HookProcessResult): HookOutcome {
  const draft: OutcomeDraft = {
    status: 'ok',
    decision: null,
    reason: null,
    context: null,
    continue: true,
    stopReason: null,
    systemMessage: null,
    suppressOutput: false,
    error: null,
    diagnostics: [],
  }
  if (!isHookEvent(event)) {
    draft.status = 'error'
    draft.error = 'The hook event is unknown.'
    draft.diagnostics.push({ level: 'error', code: 'unknown-event', message: 'The hook event is unknown.' })
    return finish(draft)
  }
  const note = (level: HookDiagnostic['level'], code: HookDiagnosticCode, message: string): void => {
    if (draft.diagnostics.length < DIAGNOSTICS_MAX)
      draft.diagnostics.push({ level, code, message, event })
  }
  try {
    const run: Partial<HookProcessResult> = isRecord(result) ? result : {}
    const stdout = typeof run.stdout === 'string' ? run.stdout : ''
    const stderr = typeof run.stderr === 'string' ? run.stderr : ''
    const exitCode = typeof run.exitCode === 'number' && Number.isFinite(run.exitCode) ? run.exitCode : null
    if (run.timedOut === true) {
      draft.status = 'error'
      draft.error = 'The hook timed out.'
      return finish(draft)
    }
    if (exitCode === null) {
      draft.status = 'error'
      draft.error = 'The hook did not exit normally.'
      return finish(draft)
    }
    if (exitCode === 2) {
      draft.reason = cappedText(stderr, HOOK_LIMITS.reasonMaxChars)
      if (BLOCKING_EVENTS.has(event)) {
        draft.status = 'blocked'
        if (event === 'PreToolUse')
          draft.decision = 'deny'
      }
      else {
        draft.status = 'error'
        draft.error = `The hook exited with code 2, but ${event} hooks cannot block.`
      }
      return finish(draft)
    }
    if (exitCode !== 0) {
      draft.status = 'error'
      draft.error = `The hook failed with exit code ${exitCode}.`
      return finish(draft)
    }
    const trimmed = stdout.trim()
    if (run.stdoutTruncated === true)
      note('info', 'too-large', 'The output was cut to the size limit.')
    if (trimmed.startsWith('{')) {
      let parsed: unknown
      let valid = true
      try {
        parsed = JSON.parse(trimmed)
      }
      catch {
        valid = false
      }
      if (valid && isRecord(parsed)) {
        readJsonOutput(event, parsed, draft, note)
        return finish(draft)
      }
      note('warning', 'invalid-output', 'The output starts like JSON but is not a valid JSON object; it was read as text.')
    }
    if (PLAIN_CONTEXT_EVENTS.has(event))
      draft.context = cappedText(trimmed, HOOK_LIMITS.contextMaxChars)
    return finish(draft)
  }
  catch {
    draft.status = 'error'
    draft.error = 'The hook output could not be read.'
    return finish(draft)
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Combination

export interface SourcedHookOutcome {
  readonly source: HookSource
  readonly outcome: HookOutcome
}

export interface CombinedHookOutcome {
  /** deny > ask > allow; null = no hook decided. */
  readonly decision: HookPermissionDecision | null
  readonly reason: string | null
  readonly context: string | null
  /** The first `updatedInput` in source order (personal, plugin, project); undefined = unchanged. */
  readonly updatedInput?: unknown
  /** True when any hook blocked. */
  readonly block: boolean
  /** AND of every hook's `continue`. */
  readonly continue: boolean
  readonly stopReason: string | null
  readonly systemMessages: readonly string[]
  readonly diagnostics: readonly HookDiagnostic[]
}

function joinCapped(values: readonly (string | null)[], separator: string, max: number): string | null {
  const unique: string[] = []
  for (const value of values) {
    if (typeof value === 'string' && value !== '' && !unique.includes(value))
      unique.push(value)
  }
  return unique.length === 0 ? null : cutText(unique.join(separator), max)
}

/**
 * Combines the outcomes of every hook that ran for one event (contexts and reasons joined and capped). Outcomes are
 * taken in source order (personal, plugin, project; stable inside a source). `reason` joins the reasons of the blocking
 * outcomes when any blocked, else those of the winning decision, else every reason (exit 2 of an event that cannot
 * block); `updatedInput` is dropped when the call is denied or blocked; `stopReason` is the first one of an outcome
 * that stopped.
 */
export function combineHookOutcomes(event: HookEvent, outcomes: readonly SourcedHookOutcome[]): CombinedHookOutcome {
  const list = (Array.isArray(outcomes) ? outcomes : [])
    .map((entry: unknown, index) => ({ entry, index }))
    .filter((item): item is { entry: SourcedHookOutcome, index: number } => isRecord(item.entry) && isRecord((item.entry as { outcome?: unknown }).outcome))
    .sort((a, b) => ((SOURCE_ORDER[a.entry.source] ?? 3) - (SOURCE_ORDER[b.entry.source] ?? 3)) || a.index - b.index)
    .map(item => item.entry.outcome)
  const decisions = list.map(outcome => outcome.decision)
  const decision: HookPermissionDecision | null = decisions.includes('deny') ? 'deny' : decisions.includes('ask') ? 'ask' : decisions.includes('allow') ? 'allow' : null
  const block = list.some(outcome => outcome.status === 'blocked')
  const reasonSource = block
    ? list.filter(outcome => outcome.status === 'blocked')
    : decision !== null
      ? list.filter(outcome => outcome.decision === decision)
      : list
  const diagnostics: HookDiagnostic[] = list.flatMap(outcome => Array.isArray(outcome.diagnostics) ? outcome.diagnostics : [])
  let updatedInput: unknown
  if (!block && decision !== 'deny') {
    let chosen: string | null = null
    let conflict = false
    for (const outcome of list) {
      if (outcome.updatedInput === undefined)
        continue
      const json = stableStringify(outcome.updatedInput)
      if (chosen === null) {
        chosen = json
        updatedInput = outcome.updatedInput
      }
      else if (json !== chosen) {
        conflict = true
      }
    }
    if (conflict) {
      const known = isHookEvent(event) ? { event } : {}
      diagnostics.push({ level: 'warning', code: 'conflict', message: 'Several hooks changed the tool input differently; the first one in source order (personal, plugin, project) was used.', ...known })
    }
  }
  const stopping = list.filter(outcome => outcome.continue === false)
  const combined: CombinedHookOutcome = {
    decision,
    reason: joinCapped(reasonSource.map(outcome => outcome.reason), '\n', HOOK_LIMITS.reasonMaxChars),
    context: joinCapped(list.map(outcome => outcome.context), '\n\n', HOOK_LIMITS.contextMaxChars),
    block,
    continue: stopping.length === 0,
    stopReason: stopping.map(outcome => outcome.stopReason).find((value): value is string => typeof value === 'string' && value !== '') ?? null,
    systemMessages: list.map(outcome => outcome.systemMessage).filter((value): value is string => typeof value === 'string' && value !== ''),
    diagnostics,
  }
  return updatedInput === undefined ? combined : { ...combined, updatedInput }
}
