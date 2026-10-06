// Pure helpers of the Customize Hooks tab (Phase 11, ADR-048; docs/UI.md 9.13, 11.8, 15): the copy of the eight events
// (label, description, whether the matcher matches tools), the actions of a row's menu, the editor's draft, a row's
// state badge and meta line, the matcher preview (over the shared `compileMatcher` / `hookTargetNames`), the Claude
// Code `hooks` JSON of rows (Copy as JSON), the hook import (over the shared `readSettingsHooks` / `readHooksConfig`),
// the tab's copy and the delete confirmation. Hook configurations are read only by the shared `util/hooks.ts`. No Vue,
// no stores. Signatures frozen from Gate P11-0b (C39); W11.8 owns the bodies (P11-A).
import type { HookDiagnostic, HookEntry, HookEvent, HookSpec } from '@harness-forge/shared'
import {
  claudeToolName,
  compileMatcher,
  HOOK_EVENTS,
  HOOK_LIMITS,
  hookTargetNames,
  readHooksConfig,
  readSettingsHooks,
  TOOL_HOOK_EVENTS,
} from '@harness-forge/shared'

/** The actions of a hook row's menu (docs/UI.md 9.13). */
export type HookAction = 'edit' | 'duplicate' | 'toggle' | 'copy-json' | 'delete' | 'review' | 'open-plugin'

/** The editor's fields (`timeout` in seconds; null = the default 60 s). */
export interface HookDraft {
  event: HookEvent
  matcher: string
  command: string
  timeout: number | null
  enabled: boolean
}

const TOOL_EVENTS: ReadonlySet<HookEvent> = new Set(TOOL_HOOK_EVENTS)

const EVENT_DESCRIPTIONS: Readonly<Record<HookEvent, string>> = {
  PreToolUse: 'Before a tool runs. It can block the call, allow it without asking or change its input.',
  PostToolUse: 'After a tool finished. It can give the agent feedback.',
  UserPromptSubmit: 'When you send a message, before the agent reads it. It can add context or block the message.',
  Notification: 'When the agent needs your attention, like an approval.',
  Stop: 'When the agent finishes a reply. It can make it continue.',
  SubagentStop: 'When a sub-agent finishes. It can make it continue.',
  PreCompact: 'Before the conversation is compacted.',
  SessionStart: 'When a chat\'s first reply starts, and again after a compaction. It can add context.',
}

/** The eight events in `HOOK_EVENTS` order: the label (Claude Code's spelling), the description, a tool matcher. */
export const HOOK_EVENT_INFO: Readonly<Record<HookEvent, { label: string, description: string, toolMatcher: boolean }>> = Object.fromEntries(
  HOOK_EVENTS.map(event => [event, { label: event, description: EVENT_DESCRIPTIONS[event], toolMatcher: TOOL_EVENTS.has(event) }]),
) as Record<HookEvent, { label: string, description: string, toolMatcher: boolean }>

/** The copy of the tab, the rows, the editor and the import (docs/UI.md 9.13, 15). */
export const HOOK_COPY: Readonly<Record<string, string>> = {
  runHooks: 'Run hooks',
  runHooksHelp: 'Shell commands that run at points of the agent\'s work, like before a tool call. Off: no command hook runs, from any source.',
  shellOff: 'Hooks are turned off on this server (HF_WORKSPACE_SHELL=0).',
  safeMode: 'Hooks are turned off on this server (safe mode).',
  personalEmpty: 'No personal hooks yet. A hook runs a shell command when something happens, like before a tool call.',
  allTools: 'All tools',
  needsApproval: 'Needs approval',
  approved: 'Approved',
  off: 'Off',
  offOnServer: 'Off on this server',
  invalid: 'Invalid',
  pluginNotTrusted: 'Plugin not trusted',
  codeHook: 'Code hook',
  copied: 'Copied hook as JSON',
  deleted: 'Deleted hook',
  warning: 'Hooks run shell commands on your server with harness-forge\'s permissions, without asking, whenever their event happens. Only add commands you understand.',
  matcherHelp: 'Tool names separated by |. Claude Code names work too (Bash, Read, Write, Edit, Grep, Glob, WebFetch). Leave it empty or use * for every tool.',
  matcherInvalid: 'Use tool names, | and * only.',
  // The runner (workspace/shell.ts) prefers /bin/bash and falls back to /bin/sh.
  commandHelp: 'Runs with bash (or sh when bash is missing) in the project folder (outside projects, in a private folder). It gets the event as JSON on stdin; exit code 2 blocks with stderr as the reason.',
  commandMissing: 'Add the command.',
  timeoutInvalid: 'Enter a whole number from 1 to 600.',
  saved: 'Hook saved',
  passwordPrompt: 'Saving a hook needs your password.',
  importTitle: 'Import hooks',
  importHelp: 'Paste Claude Code settings JSON (the whole file or its "hooks" object).',
  invalidJson: 'This isn\'t valid JSON.',
  noHooks: 'No hooks found.',
  promptIgnored: 'Ignored: "prompt" hooks aren\'t supported.',
}

/** The state badge of a row (null = an active personal or plugin hook: no badge). */
export function hookStateBadge(entry: HookEntry): { label: string, tone: 'muted' | 'warning' | 'destructive' | 'success' } | null {
  switch (entry.state) {
    case 'pending':
      // A plugin hook waits for its plugin's trust; a project hook for its approval.
      return { label: entry.source === 'plugin' ? HOOK_COPY.pluginNotTrusted! : HOOK_COPY.needsApproval!, tone: 'warning' }
    case 'off':
      return { label: HOOK_COPY.off!, tone: 'muted' }
    case 'invalid':
      return { label: HOOK_COPY.invalid!, tone: 'destructive' }
    case 'blocked':
      return { label: HOOK_COPY.offOnServer!, tone: 'muted' }
    default:
      return entry.source === 'project' ? { label: HOOK_COPY.approved!, tone: 'success' } : null
  }
}

/**
 * The muted second line of a row: the source ("Personal", "Project", the plugin's name), then "timeout {n}s" (when set)
 * and the settings file of a project hook; a code hook adds "Code hook".
 */
export function hookRowMeta(entry: HookEntry, pluginName: (id: string) => string): string[] {
  const items: string[] = []
  if (entry.source === 'personal')
    items.push('Personal')
  else if (entry.source === 'project')
    items.push('Project')
  else
    items.push(entry.pluginId ? pluginName(entry.pluginId) : 'Plugin')
  if (entry.kind === 'command') {
    if (entry.timeout !== null)
      items.push(`timeout ${entry.timeout}s`)
    if (entry.path)
      items.push(entry.path)
  }
  else {
    items.push(HOOK_COPY.codeHook!)
  }
  return items
}

/** True for a matcher that matches every tool (empty, `*`, or an alternative made of wildcards only). */
export function matchesEveryTool(matcher: string | null | undefined): boolean {
  const text = matcher?.trim() ?? ''
  if (text === '' || text === '*')
    return true
  return text.split('|').some(part => part.trim() !== '' && part.trim().replace(/\.\*/g, '*').split('*').every(piece => piece === ''))
}

/** The matcher text of a row: "All tools" for an every-tool matcher of a tool event, else the matcher (or null). */
export function hookMatcherText(entry: HookEntry): string | null {
  if (entry.kind !== 'command')
    return null
  if (TOOL_EVENTS.has(entry.event))
    return matchesEveryTool(entry.matcher) ? HOOK_COPY.allTools! : entry.matcher!.trim()
  return entry.matcher?.trim() || null
}

/** Names listed in a preview before "and {n} more". */
const PREVIEW_NAMES_MAX = 8

/** "shell (Bash)": a harness tool with its Claude Code name. */
function toolLabel(tool: string): string {
  const claude = claudeToolName(tool)
  return claude ? `${tool} (${claude})` : tool
}

function listText(names: readonly string[]): string {
  if (names.length <= PREVIEW_NAMES_MAX)
    return names.join(', ')
  return `${names.slice(0, PREVIEW_NAMES_MAX).join(', ')} and ${names.length - PREVIEW_NAMES_MAX} more`
}

/**
 * The matcher preview of the editor (docs/UI.md 9.13): the tools of `tools` (harness names) the matcher matches under
 * their harness or Claude Code names, as "Matches {list}" (the harness names with the Claude alias in brackets), "No tool
 * is named {name} now." for alternatives that match nothing, or the invalid-matcher text (`ok` false). An every-tool
 * matcher has no text (the help says it) and matches every tool.
 */
export function matcherPreview(matcher: string, tools: readonly string[]): { ok: boolean, matches: string[], text: string } {
  const compiled = compileMatcher(matcher)
  if (!compiled.ok)
    return { ok: false, matches: [], text: HOOK_COPY.matcherInvalid! }
  const known = [...new Set(tools)]
  if (matchesEveryTool(matcher))
    return { ok: true, matches: known, text: '' }
  const matches = known.filter(tool => hookTargetNames(tool).some(name => compiled.test(name)))
  const unknown: string[] = []
  for (const part of matcher.split('|')) {
    const alternative = part.trim()
    if (alternative === '' || unknown.includes(alternative))
      continue
    const single = compileMatcher(alternative)
    if (single.ok && !known.some(tool => hookTargetNames(tool).some(name => single.test(name))))
      unknown.push(alternative)
  }
  const lines: string[] = []
  if (matches.length > 0)
    lines.push(`Matches ${listText(matches.map(toolLabel))}`)
  if (unknown.length > 0)
    lines.push(`No tool is named ${unknown.join(', ')} now.`)
  return { ok: true, matches, text: lines.join('. ') }
}

/** The editor's draft of a command hook (Duplicate, Copy to personal, edit); a code hook gives an empty draft. */
export function draftFromHook(entry: HookEntry): HookDraft {
  if (entry.kind !== 'command')
    return { event: 'PreToolUse', matcher: '', command: '', timeout: null, enabled: true }
  return { event: entry.event, matcher: entry.matcher ?? '', command: entry.command, timeout: entry.timeout, enabled: entry.state !== 'off' }
}

/**
 * The Claude Code `hooks` object of command rows, pretty-printed (`{ "hooks": { <Event>: [{ matcher?, hooks: [{ type:
 * "command", command, timeout? }] }] } }`): rows of the same event and matcher share one group, in row order; events
 * follow `HOOK_EVENTS` order. Code hooks are left out.
 */
export function hookJson(entries: readonly HookEntry[]): string {
  const groups = new Map<HookEvent, { matcher: string | null, hooks: Record<string, unknown>[] }[]>()
  for (const entry of entries) {
    if (entry.kind !== 'command')
      continue
    const matcher = entry.matcher?.trim() || null
    const handler: Record<string, unknown> = entry.timeout === null
      ? { type: 'command', command: entry.command }
      : { type: 'command', command: entry.command, timeout: entry.timeout }
    const list = groups.get(entry.event) ?? []
    const group = list.find(item => item.matcher === matcher)
    if (group)
      group.hooks.push(handler)
    else
      list.push({ matcher, hooks: [handler] })
    groups.set(entry.event, list)
  }
  const hooks: Record<string, unknown[]> = {}
  for (const event of HOOK_EVENTS) {
    const list = groups.get(event)
    if (list)
      hooks[event] = list.map(group => (group.matcher === null ? { hooks: group.hooks } : { matcher: group.matcher, hooks: group.hooks }))
  }
  return JSON.stringify({ hooks }, null, 2)
}

// ---------- import ----------

/** One handler of an import preview. */
export interface ImportedHook {
  draft: HookDraft
  /** False for a handler the server would refuse (an invalid matcher): unchecked and disabled. */
  valid: boolean
  /** Why it is invalid, else null. */
  message: string | null
}

/** Pasted or chosen files above this size are refused (docs/UI.md 9.13). */
export const HOOK_IMPORT_MAX_BYTES = 256 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The raw handler a diagnostic points at (for an invalid matcher group the reader returns no item). */
function rawHandler(config: Record<string, unknown>, event: HookEvent, [group, handler]: readonly [number, number]): { matcher: string, command: string, timeout: number | null } | null {
  const groups = config[event]
  const rawGroup = Array.isArray(groups) ? groups[group] : undefined
  if (!isRecord(rawGroup) || !Array.isArray(rawGroup.hooks))
    return null
  const rawItem: unknown = rawGroup.hooks[handler]
  if (!isRecord(rawItem) || rawItem.type !== 'command' || typeof rawItem.command !== 'string' || rawItem.command.trim() === '')
    return null
  const timeout = typeof rawItem.timeout === 'number' && Number.isInteger(rawItem.timeout) && rawItem.timeout >= 1 && rawItem.timeout <= HOOK_LIMITS.timeoutMaxSec
    ? rawItem.timeout
    : null
  return {
    matcher: typeof rawGroup.matcher === 'string' ? rawGroup.matcher : '',
    command: rawItem.command.trim().slice(0, HOOK_LIMITS.commandMaxChars),
    timeout,
  }
}

/** The note of a diagnostic the preview leaves out, or null (ignored fields stay quiet). */
function noteOf(diagnostic: HookDiagnostic): string | null {
  if (diagnostic.code === 'ignored-field')
    return null
  if (diagnostic.code === 'unsupported-type')
    return /prompt/i.test(diagnostic.message) ? HOOK_COPY.promptIgnored! : `Ignored: ${diagnostic.message}`
  const where = diagnostic.event ? `${diagnostic.event}: ` : ''
  return `${where}${diagnostic.message}`
}

/**
 * Reads pasted Claude Code settings JSON (the whole file, through the shared `readSettingsHooks`, or its `hooks`
 * object, through `readHooksConfig`) into drafts, in file order: valid handlers and handlers of a group with an
 * invalid matcher (`valid` false, "Use tool names, | and * only."), the notes of what was left out (prompt hooks,
 * unknown events, other problems) and the error of an unreadable text ("This isn't valid JSON.", "No hooks found.").
 */
export function importHooks(text: string): { items: ImportedHook[], notes: string[], error: string | null } {
  const source = typeof text === 'string' ? text.replace(/^\uFEFF/, '') : ''
  if (source.trim() === '')
    return { items: [], notes: [], error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  }
  catch {
    return { items: [], notes: [], error: HOOK_COPY.invalidJson! }
  }
  if (!isRecord(parsed))
    return { items: [], notes: [], error: HOOK_COPY.noHooks! }
  const wholeFile = Object.hasOwn(parsed, 'hooks')
  const config = wholeFile ? parsed.hooks : parsed
  const result = wholeFile
    ? readSettingsHooks(source, { file: 'settings.json', maxBytes: HOOK_IMPORT_MAX_BYTES })
    : readHooksConfig(parsed, { source: 'personal' })

  const order = isRecord(config) ? Object.keys(config) : []
  const positioned: { at: [number, number, number], item: ImportedHook }[] = result.items.map((spec: HookSpec) => ({
    at: [order.indexOf(spec.event), spec.position[0], spec.position[1]],
    item: {
      draft: { event: spec.event, matcher: spec.matcher ?? '', command: spec.command, timeout: spec.timeoutSec, enabled: true },
      valid: true,
      message: null,
    },
  }))
  const notes: string[] = []
  for (const diagnostic of result.diagnostics) {
    const matcherProblem = (diagnostic.code === 'invalid-matcher' || diagnostic.code === 'too-long') && diagnostic.event && diagnostic.position
    const raw = matcherProblem && isRecord(config) ? rawHandler(config, diagnostic.event!, diagnostic.position!) : null
    if (raw && diagnostic.event && diagnostic.position) {
      positioned.push({
        at: [order.indexOf(diagnostic.event), diagnostic.position[0], diagnostic.position[1]],
        item: {
          draft: { event: diagnostic.event, matcher: raw.matcher, command: raw.command, timeout: raw.timeout, enabled: true },
          valid: false,
          message: HOOK_COPY.matcherInvalid!,
        },
      })
      continue
    }
    const note = noteOf(diagnostic)
    if (note && !notes.includes(note))
      notes.push(note)
  }
  positioned.sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1] || a.at[2] - b.at[2])
  const items = positioned.map(entry => entry.item)
  if (items.length === 0) {
    const fileProblem = result.diagnostics.find(diagnostic => diagnostic.code === 'too-large')
    return { items, notes: notes.filter(note => note !== fileProblem?.message), error: fileProblem?.message ?? HOOK_COPY.noHooks! }
  }
  return { items, notes, error: null }
}

/** "Found {n} hooks" / "Found 1 hook". */
export function foundHooksText(count: number): string {
  return `Found ${count} ${count === 1 ? 'hook' : 'hooks'}`
}

/** "Add {n} hooks" / "Add 1 hook". */
export function addHooksText(count: number): string {
  return `Add ${count} ${count === 1 ? 'hook' : 'hooks'}`
}

/** "Added {n} hooks" / "Added 1 hook". */
export function addedHooksText(count: number): string {
  return `Added ${count} ${count === 1 ? 'hook' : 'hooks'}`
}

// ---------- editor rules ----------

/** The matcher's problem in the editor's words, else null (tool events only). */
export function matcherError(value: string): string | null {
  if (value.trim().length > HOOK_LIMITS.matcherMaxChars)
    return `Use at most ${HOOK_LIMITS.matcherMaxChars} characters.`
  return compileMatcher(value).ok ? null : HOOK_COPY.matcherInvalid!
}

/** The command's problem, else null. */
export function commandError(value: string): string | null {
  if (value.trim() === '')
    return HOOK_COPY.commandMissing!
  if (value.length > HOOK_LIMITS.commandMaxChars)
    return `Use at most ${HOOK_LIMITS.commandMaxChars.toLocaleString('en-US')} characters.`
  if (value.includes('\0'))
    return 'The command cannot contain NUL characters.'
  return null
}

/** A typed timeout: '' = the default (null), else a whole number from 1 to 600. */
export function parseHookTimeout(text: string): { value: number | null } | { error: string } {
  const trimmed = text.trim()
  if (trimmed === '')
    return { value: null }
  const value = /^\d{1,3}$/.test(trimmed) ? Number(trimmed) : Number.NaN
  return Number.isInteger(value) && value >= 1 && value <= HOOK_LIMITS.timeoutMaxSec
    ? { value }
    : { error: HOOK_COPY.timeoutInvalid! }
}

/** The texts of the delete confirmation (docs/UI.md 9.13). */
export function hookDeleteCopy(_entry: HookEntry): { title: string, description: string, confirm: string } {
  return { title: 'Delete this hook?', description: 'It stops running at once.', confirm: 'Delete hook' }
}

/** Rows in event order (`HOOK_EVENTS`), then by matcher, then by command; code hooks last, by event name. */
export function sortHookEntries(entries: readonly HookEntry[]): HookEntry[] {
  const rank = (entry: HookEntry): number => (entry.kind === 'command' ? HOOK_EVENTS.indexOf(entry.event) : HOOK_EVENTS.length)
  return [...entries].sort((a, b) => {
    const byEvent = rank(a) - rank(b)
    if (byEvent !== 0)
      return byEvent
    if (a.kind === 'command' && b.kind === 'command')
      return (a.matcher ?? '').localeCompare(b.matcher ?? '') || a.command.localeCompare(b.command)
    return a.event.localeCompare(b.event)
  })
}
