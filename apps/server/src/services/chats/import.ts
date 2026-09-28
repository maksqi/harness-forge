// `POST /chats` with `messages` (API.md 5.9): the imported UI messages are deep-validated with the AI SDK
// (`validateUIMessages` with the message metadata and data part schemas), streaming parts are finalized, pending tool
// approvals are resolved as denied, and invalid or already used message ids are replaced with new ones.
import type { HarnessUIMessage, HarnessUIMessagePart } from '@harness-forge/shared'
import { createMessageId, harnessDataSchemas, MESSAGE_ID_PATTERN, messageMetadataSchema, validationError } from '@harness-forge/shared'
import { safeValidateUIMessages } from 'ai'

/** `approval.reason` of approvals that were still pending when the chat was imported. */
export const IMPORT_DENIAL_REASON = 'imported'

interface IssueLike {
  code: string
  message: string
  path: PropertyKey[]
}

/** `messages[3].metadata` -> `['messages', 3, 'metadata']`. */
function fieldPath(field: string): (string | number)[] {
  const path: (string | number)[] = []
  for (const match of field.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    if (match[2] !== undefined)
      path.push(Number(match[2]))
    else if (match[1] !== undefined)
      path.push(match[1])
  }
  return path
}

/**
 * A `validation_error` for a failed `validateUIMessages`. Only zod issue paths and messages are used: the SDK error
 * message embeds the whole rejected value, which must not be echoed.
 */
function importValidationError(error: unknown): Error {
  const cause = (error as { cause?: unknown }).cause
  const field = (error as { context?: { field?: unknown } }).context?.field
  const base = typeof field === 'string' && field.startsWith('messages') ? fieldPath(field) : ['messages']
  const rawIssues = typeof cause === 'object' && cause !== null ? (cause as { issues?: unknown }).issues : undefined
  const issues: IssueLike[] = []
  if (Array.isArray(rawIssues)) {
    for (const issue of rawIssues.slice(0, 20)) {
      const { code, message, path } = issue as { code?: unknown, message?: unknown, path?: unknown }
      issues.push({
        code: typeof code === 'string' ? code : 'custom',
        message: typeof message === 'string' ? message : 'Invalid value.',
        path: [...base, ...(Array.isArray(path) ? path.filter(key => typeof key === 'string' || typeof key === 'number') : [])],
      })
    }
  }
  if (issues.length === 0)
    issues.push({ code: 'custom', message: 'Invalid UI message.', path: base })
  return validationError(issues)
}

function isToolPart(type: string): boolean {
  return type.startsWith('tool-') || type === 'dynamic-tool'
}

/** Finalizes streaming text / reasoning and denies approvals that can no longer be answered. */
function resolvePart(part: HarnessUIMessagePart): HarnessUIMessagePart {
  const loose = part as unknown as Record<string, unknown>
  if ((part.type === 'text' || part.type === 'reasoning') && loose.state === 'streaming')
    return { ...part, state: 'done' }
  if (isToolPart(part.type) && (loose.state === 'approval-requested' || loose.state === 'approval-responded')) {
    const approval = (loose.approval ?? {}) as Record<string, unknown>
    const keepReason = loose.state === 'approval-responded' && approval.approved === false && typeof approval.reason === 'string'
    return {
      ...loose,
      state: 'output-denied',
      approval: { ...approval, approved: false, reason: keepReason ? approval.reason : IMPORT_DENIAL_REASON },
    } as unknown as HarnessUIMessagePart
  }
  return part
}

/**
 * Deep-validates imported messages (metadata optional, validated when present; data parts against
 * `harnessDataSchemas`), then finalizes their parts. Throws `validation_error` with the zod issue paths under
 * `messages`. An empty list stays empty.
 */
export async function validateImportedMessages(input: readonly HarnessUIMessage[]): Promise<HarnessUIMessage[]> {
  if (input.length === 0)
    return []
  const result = await safeValidateUIMessages<HarnessUIMessage>({
    messages: input,
    metadataSchema: messageMetadataSchema.optional(),
    dataSchemas: harnessDataSchemas,
  })
  if (!result.success)
    throw importValidationError(result.error)
  return result.data.map(message => ({ ...message, parts: message.parts.map(resolvePart) }))
}

/**
 * Keeps each message id that is a valid `msg_` id, not `taken` (used by another chat) and not repeated earlier in the
 * list; every other message gets a new id.
 */
export function assignMessageIds(list: readonly HarnessUIMessage[], taken: ReadonlySet<string>): HarnessUIMessage[] {
  const used = new Set<string>()
  return list.map((message) => {
    let id = message.id
    if (!MESSAGE_ID_PATTERN.test(id) || taken.has(id) || used.has(id)) {
      do
        id = createMessageId()
      while (taken.has(id) || used.has(id))
    }
    used.add(id)
    return id === message.id ? message : { ...message, id }
  })
}
