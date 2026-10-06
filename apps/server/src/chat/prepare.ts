// Everything `POST /chat` does before the stream starts (ARCHITECTURE.md 6.1 / 6.8 / 6.11): classify the request,
// upsert the chat (mode and effort saved as chat settings), resolve the model (`provider_not_configured` before any
// streaming; an image model, catalog kind `image`, through `resolveImageModel`), check the image options, plan the
// history operation in memory (the path it continues, slash commands, superseded approvals, the approval merge; for an
// image turn the prompt and the input images), validate the new message with `validateUIMessages`, then commit the
// history change and the active leaf in one transaction. A failure here is a normal JSON error response and leaves the
// history untouched. Nothing is ever deleted (ADR-023): an edit adds a sibling user message, a regenerate a sibling
// reply.
// Phase 7 (ADR-031, ARCHITECTURE.md 6.13): the request's `projectId` is honored only when the request creates the chat
// (an unknown project is `not_found` before the chat row exists); every chat-model run of a chat with a project opens
// its folder (`openWorkspace`): an unavailable folder gives the run no workspace and the `workspace-unavailable` notice.
// Phase 9 (C26 seams, W9.1): `/compact [focus]` resolves like a reply command (it decides the reply: no model call, no
// workspace), needs a chat model (an image model is a 400 on `['modelRef']`) and a regenerate of its reply compacts
// again; the continuation branch checks the mode of a plan approval (`checkPlanApprovalMode`, `modes.ts`).
// Phase 10 (ADR-045 / ADR-046, ARCHITECTURE.md 6.24): every run takes one catalog snapshot of its chat's project
// (`PreparedRun.catalog`, `deps.customizations.catalog`; commands, the agent-types and skills blocks, `task`, `skill`).
// A command file's `model` (`metadata.command.modelRef` of the turn's user message: a new message's command, the stored
// one for a regenerate and an approval continuation) runs the turn when it resolves to a chat model; otherwise the
// request's model runs and the reply starts with the notice `command-model-unavailable` (once per reply). The request's
// model is resolved first, as before (its errors, image options and the image-continuation check are unchanged), and
// stays the chat's model (`PreparedRun.requestModelRef`); the request's image options are not applied to a command's
// model. `PreparedRun.turnRestriction` is the turn command's `allowed-tools` (`turnToolRestriction`).
// `prepareRun(…, { serverMessage: true })` is the path of the user-role carrier message of a turn the server starts for
// finished background tasks (`origin: 'task'`): only a new message whose parts are all `data-task-result` parts is
// accepted; its parts skip `normalizeUserParts` (which refuses data parts) and the message is checked with
// `validateMessage`; it resolves no command.
// Phase 11 (C37 seams, ADR-048 / ADR-051 / ADR-052; the call sites are frozen after P11-0b, the features are W11.2's,
// W11.5's and W11.6's):
// - a server-built carrier may also hold only `data-hook` parts (the carrier of a `Stop` continuation, `origin: 'hook'`;
//   `carrierParts`: all `data-task-result` parts or all `data-hook` parts, never mixed);
// - `ensureChat` saves `ChatRequestBody.outputStyle` as `settings.outputStyle` when the request creates the chat (an
//   existing chat keeps its style);
// - the command resolution gets `CommandContext.expansion` (the chat's project folder opened lazily once, the shell
//   switch, the trust check of project command files: `!` / `@` spans, W11.5);
// - right after the project folder opened, `runPromptHooks` (`hooks-prompt.ts`, W11.2) runs `SessionStart` and
//   `UserPromptSubmit` (`PrepareRunOptions.origin`, `.hookRecords` of a queued turn): their records are appended to the
//   new user message as `data-hook` parts; a block is the 409 `hook-blocked` before anything but the chat row is written,
//   and the chat row is removed again when this request created it (open point 14: a blocked first message on `/`
//   leaves no chat; `chat.created` is followed by `chat.deleted`);
// - then `resolveRunOutputStyle` (`output-style.ts`, W11.6) gives `PreparedRun.outputStyle` for a chat-model run that
//   calls the model (null for image turns and command replies) and its notices.
import type {
  CatalogModel,
  ChatRequestBody,
  HarnessUIMessage,
  HarnessUIMessagePart,
  HookData,
  ImageAspectRatio,
  ImageOptions,
  MessageMetadata,
  NoticeData,
  RunOrigin,
  Settings,
} from '@harness-forge/shared'
import type { Logger } from '../logger.ts'
import type { ResolvedImageModel, ResolvedModel, ResolvedModelBase } from '../providers/types.ts'
import type { ChatRecord } from '../services/chats/types.ts'
import type { CustomizationCatalog } from '../services/customizations/types.ts'
import type { FilesService } from '../services/files/types.ts'
import type { OpenWorkspace } from '../services/projects/types.ts'
import type { AppDeps } from '../types.ts'
import type { CommandExpansionHost, CommandResolution } from './commands.ts'
import type { RequestKind } from './history.ts'
import type { RunOutputStyle } from './output-style.ts'
import type { Run } from './runs.ts'
import {
  createMessageId,
  harnessDataSchemas,
  HarnessError,
  HOOK_PART_TYPE,
  isHarnessError,
  LIMITS,
  messageMetadataSchema,
  safeParseModelRef,
  TASK_RESULT_PART_TYPE,
  validationError,
} from '@harness-forge/shared'
import { safeValidateUIMessages } from 'ai'
import { compactNeedsChatModel, resolveCommand, turnToolRestriction } from './commands.ts'
import { applyCommandExpansions } from './context.ts'
import { normalizeUserParts } from './files.ts'
import { isGeneratedImageType } from './generated-files.ts'
import { badRequest, classifyRequest, mergeApprovalDecisions, notFound, supersedeApprovals } from './history.ts'
import { isHookBlockedError, runPromptHooks } from './hooks-prompt.ts'
import { checkPlanApprovalMode } from './modes.ts'
import { NOTICES } from './notices.ts'
import { resolveRunOutputStyle } from './output-style.ts'

/** A message write of the history transaction. */
export interface MessageWrite {
  message: HarnessUIMessage
  /** The parent when the message is new; an existing message keeps its own. */
  parentId: string | null
}

/** Writes of the history transaction, applied in order: `updates`, `append`, then the active leaf. */
export interface HistoryWrites {
  /** Stored messages that change: superseded approvals, the merged decisions of a continuation. */
  updates: MessageWrite[]
  /** The new user message (kind `new`). */
  append: MessageWrite | null
  /** The active leaf after the commit: the new user message, the answered message or the continued message. */
  activeLeafId: string
}

/** What an image turn sends to `ImageService.generate` (ADR-028; an image turn sends no history). */
export interface ImageTurnOptions {
  /** The text of the answered user message after slash-command expansion, trimmed (1..`imagePromptMaxChars`). */
  prompt: string
  /** Images to generate (`imageOptions.n`, default 1). */
  n: number
  aspectRatio?: ImageAspectRatio
  /** Stored images sent with the prompt: the attached images, or the generated images of the parent reply. */
  inputFileIds: string[]
  /** Attachments of the new user message that are not sent (the `attachments-unsupported` notice). */
  dropped: number
}

/** The model a run calls: a chat model (`streamText`), or an image model (an image turn, `chat/images.ts`). */
export type RunTarget
  = | {
    kind: 'chat'
    model: ResolvedModel
    /** `imageOptions.aspectRatio` for a chat model with `capabilities.imageOutput` (its `imageParams`). */
    aspectRatio?: ImageAspectRatio
  }
  | { kind: 'image', model: ResolvedImageModel, options: ImageTurnOptions }

export interface PreparedRun {
  kind: RequestKind
  chat: ChatRecord
  /** The model of the run (chat or image model): `target.model`. */
  resolved: ResolvedModelBase
  target: RunTarget
  settings: Settings
  /** The path the reply is generated from, first message first; for a continuation the continued message is last. */
  history: HarnessUIMessage[]
  /** The new user message. */
  userMessage: HarnessUIMessage | null
  /** The continued assistant message (merged decisions), for a continuation. */
  continued: HarnessUIMessage | null
  /** Id of the assistant message of the reply (server-generated, ADR-019; the continued id for a continuation). */
  assistantId: string
  /**
   * The parent of the reply: the new user message, the answered message of a regenerate, or the parent of the continued
   * message. The persisted reply is stored under it and becomes the active leaf only while the leaf is still this
   * message (or the reply itself).
   */
  replyParentId: string | null
  /** A slash command of the (last) user message that decides the reply: a reply command or a failed `run`. */
  command: CommandResolution | null
  /** Approvals resolved as denied (`superseded`). */
  superseded: number
  writes: HistoryWrites
  /**
   * The project folder of a chat-model run of a chat with a project (Phase 7, `openWorkspace`, read again on every run);
   * null without a project, for image turns and command replies, and when the folder is not available.
   */
  workspace: OpenWorkspace | null
  /** Notices decided while preparing (the `workspace-unavailable` notice of a folder that could not be opened). */
  notices: NoticeData[]
  /**
   * The catalog snapshot of the run (Phase 10, ADR-044): the chat project's catalog (the global one without a project),
   * taken once while preparing; commands, the agent-types and skills blocks, `task`, `skill` and background launches of
   * this run all read it.
   */
  catalog: CustomizationCatalog
  /**
   * The model the chat keeps (Phase 10, ADR-045): `chats.model_ref` is touched with it at the start and the end of the
   * run. It is the request's model; it differs from `resolved.modelRef` (the model that runs, `run.started.modelRef`)
   * only when a command file's `model` runs the turn.
   */
  requestModelRef: string
  /**
   * The tool restriction of the turn (Phase 10, `turnToolRestriction`: the turn command's `allowed-tools`); null = none.
   * Passed to `assembleTools({ allowedTools })`.
   */
  turnRestriction: readonly string[] | null
  /**
   * The output style of the run (Phase 11, ADR-051; `resolveRunOutputStyle`): for a chat-model run that calls the
   * model; null for image turns and command replies (and absent in v1.6 test doubles: no style).
   */
  outputStyle?: RunOutputStyle | null
}

/** Options of `prepareRun`. */
export interface PrepareRunOptions {
  /**
   * The request's message was built by the server (Phase 10, ADR-046): the user-role carrier message of a turn started
   * for finished background tasks (`run.started.origin: 'task'`), holding only `data-task-result` parts. Its parts are
   * not normalized like a user's (data parts are refused there), the message is validated with `validateMessage`, and
   * only such a carrier is accepted (a new user message; any other part, an empty message, a regenerate or a
   * continuation is a `validation_error`). It resolves no command.
   */
  readonly serverMessage?: boolean
  /**
   * What started the run (Phase 11; `run.started.origin`, default `request`): the prompt hooks run `UserPromptSubmit`
   * for `request` turns and `SessionStart` for `request` and `queue` turns (`hooks-prompt.ts`).
   */
  readonly origin?: RunOrigin
  /**
   * The `UserPromptSubmit` records of a queued turn (Phase 11, ADR-048): the hooks ran when the message was queued;
   * they are attached to the new user message instead of running again.
   */
  readonly hookRecords?: readonly HookData[]
}

/** The request was stopped before its history was stored. */
export function stoppedBeforeStart(chatId: string): HarnessError {
  return new HarnessError({ code: 'conflict', message: 'The run was stopped before it started.', details: { reason: 'stale', chatId } })
}

/** A resolution with an unknown provider reported as `provider_not_configured` (API.md 2.2). */
async function withProviderCheck<T>(resolve: () => Promise<T>): Promise<T> {
  try {
    return await resolve()
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

/** `resolveModel`, with an unknown provider reported as `provider_not_configured` (API.md 2.2). */
export async function resolveChatModel(deps: Pick<AppDeps, 'providers'>, modelRef: string, signal: AbortSignal): Promise<ResolvedModel> {
  return withProviderCheck(() => deps.providers.resolveModel(modelRef, { signal }))
}

/** The resolved model of a request, before its turn is planned. */
export type ResolvedTarget = { kind: 'chat', model: ResolvedModel } | { kind: 'image', model: ResolvedImageModel }

/**
 * The model of a request (ADR-028): a model of catalog kind `image` resolves with `resolveImageModel` (an image turn),
 * anything else with `resolveModel` (which refuses image models). Resolution errors as in `resolveChatModel`.
 */
export async function resolveTarget(deps: Pick<AppDeps, 'providers' | 'catalog'>, modelRef: string, signal: AbortSignal): Promise<ResolvedTarget> {
  const parts = safeParseModelRef(modelRef)
  const entry = parts === null ? null : await deps.catalog.get(parts.providerId, parts.modelId).catch(() => null)
  if (entry?.kind === 'image')
    return { kind: 'image', model: await withProviderCheck(() => deps.providers.resolveImageModel(modelRef, { signal })) }
  return { kind: 'chat', model: await resolveChatModel(deps, modelRef, signal) }
}

/**
 * `imageOptions` (ADR-028): accepted for an image model; for a chat model only with `capabilities.imageOutput` and then
 * only `aspectRatio`. Otherwise `validation_error` on `['imageOptions']`.
 */
export function checkImageOptions(options: ImageOptions | undefined, kind: ResolvedTarget['kind'], entry: Pick<CatalogModel, 'ref' | 'capabilities'>): void {
  if (options === undefined || kind === 'image')
    return
  if (!entry.capabilities.imageOutput)
    throw badRequest(`The model "${entry.ref}" does not generate images: image options are only for image models and chat models with image output.`, ['imageOptions'])
  if (options.n !== undefined || options.editPrevious !== undefined)
    throw badRequest('A chat model with image output takes only the aspect ratio: n and editPrevious are for image models.', ['imageOptions'])
}

/** The prompt of an image turn: the text parts of the user message after slash-command expansion, trimmed. */
export function imagePrompt(message: HarnessUIMessage): string {
  const [expanded] = applyCommandExpansions([message])
  return (expanded?.parts ?? []).flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n').trim()
}

/** Ids of the generated images of an assistant reply that are still stored (the last `LIMITS.imageInputsMax`). */
export async function generatedImageIds(message: HarnessUIMessage | null | undefined, files: Pick<FilesService, 'idFromUrl' | 'get'>): Promise<string[]> {
  if (message?.role !== 'assistant')
    return []
  const ids: string[] = []
  for (const part of message.parts) {
    if (part.type !== 'file' || !isGeneratedImageType(part.mediaType))
      continue
    const id = files.idFromUrl(part.url)
    if (id === null || ids.includes(id))
      continue
    const file = await files.get(id)
    if (file !== null && isGeneratedImageType(file.mime))
      ids.push(id)
  }
  return ids.slice(-LIMITS.imageInputsMax)
}

/**
 * Input images of an image turn (ADR-028): the images attached to the message when the model has `vision` (at most
 * `LIMITS.imageInputsMax`); else, when none are attached and `editPrevious !== false`, the generated images of the
 * parent reply (vision models only). Other attachments, and images the model cannot take, are `dropped`.
 */
export async function imageTurnInputs(
  message: HarnessUIMessage,
  parent: HarnessUIMessage | null | undefined,
  model: ResolvedModelBase,
  editPrevious: boolean | undefined,
  files: Pick<FilesService, 'idFromUrl' | 'get'>,
): Promise<{ inputFileIds: string[], dropped: number }> {
  const vision = model.entry.capabilities.vision
  const attached: string[] = []
  let dropped = 0
  for (const part of message.parts) {
    if (part.type !== 'file')
      continue
    const id = files.idFromUrl(part.url)
    if (id !== null && isGeneratedImageType(part.mediaType))
      attached.push(id)
    else
      dropped += 1
  }
  if (attached.length > 0) {
    const inputFileIds = vision ? attached.slice(0, LIMITS.imageInputsMax) : []
    return { inputFileIds, dropped: dropped + attached.length - inputFileIds.length }
  }
  if (!vision || editPrevious === false)
    return { inputFileIds: [], dropped }
  return { inputFileIds: await generatedImageIds(parent, files), dropped }
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
  /** The request's model (`body.modelRef`), resolved before the turn is planned: the chat keeps it. */
  request: ResolvedTarget
  logger: Logger
  /** The run's catalog snapshot (command resolution). */
  catalog: CustomizationCatalog
  /** The request's message is a server-built carrier (`PrepareRunOptions.serverMessage`). */
  serverMessage: boolean
}

/** The part types a server-built carrier message may hold (one kind per carrier). */
const CARRIER_PART_TYPES: ReadonlySet<string> = new Set([TASK_RESULT_PART_TYPE, HOOK_PART_TYPE])

/**
 * The parts of a server-built carrier message (Phase 10, ADR-046): one or more `data-task-result` parts or (Phase 11,
 * ADR-048, the carrier of a `Stop` continuation) one or more `data-hook` parts, never mixed, kept as `{ type, id?, data }`
 * (`validateMessage` checks the data); anything else is a `validation_error` on the part.
 */
export function carrierParts(parts: readonly unknown[]): HarnessUIMessagePart[] {
  if (parts.length === 0)
    throw badRequest('A server-started turn needs at least one background task result or hook record.', ['message', 'parts'])
  let kind: string | null = null
  return parts.map((raw, index): HarnessUIMessagePart => {
    const part = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    if (typeof part.type !== 'string' || !CARRIER_PART_TYPES.has(part.type) || (kind !== null && part.type !== kind))
      throw badRequest('A server-started turn can only carry background task results or hook records (one kind).', ['message', 'parts', index])
    kind = part.type
    return { type: part.type, ...(typeof part.id === 'string' ? { id: part.id } : {}), data: part.data } as HarnessUIMessagePart
  })
}

/**
 * The expansion host of a command resolution (Phase 11, ADR-052; `CommandContext.expansion`): the chat's project folder
 * opened once on first use, the shell switch, the trust check of project command files.
 */
export function commandExpansionHost(deps: Pick<AppDeps, 'env' | 'projects' | 'projectTrust'>, projectId: string | null): CommandExpansionHost {
  let opened: Promise<OpenWorkspace | null> | null = null
  return {
    projectId,
    shellEnabled: deps.env.workspaceShell,
    workspace: () => {
      opened ??= projectId === null
        ? Promise.resolve(null)
        : deps.projects.openWorkspace(projectId).then(result => (result.ok ? result.workspace : null))
      return opened
    },
    trusted: async (id, sha256) => (await deps.projectTrust.approved(id)).has(sha256),
  }
}

/** The stored form of the new user message (server metadata, command invocation; a carrier's parts as built). */
async function buildUserMessage(context: PrepareContext, chat: ChatRecord): Promise<{ message: HarnessUIMessage, command: CommandResolution | null }> {
  const { deps, run, body, request } = context
  const metadata: MessageMetadata = { modelRef: request.model.modelRef, startedAt: run.acceptedAt }
  if (context.serverMessage)
    return { message: { id: body.message.id, role: 'user', parts: carrierParts(body.message.parts), metadata }, command: null }
  const parts = await normalizeUserParts(body.message.parts, deps.files)
  const command = await resolveCommand(deps, firstTextOf(parts), {
    chatId: body.chatId,
    signal: run.signal,
    catalog: context.catalog,
    expansion: commandExpansionHost(deps, chat.projectId),
  })
  return { message: { id: body.message.id, role: 'user', parts, metadata: { ...metadata, ...(command === null ? {} : { command: command.invocation }) } }, command }
}

/**
 * The command that decides a regenerated reply: a reply command (and `/compact`) is run again (a prompt command keeps
 * its expansion).
 */
async function regeneratedCommand(context: PrepareContext, userMessage: HarnessUIMessage): Promise<CommandResolution | null> {
  const type = userMessage.metadata?.command?.type
  if (type !== 'reply' && type !== 'compact')
    return null
  const resolution = await resolveCommand(context.deps, firstTextOf(userMessage.parts), { chatId: context.body.chatId, signal: context.run.signal, catalog: context.catalog })
  return resolution?.kind === 'prompt' ? null : resolution
}

/** `/compact` needs a chat model (Phase 9): an image model is a `validation_error` on `['modelRef']`. */
export function checkCompactTarget(command: CommandResolution | null, kind: ResolvedTarget['kind']): void {
  if (command?.kind === 'compact' && kind === 'image')
    throw compactNeedsChatModel()
}

/** The writes of changed path messages, each with its parent on the path (unused: they are stored already). */
function pathWrites(changed: readonly HarnessUIMessage[], path: readonly HarnessUIMessage[]): MessageWrite[] {
  const parentOf = new Map(path.map((message, index) => [message.id, path[index - 1]?.id ?? null]))
  return changed.map(message => ({ message, parentId: parentOf.get(message.id) ?? null }))
}

/**
 * The chat of a request (`chats.ensure`, which saves the model, mode and effort). `projectId` is applied only when this
 * request creates the chat: `ensure` answers `not_found` for an unknown project before the chat row exists (and stores
 * the id through a subquery on `projects`, so a project deleted in between leaves no dangling id); an existing chat
 * keeps its project whatever the request says (moves go through `PATCH /chats/:id`).
 */
export async function ensureChat(deps: Pick<AppDeps, 'chats'>, body: ChatRequestBody): Promise<ChatRecord> {
  return (await ensureRunChat(deps, body)).chat
}

/**
 * `ensureChat` with whether this request created the chat (Phase 11). A new chat also gets the request's
 * `outputStyle` (ADR-051: a style name; null or absent = automatic) as `settings.outputStyle`; an existing chat keeps
 * its own.
 */
export async function ensureRunChat(deps: Pick<AppDeps, 'chats'>, body: ChatRequestBody): Promise<{ chat: ChatRecord, created: boolean }> {
  const ensured = await deps.chats.ensure(body.chatId, {
    modelRef: body.modelRef,
    settings: { toolMode: body.toolMode, reasoningEffort: body.reasoningEffort },
    ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
  })
  const outputStyle = body.outputStyle
  if (!ensured.created || typeof outputStyle !== 'string')
    return ensured
  await deps.chats.touch(body.chatId, { settings: { outputStyle } })
  return { chat: { ...ensured.chat, settings: { ...ensured.chat.settings, outputStyle } }, created: true }
}

/**
 * The project folder of a run (Phase 7): opened for a chat-model run of a chat with a project that calls the model (not
 * for image turns or command replies). An unavailable folder or a deleted project gives no workspace and the
 * `workspace-unavailable` notice (the service's message); a database failure rejects.
 */
export async function openRunWorkspace(
  deps: Pick<AppDeps, 'projects'>,
  chat: Pick<ChatRecord, 'projectId'>,
  target: RunTarget,
  command: CommandResolution | null,
  logger: Logger,
): Promise<{ workspace: OpenWorkspace | null, notices: NoticeData[] }> {
  if (chat.projectId === null || target.kind !== 'chat' || command !== null)
    return { workspace: null, notices: [] }
  const result = await deps.projects.openWorkspace(chat.projectId)
  if (result.ok)
    return { workspace: result.workspace, notices: [] }
  logger.info('the project folder of the chat is not available', { projectId: chat.projectId })
  return { workspace: null, notices: [NOTICES.workspaceUnavailable(result.message)] }
}

/** The model a turn runs on (Phase 10, ADR-045) and what comes with it. */
export interface TurnModel {
  /** The command's model when it can run, else the request's model. */
  target: ResolvedTarget
  /** The request's image options for the request's model; none when a command's model runs. */
  imageOptions: ImageOptions | undefined
  /** `command-model-unavailable` when the command's model cannot run (at most one). */
  notices: NoticeData[]
}

/** The `metadata.command.modelRef` of a stored user message (the turn's command file `model`). */
export function storedCommandModel(message: HarnessUIMessage | null | undefined): string | undefined {
  const modelRef = message?.role === 'user' ? message.metadata?.command?.modelRef : undefined
  return typeof modelRef === 'string' && modelRef !== '' ? modelRef : undefined
}

/** The last user message of a path (the user message of the turn a continuation continues). */
function turnUserMessage(path: readonly HarnessUIMessage[]): HarnessUIMessage | undefined {
  return path.findLast(message => message.role === 'user')
}

/** True when `message` already shows a notice with `code` (a continuation does not repeat it). */
function hasNotice(message: HarnessUIMessage | null | undefined, code: NoticeData['code']): boolean {
  return message?.parts.some(part => part.type === 'data-notice' && (part.data as Partial<NoticeData> | undefined)?.code === code) === true
}

/**
 * A command's model as a chat model, or null when it cannot run: an unknown, disabled or unconfigured provider, a model
 * that is not in the catalog, a failing factory, or a model whose catalog kind is not `chat` (an image model). The abort
 * of a stopped run is rethrown.
 */
async function resolveCommandModel(deps: Pick<AppDeps, 'providers'>, modelRef: string, signal: AbortSignal, logger: Logger): Promise<ResolvedModel | null> {
  try {
    const model = await deps.providers.resolveModel(modelRef, { signal })
    if (model.entry.kind === 'chat')
      return model
    logger.info('the model of the command is not a chat model; the chat\'s model answers', { modelRef, kind: model.entry.kind })
    return null
  }
  catch (error) {
    if (signal.aborted)
      throw error
    logger.info('the model of the command cannot run; the chat\'s model answers', { modelRef, code: isHarnessError(error) ? error.code : 'unknown' })
    return null
  }
}

/**
 * The model of a turn (Phase 10, ADR-045): `override` (the turn command's `model`) when it differs from the request's
 * model and resolves to a chat model; otherwise the request's model, with the notice `command-model-unavailable` when an
 * override could not run (unless `continued` already shows it: one notice per reply).
 */
export async function resolveTurnModel(
  deps: Pick<AppDeps, 'providers'>,
  request: { target: ResolvedTarget, imageOptions: ImageOptions | undefined },
  override: string | undefined,
  options: { signal: AbortSignal, logger: Logger, continued?: HarnessUIMessage | null },
): Promise<TurnModel> {
  const requested: TurnModel = { target: request.target, imageOptions: request.imageOptions, notices: [] }
  if (override === undefined || override === request.target.model.modelRef)
    return requested
  const model = await resolveCommandModel(deps, override, options.signal, options.logger)
  if (model !== null)
    return { target: { kind: 'chat', model }, imageOptions: undefined, notices: [] }
  if (hasNotice(options.continued, 'command-model-unavailable'))
    return requested
  return { ...requested, notices: [NOTICES.commandModelUnavailable(override)] }
}

/**
 * Validates and plans the request. Throws `validation_error`, `not_found`, `conflict`, `provider_not_configured` (and
 * the other resolution errors) before anything but the chat row is written.
 */
export async function prepareRun(deps: AppDeps, run: Run, body: ChatRequestBody, logger: Logger, options: PrepareRunOptions = {}): Promise<PreparedRun> {
  const { planned, created } = await planRun(deps, run, body, logger, options)
  const opened = await openRunWorkspace(deps, planned.chat, planned.target, planned.command, logger)
  const prepared: PreparedRun = {
    ...planned,
    workspace: opened.workspace,
    notices: [...planned.notices, ...opened.notices],
    turnRestriction: turnToolRestriction(planned.history),
  }
  // Phase 11 (ADR-048): `SessionStart` / `UserPromptSubmit`; a block stores nothing (the chat row of this request goes).
  let hooked: PreparedRun
  try {
    const prompt = await runPromptHooks({
      deps,
      prepared,
      body,
      origin: options.origin ?? 'request',
      serverMessage: options.serverMessage === true,
      ...(options.hookRecords === undefined ? {} : { precomputed: options.hookRecords }),
      signal: run.signal,
      logger,
    })
    hooked = await withHookRecords(prepared, prompt.records)
  }
  catch (error) {
    if (created && isHookBlockedError(error))
      await removeCreatedChat(deps, body.chatId, logger)
    throw error
  }
  // Phase 11 (ADR-051): the output style of a run that calls a chat model.
  if (hooked.target.kind !== 'chat' || hooked.command !== null)
    return { ...hooked, outputStyle: null }
  const style = await resolveRunOutputStyle({
    deps,
    catalog: hooked.catalog,
    chat: hooked.chat,
    settings: hooked.settings,
    history: hooked.history,
    modelRef: hooked.resolved.modelRef,
    signal: run.signal,
    logger,
  })
  return { ...hooked, outputStyle: style.style, notices: [...hooked.notices, ...style.notices] }
}

/**
 * The prepared run with `records` appended to its new user message as `data-hook` parts (Phase 11; the history, the
 * new message and its write all carry them). Without records, or without a new user message, the run as it is.
 */
export async function withHookRecords(prepared: PreparedRun, records: readonly HookData[]): Promise<PreparedRun> {
  const message = prepared.userMessage
  if (records.length === 0 || message === null)
    return prepared
  const hooked: HarnessUIMessage = { ...message, parts: [...message.parts, ...records.map(data => ({ type: HOOK_PART_TYPE, data }) as HarnessUIMessagePart)] }
  await validateMessage(hooked)
  const append = prepared.writes.append
  return {
    ...prepared,
    userMessage: hooked,
    history: prepared.history.map(entry => (entry === message ? hooked : entry)),
    writes: { ...prepared.writes, append: append !== null && append.message === message ? { ...append, message: hooked } : append },
  }
}

/** Removes the chat row a blocked request created (Phase 11, open point 14); a failure is logged. */
async function removeCreatedChat(deps: Pick<AppDeps, 'chats'>, chatId: string, logger: Logger): Promise<void> {
  try {
    await deps.chats.remove(chatId)
  }
  catch (error) {
    logger.warn('the chat of a blocked first message could not be removed', { err: error })
  }
}

/** What `planRun` plans (`notices`: the turn model's) and whether the request created the chat. */
interface PlannedRun {
  planned: Omit<PreparedRun, 'workspace' | 'turnRestriction'>
  created: boolean
}

/** `prepareRun` without the workspace, the tool restriction, the prompt hooks and the output style. */
async function planRun(deps: AppDeps, run: Run, body: ChatRequestBody, logger: Logger, options: PrepareRunOptions): Promise<PlannedRun> {
  const kind = classifyRequest(body)
  const serverMessage = options.serverMessage === true
  if (serverMessage && kind !== 'new')
    throw badRequest('A server-started turn sends a new user message.', ['message'])
  const { chat, created } = await ensureRunChat(deps, body)
  // One catalog snapshot per run (never rejects but for an abort: an unavailable folder only adds a diagnostic).
  const catalog = await deps.customizations.catalog(chat.projectId, { signal: run.signal })
  // The request's model first (its errors before anything else); a command's model may run the turn instead.
  const request = await resolveTarget(deps, body.modelRef, run.signal)
  checkImageOptions(body.imageOptions, request.kind, request.model.entry)
  if (request.kind === 'image' && kind === 'continuation')
    throw badRequest('An image model cannot continue a tool call. Pick a chat model to answer the pending tool call.', ['modelRef'])
  const settings = await deps.settings.get()
  const context: PrepareContext = { deps, run, body, request, logger, catalog, serverMessage }
  const turnModel = (override: string | undefined, continued: HarnessUIMessage | null = null): Promise<TurnModel> =>
    resolveTurnModel(deps, { target: request, imageOptions: body.imageOptions }, override, { signal: run.signal, logger, continued })
  const planned = await planHistory(context, kind, chat, turnModel)
  const resolved: ResolvedModelBase = planned.target.model
  deps.catalog.markUsed(resolved.providerId, resolved.modelId).catch((error: unknown) => logger.debug('cannot record the model use', { err: error }))
  return { planned: { ...planned, kind, chat, resolved, settings, catalog, requestModelRef: request.model.modelRef }, created }
}

/** What `planHistory` decides (the rest of `PreparedRun` comes from `planRun`). */
type PlannedHistory = Pick<PreparedRun, 'target' | 'history' | 'userMessage' | 'continued' | 'assistantId' | 'replyParentId' | 'command' | 'superseded' | 'writes' | 'notices'>

/** The history operation of a request and the model of its turn. */
async function planHistory(
  context: PrepareContext,
  kind: RequestKind,
  chat: ChatRecord,
  turnModel: (override: string | undefined, continued?: HarnessUIMessage | null) => Promise<TurnModel>,
): Promise<PlannedHistory> {
  const { deps, body } = context
  switch (kind) {
    case 'new': {
      if (await deps.chats.getMessage(body.chatId, body.message.id) !== null)
        throw new HarnessError({ code: 'conflict', message: 'A message with this id already exists.', details: { reason: 'exists', chatId: body.chatId } })
      // The path the message continues: `parentId`, or the active leaf when it is omitted (`not_found` when unknown).
      const parentId = body.parentId === undefined ? chat.activeLeafId : body.parentId
      const path = await deps.chats.listPath(body.chatId, parentId)
      const { message, command } = await buildUserMessage(context, chat)
      await validateMessage(message)
      // Only the approvals of this path: those of other versions stay pending.
      const superseded = supersedeApprovals(path)
      const decides = command?.kind === 'prompt' ? null : command
      const model = await turnModel(command?.kind === 'prompt' ? command.invocation.modelRef : undefined)
      checkCompactTarget(decides, model.target.kind)
      return {
        target: await planTarget(context, model, { message, parent: path.at(-1), decides, countDropped: true }),
        history: [...superseded.messages, message],
        userMessage: message,
        continued: null,
        assistantId: createMessageId(),
        replyParentId: message.id,
        command: decides,
        superseded: superseded.count,
        writes: { updates: pathWrites(superseded.changed, path), append: { message, parentId }, activeLeafId: message.id },
        notices: model.notices,
      }
    }
    case 'regenerate': {
      // The target is a user message to answer, or a reply whose previous message on its path is answered instead.
      const target = body.messageId ?? chat.activeLeafId
      const path = target === null ? [] : await deps.chats.listPath(body.chatId, target)
      const answeredIndex = path.at(-1)?.role === 'user' ? path.length - 1 : path.length - 2
      const answered = path[answeredIndex]
      if (answered === undefined || answered.role !== 'user')
        throw badRequest('There is no user message to answer.', ['messageId'])
      const kept = path.slice(0, answeredIndex + 1)
      const superseded = supersedeApprovals(kept)
      const command = await regeneratedCommand(context, answered)
      // A prompt command keeps its stored expansion and model (a file changed since does not matter).
      const model = await turnModel(command === null ? storedCommandModel(answered) : undefined)
      checkCompactTarget(command, model.target.kind)
      return {
        target: await planTarget(context, model, { message: answered, parent: kept.at(-2), decides: command, countDropped: false }),
        history: superseded.messages,
        userMessage: null,
        continued: null,
        assistantId: createMessageId(),
        replyParentId: answered.id,
        command,
        superseded: superseded.count,
        writes: { updates: pathWrites(superseded.changed, kept), append: null, activeLeafId: answered.id },
        notices: model.notices,
      }
    }
    case 'continuation': {
      if (chat.activeLeafId === null || chat.activeLeafId !== body.message.id)
        throw notFound('The continuation does not match the active leaf of this chat.')
      const path = await deps.chats.listPath(body.chatId, chat.activeLeafId)
      const last = path.at(-1)
      if (last === undefined || last.role !== 'assistant' || last.id !== body.message.id)
        throw notFound('The continuation does not match the active leaf of this chat.')
      const { message, merged } = mergeApprovalDecisions(last, body.message)
      if (merged === 0)
        throw badRequest('The continuation carries no approval decision for a pending tool call.', ['message', 'parts'])
      checkPlanApprovalMode(last, message, body.toolMode)
      await validateMessage(message)
      const parentId = path.at(-2)?.id ?? null
      // The turn's command model again (the reply already shows the notice when it could not run).
      const model = await turnModel(storedCommandModel(turnUserMessage(path)), last)
      return {
        target: await planTarget(context, model, { message, parent: path.at(-2), decides: null, countDropped: false }),
        history: [...path.slice(0, -1), message],
        userMessage: null,
        continued: message,
        assistantId: message.id,
        replyParentId: parentId,
        command: null,
        superseded: 0,
        writes: { updates: [{ message, parentId }], append: null, activeLeafId: message.id },
        notices: model.notices,
      }
    }
  }
}

/** The turn a request answers: the user message, its parent on the path, the command that decides the reply. */
interface PlannedTurn {
  message: HarnessUIMessage
  parent: HarnessUIMessage | undefined
  /** A reply or failed command writes the reply without a model call (the image prompt is not checked then). */
  decides: CommandResolution | null
  /** Count the attachments an image turn does not send (the new user message only, like chat runs). */
  countDropped: boolean
}

/**
 * The target of a run. For an image model: the prompt (the user text after slash-command expansion, `400` when empty
 * or longer than `LIMITS.imagePromptMaxChars` unless a command writes the reply), `n`, the aspect ratio and the input
 * images (see `imageTurnInputs`). For a chat model with image output: the requested aspect ratio. The image options are
 * the turn model's (the request's for the request's model, none for a command's model).
 */
async function planTarget(context: PrepareContext, model: TurnModel, turn: PlannedTurn): Promise<RunTarget> {
  const resolved = model.target
  const options = model.imageOptions
  if (resolved.kind === 'chat') {
    const aspectRatio = resolved.model.entry.capabilities.imageOutput ? options?.aspectRatio : undefined
    return { kind: 'chat', model: resolved.model, ...(aspectRatio === undefined ? {} : { aspectRatio }) }
  }
  const prompt = imagePrompt(turn.message)
  if (turn.decides === null) {
    if (prompt === '')
      throw badRequest('Describe the image to generate: an image model needs a text prompt.', ['message', 'parts'])
    if (prompt.length > LIMITS.imagePromptMaxChars)
      throw badRequest(`Image prompts are limited to ${LIMITS.imagePromptMaxChars} characters.`, ['message', 'parts'])
  }
  const inputs = await imageTurnInputs(turn.message, turn.parent, resolved.model, options?.editPrevious, context.deps.files)
  return {
    kind: 'image',
    model: resolved.model,
    options: {
      prompt,
      n: options?.n ?? 1,
      ...(options?.aspectRatio === undefined ? {} : { aspectRatio: options.aspectRatio }),
      inputFileIds: inputs.inputFileIds,
      dropped: turn.countDropped ? inputs.dropped : 0,
    },
  }
}

/**
 * Applies the history writes atomically and moves the active leaf (not a compare-and-set: the request's own message
 * wins over a concurrent version switch). A write that stores nothing fails the whole commit.
 */
export async function commitHistory(deps: Pick<AppDeps, 'chats'>, chatId: string, writes: HistoryWrites): Promise<void> {
  const leafMissing = (): HarnessError => notFound(`Message ${writes.activeLeafId} not found in chat ${chatId}.`)
  if (writes.updates.length === 0 && writes.append === null) {
    // Only the leaf moves (a regenerate): a single statement.
    if (!await deps.chats.setActiveLeaf(chatId, writes.activeLeafId))
      throw leafMissing()
    return
  }
  await deps.chats.transaction(async (store) => {
    for (const { message, parentId } of writes.updates)
      await store.upsertMessage(chatId, message, parentId)
    if (writes.append !== null)
      await store.appendMessage(chatId, writes.append.message, writes.append.parentId)
    if (!await store.setActiveLeaf(chatId, writes.activeLeafId))
      throw leafMissing()
  })
}
