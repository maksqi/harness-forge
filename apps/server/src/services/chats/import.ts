// Imported messages (API.md 5.9: `POST /chats` with `messages`; `ChatsService.importChat`, ADR-024): the UI messages are
// deep-validated with the AI SDK (`validateUIMessages` with the message metadata and data part schemas), streaming
// parts are finalized, pending tool approvals are resolved as denied, the message tree (`parentIds`, `activeLeafId`,
// ADR-023) is validated before anything is written, and message ids are kept or replaced. Pending approvals are denied
// through `denyOpenApprovals` (./approvals.ts, shared with the key rotation).
import type { HarnessUIMessage, HarnessUIMessagePart } from '@harness-forge/shared'
import { createMessageId, harnessDataSchemas, MESSAGE_ID_PATTERN, messageMetadataSchema, validationError } from '@harness-forge/shared'
import { safeValidateUIMessages } from 'ai'
import { denyOpenApprovals } from './approvals.ts'

/** `approval.reason` of approvals that were still pending when the chat was imported. */
export const IMPORT_DENIAL_REASON = 'imported'

type IssuePath = readonly (string | number)[]

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
function importValidationError(error: unknown, prefix: IssuePath): Error {
  const cause = (error as { cause?: unknown }).cause
  const field = (error as { context?: { field?: unknown } }).context?.field
  const base = [...prefix, ...(typeof field === 'string' && field.startsWith('messages') ? fieldPath(field) : ['messages'])]
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

/** Finalizes streaming text / reasoning. */
function finalizePart(part: HarnessUIMessagePart): HarnessUIMessagePart {
  const loose = part as unknown as Record<string, unknown>
  if ((part.type === 'text' || part.type === 'reasoning') && loose.state === 'streaming')
    return { ...part, state: 'done' }
  return part
}

/** Finalizes streaming text / reasoning and denies approvals that can no longer be answered. */
function resolveParts(parts: HarnessUIMessagePart[]): HarnessUIMessagePart[] {
  return denyOpenApprovals(parts.map(finalizePart), IMPORT_DENIAL_REASON).parts
}

/**
 * Deep-validates imported messages (metadata optional, validated when present; data parts against
 * `harnessDataSchemas`), then finalizes their parts. Throws `validation_error` with the zod issue paths under
 * `[...prefix, 'messages']`. An empty list stays empty.
 */
export async function validateImportedMessages(input: readonly HarnessUIMessage[], prefix: IssuePath = []): Promise<HarnessUIMessage[]> {
  if (input.length === 0)
    return []
  const result = await safeValidateUIMessages<HarnessUIMessage>({
    messages: input,
    metadataSchema: messageMetadataSchema.optional(),
    dataSchemas: harnessDataSchemas,
  })
  if (!result.success)
    throw importValidationError(result.error, prefix)
  return result.data.map(message => ({ ...message, parts: resolveParts(message.parts) }))
}

/** The message tree of an import, by position (see `planImportTree`). */
export interface ImportTree {
  /** The parent of each message by index (`-1` = a first message); always an earlier index. */
  parentIndex: number[]
  /** The index of the active leaf: the most recent leaf under the requested message; `-1` without messages. */
  leafIndex: number
}

/**
 * Validates the tree of an import before anything is written and turns it into positions (ids may still be replaced).
 * Without `parentIds` the chat is linear (each message the child of the one before it; repeated ids are allowed and
 * replaced later). With `parentIds`: one per message, each `null` or the id of an EARLIER message, and the ids unique.
 * The active leaf is the most recent leaf (the highest position) under `activeLeafId`, or under the last message when
 * it is absent or null. `validation_error` with the field path under `prefix`: `parentIds`, `parentIds.<i>`,
 * `messages.<i>.id` (a repeated id) or `activeLeafId`.
 */
export function planImportTree(
  ids: readonly string[],
  parentIds: readonly (string | null)[] | undefined,
  activeLeafId: string | null | undefined,
  prefix: IssuePath = [],
): ImportTree {
  const invalid = (path: (string | number)[], message: string): Error =>
    validationError([{ path: [...prefix, ...path], message, code: 'custom' }])
  let parentIndex = ids.map((_id, index) => index - 1)
  if (parentIds !== undefined) {
    if (parentIds.length !== ids.length)
      throw invalid(['parentIds'], `Expected ${ids.length} parent ids, one per message.`)
    const indexOf = new Map<string, number>()
    ids.forEach((id, index) => {
      if (indexOf.has(id))
        throw invalid(['messages', index, 'id'], 'Message ids must be unique.')
      indexOf.set(id, index)
    })
    parentIndex = parentIds.map((parentId, index) => {
      if (parentId === null)
        return -1
      const at = indexOf.get(parentId)
      if (at === undefined || at >= index)
        throw invalid(['parentIds', index], 'Expected null or the id of an earlier message.')
      return at
    })
  }
  let start = ids.length - 1
  if (activeLeafId !== undefined && activeLeafId !== null) {
    start = ids.indexOf(activeLeafId)
    if (start < 0)
      throw invalid(['activeLeafId'], 'Expected the id of a message of the chat.')
  }
  if (start < 0)
    return { parentIndex, leafIndex: -1 }
  // A child always comes after its parent: one pass collects the subtree and its highest position.
  const subtree = new Set([start])
  let leafIndex = start
  for (let index = start + 1; index < ids.length; index++) {
    if (subtree.has(parentIndex[index] ?? -1)) {
      subtree.add(index)
      leafIndex = index
    }
  }
  return { parentIndex, leafIndex }
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

/** A new id for every message (an import as a copy). */
export function freshMessageIds(list: readonly HarnessUIMessage[]): HarnessUIMessage[] {
  const used = new Set<string>()
  return list.map((message) => {
    let id: string
    do
      id = createMessageId()
    while (used.has(id))
    used.add(id)
    return { ...message, id }
  })
}
