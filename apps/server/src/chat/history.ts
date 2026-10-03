// History operations of `POST /chat` (ARCHITECTURE.md 6.1 / 6.8, API.md 6.2). The server owns history; the request
// carries only the last UI message, and the messages of a chat form a tree (ADR-023): nothing is ever deleted.
// - new (`submit-message` with a user message): the message is stored under `parentId` (omitted = the active leaf,
//   `null` = a first message) and becomes the active leaf; pending approvals on the path to it are resolved as denied
//   with reason `superseded`. An edit is a new message whose parent is the edited message's parent (a sibling
//   version);
// - regenerate (`regenerate-message`): `messageId` (default: the active leaf) is a user message to answer, or a reply
//   whose previous message on its path is the user message to answer; the new reply becomes a sibling of the old one;
// - approval continuation (`submit-message` with the active leaf assistant message): only the approval decisions are
//   merged, by approval id, into the stored copy; every other client change is ignored.
import type { ChatRequestBody, HarnessUIMessage, HarnessUIMessagePart } from '@harness-forge/shared'
import { HarnessError, LIMITS } from '@harness-forge/shared'

export type RequestKind = 'new' | 'regenerate' | 'continuation'

/** `approval.reason` of approvals resolved by a newer user message. */
export const SUPERSEDED_REASON = 'superseded'
/** Maximum length of an approval reason taken from the client (Phase 9: plan feedback travels as the reason). */
const REASON_MAX_CHARS = LIMITS.approvalReasonMaxChars

type LoosePart = Record<string, unknown> & { type: string }

function loose(part: unknown): LoosePart | null {
  return typeof part === 'object' && part !== null && typeof (part as { type?: unknown }).type === 'string' ? part as LoosePart : null
}

export function badRequest(message: string, path: (string | number)[] = []): HarnessError {
  return new HarnessError({ code: 'validation_error', message, details: { issues: [{ path, message, code: 'custom' }] } })
}

export function notFound(message: string): HarnessError {
  return new HarnessError({ code: 'not_found', message })
}

/**
 * The kind of history operation a request asks for; `validation_error` for inconsistent requests: `parentId` on a
 * regenerate or a continuation, `messageId` on a user message (in-place edits were removed, ADR-023) or a
 * `messageId` other than the continued message, a role other than user / assistant.
 */
export function classifyRequest(body: Pick<ChatRequestBody, 'trigger' | 'message' | 'messageId' | 'parentId'>): RequestKind {
  const { message, messageId, parentId } = body
  if (body.trigger === 'regenerate-message') {
    if (parentId !== undefined)
      throw badRequest('A regenerate names its target with messageId, not parentId.', ['parentId'])
    return 'regenerate'
  }
  if (message.role === 'assistant') {
    if (parentId !== undefined)
      throw badRequest('An approval continuation continues the active leaf: it sends no parentId.', ['parentId'])
    if (messageId !== undefined && messageId !== message.id)
      throw badRequest('An approval continuation must send the active leaf assistant message.', ['messageId'])
    return 'continuation'
  }
  if (message.role !== 'user')
    throw badRequest('Only user messages (or the active leaf assistant message of an approval continuation) can be sent.', ['message', 'role'])
  if (messageId !== undefined)
    throw badRequest('messageId is only for regenerate-message: an edit is a new user message whose parentId is the parent of the edited message.', ['messageId'])
  return 'new'
}

/** A UI tool part (`tool-<name>` or `dynamic-tool`). */
export function isToolPart(part: unknown): part is LoosePart & { state?: unknown, approval?: unknown } {
  const value = loose(part)
  return value !== null && (value.type.startsWith('tool-') || value.type === 'dynamic-tool')
}

function approvalOf(part: LoosePart): Record<string, unknown> | null {
  const approval = part.approval
  return typeof approval === 'object' && approval !== null ? approval as Record<string, unknown> : null
}

/** The assistant message ends with a tool call waiting for the user (`RunFinishedData.awaitingApproval`). */
export function hasPendingApproval(message: HarnessUIMessage | undefined): boolean {
  return message?.role === 'assistant' && message.parts.some(part => isToolPart(part) && part.state === 'approval-requested')
}

/**
 * Resolves unanswered approvals (`approval-requested`) and approvals that were answered but never processed
 * (`approval-responded`) as denied with reason `superseded`. Returns the changed messages only.
 */
export function supersedeApprovals(messages: readonly HarnessUIMessage[]): { messages: HarnessUIMessage[], changed: HarnessUIMessage[], count: number } {
  let count = 0
  const changed: HarnessUIMessage[] = []
  const result = messages.map((message) => {
    if (message.role !== 'assistant')
      return message
    let touched = false
    const parts = message.parts.map((part) => {
      if (!isToolPart(part) || (part.state !== 'approval-requested' && part.state !== 'approval-responded'))
        return part
      const approval = approvalOf(part)
      if (approval === null || typeof approval.id !== 'string')
        return part
      touched = true
      count += 1
      return {
        ...part,
        state: 'output-denied',
        approval: { ...approval, approved: false, reason: SUPERSEDED_REASON },
      } as unknown as HarnessUIMessagePart
    })
    if (!touched)
      return message
    const next = { ...message, parts }
    changed.push(next)
    return next
  })
  return { messages: result, changed, count }
}

/**
 * Merges the approval decisions of the client's copy of the last assistant message into the stored copy, by approval
 * id: an `approval-requested` part becomes `approval-responded` with `approved` (and an optional `reason`). Nothing
 * else of the client's copy is used.
 */
export function mergeApprovalDecisions(stored: HarnessUIMessage, incoming: HarnessUIMessage): { message: HarnessUIMessage, merged: number } {
  const decisions = new Map<string, { approved: boolean, reason?: string }>()
  for (const part of incoming.parts as unknown[]) {
    if (!isToolPart(part))
      continue
    const approval = approvalOf(part)
    if (approval === null || typeof approval.id !== 'string' || typeof approval.approved !== 'boolean')
      continue
    const reason = typeof approval.reason === 'string' && approval.reason.trim() !== '' ? approval.reason.trim().slice(0, REASON_MAX_CHARS) : undefined
    decisions.set(approval.id, reason === undefined ? { approved: approval.approved } : { approved: approval.approved, reason })
  }
  let merged = 0
  const parts = stored.parts.map((part) => {
    if (!isToolPart(part) || part.state !== 'approval-requested')
      return part
    const approval = approvalOf(part)
    const decision = approval !== null && typeof approval.id === 'string' ? decisions.get(approval.id) : undefined
    if (approval === null || decision === undefined)
      return part
    merged += 1
    const { reason: _requested, ...rest } = approval
    return {
      ...part,
      state: 'approval-responded',
      approval: { ...rest, approved: decision.approved, ...(decision.reason === undefined ? {} : { reason: decision.reason }) },
    } as unknown as HarnessUIMessagePart
  })
  return { message: { ...stored, parts }, merged }
}

/** How a run ended, for part finalization. */
export type RunEnding = 'completed' | 'aborted' | 'failed'

export const STOPPED_TOOL_TEXT = 'The run was stopped before the tool finished.'
export const FAILED_TOOL_TEXT = 'The run ended before the tool finished.'

/** A tool part that never got its final output: no result yet, or only a preliminary one (Phase 9, a streaming tool). */
function isUnfinishedToolPart(part: LoosePart): boolean {
  return isToolPart(part) && (part.state === 'input-streaming' || part.state === 'input-available'
    || (part.state === 'output-available' && part.preliminary === true))
}

/**
 * Parts as persisted: streaming text / reasoning are marked done; tool calls that never got a result (the run was
 * stopped or failed mid-call) become `output-error` so no row spins forever after a reload. Phase 9 (ADR-043): a part
 * still holding a preliminary output (a `task` sub-agent, a streaming plugin tool) counts as unfinished too, so the
 * progress trace of a stopped call is not kept.
 */
export function finalizeParts(parts: readonly HarnessUIMessagePart[], ending: RunEnding): HarnessUIMessagePart[] {
  return parts.map((part) => {
    const value = part as unknown as LoosePart
    if ((value.type === 'text' || value.type === 'reasoning') && value.state === 'streaming')
      return { ...value, state: 'done' } as unknown as HarnessUIMessagePart
    if (isUnfinishedToolPart(value)) {
      const { approval: _approval, output: _output, preliminary: _preliminary, ...rest } = value
      return {
        ...rest,
        state: 'output-error',
        errorText: ending === 'aborted' ? STOPPED_TOOL_TEXT : FAILED_TOOL_TEXT,
      } as unknown as HarnessUIMessagePart
    }
    return part
  })
}

/** The text of the first text part (where a slash command is read). */
export function firstText(message: HarnessUIMessage): string {
  for (const part of message.parts) {
    if (part.type === 'text')
      return part.text
  }
  return ''
}

/** Plain text of a message's text parts joined with a space (titles). */
export function plainText(message: HarnessUIMessage): string {
  return message.parts.flatMap(part => (part.type === 'text' ? [part.text] : [])).join(' ').trim()
}
