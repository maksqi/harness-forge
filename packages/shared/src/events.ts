// Server-sent events of `GET /api/events` (API.md sections 4.14 and 7).
import { z } from 'zod'
import { harnessErrorInitSchema } from './errors.ts'
import { chatIdSchema, messageIdSchema, modelRefSchema, pluginIdSchema, providerIdSchema, timestampSchema } from './ids.ts'
import { chatSummarySchema } from './schemas/chats.ts'
import { pluginLogEntrySchema, pluginSummarySchema } from './schemas/plugins.ts'
import { providerSummarySchema } from './schemas/providers.ts'

/** Every server event type; the SSE `event:` field equals `type`. */
export const SERVER_EVENT_TYPES = [
  'chat.created',
  'chat.updated',
  'chat.deleted',
  'run.started',
  'run.finished',
  'provider.changed',
  'catalog.changed',
  'plugin.changed',
  'plugin.log',
] as const

export const serverEventTypeSchema = z.enum(SERVER_EVENT_TYPES)

/**
 * Data of `chat.updated` (ADR-030): the chat summary + the active leaf, so another tab that shows the chat follows a
 * version switch. `chatSummarySchema` itself is unchanged (chat export v2 extends it).
 */
export const chatUpdatedDataSchema = chatSummarySchema.extend({
  /** Last message of the shown path; null for an empty chat. */
  activeLeafId: messageIdSchema.nullable(),
})
export type ChatUpdatedData = z.infer<typeof chatUpdatedDataSchema>

export const runStartedDataSchema = z.object({
  chatId: chatIdSchema,
  messageId: messageIdSchema,
  modelRef: modelRefSchema,
})
export type RunStartedData = z.infer<typeof runStartedDataSchema>

export const runOutcomeSchema = z.enum(['completed', 'aborted', 'failed'])
export type RunOutcome = z.infer<typeof runOutcomeSchema>

export const runFinishedDataSchema = z.object({
  chatId: chatIdSchema,
  messageId: messageIdSchema,
  outcome: runOutcomeSchema,
  /** The message ends with an approval request (amber dot; persisted as `chats.pending_approval`). */
  awaitingApproval: z.boolean(),
  /** When `outcome` is `failed`. */
  error: harnessErrorInitSchema.optional(),
})
export type RunFinishedData = z.infer<typeof runFinishedDataSchema>

function eventSchema<const T extends (typeof SERVER_EVENT_TYPES)[number], D extends z.ZodType>(type: T, data: D) {
  return z.object({ type: z.literal(type), data, at: timestampSchema })
}

/** `{ type, data, at }`, discriminated on `type`. */
export const serverEventSchema = z.discriminatedUnion('type', [
  eventSchema('chat.created', chatSummarySchema),
  /** Includes title changes and version switches (`activeLeafId`). */
  eventSchema('chat.updated', chatUpdatedDataSchema),
  eventSchema('chat.deleted', z.object({ id: chatIdSchema })),
  eventSchema('run.started', runStartedDataSchema),
  eventSchema('run.finished', runFinishedDataSchema),
  /** `provider: null`: the provider was unregistered. */
  eventSchema('provider.changed', z.object({ id: providerIdSchema, provider: providerSummarySchema.nullable() })),
  /** `providerId: null`: many providers changed (refetch everything). */
  eventSchema('catalog.changed', z.object({ providerId: providerIdSchema.nullable() })),
  /** `plugin: null`: the plugin was uninstalled. */
  eventSchema('plugin.changed', z.object({ id: pluginIdSchema, plugin: pluginSummarySchema.nullable() })),
  eventSchema('plugin.log', z.object({ pluginId: pluginIdSchema, entry: pluginLogEntrySchema })),
])
export type ServerEvent = z.infer<typeof serverEventSchema>
export type ServerEventType = ServerEvent['type']

/** The event of one type. */
export type ServerEventOf<T extends ServerEventType> = Extract<ServerEvent, { type: T }>

/** `data` payload by event type (for typed `emit(type, data)` helpers). */
export type ServerEventDataMap = { [T in ServerEventType]: ServerEventOf<T>['data'] }

/** Builds a server event with `at = Date.now()` unless given. */
export function createServerEvent<T extends ServerEventType>(type: T, data: ServerEventDataMap[T], at: number = Date.now()): ServerEventOf<T> {
  return { type, data, at } as ServerEventOf<T>
}
