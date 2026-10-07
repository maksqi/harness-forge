// Pure helpers of hook records in the transcript (Phase 11, ADR-048; docs/UI.md 7.31, 11.8): the only readers of
// `data-hook` parts on the web. `hookDataOf` validates one part, `toolHooksOf` groups the tool-linked records of a reply
// by tool call id (ToolPart renders them inside the row), `isHookCarrierMessage` recognizes the user-role carrier of a
// turn the server started after a Stop hook blocked (`run.started.origin = 'hook'`). The model's view of a record is the
// server's business (`hookModelText`); the carrier rule is the shared `isHookCarrier` plus a valid record in every part.
// No Vue, no stores. Signatures frozen from Gate P11-0b (C39); `hookDataOf`, `toolHooksOf` and `isHookCarrierMessage` are
// C39's; W11.12 wrote the texts (`hookOutcomeText`, `hookSourceText`, `hookAnnouncement`) and the note helpers below.
// Phase 12 (ADR-057; docs/UI.md 7.34; W12.13): `harnessAsked` ("Allowed by hook · still asks", `hookStillAsks`), prompt
// hooks (`hooks[].kind: 'prompt'`: "Personal prompt hook" / "Project prompt hook" / "Prompt hook from {plugin}" plus "·
// {model}", the label's first line, "The model's answer could not be read." for an unreadable answer), the record that
// decides a tool row's badge (`toolHookDecision`: a `PermissionRequest` decision over the `PreToolUse` one), and a
// `context` record without a context (a prompt hook's reason, or system messages only: `PostCompact`).
import type { HarnessUIMessage, HookData } from '@harness-forge/shared'
import { HOOK_PART_TYPE, hookDataSchema, isHookCarrier, safeParseModelRef } from '@harness-forge/shared'

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

/** + Phase 12: the line of a record whose `PreToolUse` allow harness-forge did not follow (it still showed the card). */
export const HOOK_STILL_ASKS_TEXT = 'Allowed by hook · still asks'

/** + Phase 12: the details line (and the badge's tooltip) of such a record. */
export const HOOK_STILL_ASKS_DETAIL = 'harness-forge still asks for this call (plan mode, a tool that runs commands, or an Always ask policy).'

/** + Phase 12: the details of a prompt hook that failed without an error text of its own (an unreadable answer). */
export const PROMPT_HOOK_UNREADABLE_TEXT = 'The model\'s answer could not be read.'

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
      // + Phase 12: a record without a context: a prompt hook's reason (an answer with no effect), else only system
      // messages (`PostCompact` and the other observe-only events).
      if (hasContext(data))
        return `Hook added context · ${event}`
      return reason ? `A ${event} hook answered: ${reason}` : `A ${event} hook sent a message`
    case 'denied':
      return withReason(`Blocked by a ${event} hook`)
    case 'asked':
      return withReason('A hook asked you to confirm this call')
    case 'allowed':
      // + Phase 12 (ADR-057): the hook allowed it, harness-forge still showed the card.
      if (hookStillAsks(data))
        return HOOK_STILL_ASKS_TEXT
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
 * its id). + Phase 12: a prompt hook reads "Personal prompt hook" · "Project prompt hook" · "Prompt hook from {plugin}".
 */
export function hookSourceText(hook: HookData['hooks'][number], pluginName: string | null): string {
  const prompt = hook.kind === 'prompt'
  switch (hook.source) {
    case 'personal':
      return prompt ? 'Personal prompt hook' : 'Personal hook'
    case 'project':
      return prompt ? 'Project prompt hook' : 'Project hook'
    case 'plugin': {
      const plugin = pluginName ?? hook.pluginId ?? 'a plugin'
      return prompt ? `Prompt hook from ${plugin}` : `From ${plugin}`
    }
  }
}

// ---------- Phase 12 (ADR-057; docs/UI.md 7.34) ----------

/** The record has a model-visible context (not only system messages or a reason). */
function hasContext(data: HookData): boolean {
  return (data.context?.trim() ?? '') !== ''
}

/** A hook allowed the call but harness-forge still asked (`harnessAsked`; `data-state="still-asks"`). */
export function hookStillAsks(data: Pick<HookData, 'outcome' | 'harnessAsked'>): boolean {
  return data.outcome === 'allowed' && data.harnessAsked === true
}

/**
 * The source of one hook with a prompt hook's model: "{source} · {model}" (the model's display name, else the model id
 * of its ref); a command hook or a prompt hook without a model reads `hookSourceText` alone.
 */
export function hookSourceLine(hook: HookData['hooks'][number], pluginName: string | null, modelName: string | null = null): string {
  const source = hookSourceText(hook, pluginName)
  if (hook.kind !== 'prompt' || !hook.model)
    return source
  const model = modelName?.trim() || (safeParseModelRef(hook.model)?.modelId ?? hook.model)
  return `${source} · ${model}`
}

/** The label of one hook as a note shows it: a prompt hook's first line (its prompt), else the label as it is. */
export function hookRunLabel(hook: HookData['hooks'][number]): string {
  return hook.kind === 'prompt' ? firstLine(hook.label) : hook.label
}

/**
 * The error texts of a record's hooks (the `error` details): each hook's own text; a prompt hook of an `error` record
 * without one reads "The model's answer could not be read."
 */
export function hookErrorTexts(data: HookData): string[] {
  return data.hooks.flatMap((hook) => {
    const text = hook.error?.trim()
    if (text)
      return [text]
    return data.outcome === 'error' && hook.kind === 'prompt' ? [PROMPT_HOOK_UNREADABLE_TEXT] : []
  })
}

/** What a tool row's badge shows: the outcome, whether harness-forge still asked, and the record's event. */
export interface ToolHookDecision {
  outcome: 'denied' | 'allowed' | 'rewritten'
  stillAsks: boolean
  event: HookData['event']
}

/**
 * The decision a tool row's badge shows (docs/UI.md 7.31, 7.34): a `PermissionRequest` record's `allowed` / `denied`
 * (it decided the card), else the `PreToolUse` record's `denied` / `allowed` (with `harnessAsked`: still asks) /
 * `rewritten`; null without one of them.
 */
export function toolHookDecision(hooks: readonly HookData[]): ToolHookDecision | null {
  const permission = hooks.find(data => data.event === 'PermissionRequest' && (data.outcome === 'allowed' || data.outcome === 'denied'))
  const record = permission ?? hooks.find(data => data.event === 'PreToolUse' && (data.outcome === 'denied' || data.outcome === 'allowed' || data.outcome === 'rewritten'))
  if (!record)
    return null
  return { outcome: record.outcome as ToolHookDecision['outcome'], stillAsks: hookStillAsks(record), event: record.event }
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
  if (data.outcome === 'context' && hasContext(data))
    return 'context'
  return data.outcome === 'error' ? 'output' : 'details'
}

/** The plugin of a record's first plugin hook (its name comes from the plugins store, outside this module), else null. */
export function hookPluginId(data: HookData): string | null {
  return data.hooks.find(hook => hook.source === 'plugin' && hook.pluginId)?.pluginId ?? null
}
