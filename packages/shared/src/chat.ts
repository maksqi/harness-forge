// Chat contract: UI messages, message metadata, data parts and the `POST /chat` request (API.md sections 4.7, 6).
import type { UIMessage } from 'ai'
import { z } from 'zod'
import { reasoningEffortSchema, toolModeSchema } from './enums.ts'
import { harnessErrorInitSchema } from './errors.ts'
import { chatIdSchema, commandNameSchema, messageIdSchema, modelRefSchema, projectIdSchema, timestampSchema } from './ids.ts'
import { LIMITS } from './limits.ts'
import { imageOptionsSchema, imageTurnMetadataSchema } from './schemas/images.ts'
import { utf8ByteLength } from './util/text.ts'

const tokenCountSchema = z.int().min(0)

/** Tokens summed over all steps of a message. */
export const messageUsageSchema = z.object({
  /** AI SDK `usage.inputTokens`. */
  inputTokens: tokenCountSchema.optional(),
  /** `usage.outputTokens` (includes reasoning). */
  outputTokens: tokenCountSchema.optional(),
  /** `usage.outputTokenDetails.reasoningTokens`. */
  reasoningTokens: tokenCountSchema.optional(),
  /** `usage.inputTokenDetails.cacheReadTokens`. */
  cacheReadTokens: tokenCountSchema.optional(),
  /** `usage.inputTokenDetails.cacheWriteTokens`. */
  cacheWriteTokens: tokenCountSchema.optional(),
  totalTokens: tokenCountSchema.optional(),
  /** Input + output tokens of the final step: current context occupancy (context ring). */
  contextTokens: tokenCountSchema.optional(),
})
export type MessageUsage = z.infer<typeof messageUsageSchema>

/** A slash command invoked by a user message. */
export const commandInvocationSchema = z.object({
  name: commandNameSchema,
  /** Text after `/name `. */
  input: z.string(),
  type: z.enum(['prompt', 'reply']),
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
 * tools (the message names the folder and the reason).
 */
export const noticeCodeSchema = z.enum(['context-trimmed', 'approvals-superseded', 'tools-unsupported', 'attachments-unsupported', 'generated-file-dropped', 'workspace-unavailable'])
export type NoticeCode = z.infer<typeof noticeCodeSchema>

/** Data of `data-notice` parts. */
export const noticeDataSchema = z.object({
  level: noticeLevelSchema,
  code: noticeCodeSchema,
  message: z.string(),
})
export type NoticeData = z.infer<typeof noticeDataSchema>

/** Data part schemas for `useChat({ dataPartSchemas })` and `validateUIMessages({ dataSchemas })`. */
export const harnessDataSchemas = {
  notice: noticeDataSchema,
}

/** Data part types (`data-notice`). A type alias (not an interface) so it satisfies the AI SDK `UIDataTypes`. */
// eslint-disable-next-line ts/consistent-type-definitions
export type HarnessDataTypes = { notice: NoticeData }

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

/** `POST /chat/:id/stop`: `stopped` is false when no run was active. */
export const chatStopResultSchema = z.object({
  stopped: z.boolean(),
})
export type ChatStopResult = z.infer<typeof chatStopResultSchema>
