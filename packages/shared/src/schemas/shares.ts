// Share link DTOs (API.md section 4.17, ADR-025): the owner routes `/shares`, the stored snapshot and the public
// `GET /share/:token` view. A snapshot is an allowlist-sanitized copy of a chat's active path, never a live view.
import { z } from 'zod'
import { invocationKindSchema } from '../enums.ts'
import { catalogNameSchema, chatIdSchema, modelRefSchema, shareIdSchema, timestampSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'
import { titleInputSchema } from './chats.ts'

const countSchema = z.int().min(0)

const shareOptionFields = {
  reasoning: z.boolean(),
  toolDetails: z.boolean(),
  attachments: z.boolean(),
}

/** What a share shows besides the text; the defaults apply when a share is created without the key. */
export const shareOptionsSchema = z.strictObject({
  /** Reasoning parts; default false. */
  reasoning: shareOptionFields.reasoning.default(false),
  /**
   * Tool inputs and outputs, each value capped at `LIMITS.shareToolValueChars`; default false (tool names and states
   * are always shown).
   */
  toolDetails: shareOptionFields.toolDetails.default(false),
  /** Attachments, served by `GET /share/:token/files/:fileId`; default true. */
  attachments: shareOptionFields.attachments.default(true),
})
export type ShareOptions = z.infer<typeof shareOptionsSchema>

/**
 * Options of `ShareCreate` / `ShareUpdate`: a key not sent keeps its default (create) or its current value (update).
 * No defaults here: a partial update never resets the other options.
 */
export const shareOptionsInputSchema = z.strictObject(shareOptionFields).partial()
export type ShareOptionsInput = z.infer<typeof shareOptionsInputSchema>

/**
 * Body of `POST /shares` (fresh auth). `expiresAt` must be in the future and at most 365 days ahead (checked by the
 * server); null or omitted: the link never expires.
 */
export const shareCreateSchema = z.strictObject({
  chatId: chatIdSchema,
  /** Title shown on the share page; default: the chat title. */
  title: titleInputSchema.optional(),
  options: shareOptionsInputSchema.optional(),
  expiresAt: timestampSchema.nullable().optional(),
})
export type ShareCreate = z.infer<typeof shareCreateSchema>

/** Body of `PATCH /shares/:id` (fresh auth): strict, at least one key. The token and the path never change. */
export const shareUpdateSchema = z
  .strictObject({
    /** null: back to the chat title. */
    title: titleInputSchema.nullable().optional(),
    options: shareOptionsInputSchema.optional(),
    /** Same rules as `ShareCreate.expiresAt`; null removes the expiry. */
    expiresAt: timestampSchema.nullable().optional(),
    /** Re-snapshot the chat's current active path ("Update snapshot"). */
    refresh: z.literal(true).optional(),
  })
  .refine(value => Object.keys(value).length > 0, 'Send at least one field.')
export type ShareUpdate = z.infer<typeof shareUpdateSchema>

/** Query of `GET /shares`. */
export const sharesQuerySchema = z.object({
  /** Only the links of this chat. */
  chatId: chatIdSchema.optional(),
})
export type SharesQuery = z.infer<typeof sharesQuerySchema>

/** A share link as its owner sees it. */
export const shareSummarySchema = z.object({
  id: shareIdSchema,
  chatId: chatIdSchema,
  /** The chat's current title. */
  chatTitle: z.string().nullable(),
  /** The custom title; null = the chat title of the snapshot. */
  title: z.string().nullable(),
  options: shareOptionsSchema,
  /** `/share/<token>` (recomputed, never stored); the web shows `location.origin + path`. */
  path: z.string(),
  /** Messages in the snapshot. */
  messageCount: countSchema,
  snapshotAt: timestampSchema,
  /** The chat changed after `snapshotAt`. */
  outdated: z.boolean(),
  expiresAt: timestampSchema.nullable(),
  expired: z.boolean(),
  createdAt: timestampSchema,
})
export type ShareSummary = z.infer<typeof shareSummarySchema>

/** Outcome of a tool call in a snapshot. */
export const shareToolStatusSchema = z.enum(['done', 'error', 'denied', 'stopped'])
export type ShareToolStatus = z.infer<typeof shareToolStatusSchema>

/** The parts a snapshot keeps (allowlist); everything else is dropped when the snapshot is taken. */
export const sharePartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  /** Only with `options.reasoning`. */
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  /** Only with `options.attachments`; `url` is a file URL of the share or a raster image data URL. */
  z.object({ type: z.literal('file'), mediaType: z.string().max(255), filename: z.string().max(255).optional(), url: z.string() }),
  z.object({ type: z.literal('source-url'), sourceId: z.string().max(64), url: z.string().max(2048), title: z.string().max(500).optional() }),
  z.object({ type: z.literal('source-document'), sourceId: z.string().max(64), title: z.string().max(500), mediaType: z.string().max(255), filename: z.string().max(255).optional() }),
  /** `input` / `output` only with `options.toolDetails`. */
  z.object({
    type: z.literal('tool'),
    toolName: z.string().max(64),
    status: shareToolStatusSchema,
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    errorText: z.string().max(4096).optional(),
  }),
])
export type SharePart = z.infer<typeof sharePartSchema>

/** A message of a snapshot: user and assistant messages only, without ids, metadata, usage or errors. */
export const shareMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  /** Assistant messages: the model that answered. */
  modelRef: modelRefSchema.optional(),
  /** User messages that invoked a slash command (never its expansion); Phase 12: the name may be qualified. */
  command: z.object({ name: catalogNameSchema, kind: invocationKindSchema.optional() }).optional(),
  /** The reply ended with an error (no details) or was stopped. */
  status: z.enum(['failed', 'stopped']).optional(),
  parts: z.array(sharePartSchema).max(LIMITS.messagePartsMax),
})
export type ShareMessage = z.infer<typeof shareMessageSchema>

/**
 * The stored snapshot (`chat_shares.snapshot`, at most `LIMITS.shareSnapshotBytes` serialized); file URLs are
 * `/api/files/<id>` and are rewritten when served.
 */
export const shareSnapshotSchema = z.object({
  /** Title shown on the share page. */
  title: z.string().nullable(),
  messages: z.array(shareMessageSchema),
})
export type ShareSnapshot = z.infer<typeof shareSnapshotSchema>

/** `GET /share/:token` (public): the snapshot with file URLs `/api/share/<token>/files/<id>`. */
export const shareViewSchema = shareSnapshotSchema.extend({
  snapshotAt: timestampSchema,
  options: shareOptionsSchema,
})
export type ShareView = z.infer<typeof shareViewSchema>
