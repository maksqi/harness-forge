// Streaming and persistence of a run (ARCHITECTURE.md 6.1-6.3, API.md 6). After the history is committed the run
// always answers with an AI SDK v7 UI message stream:
// - model runs: `streamText({ model, instructions, messages, tools, toolApproval, stopWhen: isStepCount(maxSteps),
//   abortSignal: run.signal, maxRetries: 2, ... })`, `result.consumeStream()` (the run survives a client disconnect)
//   and `toUIMessageStream({ stream: result.stream, originalMessages, generateMessageId, sendReasoning, sendSources,
//   messageMetadata, onError, onEnd })`; a request without tools gets earlier tool calls as text (`tool-history.ts`);
// - reply commands and failures before the model call: `createUIMessageStream` without a model call.
// `createUIMessageStreamResponse({ stream, consumeSseStream })` tees the SSE text into the run buffer (resume). The end
// callback persists the message idempotently (upsert by id, `aborted` / `error` in the metadata), writes the usage
// row, touches the chat (`pending_approval`), records the provider outcome, releases the run, emits `run.finished`
// and fires `message.completed`. A stream that fails without reaching the end callback is finalized when the SSE copy
// ends, so a run is always released.
import type { HarnessError, HarnessUIMessage, MessageMetadata, NoticeData, ReasoningEffort, ToolMode } from '@harness-forge/shared'
import type { ModelMessage, TextStreamPart, ToolSet, UIMessageChunk, UIMessageStreamOnEndCallback } from 'ai'
import type { Logger } from '../logger.ts'
import type { AppDeps } from '../types.ts'
import type { RunEnding } from './history.ts'
import type { PreparedRun } from './prepare.ts'
import type { Run, RunRegistry } from './runs.ts'
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
} from 'ai'
import { createToolApproval } from './approval.ts'
import { applyCommandExpansions, trimToContext, validModelMessages } from './context.ts'
import {
  errorEnvelopeText,
  errorInit,
  isAbortError,
  isToolCallError,
  mapRunError,
  PROVIDER_ERROR_CODES,
  toolErrorText,
} from './errors.ts'
import { prepareModelFiles } from './files.ts'
import { finalizeParts, hasPendingApproval, plainText } from './history.ts'
import { buildRunParams } from './params.ts'
import { SseReplayBuffer } from './runs.ts'
import { generateChatTitle } from './title.ts'
import { toolPartsAsText } from './tool-history.ts'
import { assembleTools } from './tools.ts'
import { addMessageUsage, roundUsd, RunTracker, toMessageUsage } from './usage.ts'

/** Retries of a failed model call before streaming starts. */
export const MODEL_MAX_RETRIES = 2
const REPLY_TEXT_ID = 'text-0'

// ---------- notices ----------

export const NOTICES = {
  superseded: (count: number): NoticeData => ({
    level: 'info',
    code: 'approvals-superseded',
    message: count === 1
      ? 'A pending tool call was denied because a new message was sent.'
      : `${count} pending tool calls were denied because a new message was sent.`,
  }),
  toolsUnsupported: (): NoticeData => ({
    level: 'warning',
    code: 'tools-unsupported',
    message: 'This model does not support tools, so no tools were sent.',
  }),
  filesNotSent: (count: number): NoticeData => ({
    level: 'warning',
    code: 'attachments-unsupported',
    message: count === 1
      ? 'This model cannot read the attached file, so it was not sent.'
      : `This model cannot read ${count} of the attached files, so they were not sent.`,
  }),
  contextTrimmed: (): NoticeData => ({
    level: 'info',
    code: 'context-trimmed',
    message: 'Older messages were left out to fit the context window of this model.',
  }),
} as const

/** An earlier reply of the same model already shows this notice (shown once per chat and model, not on every reply). */
export function alreadyNoticed(history: readonly HarnessUIMessage[], notice: NoticeData, modelRef: string): boolean {
  return history.some(message => message.role === 'assistant' && message.metadata?.modelRef === modelRef
    && message.parts.some(part => part.type === 'data-notice' && part.data.code === notice.code && part.data.message === notice.message))
}

/** Adds `data-notice` chunks right after the `start` chunk. */
export function withNotices(stream: ReadableStream<UIMessageChunk>, notices: () => readonly NoticeData[]): ReadableStream<UIMessageChunk> {
  let injected = false
  return stream.pipeThrough(new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      if (!injected && chunk.type === 'start') {
        injected = true
        for (const data of notices())
          controller.enqueue({ type: 'data-notice', data })
      }
    },
  }))
}

/**
 * `result.stream` with read errors turned into an `error` part: `streamText` errors its stream when the model stream
 * breaks mid-way (a reset connection); as a part the error reaches the client as an envelope and the message is
 * persisted through the normal end callback.
 */
export function catchStreamErrors(stream: ReadableStream<TextStreamPart<ToolSet>>): ReadableStream<TextStreamPart<ToolSet>> {
  const reader = stream.getReader()
  return new ReadableStream<TextStreamPart<ToolSet>>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done)
          controller.close()
        else
          controller.enqueue(value)
      }
      catch (error) {
        controller.enqueue({ type: 'error', error })
        controller.close()
      }
    },
    cancel: reason => reader.cancel(reason),
  })
}

// ---------- background tasks ----------

/** Background work of runs (titles, `message.completed` hooks), awaited by `idle()` in tests and at shutdown. */
export class TaskTracker {
  readonly #tasks = new Set<Promise<unknown>>()

  track(task: Promise<unknown>): void {
    const tracked = task.catch(() => {})
    this.#tasks.add(tracked)
    void tracked.finally(() => this.#tasks.delete(tracked))
  }

  async idle(): Promise<void> {
    while (this.#tasks.size > 0)
      await Promise.allSettled([...this.#tasks])
  }
}

// ---------- session ----------

export interface RunContext {
  deps: AppDeps
  registry: RunRegistry
  run: Run
  prepared: PreparedRun
  toolMode: ToolMode
  reasoningEffort: ReasoningEffort
  logger: Logger
  now: () => number
  tasks: TaskTracker
  titleTimeoutMs: number
  /** Aborted at shutdown (title attempts). */
  lifecycle: AbortSignal
}

type StreamMode = 'model' | 'reply' | 'error'

/** State of one run between the stream start and its persistence. */
export class RunSession {
  readonly tracker: RunTracker
  readonly notices: NoticeData[] = []
  mode: StreamMode = 'model'
  fatal: HarnessError | null = null
  finishMetadata: MessageMetadata | null = null
  readonly startedAt: number
  #finalized = false
  #finalizing: Promise<void> | null = null
  readonly #mapped = new Map<unknown, HarnessError>()
  readonly ctx: RunContext

  constructor(ctx: RunContext) {
    this.ctx = ctx
    this.tracker = new RunTracker(ctx.now)
    this.startedAt = ctx.now()
  }

  get chatId(): string {
    return this.ctx.run.chatId
  }

  get assistantId(): string {
    return this.ctx.prepared.assistantId
  }

  /** Metadata of the continued message (an approval continuation extends it). */
  get previous(): MessageMetadata | undefined {
    return this.ctx.prepared.continued?.metadata
  }

  startMetadata(): MessageMetadata {
    return { modelRef: this.ctx.prepared.resolved.modelRef, startedAt: this.previous?.startedAt ?? this.startedAt }
  }

  /** The complete metadata of the message when the run ends at `finishedAt`. */
  buildFinishMetadata(finishedAt: number, ending: RunEnding): MessageMetadata {
    const previous = this.previous
    const { aborted: _aborted, error: _error, finishReason: _finishReason, ...kept } = previous ?? {}
    const metadata: MessageMetadata = {
      ...kept,
      ...this.startMetadata(),
      finishedAt,
      durationMs: (previous?.durationMs ?? 0) + Math.max(0, finishedAt - this.startedAt),
    }
    const reasoningMs = this.tracker.reasoningMs()
    if (reasoningMs !== undefined || previous?.reasoningMs !== undefined)
      metadata.reasoningMs = (previous?.reasoningMs ?? 0) + (reasoningMs ?? 0)
    if (this.mode === 'model' && this.tracker.hasUsage) {
      metadata.usage = addMessageUsage(previous?.usage, toMessageUsage(this.tracker.usage, this.tracker.finalStepUsage))
      const cost = this.tracker.cost(this.ctx.prepared.resolved.entry.cost)
      if (cost !== undefined || previous?.costUsd !== undefined)
        metadata.costUsd = roundUsd((previous?.costUsd ?? 0) + (cost ?? 0))
    }
    if (ending === 'failed')
      metadata.finishReason = 'error'
    else if (this.tracker.finishReason !== undefined)
      metadata.finishReason = this.tracker.finishReason
    else if (ending === 'completed')
      metadata.finishReason = 'stop'
    if (ending === 'aborted')
      metadata.aborted = true
    if (ending === 'failed' && this.fatal !== null)
      metadata.error = errorInit(this.fatal)
    return metadata
  }

  map(error: unknown): HarnessError {
    let mapped = this.#mapped.get(error)
    if (mapped === undefined) {
      mapped = mapRunError(this.ctx.deps.providers, this.ctx.prepared.resolved.providerId, error)
      this.#mapped.set(error, mapped)
    }
    return mapped
  }

  /** Records the error that ends the run (the first one; an abort of a stopped run is not a failure). */
  recordFatal(error: unknown): void {
    if (this.fatal !== null || (this.ctx.run.signal.aborted && isAbortError(error)))
      return
    this.fatal = this.map(error)
    this.ctx.logger.warn('run failed', { code: this.fatal.code, err: error })
  }

  /** `messageMetadata` of `toUIMessageStream`: observes every part; metadata for `start` and `finish` only. */
  observe(part: TextStreamPart<ToolSet>): MessageMetadata | undefined {
    try {
      this.tracker.observe(part)
      if (part.type === 'error') {
        this.recordFatal(part.error)
      }
      else if (part.type === 'start') {
        return this.startMetadata()
      }
      else if (part.type === 'finish') {
        this.finishMetadata = this.buildFinishMetadata(this.ctx.now(), 'completed')
        return this.finishMetadata
      }
    }
    catch (error) {
      this.ctx.logger.warn('cannot observe a stream part', { err: error })
    }
    return undefined
  }

  /** `onError`: tool errors as plain text, run errors as the envelope JSON. */
  errorText(error: unknown): string {
    try {
      if (isAbortError(error))
        return 'The run was stopped.'
      if (isToolCallError(error))
        return toolErrorText(error, text => this.ctx.deps.redactor.redactText(text))
      return errorEnvelopeText(this.map(error))
    }
    catch {
      return 'An error occurred.'
    }
  }

  readonly onEnd: UIMessageStreamOnEndCallback<HarnessUIMessage> = async ({ responseMessage, isAborted }) => {
    await this.finalize(responseMessage, isAborted)
  }

  /** The SSE copy ended: finalizes a run whose stream failed before its end callback. */
  async ensureFinalized(streamError?: unknown): Promise<void> {
    if (streamError !== undefined)
      this.recordFatal(streamError)
    if (!this.#finalized)
      await this.finalize(undefined, this.ctx.run.signal.aborted && this.fatal === null)
    else if (this.#finalizing !== null)
      await this.#finalizing
  }

  finalize(responseMessage: HarnessUIMessage | undefined, isAborted: boolean): Promise<void> {
    if (this.#finalized)
      return this.#finalizing ?? Promise.resolve()
    this.#finalized = true
    this.#finalizing = this.#persist(responseMessage, isAborted)
    return this.#finalizing
  }

  #ending(isAborted: boolean): RunEnding {
    if (isAborted || (this.ctx.run.signal.aborted && this.fatal === null && this.tracker.finishReason === undefined))
      return 'aborted'
    return this.fatal === null ? 'completed' : 'failed'
  }

  finalMessage(responseMessage: HarnessUIMessage | undefined, ending: RunEnding): HarnessUIMessage {
    const base = responseMessage ?? this.ctx.prepared.continued ?? { id: this.assistantId, role: 'assistant' as const, parts: [] }
    let parts = finalizeParts(base.parts, ending)
    if (this.notices.length > 0) {
      const at = Math.min(this.ctx.prepared.continued?.parts.length ?? 0, parts.length)
      parts = [...parts.slice(0, at), ...this.notices.map(data => ({ type: 'data-notice' as const, data })), ...parts.slice(at)]
    }
    const metadata = ending === 'completed' && this.finishMetadata !== null ? this.finishMetadata : this.buildFinishMetadata(this.ctx.now(), ending)
    return { id: this.assistantId, role: 'assistant', parts, metadata }
  }

  async #step(label: string, fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn()
      return true
    }
    catch (error) {
      this.ctx.logger.error(`run end: ${label} failed`, { err: error })
      return false
    }
  }

  async #persist(responseMessage: HarnessUIMessage | undefined, isAborted: boolean): Promise<void> {
    const { deps, run, registry, prepared, logger } = this.ctx
    run.phase = 'finishing'
    const ending = this.#ending(isAborted)
    const resolved = prepared.resolved
    let message: HarnessUIMessage | null = null
    let awaitingApproval = false
    try {
      if (run.forceReleased) {
        logger.warn('a force-released run ended; its message is not stored', { messageId: this.assistantId })
        return
      }
      message = this.finalMessage(responseMessage, ending)
      awaitingApproval = hasPendingApproval(message)
      const stored = await this.#step('message upsert', () => deps.chats.upsertMessage(this.chatId, message!))
      const usage = this.tracker.usage
      if (this.mode === 'model' && this.tracker.hasUsage) {
        await this.#step('usage row', () => deps.chats.addUsage({
          chatId: this.chatId,
          messageId: this.assistantId,
          purpose: 'chat',
          providerId: resolved.providerId,
          modelId: resolved.modelId,
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
          cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
          cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
          costUsd: this.tracker.cost(resolved.entry.cost) ?? null,
        }))
      }
      if (stored)
        await this.#step('chat touch', () => deps.chats.touch(this.chatId, { pendingApproval: awaitingApproval, modelRef: resolved.modelRef }))
      if (this.mode === 'model') {
        if (ending === 'completed')
          await this.#step('provider outcome', () => deps.providers.recordOutcome(resolved.providerId, { ok: true }))
        else if (ending === 'failed' && this.fatal !== null && PROVIDER_ERROR_CODES.has(this.fatal.code))
          await this.#step('provider outcome', () => deps.providers.recordOutcome(resolved.providerId, { ok: false, error: errorInit(this.fatal!) }))
      }
    }
    catch (error) {
      logger.error('run end failed', { err: error })
    }
    finally {
      if (registry.release(run)) {
        deps.events.emit('run.finished', {
          chatId: this.chatId,
          messageId: this.assistantId,
          outcome: ending,
          awaitingApproval,
          ...(ending === 'failed' && this.fatal !== null ? { error: errorInit(this.fatal) } : {}),
        })
      }
      if (message !== null)
        this.#fireMessageCompleted(message, ending)
    }
  }

  #fireMessageCompleted(message: HarnessUIMessage, ending: RunEnding): void {
    const { deps, prepared } = this.ctx
    const cost = this.mode === 'model' ? this.tracker.cost(prepared.resolved.entry.cost) : undefined
    this.ctx.tasks.track(deps.registry.hooks.run('message.completed', {
      chatId: this.chatId,
      modelRef: prepared.resolved.modelRef,
      message,
      usage: this.tracker.usage,
      ...(cost === undefined ? {} : { costUsd: cost }),
      aborted: ending === 'aborted',
    }, undefined))
  }
}

// ---------- streams ----------

/** A reply command: the markdown written as the assistant message without a model call. */
export function replyStream(session: RunSession, markdown: string): ReadableStream<UIMessageChunk> {
  session.mode = 'reply'
  const { prepared } = session.ctx
  return createUIMessageStream<HarnessUIMessage>({
    originalMessages: prepared.history,
    generateId: () => session.assistantId,
    execute: ({ writer }) => {
      writer.write({ type: 'start', messageId: session.assistantId, messageMetadata: session.startMetadata() })
      writer.write({ type: 'start-step' })
      writer.write({ type: 'text-start', id: REPLY_TEXT_ID })
      if (markdown !== '')
        writer.write({ type: 'text-delta', id: REPLY_TEXT_ID, delta: markdown })
      writer.write({ type: 'text-end', id: REPLY_TEXT_ID })
      writer.write({ type: 'finish-step' })
      session.finishMetadata = session.buildFinishMetadata(session.ctx.now(), 'completed')
      writer.write({ type: 'finish', finishReason: 'stop', messageMetadata: session.finishMetadata })
    },
    onError: error => session.errorText(error),
    onEnd: session.onEnd,
  }) as ReadableStream<UIMessageChunk>
}

/** A run that failed before the model call (a failing command, a history the model cannot take). */
export function errorStream(session: RunSession, error: HarnessError): ReadableStream<UIMessageChunk> {
  session.mode = 'error'
  session.fatal ??= error
  const { prepared } = session.ctx
  return createUIMessageStream<HarnessUIMessage>({
    originalMessages: prepared.history,
    generateId: () => session.assistantId,
    execute: ({ writer }) => {
      writer.write({ type: 'start', messageId: session.assistantId, messageMetadata: session.startMetadata() })
      writer.write({ type: 'error', errorText: errorEnvelopeText(error) })
    },
    onError: failure => session.errorText(failure),
    onEnd: session.onEnd,
  }) as ReadableStream<UIMessageChunk>
}

/** Tools, parameters, model messages and the `streamText` call of a model run. */
export async function modelStream(session: RunSession): Promise<ReadableStream<UIMessageChunk>> {
  const { deps, run, prepared, logger } = session.ctx
  const { resolved } = prepared
  const chatId = run.chatId
  const modelRef = resolved.modelRef

  const assembled = await assembleTools({
    chatId,
    modelRef,
    toolMode: session.ctx.toolMode,
    modelSupportsTools: resolved.entry.capabilities.tools,
    registry: deps.registry,
    plugins: deps.plugins,
    toolService: deps.tools,
    mcp: deps.mcp,
    signal: run.signal,
    logger,
  })
  if (assembled.unsupported) {
    const notice = NOTICES.toolsUnsupported()
    if (!alreadyNoticed(prepared.history, notice, modelRef))
      session.notices.push(notice)
  }

  const params = await buildRunParams({
    chatId,
    modelRef,
    resolved,
    reasoningEffort: session.ctx.reasoningEffort,
    toolMode: session.ctx.toolMode,
    globalInstructions: prepared.settings.instructions,
    chatInstructions: prepared.chat.settings.instructions,
    maxSteps: prepared.settings.maxSteps,
    registry: deps.registry,
    logger,
  })

  const files = await prepareModelFiles(applyCommandExpansions(prepared.history), {
    capabilities: resolved.entry.capabilities,
    files: deps.files,
    logger,
    ...(prepared.userMessage === null ? {} : { noticeMessageId: prepared.userMessage.id }),
  })
  if (files.dropped > 0)
    session.notices.push(NOTICES.filesNotSent(files.dropped))

  const tools = Object.keys(assembled.tools).length > 0 ? assembled.tools : undefined
  // Without tool definitions, earlier tool calls go to the model as text: providers reject tool content without tools.
  const history = tools === undefined ? toolPartsAsText(files.messages) : files.messages
  const converted = await convertToModelMessages<HarnessUIMessage>(history, { tools: assembled.tools, ignoreIncompleteToolCalls: true })
  const messagesDraft: { messages: ModelMessage[] } = { messages: converted }
  await deps.registry.hooks.run('chat.messages', { chatId, modelRef }, messagesDraft)
  const hooked = validModelMessages(messagesDraft.messages)
  if (hooked === null)
    logger.warn('chat.messages hooks returned invalid messages; the original messages are sent')
  const trimmed = trimToContext(hooked ?? converted, resolved.entry.contextWindow, params.instructions)
  if (trimmed.removed > 0)
    session.notices.push(NOTICES.contextTrimmed())

  const result = streamText({
    model: resolved.model,
    instructions: params.instructions,
    messages: trimmed.messages,
    tools,
    toolApproval: createToolApproval({
      chatId,
      modelRef,
      toolMode: session.ctx.toolMode,
      tools: assembled.byName,
      prefs: assembled.prefs,
      registry: deps.registry,
      plugins: deps.plugins,
      signal: run.signal,
      logger,
    }),
    experimental_toolApprovalSecret: deps.keyring.subkey('approval'),
    stopWhen: isStepCount(params.maxSteps),
    abortSignal: run.signal,
    maxRetries: MODEL_MAX_RETRIES,
    providerOptions: params.providerOptions,
    ...(Object.keys(params.headers).length > 0 ? { headers: params.headers } : {}),
    ...(params.reasoning === undefined ? {} : { reasoning: params.reasoning }),
    ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
    ...(params.maxOutputTokens === undefined ? {} : { maxOutputTokens: params.maxOutputTokens }),
    onError: ({ error }) => {
      if (!(run.signal.aborted && isAbortError(error)))
        logger.debug('model stream error', { err: error })
    },
  })
  void Promise.resolve(result.consumeStream({ onError: () => {} })).catch(() => {})

  return toUIMessageStream<ToolSet, HarnessUIMessage>({
    stream: catchStreamErrors(result.stream),
    ...(tools === undefined ? {} : { tools }),
    originalMessages: prepared.history,
    generateMessageId: () => session.assistantId,
    sendReasoning: true,
    sendSources: true,
    messageMetadata: ({ part }) => session.observe(part),
    onError: error => session.errorText(error),
    onEnd: session.onEnd,
  }) as ReadableStream<UIMessageChunk>
}

/** Starts the title of a chat without one, in parallel with the reply. */
function startTitle(session: RunSession): void {
  const { deps, prepared, logger, tasks, titleTimeoutMs, lifecycle } = session.ctx
  if (prepared.chat.titleSource !== null)
    return
  const first = prepared.history.find(message => message.role === 'user')
  const text = first === undefined ? '' : plainText(first)
  if (text === '')
    return
  tasks.track(generateChatTitle(deps, { chatId: session.chatId, text, chatModel: prepared.resolved, logger, signal: lifecycle }, titleTimeoutMs))
}

/**
 * Starts the stream of a committed run and returns the HTTP response. Never throws: a failure before the model call
 * becomes an in-stream error that is persisted like any other.
 */
export async function launchRun(ctx: RunContext): Promise<Response> {
  const { deps, run, prepared, logger } = ctx
  const session = new RunSession(ctx)
  const buffer = new SseReplayBuffer()
  run.buffer = buffer
  run.messageId = prepared.assistantId
  run.modelRef = prepared.resolved.modelRef
  run.startedAt = session.startedAt
  run.phase = 'streaming'
  deps.events.emit('run.started', { chatId: run.chatId, messageId: prepared.assistantId, modelRef: prepared.resolved.modelRef })
  try {
    await deps.chats.touch(run.chatId, { pendingApproval: false, modelRef: prepared.resolved.modelRef })
  }
  catch (error) {
    logger.warn('cannot touch the chat', { err: error })
  }
  if (prepared.superseded > 0)
    session.notices.push(NOTICES.superseded(prepared.superseded))
  startTitle(session)

  let stream: ReadableStream<UIMessageChunk>
  try {
    const command = prepared.command
    if (command?.kind === 'reply')
      stream = replyStream(session, command.markdown)
    else if (command?.kind === 'failed')
      stream = errorStream(session, command.error)
    else
      stream = await modelStream(session)
  }
  catch (error) {
    session.recordFatal(error)
    stream = errorStream(session, session.fatal ?? session.map(error))
  }

  return createUIMessageStreamResponse({
    stream: withNotices(stream, () => session.notices),
    consumeSseStream: ({ stream: copy }) => {
      let failure: unknown
      return buffer
        .consume(copy, (error) => {
          failure = error
        })
        .then(() => session.ensureFinalized(failure))
        .catch((error: unknown) => logger.error('cannot finalize the run', { err: error }))
    },
  })
}
