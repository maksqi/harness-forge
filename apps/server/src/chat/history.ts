// History operations of `POST /chat` (ARCHITECTURE.md 6.1, API.md 6.2). The server owns history; the request carries
// only the last UI message:
// - new message (`submit-message`, user message, no `messageId`): appended; pending approvals of earlier messages are
//   resolved as denied with reason `superseded`;
// - edit (`submit-message` with `messageId` = the edited user message): that message is replaced, later ones dropped;
// - regenerate (`regenerate-message`): the assistant message `messageId` (default: the last message when it is an
//   assistant message) and every later message are dropped;
// - approval continuation (`submit-message`, the last assistant message): only the approval decisions are merged, by
//   approval id, into the stored copy; every other client change is ignored.
import type { ChatRequestBody, HarnessUIMessage, HarnessUIMessagePart } from '@harness-forge/shared'
import { HarnessError } from '@harness-forge/shared'

export type RequestKind = 'new' | 'edit' | 'regenerate' | 'continuation'

/** `approval.reason` of approvals resolved by a newer user message. */
export const SUPERSEDED_REASON = 'superseded'
/** Maximum length of an approval reason taken from the client. */
const REASON_MAX_CHARS = 500

type LoosePart = Record<string, unknown> & { type: string }

function loose(part: unknown): LoosePart | null {
  return typeof part === 'object' && part !== null && typeof (part as { type?: unknown }).type === 'string' ? part as LoosePart : null
}

function badRequest(message: string, path: (string | number)[]): HarnessError {
  return new HarnessError({ code: 'validation_error', message, details: { issues: [{ path, message, code: 'custom' }] } })
}

export function notFound(message: string): HarnessError {
  return new HarnessError({ code: 'not_found', message })
}

/** The kind of history operation a request asks for; `validation_error` for inconsistent requests. */
export function classifyRequest(body: Pick<ChatRequestBody, 'trigger' | 'message' | 'messageId'>): RequestKind {
  if (body.trigger === 'regenerate-message')
    return 'regenerate'
  const { message, messageId } = body
  if (message.role === 'assistant') {
    if (messageId !== undefined && messageId !== message.id)
      throw badRequest('An approval continuation must send the last assistant message.', ['messageId'])
    return 'continuation'
  }
  if (message.role !== 'user')
    throw badRequest('Only user messages (or the last assistant message of an approval continuation) can be sent.', ['message', 'role'])
  if (messageId === undefined)
    return 'new'
  if (messageId !== message.id)
    throw badRequest('An edited message keeps its id: messageId must equal message.id.', ['messageId'])
  return 'edit'
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

const STOPPED_TOOL_TEXT = 'The run was stopped before the tool finished.'
const FAILED_TOOL_TEXT = 'The run ended before the tool finished.'

/**
 * Parts as persisted: streaming text / reasoning are marked done; tool calls that never got a result (the run was
 * stopped or failed mid-call) become `output-error` so no row spins forever after a reload.
 */
export function finalizeParts(parts: readonly HarnessUIMessagePart[], ending: RunEnding): HarnessUIMessagePart[] {
  return parts.map((part) => {
    const value = part as unknown as LoosePart
    if ((value.type === 'text' || value.type === 'reasoning') && value.state === 'streaming')
      return { ...value, state: 'done' } as unknown as HarnessUIMessagePart
    if (isToolPart(value) && (value.state === 'input-streaming' || value.state === 'input-available')) {
      const { approval: _approval, output: _output, ...rest } = value
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
