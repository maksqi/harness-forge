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
 *
 * Phase 12 (ADR-057, C42): five more events (`PostToolUseFailure`, `PermissionRequest`, `SubagentStart`, `PostCompact`,
 * `SessionEnd`; 13 in all), prompt handlers (`type: 'prompt'`, read only with `{ prompts: true }` into
 * `ReadHooksResult.prompts`; the model answer is read by `readPromptHookAnswer` and mapped by `promptHookOutcome`, which
 * never allows anything), the command handler fields `args` (exec form, `execFormCommand`), `async`, `if`
 * (`matchHookIf`) and `statusMessage`, the payload fields `transcript_path`, `error`, `agent_id` / `agent_type` and
 * `reason`, and per event:
 * - PostToolUseFailure: like PostToolUse (exit 2 / `decision: block` → `blocked`, the reason is fed back;
 *   `additionalContext`).
 * - PermissionRequest: `hookSpecificOutput.decision.{ behavior: 'allow' | 'deny', updatedInput?, message?, interrupt? }`
 *   → decision `allow` (with `updatedInput`) or `deny` (`blocked`, `message` as the reason, `interrupt: true` stops);
 *   exit 2 is a non-blocking error (not honored).
 * - SubagentStart: `additionalContext` (for the child's first message); observe only otherwise.
 * - PostCompact / SessionEnd: observe only (like PreCompact).
 * Handler types `http`, `mcp_tool` and `agent` are `unsupported-type` warnings; unknown events stay `unknown-event`
 * infos; neither ever invalidates a source.
 */
import { safeParseModelRef } from '../ids.ts'
import { parseClaudePermissionRule } from './claude-permissions.ts'
import { claudeModelAlias } from './definitions.ts'
import { parseShellCommand } from './shell-command.ts'
import { CLAUDE_AGENT_TOOL_ALIASES, CLAUDE_TOOL_ALIASES, claudeAgentTypeNames, matchToolAllowlist } from './tool-names.ts'

export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'SessionStart',
  // Phase 12 (ADR-057).
  'PostToolUseFailure',
  'PermissionRequest',
  'SubagentStart',
  'PostCompact',
  'SessionEnd',
] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

/**
 * Events whose matcher is matched against tool names (the other events ignore the matcher, except as noted); the
 * handler field `if` is read only for these.
 */
export const TOOL_HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'] as const

/** Events that accept prompt handlers (`type: 'prompt'`; Claude Code parity, ADR-057). */
export const PROMPT_HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'PermissionRequest'] as const

export type HookMatcherSubject = 'tool' | 'source' | 'trigger' | 'notification' | 'agent' | 'reason'

/**
 * What the matcher of an event is tested against (Claude Code parity): tool names (`hookTargetNames`), the
 * SessionStart `source` (`startup` / `compact`), the PreCompact / PostCompact `trigger` (`manual` / `auto`), the
 * Notification type (`permission_prompt`), the agent type of SubagentStart / SubagentStop (`hookAgentNames`, Claude
 * Code names included), the SessionEnd `reason` (`other`); null = the matcher is ignored (the hook always runs).
 */
export const HOOK_MATCHER_SUBJECTS: Readonly<Record<HookEvent, HookMatcherSubject | null>> = {
  PreToolUse: 'tool',
  PostToolUse: 'tool',
  UserPromptSubmit: null,
  Notification: 'notification',
  Stop: null,
  SubagentStop: 'agent',
  PreCompact: 'trigger',
  SessionStart: 'source',
  PostToolUseFailure: 'tool',
  PermissionRequest: 'tool',
  SubagentStart: 'agent',
  PostCompact: 'trigger',
  SessionEnd: 'reason',
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
  // Phase 12 (ADR-057).
  /** Entries of an exec-form `args` list (the command and every argument together stay ≤ `commandMaxChars`). */
  argsMax: 64,
  /** A prompt hook's prompt (= `LIMITS.promptHookPromptMaxChars`). */
  promptMaxChars: 16_384,
  /** Default timeout of a prompt hook, in seconds (= `LIMITS.promptHookTimeoutDefaultMs` / 1000). */
  promptTimeoutDefaultSec: 30,
  /** A handler's `statusMessage` (the activity label). */
  statusMessageMaxChars: 200,
  /** A handler's `if` rule. */
  ifMaxChars: 512,
  /** The PostToolUseFailure `error` of the payload. */
  errorMaxChars: 16_384,
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
  // Phase 12 (ADR-057).
  'invalid-prompt',
  'invalid-if',
  'invalid-model',
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

/** One command hook handler of a configuration. The Phase 12 fields are present only when the handler sets them. */
export interface HookSpec {
  readonly event: HookEvent
  /** null = every target. */
  readonly matcher: string | null
  /** The shell command; with `args`, the program of the exec form. */
  readonly command: string
  /** Seconds; null = `HOOK_LIMITS.timeoutDefaultSec`. */
  readonly timeoutSec: number | null
  readonly position: readonly [number, number]
  readonly file?: string
  /** Exec form (Phase 12): each entry one literal argument of `command` (no shell parsing; see `execFormCommand`). */
  readonly args?: readonly string[]
  /** `async: true` (or `asyncRewake: true`) (Phase 12): runs detached and tracked; its output has no effect. */
  readonly async?: boolean
  /** The `if` rule (Phase 12, tool events only): a tool name or `Bash(prefix…)`, tested with `matchHookIf`. */
  readonly if?: string
  /** The activity label while the hook runs (Phase 12; ≤ `HOOK_LIMITS.statusMessageMaxChars`). */
  readonly statusMessage?: string
}

/** One prompt hook handler (`type: 'prompt'`, Phase 12, ADR-057), read only with `{ prompts: true }`. */
export interface PromptHookSpec {
  /** One of `PROMPT_HOOK_EVENTS`. */
  readonly event: HookEvent
  /** null = every target. */
  readonly matcher: string | null
  /** The prompt as written (trimmed; ≤ `HOOK_LIMITS.promptMaxChars`); `$ARGUMENTS` is the payload (`expandHookPrompt`). */
  readonly prompt: string
  /** `provider:model`, or a Claude model name (`sonnet`, `claude-…`; lowercased, `[1m]` dropped); null = the hook model. */
  readonly model: string | null
  /** Seconds; null = `HOOK_LIMITS.promptTimeoutDefaultSec`. */
  readonly timeoutSec: number | null
  /** `continueOnBlock` (default false): a PreToolUse / PostToolUse "no" is fed back instead of ending the turn. */
  readonly continueOnBlock: boolean
  readonly position: readonly [number, number]
  readonly file?: string
  /** The `if` rule (tool events only), as for command hooks. */
  readonly if?: string
  /** The activity label while the hook runs. */
  readonly statusMessage?: string
}

export interface ReadHooksResult {
  readonly items: readonly HookSpec[]
  /** Prompt handlers (Phase 12): always present; empty unless the reading was asked for them (`prompts: true`). */
  readonly prompts: readonly PromptHookSpec[]
  readonly diagnostics: readonly HookDiagnostic[]
}

export interface ReadHooksOptions {
  readonly source: HookSource
  /** Project-relative settings file, for diagnostics and specs. */
  readonly file?: string
  /** Read prompt handlers into `prompts` (Phase 12); without it a prompt handler is an `unsupported-type` warning. */
  readonly prompts?: boolean
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
const BLOCKING_EVENTS: ReadonlySet<HookEvent> = new Set(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'PostToolUseFailure'])
/** Events whose plain stdout (exit 0, not JSON) is model-visible context. */
const PLAIN_CONTEXT_EVENTS: ReadonlySet<HookEvent> = new Set(['UserPromptSubmit', 'SessionStart'])
/** Events that read `hookSpecificOutput.additionalContext`. */
const CONTEXT_EVENTS: ReadonlySet<HookEvent> = new Set(['PostToolUse', 'UserPromptSubmit', 'SessionStart', 'PostToolUseFailure', 'SubagentStart'])
/** Events that can stop the agent with `continue: false`. */
const STOPPABLE_EVENTS: ReadonlySet<HookEvent> = new Set(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'SessionStart', 'PostToolUseFailure', 'PermissionRequest'])
/** Events whose payload describes a tool call (`tool_name`, `tool_input`, `tool_use_id`). */
const TOOL_EVENTS: ReadonlySet<HookEvent> = new Set(TOOL_HOOK_EVENTS)
const PROMPT_EVENTS: ReadonlySet<HookEvent> = new Set(PROMPT_HOOK_EVENTS)
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
  readonly prompts: PromptHookSpec[]
  readonly diagnostics: HookDiagnostic[]
  readonly file: string | undefined
  /** Prompt handlers are read (`ReadHooksOptions.prompts`). */
  readonly readPrompts: boolean
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

/** Keys of a command handler (Claude Code's; `asyncRewake`, `once` and `shell` are read for their diagnostics). */
const COMMAND_HANDLER_KEYS: ReadonlySet<string> = new Set(['type', 'command', 'timeout', 'args', 'async', 'asyncRewake', 'if', 'statusMessage', 'once', 'shell'])
/** Keys of a prompt handler. */
const PROMPT_HANDLER_KEYS: ReadonlySet<string> = new Set(['type', 'prompt', 'model', 'timeout', 'continueOnBlock', 'if', 'statusMessage', 'once'])
const GROUP_KEYS: ReadonlySet<string> = new Set(['matcher', 'hooks'])
/** Handler types Claude Code has and the harness does not run (an `unsupported-type` warning each). */
const UNSUPPORTED_TYPE_MESSAGES: Readonly<Record<string, string>> = {
  http: 'HTTP hooks are not supported; this hook never runs.',
  mcp_tool: 'MCP tool hooks are not supported; this hook never runs.',
  agent: 'Agent hooks are not supported; this hook never runs.',
}
/** A `${user_config.…}` reference, which shell-form hooks may not use (Claude Code refuses it too). */
const USER_CONFIG_REFERENCE = /\$\{user_config\./

/** Whether the handler holds more hooks than the configuration may keep (reported once). */
function isFull(collector: Collector, event: HookEvent, position: [number, number]): boolean {
  if (collector.items.length + collector.prompts.length < HOOK_LIMITS.itemsMax)
    return false
  if (!collector.overflow) {
    collector.overflow = true
    report(collector, { level: 'warning', code: 'too-many', message: `Only the first ${HOOK_LIMITS.itemsMax} hooks are used.`, event, position })
  }
  return true
}

function reportIgnoredKeys(collector: Collector, event: HookEvent, handler: Record<string, unknown>, known: ReadonlySet<string>, position: [number, number]): void {
  for (const key of Object.keys(handler)) {
    if (!known.has(key))
      report(collector, { level: 'info', code: 'ignored-field', message: `The field "${shownKey(key)}" is ignored.`, event, position })
  }
  if (Object.hasOwn(handler, 'once'))
    report(collector, { level: 'info', code: 'ignored-field', message: '"once" is used only by skill hooks; it is ignored.', event, position })
}

/** The `if` rule of a handler: null (none, or ignored outside tool events), the rule, or false (invalid, reported). */
function readIf(collector: Collector, event: HookEvent, value: unknown, position: [number, number]): string | null | false {
  if (value === undefined || value === null)
    return null
  if (typeof value !== 'string') {
    report(collector, { level: 'error', code: 'invalid-if', message: 'The "if" rule must be text; this hook never runs.', event, position })
    return false
  }
  const rule = value.trim()
  if (rule === '')
    return null
  if (!TOOL_EVENTS.has(event)) {
    report(collector, { level: 'info', code: 'ignored-field', message: `"if" is used only by tool events; it is ignored for ${event} hooks.`, event, position })
    return null
  }
  const reason = checkHookIf(rule)
  if (reason !== null) {
    report(collector, { level: 'error', code: 'invalid-if', message: `${reason} This hook never runs.`, event, position })
    return false
  }
  return rule
}

/** The `statusMessage` of a handler (control characters removed, blanks collapsed, capped), or null. */
function readStatusMessage(collector: Collector, event: HookEvent, value: unknown, position: [number, number]): string | null {
  if (value === undefined || value === null)
    return null
  if (typeof value !== 'string') {
    report(collector, { level: 'warning', code: 'ignored-field', message: '"statusMessage" must be text; it is ignored.', event, position })
    return null
  }
  const text = value.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim()
  return text === '' ? null : cutText(text, HOOK_LIMITS.statusMessageMaxChars)
}

/** The exec-form `args` of a command handler: undefined (shell form), the list, or false (invalid, reported). */
function readArgs(collector: Collector, event: HookEvent, command: string, value: unknown, position: [number, number]): string[] | undefined | false {
  if (value === undefined || value === null)
    return undefined
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    report(collector, { level: 'error', code: 'invalid-command', message: '"args" must be a list of texts.', event, position })
    return false
  }
  const args = value as string[]
  if (args.length > HOOK_LIMITS.argsMax) {
    report(collector, { level: 'error', code: 'too-long', message: `The hook has more than ${HOOK_LIMITS.argsMax} arguments.`, event, position })
    return false
  }
  if (args.some(entry => entry.includes('\0'))) {
    report(collector, { level: 'error', code: 'invalid-command', message: 'An argument contains a NUL character.', event, position })
    return false
  }
  const length = args.reduce((total, entry) => total + entry.length, command.length)
  if (length > HOOK_LIMITS.commandMaxChars) {
    report(collector, { level: 'error', code: 'too-long', message: `The command and its arguments are longer than ${HOOK_LIMITS.commandMaxChars} characters.`, event, position })
    return false
  }
  return [...args]
}

function readCommandHandler(collector: Collector, event: HookEvent, handler: Record<string, unknown>, matcher: string | null, position: [number, number]): void {
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
  if (handler.shell !== undefined && handler.shell !== null && handler.shell !== 'bash') {
    const message = handler.shell === 'powershell' ? 'PowerShell hooks are not supported; this hook never runs.' : 'The shell must be "bash"; this hook never runs.'
    report(collector, { level: 'error', code: 'invalid-command', message, event, position })
    return
  }
  const args = readArgs(collector, event, trimmed, handler.args, position)
  if (args === false)
    return
  if (args === undefined && USER_CONFIG_REFERENCE.test(trimmed)) {
    report(collector, { level: 'error', code: 'invalid-command', message: 'Shell-form hooks cannot use user_config variables; use "args" (exec form). This hook never runs.', event, position })
    return
  }
  const timeoutSec = readTimeout(collector, event, handler.timeout, position)
  let async = false
  if (handler.async !== undefined && handler.async !== null) {
    if (typeof handler.async === 'boolean')
      async = handler.async
    else
      report(collector, { level: 'warning', code: 'ignored-field', message: '"async" must be true or false; it is ignored.', event, position })
  }
  if (handler.asyncRewake !== undefined && handler.asyncRewake !== null) {
    if (handler.asyncRewake === true)
      async = true
    report(collector, { level: 'info', code: 'ignored-field', message: '"asyncRewake" is not supported; the hook runs in the background like "async".', event, position })
  }
  const rule = readIf(collector, event, handler.if, position)
  if (rule === false)
    return
  const statusMessage = readStatusMessage(collector, event, handler.statusMessage, position)
  reportIgnoredKeys(collector, event, handler, COMMAND_HANDLER_KEYS, position)
  if (isFull(collector, event, position))
    return
  collector.items.push({
    event,
    matcher,
    command: trimmed,
    timeoutSec,
    position,
    ...(collector.file === undefined ? {} : { file: collector.file }),
    ...(args === undefined ? {} : { args }),
    ...(async ? { async: true } : {}),
    ...(rule === null ? {} : { if: rule }),
    ...(statusMessage === null ? {} : { statusMessage }),
  })
}

/** The `model` of a prompt handler: a `provider:model` ref or a Claude model name (normalized), else null. */
function readPromptModel(collector: Collector, event: HookEvent, value: unknown, position: [number, number]): string | null {
  if (value === undefined || value === null)
    return null
  const text = typeof value === 'string' ? value.trim() : null
  if (text === '')
    return null
  if (text !== null && text.length <= 256) {
    if (text.includes(':') && !/\s/.test(text) && safeParseModelRef(text) !== null)
      return text
    const alias = claudeModelAlias(text)
    if (alias !== null)
      return alias
  }
  report(collector, { level: 'warning', code: 'invalid-model', message: 'The model must be "provider:model" or a Claude model name; the hook model is used.', event, position })
  return null
}

function readPromptHandler(collector: Collector, event: HookEvent, handler: Record<string, unknown>, matcher: string | null, position: [number, number]): void {
  if (!collector.readPrompts) {
    report(collector, { level: 'warning', code: 'unsupported-type', message: 'Prompt hooks are not supported here; only command hooks run.', event, position })
    return
  }
  if (!PROMPT_EVENTS.has(event)) {
    report(collector, { level: 'warning', code: 'unsupported-type', message: `Prompt hooks do not run for ${event} hooks; use a command hook.`, event, position })
    return
  }
  const prompt = handler.prompt
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    report(collector, { level: 'error', code: 'invalid-prompt', message: 'The prompt must be non-empty text.', event, position })
    return
  }
  if (prompt.includes('\0')) {
    report(collector, { level: 'error', code: 'invalid-prompt', message: 'The prompt contains a NUL character.', event, position })
    return
  }
  const trimmed = prompt.trim()
  if (trimmed.length > HOOK_LIMITS.promptMaxChars) {
    report(collector, { level: 'error', code: 'too-long', message: `The prompt is longer than ${HOOK_LIMITS.promptMaxChars} characters.`, event, position })
    return
  }
  const model = readPromptModel(collector, event, handler.model, position)
  const timeoutSec = readTimeout(collector, event, handler.timeout, position)
  let continueOnBlock = false
  if (handler.continueOnBlock !== undefined && handler.continueOnBlock !== null) {
    if (typeof handler.continueOnBlock === 'boolean')
      continueOnBlock = handler.continueOnBlock
    else
      report(collector, { level: 'warning', code: 'invalid-prompt', message: '"continueOnBlock" must be true or false; false is used.', event, position })
  }
  const rule = readIf(collector, event, handler.if, position)
  if (rule === false)
    return
  const statusMessage = readStatusMessage(collector, event, handler.statusMessage, position)
  reportIgnoredKeys(collector, event, handler, PROMPT_HANDLER_KEYS, position)
  if (isFull(collector, event, position))
    return
  collector.prompts.push({
    event,
    matcher,
    prompt: trimmed,
    model,
    timeoutSec,
    continueOnBlock,
    position,
    ...(collector.file === undefined ? {} : { file: collector.file }),
    ...(rule === null ? {} : { if: rule }),
    ...(statusMessage === null ? {} : { statusMessage }),
  })
}

function readHandler(collector: Collector, event: HookEvent, handler: unknown, matcher: string | null, position: [number, number]): void {
  if (!isRecord(handler)) {
    report(collector, { level: 'error', code: 'not-an-object', message: 'A hook must be an object with a type and a command.', event, position })
    return
  }
  if (handler.type === 'command') {
    readCommandHandler(collector, event, handler, matcher, position)
    return
  }
  if (handler.type === 'prompt') {
    readPromptHandler(collector, event, handler, matcher, position)
    return
  }
  const message = typeof handler.type === 'string' && Object.hasOwn(UNSUPPORTED_TYPE_MESSAGES, handler.type)
    ? UNSUPPORTED_TYPE_MESSAGES[handler.type] as string
    : 'The hook type is not supported; use "command".'
  report(collector, { level: 'warning', code: 'unsupported-type', message, event, position })
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

function readUnchecked(value: unknown, file: string | undefined, readPrompts: boolean): ReadHooksResult {
  const collector: Collector = { items: [], prompts: [], diagnostics: [], file, readPrompts, dropped: 0, overflow: false }
  if (value === undefined || value === null)
    return { items: [], prompts: [], diagnostics: [] }
  if (!isRecord(value)) {
    report(collector, { level: 'error', code: 'not-an-object', message: 'The hooks must be an object keyed by event name.' })
    return { items: [], prompts: [], diagnostics: collector.diagnostics }
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
  return { items: collector.items, prompts: collector.prompts, diagnostics: collector.diagnostics }
}

/**
 * Reads a `hooks` object (the value of a settings file's `hooks` key, a plugin's `contributes.hooks`, a Claude plugin's
 * `hooks/hooks.json` `hooks`). Prompt handlers are read into `prompts` only with `prompts: true` (Phase 12).
 */
export function readHooksConfig(value: unknown, options: ReadHooksOptions): ReadHooksResult {
  const file = typeof options?.file === 'string' && options.file !== '' ? options.file : undefined
  try {
    return readUnchecked(value, file, options?.prompts === true)
  }
  catch {
    const entry: HookDiagnostic = { level: 'error', code: 'not-an-object', message: 'The hooks could not be read.' }
    return { items: [], prompts: [], diagnostics: [file === undefined ? entry : { ...entry, file }] }
  }
}

/**
 * Reads a whole settings file: byte cap, `JSON.parse`, then only its `hooks` key (every other key is ignored). Prompt
 * handlers are read only with `prompts: true` (Phase 12).
 */
export function readSettingsHooks(text: string, options: { readonly file: string, readonly maxBytes?: number, readonly prompts?: boolean }): ReadHooksResult {
  const file = typeof options?.file === 'string' && options.file !== '' ? options.file : undefined
  const fail = (code: HookDiagnosticCode, message: string): ReadHooksResult => {
    const entry: HookDiagnostic = { level: 'error', code, message }
    return { items: [], prompts: [], diagnostics: [file === undefined ? entry : { ...entry, file }] }
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
    return { items: [], prompts: [], diagnostics: [] }
  return readHooksConfig(parsed.hooks, { source: 'project', prompts: options?.prompts === true, ...(file === undefined ? {} : { file }) })
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

/**
 * Harness tool → Claude Code names (the reverse of `CLAUDE_TOOL_ALIASES`, then of `CLAUDE_AGENT_TOOL_ALIASES`: `task` is
 * `Task` and, since Claude Code renamed it, `Agent`).
 */
const HOOK_TOOL_ALIASES: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>()
  for (const aliases of [CLAUDE_TOOL_ALIASES, CLAUDE_AGENT_TOOL_ALIASES]) {
    for (const [claude, harness] of Object.entries(aliases)) {
      const list = map.get(harness) ?? []
      if (!list.includes(claude))
        list.push(claude)
      map.set(harness, list)
    }
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

/**
 * The names an agent type is matched under by SubagentStart / SubagentStop matchers (Phase 12): the harness type and
 * its Claude Code names (`general` → `general`, `general-purpose`; `explore` → `explore`, `Explore`).
 */
export function hookAgentNames(type: string): string[] {
  return claudeAgentTypeNames(type)
}

// ---------------------------------------------------------------------------------------------------------------------
// `if` rules (Phase 12)

/** A tool call an `if` rule is tested against. */
export interface HookIfTarget {
  /** The harness tool name (`shell`, `write_file`, `mcp__server__tool`). */
  readonly tool: string
  /** The tool input; a `Bash(…)` rule reads its `command`. */
  readonly input?: unknown
  /** The Claude Code name of a project MCP server (see `hookTargetNames`). */
  readonly mcpServerName?: string
}

type CompiledIf
  = | { readonly kind: 'tool', readonly tool: string }
    | { readonly kind: 'bash', readonly words: readonly string[], readonly exact: boolean }

/** A bare tool name of an `if` rule: a tool name, or MCP tools (`mcp__server`, `mcp__server__*`, `mcp__*`). */
const IF_TOOL_NAME = /^(?:[A-Z_a-z][\w-]{0,127}|mcp__(?:[\w-]{1,64}__)?\*)$/

/** The permission rule of `rule` (C41's parser), or null when it is not one or the parser fails. */
function permissionRule(rule: string): { tool: string, specifier: string | null } | null {
  try {
    const parsed = parseClaudePermissionRule(rule)
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.tool !== 'string')
      return null
    return { tool: parsed.tool, specifier: typeof parsed.specifier === 'string' ? parsed.specifier : null }
  }
  catch {
    return null
  }
}

function compileIf(rule: unknown): { readonly ok: true, readonly compiled: CompiledIf } | { readonly ok: false, readonly reason: string } {
  if (typeof rule !== 'string')
    return { ok: false, reason: 'The "if" rule must be text.' }
  const trimmed = rule.trim()
  if (trimmed === '')
    return { ok: false, reason: 'The "if" rule is empty.' }
  if (trimmed.length > HOOK_LIMITS.ifMaxChars)
    return { ok: false, reason: `The "if" rule is longer than ${HOOK_LIMITS.ifMaxChars} characters.` }
  const parsed = permissionRule(trimmed)
  if (parsed === null)
    return { ok: false, reason: 'The "if" rule must be a tool name or a Bash(command prefix) rule.' }
  if (parsed.specifier === null) {
    return IF_TOOL_NAME.test(parsed.tool)
      ? { ok: true, compiled: { kind: 'tool', tool: parsed.tool } }
      : { ok: false, reason: 'The "if" rule must name one tool.' }
  }
  if (parsed.tool !== 'Bash')
    return { ok: false, reason: 'Only Bash rules may have a pattern in parentheses.' }
  const specifier = parsed.specifier.trim()
  let prefix = specifier
  let exact = true
  if (specifier.endsWith(':*') || specifier.endsWith(' *')) {
    prefix = specifier.slice(0, -2).trim()
    exact = false
  }
  if (prefix === '')
    return { ok: false, reason: 'The Bash rule needs a command prefix.' }
  if (prefix.includes('*'))
    return { ok: false, reason: 'A Bash rule may have a wildcard only at its end (":*" or " *").' }
  const words = parseShellCommand(prefix)
  if (!words.ok || words.segments.length !== 1 || words.segments[0] === undefined || words.segments[0].words.length === 0)
    return { ok: false, reason: 'The Bash rule must be one simple command prefix.' }
  return { ok: true, compiled: { kind: 'bash', words: words.segments[0].words, exact } }
}

/**
 * Why an `if` rule is invalid, or null when it is valid (Phase 12, ADR-057): a tool name (`Write`, `mcp__github__*`)
 * or `Bash(p:*)` / `Bash(p *)` (a command prefix) / `Bash(p)` (the exact command); anything else (other tools'
 * patterns, inner wildcards, `Bash(*)`) is invalid and the hook never runs.
 */
export function checkHookIf(rule: string): string | null {
  const compiled = compileIf(rule)
  return compiled.ok ? null : compiled.reason
}

/**
 * True when the `if` rule of a hook matches a tool call (no rule = always). A tool name matches the tool's harness or
 * Claude Code names (`hookTargetNames`); a `Bash(…)` rule matches a `shell` call when any segment of its command (`a &&
 * b`) starts with the prefix words (`Bash(p)`: equals them); a command that cannot be split (`$`, backticks, …)
 * matches, so a guarding hook still runs. An invalid rule never matches (the hook never runs).
 */
export function matchHookIf(rule: string | null | undefined, target: HookIfTarget): boolean {
  if (rule === null || rule === undefined || (typeof rule === 'string' && rule.trim() === ''))
    return true
  const compiled = compileIf(rule)
  if (!compiled.ok || typeof target !== 'object' || target === null)
    return false
  const names = hookTargetNames(target.tool, typeof target.mcpServerName === 'string' ? { mcpServerName: target.mcpServerName } : undefined)
  if (compiled.compiled.kind === 'tool') {
    const tool = compiled.compiled.tool
    return tool.startsWith('mcp__') ? names.some(name => matchToolAllowlist(name, [tool])) : names.includes(tool)
  }
  if (!names.includes('Bash'))
    return false
  const input = target.input
  const command = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>).command : undefined
  if (typeof command !== 'string')
    return true
  const parsed = parseShellCommand(command)
  if (!parsed.ok)
    return true
  const { words, exact } = compiled.compiled
  return parsed.segments.some(segment =>
    (exact ? segment.words.length === words.length : segment.words.length >= words.length)
    && words.every((word, index) => segment.words[index] === word))
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
  /** Phase 12: the chat transcript (`transcript_path`, every event); absent when it could not be written. */
  readonly transcriptPath?: string
  /** Phase 12: the tool error of PostToolUseFailure (`error`, cut to `HOOK_LIMITS.errorMaxChars`). */
  readonly error?: string
  /** Phase 12: the sub-agent of SubagentStart / SubagentStop, or of a hook that runs inside one (`agent_id`, `agent_type`). */
  readonly agent?: { readonly id: string, readonly type: string }
  /** Phase 12: why the session ended (SessionEnd `reason`; default `other`). */
  readonly sessionEndReason?: string
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
const SHRINK_ORDER = ['tool_response', 'tool_input', 'error', 'prompt', 'custom_instructions', 'message'] as const

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
  if (typeof input.transcriptPath === 'string' && input.transcriptPath !== '')
    add('transcript_path', input.transcriptPath)
  add('cwd', text(input.cwd))
  add('permission_mode', hookPermissionMode(text(input.toolMode)))
  add('hook_event_name', event)
  const agent = isRecord(input.agent) ? input.agent : null
  if (agent !== null) {
    add('agent_id', text(agent.id))
    add('agent_type', text(agent.type))
  }
  const tool = isRecord(input.tool) ? input.tool : null
  const toolName = tool === null ? '' : text(tool.name)
  switch (event) {
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionRequest':
      if (tool !== null) {
        add('tool_name', claudeToolName(toolName) ?? toolName)
        add('tool_input', tool.input ?? {}, '{}')
        if (event === 'PostToolUse')
          add('tool_response', tool.output ?? null, 'null')
        if (event === 'PostToolUseFailure')
          add('error', cutText(text(input.error), HOOK_LIMITS.errorMaxChars), '""')
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
    case 'PostCompact':
      add('trigger', input.trigger === 'manual' ? 'manual' : 'auto')
      break
    case 'SessionEnd':
      add('reason', typeof input.sessionEndReason === 'string' && input.sessionEndReason !== '' ? input.sessionEndReason : 'other')
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
  if (tool !== null && TOOL_EVENTS.has(event))
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
  /**
   * `ok` = exit 0; `blocked` = exit 2 or `decision: block` / `permissionDecision: deny` (PermissionRequest:
   * `behavior: deny`); `error` = anything else.
   */
  readonly status: 'ok' | 'blocked' | 'error'
  /** PreToolUse and PermissionRequest only (PermissionRequest: `allow` or `deny`). */
  readonly decision: HookPermissionDecision | null
  /** A block or decision reason (≤ `HOOK_LIMITS.reasonMaxChars`). */
  readonly reason: string | null
  /** Model-visible context (`additionalContext`, or plain stdout for UserPromptSubmit / SessionStart). */
  readonly context: string | null
  /** PreToolUse and PermissionRequest (`allow`) only; undefined = unchanged. */
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

type Note = (level: HookDiagnostic['level'], code: HookDiagnosticCode, message: string) => void

/** An `updatedInput` value: the object (keys sorted) when it is one and fits the cap, else undefined (noted). */
function readUpdatedInput(value: unknown, note: Note): unknown {
  if (!isRecord(value)) {
    note('warning', 'invalid-output', 'updatedInput must be an object; it was ignored.')
    return undefined
  }
  const json = stableStringify(value)
  if (json === null || utf8LengthUpTo(json, HOOK_LIMITS.updatedInputBytes) > HOOK_LIMITS.updatedInputBytes) {
    note('warning', 'too-large', `updatedInput is larger than ${formatBytes(HOOK_LIMITS.updatedInputBytes)}; it was ignored.`)
    return undefined
  }
  return JSON.parse(json) as unknown
}

/** The PermissionRequest `decision` object (Phase 12): `{ behavior: 'allow' | 'deny', updatedInput?, message?, interrupt? }`. */
interface PermissionRequestDecision {
  readonly behavior: 'allow' | 'deny'
  readonly updatedInput?: unknown
  readonly message: string | null
  readonly interrupt: boolean
}

const PERMISSION_DECISION_KEYS: ReadonlySet<string> = new Set(['behavior', 'updatedInput', 'message', 'interrupt'])

function readPermissionRequestDecision(value: unknown, note: Note): PermissionRequestDecision | null {
  if (!isRecord(value)) {
    note('warning', 'invalid-output', 'hookSpecificOutput.decision must be an object; it was ignored.')
    return null
  }
  if (value.behavior !== 'allow' && value.behavior !== 'deny') {
    note('warning', 'invalid-output', 'decision.behavior must be "allow" or "deny"; the decision was ignored.')
    return null
  }
  const behavior = value.behavior
  for (const key of Object.keys(value)) {
    if (!PERMISSION_DECISION_KEYS.has(key))
      note('info', 'ignored-field', `decision.${shownKey(key)} is not used.`)
  }
  let updatedInput: unknown
  if (value.updatedInput !== undefined && value.updatedInput !== null) {
    if (behavior === 'allow')
      updatedInput = readUpdatedInput(value.updatedInput, note)
    else
      note('info', 'ignored-field', 'decision.updatedInput is not used when the hook denies the request.')
  }
  let message: string | null = null
  if (value.message !== undefined && value.message !== null) {
    if (typeof value.message !== 'string')
      note('warning', 'invalid-output', 'decision.message must be text; it was ignored.')
    else if (behavior === 'deny')
      message = cappedText(value.message, HOOK_LIMITS.reasonMaxChars)
    else
      note('info', 'ignored-field', 'decision.message is used only when the hook denies the request.')
  }
  let interrupt = false
  if (value.interrupt !== undefined && value.interrupt !== null) {
    if (typeof value.interrupt !== 'boolean')
      note('warning', 'invalid-output', 'decision.interrupt must be true or false; it was ignored.')
    else if (behavior === 'deny')
      interrupt = value.interrupt
    else if (value.interrupt)
      note('info', 'ignored-field', 'decision.interrupt is used only when the hook denies the request.')
  }
  return updatedInput === undefined ? { behavior, message, interrupt } : { behavior, updatedInput, message, interrupt }
}

/** Reads the `hookSpecificOutput` object of a JSON output. */
function readSpecific(event: HookEvent, specific: unknown, draft: OutcomeDraft, note: Note): {
  permissionDecision?: HookPermissionDecision
  permissionReason?: string | null
  updatedInput?: unknown
  request?: PermissionRequestDecision | null
} {
  if (!isRecord(specific)) {
    note('warning', 'invalid-output', 'hookSpecificOutput must be an object; it was ignored.')
    return {}
  }
  if (specific.hookEventName !== event) {
    note('warning', 'invalid-output', `hookSpecificOutput.hookEventName must be "${event}"; it was ignored.`)
    return {}
  }
  const result: { permissionDecision?: HookPermissionDecision, permissionReason?: string | null, updatedInput?: unknown, request?: PermissionRequestDecision | null } = {}
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
      const updated = readUpdatedInput(value, note)
      if (updated !== undefined)
        result.updatedInput = updated
      continue
    }
    if (event === 'PermissionRequest' && key === 'decision') {
      result.request = readPermissionRequestDecision(value, note)
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

function readJsonOutput(event: HookEvent, output: Record<string, unknown>, draft: OutcomeDraft, note: Note): void {
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
  if (event === 'PermissionRequest') {
    const request = specific.request
    if (request === undefined || request === null)
      return
    draft.decision = request.behavior
    if (request.behavior === 'allow') {
      if (request.updatedInput !== undefined)
        draft.updatedInput = request.updatedInput
      return
    }
    draft.status = 'blocked'
    draft.reason = request.message
    if (request.interrupt) {
      draft.continue = false
      draft.stopReason ??= request.message
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

// ---------------------------------------------------------------------------------------------------------------------
// Prompt hooks (Phase 12, ADR-057)

/** The answer of a prompt hook's model: `{ ok, reason?, impossible? }`. */
export interface PromptHookAnswer {
  readonly ok: boolean
  /** Required when `ok` is false (≤ `HOOK_LIMITS.reasonMaxChars`). */
  readonly reason: string | null
  /** Stop / SubagentStop only: the agent may stop although the hook said no (the reason is recorded). */
  readonly impossible: boolean
}

export type ReadPromptHookAnswerResult
  = | { readonly valid: true, readonly answer: PromptHookAnswer }
    | { readonly valid: false, readonly error: string }

/** Characters of a model answer that are read (the answer is a small JSON object). */
const ANSWER_SCAN_MAX_CHARS = 65_536
/** `{` positions tried before the answer counts as unreadable. */
const ANSWER_OBJECT_ATTEMPTS = 32
const FENCE = '```'

/** The content of the first Markdown code fence (```json … ```; the info string skipped), or null. */
function fencedContent(text: string): string | null {
  const open = text.indexOf(FENCE)
  if (open === -1)
    return null
  const lineEnd = text.indexOf('\n', open + FENCE.length)
  const start = lineEnd === -1 ? open + FENCE.length : lineEnd + 1
  const close = text.indexOf(FENCE, start)
  return close === -1 ? null : text.slice(start, close)
}

/** The end index of the balanced `{…}` that starts at `start` (string-aware), or -1. */
function objectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (char === '\\')
        index++
      else if (char === '"')
        inString = false
      continue
    }
    if (char === '"') {
      inString = true
    }
    else if (char === '{') {
      depth++
    }
    else if (char === '}') {
      depth--
      if (depth === 0)
        return index
    }
  }
  return -1
}

/** The first JSON object of `text` (tried at up to `ANSWER_OBJECT_ATTEMPTS` `{` positions), or null. */
function firstJsonObject(text: string): Record<string, unknown> | null {
  let start = text.indexOf('{')
  for (let attempt = 0; start !== -1 && attempt < ANSWER_OBJECT_ATTEMPTS; attempt++) {
    const end = objectEnd(text, start)
    if (end !== -1) {
      try {
        const parsed: unknown = JSON.parse(text.slice(start, end + 1))
        if (isRecord(parsed))
          return parsed
      }
      catch {
        // Not JSON (prose with braces): try the next `{`.
      }
    }
    start = text.indexOf('{', start + 1)
  }
  return null
}

/**
 * Reads the answer of a prompt hook's model: a JSON code fence is unwrapped, the first JSON object is taken; `ok` must
 * be true or false, `reason` (text) is required when `ok` is false, `impossible` counts only when it is `true` (and `ok`
 * is false). Anything else is invalid (a non-blocking error; the error never quotes the answer).
 */
export function readPromptHookAnswer(text: string): ReadPromptHookAnswerResult {
  if (typeof text !== 'string' || text.trim() === '')
    return { valid: false, error: 'The hook model gave no answer.' }
  try {
    const source = text.slice(0, ANSWER_SCAN_MAX_CHARS)
    const fenced = fencedContent(source)
    const value = (fenced === null ? null : firstJsonObject(fenced)) ?? firstJsonObject(source)
    if (value === null)
      return { valid: false, error: 'The hook model did not answer with a JSON object.' }
    if (typeof value.ok !== 'boolean')
      return { valid: false, error: 'The hook model\'s answer has no "ok" true or false.' }
    const reason = cappedText(value.reason, HOOK_LIMITS.reasonMaxChars)
    if (!value.ok && reason === null)
      return { valid: false, error: 'The hook model said no without a reason.' }
    return { valid: true, answer: { ok: value.ok, reason, impossible: !value.ok && value.impossible === true } }
  }
  catch {
    return { valid: false, error: 'The hook model\'s answer could not be read.' }
  }
}

/** One pass: `\$` → `$`, `$ARGUMENTS` → the payload. */
const PROMPT_PLACEHOLDER = /\\\$|\$ARGUMENTS/g

/**
 * The text a prompt hook's model reads: `$ARGUMENTS` is replaced by the payload JSON (every occurrence; the payload is
 * appended after a blank line when the prompt has none) and `\$` is a literal `$` (so `\$ARGUMENTS` stays text).
 */
export function expandHookPrompt(prompt: string, payloadJson: string): string {
  const template = typeof prompt === 'string' ? prompt : ''
  const json = typeof payloadJson === 'string' ? payloadJson : ''
  let used = false
  const text = template.replace(PROMPT_PLACEHOLDER, (match: string) => {
    if (match !== '$ARGUMENTS')
      return '$'
    used = true
    return json
  })
  if (used)
    return text
  return text === '' ? json : `${text}\n\n${json}`
}

/**
 * The outcome of a prompt hook (ADR-057), so the seams apply it like a command hook's. `answer` null (unreadable, timed
 * out, failed) → a non-blocking error (`options.error` or a generic text). `ok: true` decides nothing (it never allows).
 * `ok: false`:
 * - PreToolUse: deny and end the turn (`continue: false`); with `continueOnBlock`, deny only (the reason is the tool
 *   error);
 * - PostToolUse: end the turn (`continue: false`); with `continueOnBlock`, block (the reason is fed back);
 * - PostToolUseFailure, UserPromptSubmit: block;
 * - Stop / SubagentStop: block (the agent continues with the reason) unless `impossible` (the stop is allowed, the
 *   reason recorded);
 * - PermissionRequest and every other event: no effect, the reason is recorded.
 */
export function promptHookOutcome(event: HookEvent, answer: PromptHookAnswer | null, options?: { readonly continueOnBlock?: boolean, readonly error?: string }): HookOutcome {
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
  if (answer === null || !isRecord(answer) || typeof answer.ok !== 'boolean') {
    draft.status = 'error'
    draft.error = cappedText(options?.error, HOOK_LIMITS.reasonMaxChars) ?? 'The hook model did not give a valid answer.'
    return finish(draft)
  }
  if (answer.ok)
    return finish(draft)
  const reason = cappedText(answer.reason, HOOK_LIMITS.reasonMaxChars) ?? 'A prompt hook said no.'
  const continueOnBlock = options?.continueOnBlock === true
  draft.reason = reason
  switch (event) {
    case 'PreToolUse':
      draft.status = 'blocked'
      draft.decision = 'deny'
      if (!continueOnBlock) {
        draft.continue = false
        draft.stopReason = reason
      }
      break
    case 'PostToolUse':
      if (continueOnBlock) {
        draft.status = 'blocked'
      }
      else {
        draft.continue = false
        draft.stopReason = reason
      }
      break
    case 'PostToolUseFailure':
    case 'UserPromptSubmit':
      draft.status = 'blocked'
      break
    case 'Stop':
    case 'SubagentStop':
      if (answer.impossible !== true)
        draft.status = 'blocked'
      break
    default:
      break
  }
  return finish(draft)
}

// ---------------------------------------------------------------------------------------------------------------------
// Exec form (Phase 12, ADR-057)

/** A `${NAME}` placeholder (`CLAUDE_PLUGIN_ROOT`, `CLAUDE_PROJECT_DIR`, `user_config.KEY`, …). */
const EXEC_PLACEHOLDER = /\$\{([a-z_]\w{0,63}(?:\.[\w-]{1,64})?)\}/gi

/** `word` single-quoted for a POSIX shell (`'` → `'\''`); nothing inside single quotes is special. */
function shellQuote(word: string): string {
  return `'${word.replace(/'/g, '\'\\\'\'')}'`
}

/**
 * The shell text of an exec-form hook (`command` + `args`), for `runShellCommand` (the only shell-string spawn): every
 * `${NAME}` whose name is a key of `vars` is replaced by its value as plain text (no shell expansion; unknown names stay
 * as written, never read from the environment), then each word is single-quoted, so no argument is ever parsed by the
 * shell (spaces, quotes, `$`, backticks, `;` and newlines stay literal). null when the command is empty or a word holds
 * a NUL character (an argument list cannot carry it).
 */
export function execFormCommand(command: string, args: readonly string[], vars?: Readonly<Record<string, string>>): string | null {
  if (typeof command !== 'string' || command.trim() === '')
    return null
  const values = typeof vars === 'object' && vars !== null ? vars : {}
  const substitute = (word: string): string => word.replace(EXEC_PLACEHOLDER, (match: string, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined
    return typeof value === 'string' ? value : match
  })
  const words = [command.trim(), ...(Array.isArray(args) ? args : [])]
  if (words.some(word => typeof word !== 'string'))
    return null
  const substituted = words.map(substitute)
  if (substituted.some(word => word.includes('\0')))
    return null
  return substituted.map(shellQuote).join(' ')
}
