// Pure helpers of hook records in the transcript (Phase 11, ADR-048; docs/UI.md 7.31, 11.8): the only readers of
// `data-hook` parts on the web. `hookDataOf` validates one part, `toolHooksOf` groups the tool-linked records of a reply
// by tool call id (ToolPart renders them inside the row), `isHookCarrierMessage` recognizes the user-role carrier of a
// turn the server started after a Stop hook blocked (`run.started.origin = 'hook'`). The model's view of a record is the
// server's business (`hookModelText`); the carrier rule is the shared `isHookCarrier` plus a valid record in every part.
// No Vue, no stores. Signatures frozen from Gate P11-0b (C39); `hookDataOf`, `toolHooksOf` and `isHookCarrierMessage` are
// complete; W11.12 owns the texts in P11-A (P11-0b: plain placeholders).
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

/** The note's line (docs/UI.md 7.31, the table by `outcome`). P11-0b placeholder: "Hook · {event}"; W11.12 implements it. */
export function hookOutcomeText(data: HookData): string {
  return `Hook · ${data.event}`
}

/**
 * The source line of one hook of a record: "Personal hook" · "Project hook" · "From {plugin}" (the plugin's name, else its
 * id). P11-0b placeholder; W11.12 implements it.
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
 * The polite announcement of a record ("A hook blocked {tool}" for a `denied` record, "A hook asked the agent to
 * continue" for a carrier's `continued` record), else null. P11-0b: null for every record; W11.12 implements it.
 */
export function hookAnnouncement(_data: HookData, _toolTitle: string | null): string | null {
  return null
}
