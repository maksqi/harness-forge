// Chat contract: UI messages, message metadata, data parts and the `POST /chat` request (API.md sections 4.7, 6).
import type { UIMessage } from 'ai'
import { z } from 'zod'
import { reasoningEffortSchema, toolModeSchema } from './enums.ts'
import { harnessErrorInitSchema } from './errors.ts'
import { chatIdSchema, commandNameSchema, messageIdSchema, modelRefSchema, projectIdSchema, timestampSchema } from './ids.ts'
import { LIMITS } from './limits.ts'
import { todoItemSchema } from './schemas/agent.ts'
import { imageOptionsSchema, imageTurnMetadataSchema } from './schemas/images.ts'
import { queueItemSchema, userMessagePartSchema } from './schemas/queue.ts'
import { messageUsageSchema } from './schemas/usage.ts'
import { utf8ByteLength } from './util/text.ts'

const tokenCountSchema = z.int().min(0)

export { messageUsageSchema } from './schemas/usage.ts'
export type { MessageUsage } from './schemas/usage.ts'

/** A slash command invoked by a user message. */
export const commandInvocationSchema = z.object({
  name: commandNameSchema,
  /** Text after `/name `. */
  input: z.string(),
  /** `compact`: the harness command `/compact [focus]` (Phase 9, ADR-040), run by the server. */
  type: z.enum(['prompt', 'reply', 'compact']),
  /** Prompt commands: the text sent to the model instead (<= 64 KB). */
  expansion: z
    .string()
    .refine(value => utf8ByteLength(value) <= LIMITS.commandExpansionBytes, 'Expansions are limited to 64 KB.')
    .optional(),
})
export type CommandInvocation = z.infer<typeof commandInvocationSchema>

/** Metadata of stored and streamed messages; set by the server (client values are ignored). */
export const messageMetadataSchema = z.object({
  /** Assistant: model used; user: model selected when sent. */
  modelRef: modelRefSchema,
  /** Assistant: stream start; user: time received. */
  startedAt: timestampSchema,
  finishedAt: timestampSchema.optional(),
  durationMs: z.number().min(0).optional(),
  /** Assistant: time spent streaming reasoning parts ("Thought for Ns" after a reload). */
  reasoningMs: z.number().min(0).optional(),
  usage: messageUsageSchema.optional(),
  costUsd: z.number().min(0).optional(),
  /** AI SDK `FinishReason` (`stop`, `length`, `content-filter`, `tool-calls`, `error`, `other`). */
  finishReason: z.string().optional(),
  /** Stopped by the user or by shutdown. */
  aborted: z.boolean().optional(),
  /** The error that ended the message. */
  error: harnessErrorInitSchema.optional(),
  /** User messages that invoked a slash command. */
  command: commandInvocationSchema.optional(),
  /** Image-turn replies (ADR-028): what was requested, set in the `start` metadata (placeholder tiles). */
  image: imageTurnMetadataSchema.optional(),
})
export type MessageMetadata = z.infer<typeof messageMetadataSchema>

export const noticeLevelSchema = z.enum(['info', 'warning'])
/**
 * `generated-file-dropped` (ADR-028): a file the model generated was not stored (not a raster image, or too large);
 * `workspace-unavailable` (ADR-031): the project folder of the chat could not be opened, so the run has no workspace
 * tools (the message names the folder and the reason); `compaction-failed` (ADR-040): the summary could not be written,
 * so the oldest turns were trimmed instead.
 */
export const noticeCodeSchema = z.enum(['context-trimmed', 'approvals-superseded', 'tools-unsupported', 'attachments-unsupported', 'generated-file-dropped', 'workspace-unavailable', 'compaction-failed'])
export type NoticeCode = z.infer<typeof noticeCodeSchema>

/** Data of `data-notice` parts. */
export const noticeDataSchema = z.object({
  level: noticeLevelSchema,
  code: noticeCodeSchema,
  message: z.string(),
})
export type NoticeData = z.infer<typeof noticeDataSchema>

/** What started a compaction: `/compact` (`manual`) or the context guard (`auto`). */
export const compactionTriggerSchema = z.enum(['manual', 'auto'])
export type CompactionTrigger = z.infer<typeof compactionTriggerSchema>

/**
 * What the model still sees in full after a compaction: `none` (only the summary and what follows the marker) or
 * `last-user` (also the user message of the turn that compacted).
 */
export const compactionKeepSchema = z.enum(['none', 'last-user'])
export type CompactionKeep = z.infer<typeof compactionKeepSchema>

/**
 * Data of `data-compaction` parts (ADR-040): a model-written summary that replaces, for the model, everything before
 * the part on the message path (earlier messages and the earlier parts of its own message). Positional: the latest
 * marker on the path wins (`findCompaction`); stored messages are never rewritten.
 */
export const compactionDataSchema = z.object({
  trigger: compactionTriggerSchema,
  keep: compactionKeepSchema,
  /** The summary the model sees instead of the compacted messages (Markdown), at most 60 000 characters. */
  summary: z.string().max(LIMITS.compactionSummaryMaxChars),
  /** The focus of `/compact [focus]`, at most 1000 characters. */
  focus: z.string().max(LIMITS.compactFocusMaxChars).optional(),
  /** The todo list at the time of the compaction (`latestTodos`). */
  todos: z.array(todoItemSchema).max(LIMITS.todoItemsMax).optional(),
  /** The model that wrote the summary. */
  modelRef: modelRefSchema,
  /** Messages the summary replaces. */
  messagesCompacted: tokenCountSchema,
  /** Estimated context tokens before and after the compaction. */
  tokensBefore: tokenCountSchema,
  tokensAfter: tokenCountSchema,
  createdAt: timestampSchema,
})
export type CompactionData = z.infer<typeof compactionDataSchema>

/**
 * Data of `data-steer` parts (ADR-042): a message the user queued while the agent worked, delivered to the model at a
 * step boundary. Stored inside the running assistant message; the model history splits the reply there and sends it as
 * a user message (`splitSteers`).
 */
export const steerDataSchema = z.object({
  /** The id of the queued message (a client-generated `msg_` id). */
  id: messageIdSchema,
  /** The text and file parts of the message, as stored for user messages. */
  parts: z.array(userMessagePartSchema).min(1).max(LIMITS.messagePartsMax),
  queuedAt: timestampSchema,
  deliveredAt: timestampSchema,
})
export type SteerData = z.infer<typeof steerDataSchema>

/** What a run does right now, shown live (`compacting`: a summary is being written). */
export const activityKindSchema = z.enum(['compacting', 'idle'])
export type ActivityKind = z.infer<typeof activityKindSchema>

/** Data of the transient `data-activity` chunks (ADR-040): reach only `onData`, never stored in a message. */
export const activityDataSchema = z.object({
  kind: activityKindSchema,
})
export type ActivityData = z.infer<typeof activityDataSchema>

/** Data part schemas for `useChat({ dataPartSchemas })` and `validateUIMessages({ dataSchemas })`. */
export const harnessDataSchemas = {
  notice: noticeDataSchema,
  compaction: compactionDataSchema,
  steer: steerDataSchema,
  activity: activityDataSchema,
}

/**
 * Data part types (`data-notice`, `data-compaction`, `data-steer`, the transient `data-activity`). A type alias (not an
 * interface) so it satisfies the AI SDK `UIDataTypes`.
 */
// eslint-disable-next-line ts/consistent-type-definitions
export type HarnessDataTypes = { notice: NoticeData, compaction: CompactionData, steer: SteerData, activity: ActivityData }

/** AI SDK v7 UI message of this app; pass `ChatDetail.messages` directly to `useChat({ messages })`. */
export type HarnessUIMessage = UIMessage<MessageMetadata, HarnessDataTypes>
export type HarnessUIMessagePart = HarnessUIMessage['parts'][number]

/** The role of a UI message. */
export const uiMessageRoleSchema = z.enum(['system', 'user', 'assistant'])

function uiMessageSchema(id: z.ZodType<string, string>) {
  return z
    .object({
      id,
      role: uiMessageRoleSchema,
      metadata: z.unknown().optional(),
      parts: z
        .array(z.looseObject({ type: z.string().min(1) }))
        .max(LIMITS.messagePartsMax),
    })
    .pipe(z.custom<HarnessUIMessage>())
}

/**
 * Structural check of a `HarnessUIMessage`: `id`, `role`, optional `metadata`, `parts` as objects with a string
 * `type` (<= 1000 parts; part fields are kept as sent). The server performs the deep check with the AI SDK:
 * `validateUIMessages({ messages, metadataSchema: messageMetadataSchema, dataSchemas: harnessDataSchemas })`.
 */
export const harnessUIMessageSchema = uiMessageSchema(z.string().min(1).max(256))

export const chatTriggerSchema = z.enum(['submit-message', 'regenerate-message'])
export type ChatTrigger = z.infer<typeof chatTriggerSchema>

/**
 * Body of `POST /chat` (max 2 MB): only the last UI message is sent, the server owns history. The messages of a chat
 * form a tree (ADR-023): a new user message names its parent (`parentId`), a regenerate names its target
 * (`messageId`), an approval continuation names neither.
 */
export const chatRequestBodySchema = z.strictObject({
  chatId: chatIdSchema,
  /**
   * The last UI message: a new user message (an edit is a new user message too, with a new id), or the active leaf
   * assistant message (approval continuation).
   */
  message: uiMessageSchema(messageIdSchema),
  trigger: chatTriggerSchema,
  /**
   * `submit-message` with a user message only: the parent of the new message (`null` = a first message). An edit sends
   * the parent of the edited message, so the new message becomes a sibling version of it. Omitted = the chat's active
   * leaf. Sent with a regenerate or an approval continuation -> `400`; unknown -> `404`.
   */
  parentId: messageIdSchema.nullable().optional(),
  /**
   * `regenerate-message` only: the reply to regenerate, or the user message to answer (default: the active leaf).
   * A user message sent with `messageId` is rejected (`400`): in-place edits were removed (ADR-023).
   */
  messageId: messageIdSchema.optional(),
  modelRef: modelRefSchema,
  reasoningEffort: reasoningEffortSchema,
  toolMode: toolModeSchema,
  /**
   * Image options (ADR-028): only for an image model or a chat model with `capabilities.imageOutput`; `n` and
   * `editPrevious` only for image models (else `400` on `['imageOptions']`, checked by the server).
   */
  imageOptions: imageOptionsSchema.optional(),
  /**
   * The project of a new chat (ADR-031): honored only when this request creates the chat (an unknown project is a
   * `404` before the chat row exists); ignored for an existing chat (move a chat with `PATCH /chats/:id`).
   */
  projectId: projectIdSchema.optional(),
})
export type ChatRequestBody = z.infer<typeof chatRequestBodySchema>

/**
 * `POST /chat/:id/stop`: `stopped` is false when no run was active. `dropped` (Phase 9, ADR-042): the queued messages
 * the stop removed, oldest first, for the stopping tab to put back into its composer; absent when none were queued.
 */
export const chatStopResultSchema = z.object({
  stopped: z.boolean(),
  dropped: z.array(queueItemSchema).optional(),
})
export type ChatStopResult = z.infer<typeof chatStopResultSchema>
