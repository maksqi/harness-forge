// Chat DTOs (API.md section 4.7). UI messages and the chat request live in `chat.ts`.
import { z } from 'zod'
import { harnessUIMessageSchema } from '../chat.ts'
import { reasoningEffortSchema, titleSourceSchema, toolModeSchema } from '../enums.ts'
import { chatIdSchema, modelRefSchema, timestampSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'
import { cursorSchema, queryBooleanSchema, queryIntSchema } from './common.ts'

const instructionsSchema = z.string().max(LIMITS.instructionsMaxChars)
const titleInputSchema = z.string().trim().min(1).max(200)

/** Per-chat settings; an absent key means the global default. */
export const chatSettingsSchema = z.strictObject({
  toolMode: toolModeSchema.optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  /** Chat-level instructions appended to the global ones. */
  instructions: instructionsSchema.optional(),
})
export type ChatSettings = z.infer<typeof chatSettingsSchema>

/** Merge update of chat settings: a value sets the key, null removes it. */
export const chatSettingsUpdateSchema = z.strictObject({
  toolMode: toolModeSchema.nullable().optional(),
  reasoningEffort: reasoningEffortSchema.nullable().optional(),
  instructions: instructionsSchema.nullable().optional(),
})
export type ChatSettingsUpdate = z.infer<typeof chatSettingsUpdateSchema>

export const chatSummarySchema = z.object({
  id: chatIdSchema,
  /** null until the first title is set. */
  title: z.string().nullable(),
  titleSource: titleSourceSchema.nullable(),
  /** Last used model. */
  modelRef: modelRefSchema.nullable(),
  pinned: z.boolean(),
  archived: z.boolean(),
  /** A run is active (live, from the runs registry). */
  running: z.boolean(),
  /** The last assistant message waits for a tool approval. */
  pendingApproval: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  /** Only for `GET /chats?q=`: matching excerpt, plain text. */
  snippet: z.string().max(160).optional(),
})
export type ChatSummary = z.infer<typeof chatSummarySchema>

/** Sums over the chat's usage rows (purpose `chat`). */
export const usageTotalsSchema = z.object({
  inputTokens: z.int().min(0),
  outputTokens: z.int().min(0),
  reasoningTokens: z.int().min(0),
  cacheReadTokens: z.int().min(0),
  cacheWriteTokens: z.int().min(0),
  /** null when no row had a known price. */
  costUsd: z.number().min(0).nullable(),
})
export type UsageTotals = z.infer<typeof usageTotalsSchema>

export const chatDetailSchema = chatSummarySchema.extend({
  settings: chatSettingsSchema,
  /** Ordered by `seq`; pass directly to `useChat({ messages })`. */
  messages: z.array(harnessUIMessageSchema),
  totals: usageTotalsSchema,
})
export type ChatDetail = z.infer<typeof chatDetailSchema>

/** Query of `GET /chats`; order: `updatedAt` desc, `id` desc. `limit` defaults to 50, `archived` to false. */
export const chatsQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: queryIntSchema(1, LIMITS.pageLimitMax).optional(),
  /** Case-insensitive match on title and message text. */
  q: z.string().trim().min(1).max(200).optional(),
  /** true: only archived chats; false (default): only non-archived chats. */
  archived: queryBooleanSchema.optional(),
})
export type ChatsQuery = z.infer<typeof chatsQuerySchema>

/** Body of `POST /chats`: an empty chat, or an import of `messages`. */
export const chatCreateSchema = z.strictObject({
  /** Default: server-generated uuidv7. */
  id: chatIdSchema.optional(),
  /** Sets `titleSource: 'user'`. */
  title: titleInputSchema.optional(),
  modelRef: modelRefSchema.optional(),
  settings: chatSettingsSchema.optional(),
  /** Import (e.g. the `chat.messages` of a JSON export). */
  messages: z.array(harnessUIMessageSchema).max(LIMITS.chatImportMessagesMax).optional(),
})
export type ChatCreate = z.infer<typeof chatCreateSchema>

/** Body of `PATCH /chats/:id`: strict, at least one key. */
export const chatUpdateSchema = z
  .strictObject({
    /** Sets `titleSource: 'user'`. */
    title: titleInputSchema.optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    modelRef: modelRefSchema.nullable().optional(),
    settings: chatSettingsUpdateSchema.optional(),
  })
  .refine(value => Object.keys(value).length > 0, 'Send at least one field.')
export type ChatUpdate = z.infer<typeof chatUpdateSchema>

export const chatExportFormatSchema = z.enum(['md', 'json'])
export type ChatExportFormat = z.infer<typeof chatExportFormatSchema>

/** Query of `GET /chats/:id/export`. */
export const chatExportQuerySchema = z.object({
  format: chatExportFormatSchema,
})
export type ChatExportQuery = z.infer<typeof chatExportQuerySchema>

/** Body of a `format=json` export (`running` / `pendingApproval` are false). */
export const chatExportSchema = z.object({
  format: z.literal('harness-forge.chat'),
  version: z.literal(1),
  exportedAt: timestampSchema,
  chat: chatDetailSchema,
})
export type ChatExport = z.infer<typeof chatExportSchema>
