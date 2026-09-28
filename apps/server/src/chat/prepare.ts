// Everything `POST /chat` does before the stream starts (ARCHITECTURE.md 6.1): classify the request, upsert the chat
// (mode and effort saved as chat settings), resolve the model (`provider_not_configured` before any streaming), plan
// the history operation in memory (slash commands, superseded approvals, edit / regenerate, approval merge), validate
// the new message with `validateUIMessages`, then commit the history change in one transaction. A failure here is a
// normal JSON error response and leaves the history untouched.
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
import { classifyRequest, mergeApprovalDecisions, notFound, supersedeApprovals } from './history.ts'

/** Writes of the history transaction, applied in order: `replace` first, then the upserts. */
export interface HistoryWrites {
  replace: { fromId: string, messages: HarnessUIMessage[] } | null
  upserts: HarnessUIMessage[]
}

export interface PreparedRun {
  kind: RequestKind
  chat: ChatRecord
  resolved: ResolvedModel
  settings: Settings
  /** The history the reply is generated from; for a continuation the continued assistant message is last. */
  history: HarnessUIMessage[]
  /** The new or edited user message. */
  userMessage: HarnessUIMessage | null
  /** The continued assistant message (merged decisions), for a continuation. */
  continued: HarnessUIMessage | null
  /** Id of the assistant message of the reply (server-generated, ADR-019; the continued id for a continuation). */
  assistantId: string
  /** A slash command of the (last) user message that decides the reply: a reply command or a failed `run`. */
  command: CommandResolution | null
  /** Approvals resolved as denied (`superseded`). */
  superseded: number
  writes: HistoryWrites
}

function badRequest(message: string, path: (string | number)[] = []): HarnessError {
  return new HarnessError({ code: 'validation_error', message, details: { issues: [{ path, message, code: 'custom' }] } })
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

/** The stored form of the new or edited user message (server metadata, command invocation). */
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
  const stored = await deps.chats.listMessages(body.chatId)
  const context: PrepareContext = { deps, run, body, resolved, logger }
  const base = { kind, chat, resolved, settings }

  switch (kind) {
    case 'new': {
      if (stored.some(message => message.id === body.message.id))
        throw new HarnessError({ code: 'conflict', message: 'A message with this id already exists.', details: { reason: 'exists', chatId: body.chatId } })
      const { message, command } = await buildUserMessage(context)
      await validateMessage(message)
      const superseded = supersedeApprovals(stored)
      return {
        ...base,
        history: [...superseded.messages, message],
        userMessage: message,
        continued: null,
        assistantId: createMessageId(),
        command: command?.kind === 'prompt' ? null : command,
        superseded: superseded.count,
        writes: { replace: null, upserts: [...superseded.changed, message] },
      }
    }
    case 'edit': {
      const index = stored.findIndex(message => message.id === body.message.id)
      if (index < 0 || stored[index]?.role !== 'user')
        throw notFound(`Message ${body.message.id} is not a user message of this chat.`)
      const { message, command } = await buildUserMessage(context)
      await validateMessage(message)
      const superseded = supersedeApprovals(stored.slice(0, index))
      return {
        ...base,
        history: [...superseded.messages, message],
        userMessage: message,
        continued: null,
        assistantId: createMessageId(),
        command: command?.kind === 'prompt' ? null : command,
        superseded: superseded.count,
        writes: { replace: { fromId: body.message.id, messages: [message] }, upserts: superseded.changed },
      }
    }
    case 'regenerate': {
      let cut: number
      if (body.messageId !== undefined) {
        const index = stored.findIndex(message => message.id === body.messageId)
        if (index < 0)
          throw notFound(`Message ${body.messageId} is not in this chat.`)
        cut = stored[index]?.role === 'assistant' ? index : index + 1
      }
      else {
        cut = stored.at(-1)?.role === 'assistant' ? stored.length - 1 : stored.length
      }
      const kept = stored.slice(0, cut)
      const last = kept.at(-1)
      if (last === undefined || last.role !== 'user')
        throw badRequest('There is no user message to answer.', ['messageId'])
      const superseded = supersedeApprovals(kept)
      const removed = stored[cut]
      return {
        ...base,
        history: superseded.messages,
        userMessage: null,
        continued: null,
        assistantId: createMessageId(),
        command: await regeneratedCommand(context, last),
        superseded: superseded.count,
        writes: { replace: removed === undefined ? null : { fromId: removed.id, messages: [] }, upserts: superseded.changed },
      }
    }
    case 'continuation': {
      const last = stored.at(-1)
      if (last === undefined || last.role !== 'assistant' || last.id !== body.message.id)
        throw notFound('The continuation does not match the last assistant message of this chat.')
      const { message, merged } = mergeApprovalDecisions(last, body.message)
      if (merged === 0)
        throw badRequest('The continuation carries no approval decision for a pending tool call.', ['message', 'parts'])
      await validateMessage(message)
      return {
        ...base,
        history: [...stored.slice(0, -1), message],
        userMessage: null,
        continued: message,
        assistantId: message.id,
        command: null,
        superseded: 0,
        writes: { replace: null, upserts: [message] },
      }
    }
  }
}

/** Applies the history writes atomically. */
export async function commitHistory(deps: Pick<AppDeps, 'chats'>, chatId: string, writes: HistoryWrites): Promise<void> {
  if (writes.replace === null && writes.upserts.length === 0)
    return
  await deps.chats.transaction(async (store) => {
    if (writes.replace !== null)
      await store.replaceFrom(chatId, writes.replace.fromId, writes.replace.messages)
    for (const message of writes.upserts)
      await store.upsertMessage(chatId, message)
  })
}
