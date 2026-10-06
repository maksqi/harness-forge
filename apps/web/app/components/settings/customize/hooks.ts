// Pure helpers of the Customize Hooks tab (Phase 11, ADR-048; docs/UI.md 9.13, 11.8, 15): the copy of the eight events
// (label, description, whether the matcher matches tools), the actions of a row's menu, the editor's draft, a row's
// state badge and meta line, the matcher preview (over the shared `compileMatcher` / `hookTargetNames`), the Claude
// Code `hooks` JSON of rows (Copy as JSON), the hook import (over the shared `readSettingsHooks` / `readHooksConfig`),
// the tab's copy and the delete confirmation. Hook configurations are read only by the shared `util/hooks.ts`. No Vue,
// no stores. Signatures frozen from Gate P11-0b (C39); W11.8 owns the bodies in P11-A (P11-0b: the event copy and plain
// first versions).
import type { HookEntry, HookEvent } from '@harness-forge/shared'
import { HOOK_EVENTS, TOOL_HOOK_EVENTS } from '@harness-forge/shared'

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
  warning: 'Hooks run shell commands on your server with harness-forge\'s permissions, without asking, whenever their event happens. Only add commands you understand.',
  saved: 'Hook saved',
  passwordPrompt: 'Saving a hook needs your password.',
  importTitle: 'Import hooks',
  importHelp: 'Paste Claude Code settings JSON (the whole file or its "hooks" object).',
  invalidJson: 'This isn\'t valid JSON.',
  noHooks: 'No hooks found.',
}

/** The state badge of a row (null = active, no badge). P11-0b first version; W11.8 refines it. */
export function hookStateBadge(entry: HookEntry): { label: string, tone: 'muted' | 'warning' | 'destructive' | 'success' } | null {
  switch (entry.state) {
    case 'pending':
      return { label: HOOK_COPY.needsApproval!, tone: 'warning' }
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

/** The muted second line of a row: the source ("Personal", "Project", the plugin's name), the timeout, the path. */
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
  return items
}

/**
 * The matcher preview of the editor: "Matches {list}" or "No tool is named {name} now.", `ok` false for an invalid
 * matcher. P11-0b placeholder (no matches); W11.8 implements it over `compileMatcher` / `hookTargetNames`.
 */
export function matcherPreview(_matcher: string, _tools: readonly string[]): { ok: boolean, matches: string[], text: string } {
  return { ok: true, matches: [], text: '' }
}

/** The editor's draft of a command hook (Duplicate, Copy to personal, edit); a code hook gives an empty draft. */
export function draftFromHook(entry: HookEntry): HookDraft {
  if (entry.kind !== 'command')
    return { event: 'PreToolUse', matcher: '', command: '', timeout: null, enabled: true }
  return { event: entry.event, matcher: entry.matcher ?? '', command: entry.command, timeout: entry.timeout, enabled: entry.state !== 'off' }
}

/**
 * The Claude Code `hooks` object of command rows, pretty-printed (`{ "hooks": { <Event>: [{ matcher?, hooks: [{ type:
 * "command", command, timeout? }] }] } }`). P11-0b first version (one group per row); W11.8 refines it.
 */
export function hookJson(entries: readonly HookEntry[]): string {
  const hooks: Record<string, unknown[]> = {}
  for (const entry of entries) {
    if (entry.kind !== 'command')
      continue
    const handler = entry.timeout === null ? { type: 'command', command: entry.command } : { type: 'command', command: entry.command, timeout: entry.timeout }
    const group = entry.matcher ? { matcher: entry.matcher, hooks: [handler] } : { hooks: [handler] }
    const groups = hooks[entry.event] ?? []
    groups.push(group)
    hooks[entry.event] = groups
  }
  return JSON.stringify({ hooks }, null, 2)
}

/**
 * Reads pasted Claude Code settings JSON (the whole file or its `hooks` object) into drafts, with the notes of what was
 * left out and the error of an unreadable text. P11-0b placeholder (nothing found); W11.8 implements it over the shared
 * `readSettingsHooks` / `readHooksConfig`.
 */
export function importHooks(text: string): { items: { draft: HookDraft, valid: boolean, message: string | null }[], notes: string[], error: string | null } {
  return { items: [], notes: [], error: text.trim() === '' ? null : HOOK_COPY.noHooks! }
}

/** The texts of the delete confirmation (docs/UI.md 9.13). */
export function hookDeleteCopy(_entry: HookEntry): { title: string, description: string, confirm: string } {
  return { title: 'Delete this hook?', description: 'It stops running at once.', confirm: 'Delete hook' }
}
