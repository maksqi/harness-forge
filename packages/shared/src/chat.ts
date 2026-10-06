// Chat contract: UI messages, message metadata, data parts and the `POST /chat` request (API.md sections 4.7, 6).
import type { UIMessage } from 'ai'
import type { TaskResultData } from './schemas/background-tasks.ts'
import { z } from 'zod'
import {
  commandSourceSchema,
  hookEventSchema,
  hookRecordOutcomeSchema,
  hookSourceSchema,
  invocationKindSchema,
  reasoningEffortSchema,
  toolModeSchema,
} from './enums.ts'
import { harnessErrorInitSchema } from './errors.ts'
import {
  agentNameSchema,
  chatIdSchema,
  hookRecordIdSchema,
  messageIdSchema,
  modelRefSchema,
  pluginIdSchema,
  projectIdSchema,
  slashNameSchema,
  timestampSchema,
} from './ids.ts'
import { LIMITS } from './limits.ts'
import { todoItemSchema } from './schemas/agent.ts'
import { taskResultDataSchema } from './schemas/background-tasks.ts'
import { imageOptionsSchema, imageTurnMetadataSchema } from './schemas/images.ts'
import { queueItemSchema, userMessagePartSchema } from './schemas/queue.ts'
import { messageUsageSchema } from './schemas/usage.ts'
import { DEFINITION_LIMITS } from './util/definitions.ts'
import { utf8ByteLength } from './util/text.ts'

const tokenCountSchema = z.int().min(0)

export { messageUsageSchema } from './schemas/usage.ts'
export type { MessageUsage } from './schemas/usage.ts'

/** A slash command (or, since Phase 11, a user-invocable skill) invoked by a user message. */
export const commandInvocationSchema = z.object({
  /** A command name (up to 32 characters) or, since Phase 11 (ADR-052), a skill name (up to 64; `slashNameSchema`). */
  name: slashNameSchema,
  /** Text after `/name `. */
  input: z.string(),
  /** `compact`: the harness command `/compact [focus]` (Phase 9, ADR-040), run by the server. */
  type: z.enum(['prompt', 'reply', 'compact']),
  /** Prompt commands: the text sent to the model instead (<= 64 KB). */
  expansion: z
    .string()
    .refine(value => utf8ByteLength(value) <= LIMITS.commandExpansionBytes, 'Expansions are limited to 64 KB.')
    .optional(),
  /** Where the command came from (Phase 10, ADR-045; absent in v1.5 messages = a plugin or harness command). */
  source: commandSourceSchema.optional(),
  /**
   * The `model` of a command file (Phase 10): the turn runs on it, the chat keeps its model; a continuation or a
   * regenerate of the turn reuses it. When it cannot run, the chat model answers (notice `command-model-unavailable`).
   */
  modelRef: modelRefSchema.optional(),
  /**
   * The `allowed-tools` of a command file (Phase 10): narrows the tools of the turn (never a grant); a continuation or a
   * regenerate of the turn reads it again.
   */
  allowedTools: z.array(z.string().min(1).max(256)).max(DEFINITION_LIMITS.toolsMax).optional(),
  /**
   * What the name invoked (Phase 11, ADR-052): a command, or a user-invocable skill (`/name [arguments]`, its content is
   * the expansion). Absent in v1.6 messages (= `command`).
   */
  kind: invocationKindSchema.optional(),
  /**
   * What a trusted command file inlined into `expansion` before the model call (Phase 11, ADR-052): the number of
   * `` !`cmd` `` spans that ran and the project-relative `@path` files that were read. Frozen with the expansion, so a
   * regenerate or a continuation never runs the spans again. Absent when nothing was inlined.
   */
  inlined: z
    .object({
      shell: z.int().min(0).max(LIMITS.commandShellSpansMax),
      files: z.array(z.string().min(1).max(LIMITS.workspacePathMaxChars)).max(LIMITS.commandFileRefsMax),
    })
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
 * so the oldest turns were trimmed instead; `command-model-unavailable` (Phase 10, ADR-045): the `model` of a command
 * file cannot run, so the chat model answered; Phase 11: `output-style-unavailable` (ADR-051): the effective output
 * style is unknown or inactive, so the run used `default`; `hook-continuation-limit` (ADR-048): `Stop` hooks blocked 5
 * runs in a row, so no further follow-up turn starts; `project-mcp-unavailable` (ADR-050): an approved project MCP server
 * was not ready within 5 s (or failed), so the run has no tools of it.
 */
export const noticeCodeSchema = z.enum([
  'context-trimmed',
  'approvals-superseded',
  'tools-unsupported',
  'attachments-unsupported',
  'generated-file-dropped',
  'workspace-unavailable',
  'compaction-failed',
  'command-model-unavailable',
  'output-style-unavailable',
  'hook-continuation-limit',
  'project-mcp-unavailable',
])
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

/**
 * What a run does right now, shown live (`compacting`: a summary is being written; `hooks` (Phase 11, ADR-048): command
 * hooks of an event are running, "Running hook…"; `idle`: nothing special any more).
 */
export const activityKindSchema = z.enum(['compacting', 'idle', 'hooks'])
export type ActivityKind = z.infer<typeof activityKindSchema>

/** Data of the transient `data-activity` chunks (ADR-040): reach only `onData`, never stored in a message. */
export const activityDataSchema = z.object({
  kind: activityKindSchema,
  /** `hooks`: the event whose hooks run (Phase 11). */
  event: hookEventSchema.optional(),
  /** `hooks` of `PreToolUse` / `PostToolUse`: the tool call they run for (Phase 11). */
  toolCallId: z.string().min(1).max(256).optional(),
})
export type ActivityData = z.infer<typeof activityDataSchema>

function isJsonWithin(value: unknown, maxBytes: number): boolean {
  try {
    return utf8ByteLength(JSON.stringify(value) ?? '') <= maxBytes
  }
  catch {
    return false
  }
}

/**
 * One hook that ran for a `data-hook` record (Phase 11, ADR-048). Never holds the payload, stdout or stderr: `error` is
 * a short description (an exit code, a timeout, invalid output) and `systemMessage` is the hook's own message to the
 * user.
 */
export const hookResultSchema = z.object({
  source: hookSourceSchema,
  /** The hook's command (a personal, project or plugin command hook) or `<pluginId>: <event>` (a code hook), cut. */
  label: z.string().max(LIMITS.hookLabelMaxChars),
  /** Plugin hooks: the plugin. */
  pluginId: pluginIdSchema.optional(),
  /** null when the process did not exit normally (timeout, killed, failed to start) and for code hooks. */
  exitCode: z.int().nullable(),
  timedOut: z.boolean().optional(),
  durationMs: z.number().min(0),
  /** A non-blocking failure, safe to show (never the raw stderr). */
  error: z.string().max(LIMITS.hookSystemMessageMaxChars).optional(),
  /** The hook's `systemMessage` for the user (never sent to the model). */
  systemMessage: z.string().max(LIMITS.hookSystemMessageMaxChars).optional(),
})
export type HookResult = z.infer<typeof hookResultSchema>

/**
 * Data of `data-hook` parts (Phase 11, ADR-048): what the hooks of one event did, stored where they ran (a silent
 * success stores nothing). In an assistant reply at the point of the event (tool hooks carry the tool call id); the
 * context of `UserPromptSubmit` / `SessionStart` on the user message; a `Stop` continuation is a user-role carrier
 * message that holds only `data-hook` parts (`run.started.origin = hook`). `context` (and in a carrier the `reason`)
 * reach the model through `splitHooks` / `hookModelText` (`util/agent-state.ts`); everything else is display-only.
 */
export const hookDataSchema = z.object({
  /** `hev_` + 16 characters; also the id of the run log entries of this event. */
  id: hookRecordIdSchema,
  event: hookEventSchema,
  outcome: hookRecordOutcomeSchema,
  /** `PreToolUse` / `PostToolUse`: the tool call (the tool part with the same `toolCallId`). */
  toolCallId: z.string().min(1).max(256).optional(),
  /** `PreToolUse` / `PostToolUse`: the harness tool name. */
  toolName: z.string().min(1).max(256).optional(),
  createdAt: timestampSchema,
  /** Every hook that ran for the event (at most 20). */
  hooks: z.array(hookResultSchema).max(LIMITS.hooksPerEventMax),
  /** Model-visible context (`additionalContext`, plain stdout of `UserPromptSubmit` / `SessionStart`; joined, capped). */
  context: z.string().max(LIMITS.hookContextMaxChars).optional(),
  /** A block or decision reason (user-visible; the model sees it as feedback where the event allows). */
  reason: z.string().max(LIMITS.hookReasonMaxChars).optional(),
  /**
   * `PreToolUse` `updatedInput` (`outcome: 'rewritten'`): the input the tool ran with (at most 64 KiB of JSON); the tool
   * part keeps the model's input.
   */
  updatedInput: z
    .unknown()
    .refine(value => value === undefined || isJsonWithin(value, LIMITS.hookUpdatedInputBytes), 'The updated input is limited to 64 KB of JSON.')
    .optional(),
})
export type HookData = z.infer<typeof hookDataSchema>

/**
 * Data part schemas for `useChat({ dataPartSchemas })` and `validateUIMessages({ dataSchemas })`. `task-result` (Phase
 * 10, ADR-046): the result of a background task (`data-task-result`, `taskResultDataSchema`); `hook` (Phase 11,
 * ADR-048): what the hooks of one event did (`data-hook`, `hookDataSchema`).
 */
export const harnessDataSchemas = {
  'notice': noticeDataSchema,
  'compaction': compactionDataSchema,
  'steer': steerDataSchema,
  'activity': activityDataSchema,
  'task-result': taskResultDataSchema,
  'hook': hookDataSchema,
}

/**
 * Data part types (`data-notice`, `data-compaction`, `data-steer`, the transient `data-activity`, `data-task-result`,
 * `data-hook`). A type alias (not an interface) so it satisfies the AI SDK `UIDataTypes`.
 */
// eslint-disable-next-line ts/consistent-type-definitions
export type HarnessDataTypes = {
  'notice': NoticeData
  'compaction': CompactionData
  'steer': SteerData
  'activity': ActivityData
  'task-result': TaskResultData
  'hook': HookData
}

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
  /**
   * The output style of a new chat (Phase 11, ADR-051): a style name, or null = automatic (the project's, else the
   * global `outputStyle`). Honored only when this request creates the chat (saved as `settings.outputStyle`); ignored
   * for an existing chat (change it with `PATCH /chats/:id`). An unknown style is not an error: the run uses `default`
   * with notice `output-style-unavailable`.
   */
  outputStyle: agentNameSchema.nullable().optional(),
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
