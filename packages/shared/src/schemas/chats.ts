// Chat DTOs (API.md section 4.7). UI messages and the chat request live in `chat.ts`.
import { z } from 'zod'
import { harnessUIMessageSchema } from '../chat.ts'
import { reasoningEffortSchema, titleSourceSchema, toolModeSchema } from '../enums.ts'
import { agentNameSchema, chatIdSchema, messageIdSchema, modelRefSchema, projectIdSchema, timestampSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'
import { cursorSchema, queryBooleanSchema, queryIntSchema } from './common.ts'

const instructionsSchema = z.string().max(LIMITS.instructionsMaxChars)

/** A title sent by the client (chats, share links): trimmed, 1..200 characters. */
export const titleInputSchema = z.string().trim().min(1).max(200)

/**
 * A message id inside an import or an export (`POST /chats`, chat JSON): as lenient as the ids of
 * `harnessUIMessageSchema`, because imported ids that are invalid or already used are replaced.
 */
const importedMessageIdSchema = z.string().min(1).max(256)

/** Per-chat settings; an absent key means the global default. */
export const chatSettingsSchema = z.strictObject({
  toolMode: toolModeSchema.optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  /** Chat-level instructions appended to the global ones. */
  instructions: instructionsSchema.optional(),
  /**
   * The chat's output style (Phase 11, ADR-051); absent = automatic (the project's, else the global `outputStyle`).
   * Set by the composer menu and `/output-style`; applies from the next turn.
   */
  outputStyle: agentNameSchema.optional(),
})
export type ChatSettings = z.infer<typeof chatSettingsSchema>

/** Merge update of chat settings: a value sets the key, null removes it. */
export const chatSettingsUpdateSchema = z.strictObject({
  toolMode: toolModeSchema.nullable().optional(),
  reasoningEffort: reasoningEffortSchema.nullable().optional(),
  instructions: instructionsSchema.nullable().optional(),
  /** Phase 11: null = automatic. */
  outputStyle: agentNameSchema.nullable().optional(),
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
  /** The active leaf (an assistant message) waits for a tool approval. */
  pendingApproval: z.boolean(),
  /**
   * The project the chat belongs to (ADR-031); null = no project. Never part of a chat export or a backup (projects are
   * host-specific): the export schemas omit it.
   */
  projectId: projectIdSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  /** Only for `GET /chats?q=`: matching excerpt, plain text. */
  snippet: z.string().max(160).optional(),
})
export type ChatSummary = z.infer<typeof chatSummarySchema>

/**
 * Sums over the chat's usage rows (purposes `chat` and `image`, ADR-028), every message version included, deleted
 * versions too (the cost actually paid).
 */
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

/**
 * The versions of a message on the active path (ADR-023): every message with the same parent (the first messages of a
 * chat are siblings of each other), in `seq` order, and the position of the path message among them.
 */
export const messageBranchSchema = z.object({
  /** At least 2 message ids. */
  siblings: z.array(messageIdSchema).min(2),
  /** Index of the path message in `siblings`. */
  index: z.int().min(0),
})
export type MessageBranch = z.infer<typeof messageBranchSchema>

export const chatDetailSchema = chatSummarySchema.extend({
  settings: chatSettingsSchema,
  /**
   * The active path (first message -> active leaf) in `seq` order; pass directly to `useChat({ messages })`. During a
   * run it ends at the message committed when the run started (the in-flight reply is excluded).
   */
  messages: z.array(harnessUIMessageSchema),
  /** Versions of the path messages that have siblings, keyed by the path message id (absent: a single version). */
  branches: z.record(messageIdSchema, messageBranchSchema),
  totals: usageTotalsSchema,
})
export type ChatDetail = z.infer<typeof chatDetailSchema>

/**
 * Body of `POST /chats/:id/branch`: show the path last shown under `messageId` (any message of the chat; ADR-030), else
 * the most recent leaf under it.
 */
export const chatBranchBodySchema = z.strictObject({
  messageId: messageIdSchema,
})
export type ChatBranchBody = z.infer<typeof chatBranchBodySchema>

/** Query of `GET /chats`; order: `updatedAt` desc, `id` desc. `limit` defaults to 50, `archived` to false. */
export const chatsQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: queryIntSchema(1, LIMITS.pageLimitMax).optional(),
  /** Case-insensitive match on title and message text. */
  q: z.string().trim().min(1).max(200).optional(),
  /** true: only archived chats; false (default): only non-archived chats. */
  archived: queryBooleanSchema.optional(),
  /** Only the chats of this project, or `none`: only chats without a project (ADR-031); omitted = every chat. */
  projectId: z.union([projectIdSchema, z.literal('none')]).optional(),
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
  /** The project of the chat (ADR-031); an unknown project is a `404`. Default: no project. */
  projectId: projectIdSchema.optional(),
  /** Import (e.g. the `chat.messages` of a JSON export), in `seq` order. */
  messages: z.array(harnessUIMessageSchema).max(LIMITS.chatImportMessagesMax).optional(),
  /**
   * Import: the parent of each message, aligned with `messages` by index (`null` = a first message). Each parent must
   * be the id of an earlier message of the import (else `400` with the field path). Omitted = a linear chat.
   */
  parentIds: z.array(importedMessageIdSchema.nullable()).max(LIMITS.chatImportMessagesMax).optional(),
  /** Import: the path to show; the active leaf becomes the most recent leaf under it (default: the last message). */
  activeLeafId: importedMessageIdSchema.optional(),
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
    /**
     * Moves the chat to a project, or out of it with null (ADR-031): `404` for an unknown project, `409` (`run-active`)
     * while a run holds the chat.
     */
    projectId: projectIdSchema.nullable().optional(),
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

const exportedMessagesSchema = z.array(harnessUIMessageSchema).max(LIMITS.backupChatMessagesMax)

/**
 * Chat JSON export version 1 (linear chats, written before ADR-023; still accepted by imports): `chat` is the detail
 * without `branches` and `projectId`. `running` / `pendingApproval` are false.
 *
 * Neither export version carries `projectId` (ADR-031): projects are host-specific, so imported chats never get one,
 * and the exports written before Phase 7 (without the field) keep importing. A `projectId` key in an upload is dropped.
 */
export const chatExportV1Schema = z.object({
  format: z.literal('harness-forge.chat'),
  version: z.literal(1),
  exportedAt: timestampSchema,
  chat: chatDetailSchema.omit({ branches: true, projectId: true }).extend({ messages: exportedMessagesSchema }),
})
export type ChatExportV1 = z.infer<typeof chatExportV1Schema>

/**
 * Chat JSON export version 2 (ADR-023): `chat` = summary (without `projectId`, ADR-031) + settings + totals + every
 * message version in `seq` order + the parent of each message (aligned by index) + the active leaf. Messages carry no
 * parent field of their own. `running` / `pendingApproval` are false.
 */
export const chatExportV2Schema = z.object({
  format: z.literal('harness-forge.chat'),
  version: z.literal(2),
  exportedAt: timestampSchema,
  chat: chatSummarySchema.omit({ projectId: true }).extend({
    settings: chatSettingsSchema,
    totals: usageTotalsSchema,
    /** Every version, in `seq` order. */
    messages: exportedMessagesSchema,
    /** The parent of `messages[i]` (`null` = a first message); each parent is an earlier message. */
    parentIds: z.array(importedMessageIdSchema.nullable()).max(LIMITS.backupChatMessagesMax),
    /** Last message of the shown path; null for an empty chat. */
    activeLeafId: importedMessageIdSchema.nullable(),
  }),
})
export type ChatExportV2 = z.infer<typeof chatExportV2Schema>

/**
 * Body of a `format=json` export (`GET /chats/:id/export`) and of `chats/<chatId>.json` in a backup: the version
 * written today (2). Imports accept `chatExportAnySchema`.
 */
export const chatExportSchema = chatExportV2Schema
export type ChatExport = z.infer<typeof chatExportSchema>

/** Every chat JSON export an import accepts (versions 1 and 2), discriminated on `version`. */
export const chatExportAnySchema = z.discriminatedUnion('version', [chatExportV1Schema, chatExportV2Schema])
export type ChatExportAny = z.infer<typeof chatExportAnySchema>
