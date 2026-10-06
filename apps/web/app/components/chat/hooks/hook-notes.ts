// Pure helpers of hook records in the transcript (Phase 11, ADR-048; docs/UI.md 7.31, 11.8): the only readers of
// `data-hook` parts on the web. `hookDataOf` validates one part, `toolHooksOf` groups the tool-linked records of a reply
// by tool call id (ToolPart renders them inside the row), `isHookCarrierMessage` recognizes the user-role carrier of a
// turn the server started after a Stop hook blocked (`run.started.origin = 'hook'`). The model's view of a record is the
// server's business (`hookModelText`); the carrier rule is the shared `isHookCarrier` plus a valid record in every part.
// No Vue, no stores. Signatures frozen from Gate P11-0b (C39); `hookDataOf`, `toolHooksOf` and `isHookCarrierMessage` are
// C39's; W11.12 wrote the texts (`hookOutcomeText`, `hookSourceText`, `hookAnnouncement`) and the note helpers below.
import type { HarnessUIMessage, HookData } from '@harness-forge/shared'
import { HOOK_PART_TYPE, hookDataSchema, isHookCarrier } from '@harness-forge/shared'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The data of a valid `data-hook` part (`hookDataSchema`), else null (another part, malformed or invalid data). */
export function hookDataOf(part: unknown): HookData | null {
  if (!isRecord(part) || part.type !== HOOK_PART_TYPE)
    return null
  const parsed = hookDataSchema.safeParse(part.data)
  return parsed.success ? parsed.data : null
}

/**
 * The tool-linked hook records of a message's parts (PreToolUse / PostToolUse records with a `toolCallId`), by tool call
 * id, each list in part order. Records without a tool call id and invalid parts are left out.
 */
export function toolHooksOf(parts: readonly unknown[]): Map<string, HookData[]> {
  const byCall = new Map<string, HookData[]>()
  if (!Array.isArray(parts))
    return byCall
  for (const part of parts) {
    const data = hookDataOf(part)
    if (!data?.toolCallId)
      continue
    const list = byCall.get(data.toolCallId)
    if (list)
      list.push(data)
    else
      byCall.set(data.toolCallId, [data])
  }
  return byCall
}

/**
 * True for the carrier of a hook turn: a user message whose parts are all valid `data-hook` parts (at least one; the
 * shared `isHookCarrier` with valid data). ChatMessage renders it as notes (variant `turn`), with no bubble, actions,
 * edit, versions or rewind.
 */
export function isHookCarrierMessage(message: HarnessUIMessage): boolean {
  return isHookCarrier(message) && message.parts.every(part => hookDataOf(part) !== null)
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0) ?? ''
}

/** Whole seconds of a duration (at least 1), for "timed out after {n}s". */
function wholeSeconds(ms: number): number {
  return Math.max(1, Math.round(ms / 1000))
}

/** The hook of a record that failed first: a timeout, else a non-zero exit, else one with an error text; else null. */
function failedHook(data: HookData): HookData['hooks'][number] | null {
  return data.hooks.find(hook => hook.timedOut === true)
    ?? data.hooks.find(hook => hook.exitCode !== null && hook.exitCode !== 0)
    ?? data.hooks.find(hook => hook.error !== undefined && hook.error.trim() !== '')
    ?? null
}

/**
 * The note's line (docs/UI.md 7.31, the table by `outcome`; the reason on one line): "Hook added context · {event}",
 * "Blocked by a {event} hook: {reason}", "A hook asked you to confirm this call: {reason}", "Allowed by a {event} hook"
 * (+ ": {reason}"), "Input changed by a {event} hook", "A {event} hook told the agent: {reason}" (the reason, else the
 * first line of the context: a PostToolUse block's feedback), "A {event} hook asked the agent to continue", "A hook
 * stopped the agent: {reason}", "A {event} hook failed: exit {n}" / "A {event} hook timed out after {n}s" / "A {event}
 * hook failed". A missing reason leaves out ": {reason}".
 */
export function hookOutcomeText(data: HookData): string {
  const event = data.event
  const reason = data.reason ? oneLine(data.reason) : ''
  const withReason = (text: string): string => (reason ? `${text}: ${reason}` : text)
  switch (data.outcome) {
    case 'context':
      return `Hook added context · ${event}`
    case 'denied':
      return withReason(`Blocked by a ${event} hook`)
    case 'asked':
      return withReason('A hook asked you to confirm this call')
    case 'allowed':
      return withReason(`Allowed by a ${event} hook`)
    case 'rewritten':
      return `Input changed by a ${event} hook`
    case 'blocked': {
      const feedback = reason || oneLine(firstLine(data.context ?? ''))
      return feedback ? `A ${event} hook told the agent: ${feedback}` : `A ${event} hook sent the agent feedback`
    }
    case 'continued':
      return `A ${event} hook asked the agent to continue`
    case 'stopped':
      return withReason('A hook stopped the agent')
    case 'error': {
      const failed = failedHook(data)
      if (failed?.timedOut === true)
        return `A ${event} hook timed out after ${wholeSeconds(failed.durationMs)}s`
      if (failed && failed.exitCode !== null && failed.exitCode !== 0)
        return `A ${event} hook failed: exit ${failed.exitCode}`
      return `A ${event} hook failed`
    }
  }
}

/**
 * The source line of one hook of a record: "Personal hook" · "Project hook" · "From {plugin}" (the plugin's name, else
 * its id).
 */
export function hookSourceText(hook: HookData['hooks'][number], pluginName: string | null): string {
  switch (hook.source) {
    case 'personal':
      return 'Personal hook'
    case 'project':
      return 'Project hook'
    case 'plugin':
      return `From ${pluginName ?? hook.pluginId ?? 'a plugin'}`
  }
}

/**
 * The polite announcement of a record (ChatView, once per part per tab): "A hook blocked {tool}" for a `denied` record
 * (the row's title, else the record's tool name), "A hook asked the agent to continue" for a `continued` record (a
 * carrier's); null for every other record.
 */
export function hookAnnouncement(data: HookData, toolTitle: string | null): string | null {
  if (data.outcome === 'denied')
    return `A hook blocked ${toolTitle?.trim() || data.toolName || 'a tool call'}`
  if (data.outcome === 'continued')
    return 'A hook asked the agent to continue'
  return null
}

/** What a note's details toggle names: the context, the hooks' output (errors) or the details (the source lines). */
export function hookDetailsKind(data: HookData): 'context' | 'output' | 'details' {
  if (data.outcome === 'context')
    return 'context'
  return data.outcome === 'error' ? 'output' : 'details'
}

/** The plugin of a record's first plugin hook (its name comes from the plugins store, outside this module), else null. */
export function hookPluginId(data: HookData): string | null {
  return data.hooks.find(hook => hook.source === 'plugin' && hook.pluginId)?.pluginId ?? null
}
