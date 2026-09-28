// Everything `POST /chat` does before the stream starts (ARCHITECTURE.md 6.1 / 6.8): classify the request, upsert the
// chat (mode and effort saved as chat settings), resolve the model (`provider_not_configured` before any streaming),
// plan the history operation in memory (the path it continues, slash commands, superseded approvals, the approval
// merge), validate the new message with `validateUIMessages`, then commit the history change and the active leaf in one
// transaction. A failure here is a normal JSON error response and leaves the history untouched. Nothing is ever deleted
// (ADR-023): an edit adds a sibling user message, a regenerate a sibling reply.
import type { ChatRequestBody, HarnessUIMessage, HarnessUIMessagePart, MessageMetadata, Settings } from '@harness-forge/shared'
import type { Logger } from '../logger.ts'
import type { ResolvedModel } from '../providers/types.ts'
import type { ChatRecord } from '../services/chats/types.ts'
import type { AppDeps } from '../types.ts'
import type { CommandResolution } from './commands.ts'
import type { RequestKind } from './history.ts'
import type { Run } from './runs.ts'
import { createMessageId, harnessDataSchemas, HarnessError, isHarnessError, messageMetadataSchema, validationError } from '@harness-forge/shared'
import { safeValidateUIMessages } from 'ai'
import { resolveCommand } from './commands.ts'
import { normalizeUserParts } from './files.ts'
import { badRequest, classifyRequest, mergeApprovalDecisions, notFound, supersedeApprovals } from './history.ts'

/** A message write of the history transaction. */
export interface MessageWrite {
  message: HarnessUIMessage
  /** The parent when the message is new; an existing message keeps its own. */
  parentId: string | null
}

/** Writes of the history transaction, applied in order: `updates`, `append`, then the active leaf. */
export interface HistoryWrites {
  /** Stored messages that change: superseded approvals, the merged decisions of a continuation. */
  updates: MessageWrite[]
  /** The new user message (kind `new`). */
  append: MessageWrite | null
  /** The active leaf after the commit: the new user message, the answered message or the continued message. */
  activeLeafId: string
}

export interface PreparedRun {
  kind: RequestKind
  chat: ChatRecord
  resolved: ResolvedModel
  settings: Settings
  /** The path the reply is generated from, first message first; for a continuation the continued message is last. */
  history: HarnessUIMessage[]
  /** The new user message. */
  userMessage: HarnessUIMessage | null
  /** The continued assistant message (merged decisions), for a continuation. */
  continued: HarnessUIMessage | null
  /** Id of the assistant message of the reply (server-generated, ADR-019; the continued id for a continuation). */
  assistantId: string
  /**
   * The parent of the reply: the new user message, the answered message of a regenerate, or the parent of the continued
   * message. The persisted reply is stored under it and becomes the active leaf only while the leaf is still this
   * message (or the reply itself).
   */
  replyParentId: string | null
  /** A slash command of the (last) user message that decides the reply: a reply command or a failed `run`. */
  command: CommandResolution | null
  /** Approvals resolved as denied (`superseded`). */
  superseded: number
  writes: HistoryWrites
}

/** The request was stopped before its history was stored. */
export function stoppedBeforeStart(chatId: string): HarnessError {
  return new HarnessError({ code: 'conflict', message: 'The run was stopped before it started.', details: { reason: 'stale', chatId } })
}

/** `resolveModel`, with an unknown provider reported as `provider_not_configured` (API.md 2.2). */
export async function resolveChatModel(deps: Pick<AppDeps, 'providers'>, modelRef: string, signal: AbortSignal): Promise<ResolvedModel> {
  try {
    return await deps.providers.resolveModel(modelRef, { signal })
  }
  catch (error) {
    if (isHarnessError(error) && error.code === 'not_found' && error.providerId !== undefined) {
      throw new HarnessError(
        { code: 'provider_not_configured', message: `The provider "${error.providerId}" is not available. Pick another model or install the provider.`, providerId: error.providerId, action: 'configure-provider' },
        { cause: error },
      )
    }
    throw error
  }
}

/** Deep check of one message (AI SDK `validateUIMessages` with the metadata and data part schemas). */
export async function validateMessage(message: HarnessUIMessage): Promise<void> {
  const result = await safeValidateUIMessages<HarnessUIMessage>({
    messages: [message],
    metadataSchema: messageMetadataSchema.optional(),
    dataSchemas: harnessDataSchemas,
  })
  if (result.success)
    return
  const cause = (result.error as { cause?: { issues?: unknown } }).cause
  const raw = Array.isArray(cause?.issues) ? cause.issues as { code?: unknown, message?: unknown, path?: unknown }[] : []
  const issues = raw.slice(0, 20).map(issue => ({
    code: typeof issue.code === 'string' ? issue.code : 'custom',
    message: typeof issue.message === 'string' ? issue.message : 'Invalid value.',
    path: ['message', ...(Array.isArray(issue.path) ? issue.path.filter((key): key is string | number => typeof key === 'string' || typeof key === 'number') : [])],
  }))
  throw validationError(issues.length > 0 ? issues : [{ code: 'custom', message: 'Invalid UI message.', path: ['message'] }])
}

function firstTextOf(parts: readonly HarnessUIMessagePart[]): string {
  for (const part of parts) {
    if (part.type === 'text')
      return part.text
  }
  return ''
}

interface PrepareContext {
  deps: AppDeps
  run: Run
  body: ChatRequestBody
  resolved: ResolvedModel
  logger: Logger
}

/** The stored form of the new user message (server metadata, command invocation). */
async function buildUserMessage(context: PrepareContext): Promise<{ message: HarnessUIMessage, command: CommandResolution | null }> {
  const { deps, run, body, resolved } = context
  const parts = await normalizeUserParts(body.message.parts, deps.files)
  const command = await resolveCommand(deps, firstTextOf(parts), { chatId: body.chatId, signal: run.signal })
  const metadata: MessageMetadata = {
    modelRef: resolved.modelRef,
    startedAt: run.acceptedAt,
    ...(command === null ? {} : { command: command.invocation }),
  }
  return { message: { id: body.message.id, role: 'user', parts, metadata }, command }
}

/** The command that decides a regenerated reply: a reply command is run again (a prompt command keeps its expansion). */
async function regeneratedCommand(context: PrepareContext, userMessage: HarnessUIMessage): Promise<CommandResolution | null> {
  if (userMessage.metadata?.command?.type !== 'reply')
    return null
  const resolution = await resolveCommand(context.deps, firstTextOf(userMessage.parts), { chatId: context.body.chatId, signal: context.run.signal })
  return resolution?.kind === 'prompt' ? null : resolution
}

/** The writes of changed path messages, each with its parent on the path (unused: they are stored already). */
function pathWrites(changed: readonly HarnessUIMessage[], path: readonly HarnessUIMessage[]): MessageWrite[] {
  const parentOf = new Map(path.map((message, index) => [message.id, path[index - 1]?.id ?? null]))
  return changed.map(message => ({ message, parentId: parentOf.get(message.id) ?? null }))
}

/**
 * Validates and plans the request. Throws `validation_error`, `not_found`, `conflict`, `provider_not_configured` (and
 * the other resolution errors) before anything but the chat row is written.
 */
export async function prepareRun(deps: AppDeps, run: Run, body: ChatRequestBody, logger: Logger): Promise<PreparedRun> {
  const kind = classifyRequest(body)
  const { chat } = await deps.chats.ensure(body.chatId, {
    modelRef: body.modelRef,
    settings: { toolMode: body.toolMode, reasoningEffort: body.reasoningEffort },
  })
  const resolved = await resolveChatModel(deps, body.modelRef, run.signal)
  deps.catalog.markUsed(resolved.providerId, resolved.modelId).catch((error: unknown) => logger.debug('cannot record the model use', { err: error }))
  const settings = await deps.settings.get()
  const context: PrepareContext = { deps, run, body, resolved, logger }
  const base = { kind, chat, resolved, settings }

  switch (kind) {
    case 'new': {
      if (await deps.chats.getMessage(body.chatId, body.message.id) !== null)
        throw new HarnessError({ code: 'conflict', message: 'A message with this id already exists.', details: { reason: 'exists', chatId: body.chatId } })
      // The path the message continues: `parentId`, or the active leaf when it is omitted (`not_found` when unknown).
      const parentId = body.parentId === undefined ? chat.activeLeafId : body.parentId
      const path = await deps.chats.listPath(body.chatId, parentId)
      const { message, command } = await buildUserMessage(context)
      await validateMessage(message)
      // Only the approvals of this path: those of other versions stay pending.
      const superseded = supersedeApprovals(path)
      return {
        ...base,
        history: [...superseded.messages, message],
        userMessage: message,
        continued: null,
        assistantId: createMessageId(),
        replyParentId: message.id,
        command: command?.kind === 'prompt' ? null : command,
        superseded: superseded.count,
        writes: { updates: pathWrites(superseded.changed, path), append: { message, parentId }, activeLeafId: message.id },
      }
    }
    case 'regenerate': {
      // The target is a user message to answer, or a reply whose previous message on its path is answered instead.
      const target = body.messageId ?? chat.activeLeafId
      const path = target === null ? [] : await deps.chats.listPath(body.chatId, target)
      const answeredIndex = path.at(-1)?.role === 'user' ? path.length - 1 : path.length - 2
      const answered = path[answeredIndex]
      if (answered === undefined || answered.role !== 'user')
        throw badRequest('There is no user message to answer.', ['messageId'])
      const kept = path.slice(0, answeredIndex + 1)
      const superseded = supersedeApprovals(kept)
      return {
        ...base,
        history: superseded.messages,
        userMessage: null,
        continued: null,
        assistantId: createMessageId(),
        replyParentId: answered.id,
        command: await regeneratedCommand(context, answered),
        superseded: superseded.count,
        writes: { updates: pathWrites(superseded.changed, kept), append: null, activeLeafId: answered.id },
      }
    }
    case 'continuation': {
      if (chat.activeLeafId === null || chat.activeLeafId !== body.message.id)
        throw notFound('The continuation does not match the active leaf of this chat.')
      const path = await deps.chats.listPath(body.chatId, chat.activeLeafId)
      const last = path.at(-1)
      if (last === undefined || last.role !== 'assistant' || last.id !== body.message.id)
        throw notFound('The continuation does not match the active leaf of this chat.')
      const { message, merged } = mergeApprovalDecisions(last, body.message)
      if (merged === 0)
        throw badRequest('The continuation carries no approval decision for a pending tool call.', ['message', 'parts'])
      await validateMessage(message)
      const parentId = path.at(-2)?.id ?? null
      return {
        ...base,
        history: [...path.slice(0, -1), message],
        userMessage: null,
        continued: message,
        assistantId: message.id,
        replyParentId: parentId,
        command: null,
        superseded: 0,
        writes: { updates: [{ message, parentId }], append: null, activeLeafId: message.id },
      }
    }
  }
}

/**
 * Applies the history writes atomically and moves the active leaf (not a compare-and-set: the request's own message
 * wins over a concurrent version switch). A write that stores nothing fails the whole commit.
 */
export async function commitHistory(deps: Pick<AppDeps, 'chats'>, chatId: string, writes: HistoryWrites): Promise<void> {
  const leafMissing = (): HarnessError => notFound(`Message ${writes.activeLeafId} not found in chat ${chatId}.`)
  if (writes.updates.length === 0 && writes.append === null) {
    // Only the leaf moves (a regenerate): a single statement.
    if (!await deps.chats.setActiveLeaf(chatId, writes.activeLeafId))
      throw leafMissing()
    return
  }
  await deps.chats.transaction(async (store) => {
    for (const { message, parentId } of writes.updates)
      await store.upsertMessage(chatId, message, parentId)
    if (writes.append !== null)
      await store.appendMessage(chatId, writes.append.message, writes.append.parentId)
    if (!await store.setActiveLeaf(chatId, writes.activeLeafId))
      throw leafMissing()
  })
}
