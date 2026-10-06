// Server-sent events of `GET /api/events` (API.md sections 4.14 and 7).
import { z } from 'zod'
import { runOriginSchema } from './enums.ts'
import { harnessErrorInitSchema } from './errors.ts'
import { chatIdSchema, messageIdSchema, modelRefSchema, pluginIdSchema, projectIdSchema, providerIdSchema, timestampSchema } from './ids.ts'
import { taskChangedDataSchema } from './schemas/background-tasks.ts'
import { workspaceChangedDataSchema } from './schemas/changes.ts'
import { chatSummarySchema } from './schemas/chats.ts'
import { customizationChangedDataSchema } from './schemas/customizations.ts'
import { hooksChangedDataSchema } from './schemas/hooks.ts'
import { pluginLogEntrySchema, pluginSummarySchema } from './schemas/plugins.ts'
import { projectMcpChangedDataSchema, projectTrustChangedDataSchema } from './schemas/project-trust.ts'
import { projectSummarySchema } from './schemas/projects.ts'
import { providerSummarySchema } from './schemas/providers.ts'
import { queueChangedDataSchema } from './schemas/queue.ts'

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
  'project.changed',
  'key.rotated',
  'workspace.changed',
  'queue.changed',
  'task.changed',
  'customization.changed',
  'hooks.changed',
  'project-trust.changed',
  'project-mcp.changed',
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
  /**
   * What started the run (`runOriginSchema`, in `enums.ts`): `request`, `queue` (Phase 9), `task` (Phase 10, ADR-046:
   * the results of finished background tasks) or `hook` (Phase 11, ADR-048: a `Stop` hook blocked the end of the
   * previous run). Absent in events of servers before v1.5 (= `request`).
   */
  origin: runOriginSchema.optional(),
  /**
   * The user message the run answers; set when the server started the turn (`origin: 'queue'`; `origin: 'task'`: the
   * user-role carrier message that holds only `data-task-result` parts; `origin: 'hook'`: the carrier message that holds
   * only `data-hook` parts).
   */
  userMessageId: messageIdSchema.optional(),
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

/**
 * Data of `project.changed` (ADR-031): `project: null` = the project was deleted (its chats were detached in the same
 * transaction; no `chat.updated` is sent per chat, clients set their `projectId` to null).
 */
export const projectChangedDataSchema = z.object({
  id: projectIdSchema,
  project: projectSummarySchema.nullable(),
})
export type ProjectChangedData = z.infer<typeof projectChangedDataSchema>

/**
 * Data of `key.rotated` (ADR-034): sent once after a master-key rotation, then every event stream closes (the sessions
 * were revoked). `chatIds`: the chats whose pending approvals expired or whose runs were stopped (at most 1000).
 */
export const keyRotatedDataSchema = z.object({
  keyVersion: z.int().min(1),
  rotatedAt: timestampSchema,
  chatIds: z.array(chatIdSchema).max(1000),
})
export type KeyRotatedData = z.infer<typeof keyRotatedDataSchema>

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
  /** `project: null`: the project was deleted. */
  eventSchema('project.changed', projectChangedDataSchema),
  /** The last event of every stream: the server closes the streams right after it. */
  eventSchema('key.rotated', keyRotatedDataSchema),
  /** Files of a project folder were written by an agent tool or by a rewind, revert or undo (ADR-036). */
  eventSchema('workspace.changed', workspaceChangedDataSchema),
  /** The steer queue of a chat changed (ADR-042): the whole queue after the change, and what left it. */
  eventSchema('queue.changed', queueChangedDataSchema),
  /** A background task of a chat changed (ADR-046): the task after the change (an upsert; at most 1/s per task). */
  eventSchema('task.changed', taskChangedDataSchema),
  /** The catalog of agents, commands, skills and output styles changed (ADR-044): refetch what it names. */
  eventSchema('customization.changed', customizationChangedDataSchema),
  /** The hooks of a scope changed (ADR-048): refetch `GET /hooks` (`projectId: null` = personal or plugin hooks). */
  eventSchema('hooks.changed', hooksChangedDataSchema),
  /** The approvals or the executable items of a project changed (ADR-049): refetch its trust list. */
  eventSchema('project-trust.changed', projectTrustChangedDataSchema),
  /** The MCP servers of a project changed state (ADR-050): the servers after the change. */
  eventSchema('project-mcp.changed', projectMcpChangedDataSchema),
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
