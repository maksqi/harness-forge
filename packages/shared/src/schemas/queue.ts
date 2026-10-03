// Steer queue of a chat (Phase 9, ADR-042; API.md section 4.26): messages sent while a run is active. At the next step
// boundary the run takes every queued message (stored as a `data-steer` part); a message still queued when the run
// completes becomes the next turn. In memory only (lost on a restart), at most `LIMITS.queueItemsMax` per chat.
import { z } from 'zod'
import { reasoningEffortSchema, toolModeSchema } from '../enums.ts'
import { chatIdSchema, messageIdSchema, modelRefSchema, timestampSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'
import { utf8ByteLength } from '../util/text.ts'

/** A text part of a user message. */
export const userTextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

/**
 * A file part of a user message: `url` is `/api/files/<id>` (a file uploaded through `POST /files`); the server
 * rewrites `mediaType` and `filename` from the stored file.
 */
export const userFilePartSchema = z.object({
  type: z.literal('file'),
  mediaType: z.string().min(1).max(255),
  filename: z.string().max(255).optional(),
  url: z.string().min(1).max(2048),
})

/** A part of a user message: text or an uploaded file (the only parts a user message can hold). */
export const userMessagePartSchema = z.discriminatedUnion('type', [userTextPartSchema, userFilePartSchema])
export type UserMessagePart = z.infer<typeof userMessagePartSchema>

/** A queued user message: a harness UI message with a client-generated `msg_` id and text / file parts. */
export const queueMessageSchema = z.object({
  id: messageIdSchema,
  role: z.literal('user'),
  parts: z.array(userMessagePartSchema).min(1).max(LIMITS.messagePartsMax),
})
export type QueueMessage = z.infer<typeof queueMessageSchema>

/** A queued message with the chat settings it was sent with. */
export const queueItemSchema = z
  .object({
    /** The id of `message`. */
    id: messageIdSchema,
    message: queueMessageSchema,
    modelRef: modelRefSchema,
    reasoningEffort: reasoningEffortSchema,
    toolMode: toolModeSchema,
    createdAt: timestampSchema,
    /**
     * Never steered into a running reply, only started as the next turn: server commands (`/compact` and plugin
     * commands).
     */
    turnOnly: z.boolean(),
  })
  .refine(item => item.id === item.message.id, { message: 'The item id must equal the message id.', path: ['id'] })
export type QueueItem = z.infer<typeof queueItemSchema>

/**
 * Body of `POST /chat/:id/queue`: the message (at most 256 KiB serialized; its `id` becomes the item id) and the chat
 * settings of the composer.
 */
export const queueAddBodySchema = z.strictObject({
  message: queueMessageSchema.refine(
    message => utf8ByteLength(JSON.stringify(message)) <= LIMITS.queueItemBytes,
    `Queued messages are limited to ${LIMITS.queueItemBytes / 1024} KiB.`,
  ),
  modelRef: modelRefSchema,
  reasoningEffort: reasoningEffortSchema,
  toolMode: toolModeSchema,
})
export type QueueAddBody = z.infer<typeof queueAddBodySchema>

/** `GET /chat/:id/queue`: the queued messages, oldest first. */
export const queueListSchema = z.object({
  items: z.array(queueItemSchema).max(LIMITS.queueItemsMax),
})
export type QueueList = z.infer<typeof queueListSchema>

/**
 * Why a message left the queue: `delivered` (steered into the running reply), `started` (became the next turn),
 * `cancelled` (`DELETE /chat/:id/queue/:itemId`), `stopped` (Stop, or the run was aborted; returned by
 * `POST /chat/:id/stop` as `dropped`), `failed` (the run failed, or the next turn could not start).
 */
export const queueRemovalReasonSchema = z.enum(['delivered', 'started', 'cancelled', 'stopped', 'failed'])
export type QueueRemovalReason = z.infer<typeof queueRemovalReasonSchema>

export const queueRemovalSchema = z.object({
  id: messageIdSchema,
  reason: queueRemovalReasonSchema,
  /** `failed`: what went wrong (no message contents). */
  error: z.string().max(2000).optional(),
})
export type QueueRemoval = z.infer<typeof queueRemovalSchema>

/** Data of the `queue.changed` server event: the whole queue after the change, and what left it. */
export const queueChangedDataSchema = z.object({
  chatId: chatIdSchema,
  items: z.array(queueItemSchema).max(LIMITS.queueItemsMax),
  removed: z.array(queueRemovalSchema).optional(),
})
export type QueueChangedData = z.infer<typeof queueChangedDataSchema>
