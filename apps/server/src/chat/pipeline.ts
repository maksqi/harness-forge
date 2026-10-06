// Streaming and persistence of a run (ARCHITECTURE.md 6.1-6.3 / 6.11, API.md 6). After the history is committed the
// run always answers with an AI SDK v7 UI message stream built with `createUIMessageStream`, whose end callback saves
// exactly what was streamed:
// - model runs: `streamText({ model, instructions, messages, tools, toolApproval, stopWhen: isStepCount(maxSteps),
//   abortSignal: run.signal, maxRetries: 2, ... })`, `result.consumeStream()` (the run survives a client disconnect),
//   `const ui = toUIMessageStream({ stream: result.stream, originalMessages, generateMessageId, sendReasoning,
//   sendSources, messageMetadata, onError })` (no end callback of its own) and `writer.merge(ui.pipeThrough(
//   storeGeneratedFiles(...)))`: generated files are stored before they are streamed or saved (`generated-files.ts`);
//   a request without tools gets earlier tool calls as text (`tool-history.ts`); a chat model with image output gets
//   the provider options of `imageParams` (ADR-028); a run with an open project folder (Phase 7, `prepared.workspace`)
//   gets the workspace tools (`execute` tools only with `env.workspaceShell`), `ToolCallContext.workspace`, the
//   workspace instructions and `projectMaxSteps`; Phase 8: and the run scope (`scope.ts`: the assistant message id,
//   the run's checkpoint journal, the shell rules and the shared working folder), bound to every tool and policy call;
// - image turns (an image model): `imageStream` (`images.ts`), one `ImageService.generate` call;
// - reply commands and failures before the model call: `createUIMessageStream` without a model call.
// `createUIMessageStreamResponse({ stream, consumeSseStream })` tees the SSE text into the run buffer (resume). The end
// callback persists the message idempotently (one transaction: an upsert by id under the reply parent, `aborted` /
// `error` in the metadata, and a compare-and-set of the active leaf, ADR-023), writes the usage row, touches the chat
// (`pending_approval`), records the provider outcome, releases the run, emits `run.finished` and fires
// `message.completed`. A stream that fails without reaching the end callback is finalized when the SSE copy ends, so a
// run is always released.
// Phase 9 seams (C26; the features land behind them in P9-A): the model history is `buildModelHistory`
// (`model-history.ts`: compaction, steers, sub-agent outputs, command expansions); `streamText` gets the step composer
// `createPrepareStep({ contextGuard, steer })` (`steps.ts`) and `activeTools` (`modes.ts` through `assembleTools`);
// chunks a step boundary adds (`RunSession.inject`) are placed by `stepInjector` (`steer.ts`) before the step's
// `start-step`; transient chunks go out through `RunSession.writeTransient`; extra costs (`generate_image`, compaction,
// sub-agents) through `RunSession.addExtraCost`; the agent scope (`agent-scope.ts`: the mode, the sub-agent runner of
// `subagent/index.ts`, the todos) is bound to every tool call; `RunContext.onReleased` runs once right after the run
// left the registry (the queue's run end); a `/compact` command is answered by `compactStream`
// (`compaction/stream.ts`). W9.1: the v1.4 pre-stream trim moved into the context guard (`compaction/guard.ts`), which
// compacts the context before any model call above 80 % of the window and injects its marker or notice for that step;
// `run.started` carries `origin` (`RunContext.origin`, default `request`) and, for a queued turn, `userMessageId`.
// Phase 10 (C31 seams, ADR-044 – ADR-047; COMPLETE and FROZEN after P10-0b): the run reads one catalog snapshot
// (`PreparedRun.catalog`): its agents and skills go to `buildRunParams` (`agentTypes`, `skills`), `assembleTools` sends
// `skill` only when it has skills and narrows the turn's tools to `PreparedRun.turnRestriction` (`allowedTools`), and the
// sub-agent runner gets it with the runner's background manager (`RunContext.background`) and the run's origin; the
// agent scope also binds `loadSkill` (`skills.ts`) and `savePlan` (`plan-file.ts`). The chat keeps
// `PreparedRun.requestModelRef` (both chat touches), so a command's model never becomes the chat's model, while
// `run.started.modelRef` and the metadata name the model that ran. `run.started.userMessageId` is set for every
// server-started turn (`queue`, and `task`: the carrier message). `data-task-result` chunks injected at a step boundary
// (the steer step, W10.4) are tracked like steers: one the response lost is appended to the saved reply, once.
// Phase 11 (C37 seams, ADR-048 / ADR-050 / ADR-051; COMPLETE and FROZEN after P11-0b):
// - hooks: a model run takes ONE hook snapshot (`deps.hooks.snapshot({ chatId, projectId, workspace, toolMode, origin,
//   modelRef })`) and builds its `RunHooks` (`hooks.ts`, `RunSession.hooks`): `PreToolUse` in the approval function,
//   the `updatedInput` rewrite and `PostToolUse` in the tool wrapper, the hooks piece of the step composer (guard →
//   hooks → steer), the extra `stopWhen` condition of a `continue: false` hook, the `hookGate` transform after
//   `stepInjector` (`Stop`: holds `finish`, runs the hooks, may hand a follow-up turn to the runner through
//   `RunSession.followUp` → `RunContext.onReleased(ending, awaitingApproval, followUp)`; only a completed run without a
//   pending approval hands one over), the `Notification` hooks of a run released waiting for an approval (tracked,
//   fire-and-forget) and the child hooks of sub-agents (`RunSession.hooks.forChild`). `data-hook`
//   chunks injected at a step boundary or written by the gate are tracked like steers (by record id). Run origin
//   `hook` = a `Stop` continuation (its carrier is the turn's user message, like `task`). Other streams (reply
//   commands, failures, image turns, `/compact`) have no hooks (`RunSession.hooks` is an empty instance);
// - project MCP: a run of a project chat with an open folder (tools on, a model with tools) asks
//   `deps.projectMcp.toolsFor(projectId, { signal, waitMs: LIMITS.projectMcpConnectWaitMs })` and hands its tools and
//   shadowed global server ids to `assembleTools({ extraTools, shadowedMcpServers })` and (W11.17) to the sub-agent runner
//   (`createSubagentRunner({ projectTools })`: foreground and background children); servers that were not ready add
//   the notice `project-mcp-unavailable`;
// - output styles: `PreparedRun.outputStyle` (`output-style.ts`, resolved while preparing) reaches `buildRunParams`
//   (`RunParamsInput.outputStyle`; the main agent only).
// Phase 12 (C44, ADR-057 / ADR-058; COMPLETE and FROZEN after P12-0b): the run's `RunHooks` also run
// `PermissionRequest` and settle the hook records of every call in the approval function (`approval.ts`),
// `PostToolUseFailure` in the tool wrapper (`tools.ts`; its model text goes through the same queue and hooks piece as
// `PostToolUse`'s, so `splitHooks` rebuilds it from the saved reply), `PostCompact` after an automatic compaction
// (`compaction/guard.ts`) and `SubagentStart` in the children; the hook matchers see the Claude names of plugin MCP
// servers too (`hookMcpServerNames`); the `hooks` activity carries the `statusMessage` label. The agent scope's
// `loadSkill` passes its options (`{ file?, toolCallId? }`, `skills.ts`; W12.7). Nothing else changes here.
import type { HarnessError, HarnessUIMessage, HarnessUIMessagePart, MessageMetadata, NoticeData, ReasoningEffort, RunOrigin, ToolMode } from '@harness-forge/shared'
import type { LanguageModelUsage, ModelMessage, TextStreamPart, Tool, ToolSet, UIMessageChunk, UIMessageStreamOnEndCallback, UIMessageStreamWriter } from 'ai'
import type { Logger } from '../logger.ts'
import type { PluginHost } from '../plugins/types.ts'
import type { ResolvedModel } from '../providers/types.ts'
import type { RegisteredTool } from '../registry/types.ts'
import type { ImageGenerationResult } from '../services/images/types.ts'
import type { AppDeps } from '../types.ts'
import type { AgentRunScope } from './agent-scope.ts'
import type { BackgroundTasks } from './background/types.ts'
import type { HarnessUIMessageChunk } from './generated-files.ts'
import type { RunEnding } from './history.ts'
import type { RunHooks } from './hooks.ts'
import type { PreparedRun } from './prepare.ts'
import type { ChatQueue } from './queue.ts'
import type { Run, RunRegistry } from './runs.ts'
import type { RunReleaseFollowUp } from './types.ts'
import { latestTodos, LIMITS, splitHooks, splitTaskResults } from '@harness-forge/shared'
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
} from 'ai'
import { createToolApproval, toolWorkspaceAccess } from './approval.ts'
import { createContextGuard } from './compaction/guard.ts'
import { compactStream } from './compaction/stream.ts'
import { applyCommandExpansions, validModelMessages } from './context.ts'
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
import { GeneratedFiles, storeGeneratedFiles } from './generated-files.ts'
import { finalizeParts, hasPendingApproval, plainText } from './history.ts'
import { createRunHooks, hookMcpServerNames, noHookSnapshot, PERMISSION_PROMPT, permissionPromptMessage } from './hooks.ts'
import { imageStream } from './images.ts'
import { buildModelHistory } from './model-history.ts'
import { NOTICES } from './notices.ts'
import { buildRunParams, offeredAgentTools, providerImageOptions, runMaxSteps } from './params.ts'
import { savePlan } from './plan-file.ts'
import { SseReplayBuffer } from './runs.ts'
import { createRunScope } from './scope.ts'
import { loadSkill, modelInvocableSkills } from './skills.ts'
import { createSteerStep, stepInjector } from './steer.ts'
import { createPrepareStep } from './steps.ts'
import { createSubagentRunner } from './subagent/index.ts'
import { generateChatTitle } from './title.ts'
import { toolPartsAsText } from './tool-history.ts'
import { assembleTools, wrapToModelOutput } from './tools.ts'
import { addMessageUsage, roundUsd, RunTracker, toMessageUsage } from './usage.ts'

/** Retries of a failed model call before streaming starts. */
export const MODEL_MAX_RETRIES = 2
const REPLY_TEXT_ID = 'text-0'

// ---------- notices ----------

export { NOTICES } from './notices.ts'

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
  /** Interval of the `message-metadata` keep-alive of image turns (default `IMAGE_KEEPALIVE_MS`). */
  imageKeepAliveMs?: number
  /** The steer queue of the runner (Phase 9; the steer step takes the chat's queued messages from it). */
  queue: ChatQueue
  /**
   * Called once, right after the run left the registry (`registry.release`) and `run.finished` was emitted, with how
   * the run ended and whether its stored reply waits for an approval (Phase 9, W9.2: the queue's run end). Not called
   * for a run released by a forced stop. A throw is logged. Phase 11 (ADR-048): `followUp` is what the run asks the
   * runner to start next (`{ kind: 'hook', data }`: its `Stop` hooks blocked); only for a `completed` run without a
   * pending approval, else undefined.
   */
  onReleased: (ending: RunEnding, awaitingApproval: boolean, followUp?: RunReleaseFollowUp) => void
  /**
   * What started the run (Phase 9, ADR-042; `run.started.origin`): a `POST /chat` request (the default), the server with
   * the first queued message (`queue`), or (Phase 10, ADR-046) the server with the results of finished background tasks
   * (`task`: the user message is the carrier of `data-task-result` parts), or (Phase 11, ADR-048) the server after a
   * blocking `Stop` hook (`hook`: the user message is the carrier of `data-hook` parts; `stop_hook_active`). For `queue`,
   * `task` and `hook`, `run.started` also carries the new user message id as `userMessageId`. A background task
   * launched by a `task` run never starts a turn.
   */
  origin?: RunOrigin
  /**
   * The runner's background manager (Phase 10, ADR-046; `chat/background/types.ts`): `task { background: true }`
   * launches there (the sub-agent runner), and the steer step takes the finished results from it (W10.4).
   */
  background: BackgroundTasks
}

/**
 * A data chunk of this app (`data-notice`, `data-compaction`, `data-steer`, `data-activity`, `data-task-result`,
 * `data-hook`).
 */
export type HarnessDataChunk = Extract<HarnessUIMessageChunk, { type: `data-${string}` }>

/** How the run answers: a model run, a reply command, a failure before the model call, an image turn, `/compact`. */
type StreamMode = 'model' | 'reply' | 'error' | 'image' | 'compact'

/** An image generation usage as the `LanguageModelUsage` of the `message.completed` hook. */
function imageHookUsage(usage: ImageGenerationResult['usage']): LanguageModelUsage {
  return {
    inputTokens: usage?.inputTokens,
    inputTokenDetails: { noCacheTokens: usage?.inputTokens, cacheReadTokens: undefined, cacheWriteTokens: undefined },
    outputTokens: usage?.outputTokens,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    totalTokens: usage?.totalTokens,
  }
}

/** A token count as stored in `MessageUsage` (integer >= 0). */
function tokens(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

/** `text` cut to at most `max` UTF-16 code units, never inside a surrogate pair. */
function cutText(text: string, max: number): string {
  if (text.length <= max)
    return text
  const last = text.charCodeAt(max - 1)
  return text.slice(0, last >= 0xD800 && last <= 0xDBFF ? max - 1 : max)
}

/** State of one run between the stream start and its persistence. */
export class RunSession {
  readonly tracker: RunTracker
  readonly notices: NoticeData[] = []
  /** Files this run stored (image turns, generated files, `generate_image` images): names for the saved parts. */
  readonly generated: GeneratedFiles
  mode: StreamMode = 'model'
  fatal: HarnessError | null = null
  finishMetadata: MessageMetadata | null = null
  /**
   * Estimated extra costs of this run, added to the message cost: `generate_image` outputs, compaction summaries and
   * sub-agents (Phase 9, `addExtraCost`).
   */
  extraCostUsd = 0
  /** The result of an image turn. */
  image: ImageGenerationResult | null = null
  /** The pipeline wrote the `finish` chunk itself (a reply command, an image turn): the run completed. */
  finished = false
  readonly startedAt: number
  #finalized = false
  #finalizing: Promise<void> | null = null
  readonly #mapped = new Map<unknown, HarnessError>()
  /** Chunks injected at step boundaries and not yet placed by `stepInjector`, in injection order. */
  #injections: { chunk: HarnessDataChunk, step: number }[] = []
  /**
   * Every injected `data-steer`, (Phase 10) `data-task-result` and (Phase 11) `data-hook` chunk, in injection order
   * (`finalMessage` appends one the response lost).
   */
  readonly #injectedTracked: HarnessDataChunk[] = []
  /**
   * The step the run is in (Phase 11): `prepareStep`'s step number, recorded by the hooks piece of the step composer;
   * -1 before the first model call (the approved calls of a continuation run before it). Hook records are placed for
   * the next step (`RunHooks.record`).
   */
  stepNumber = -1
  /**
   * The command hooks of the run (Phase 11, `hooks.ts`): `modelStream` replaces this empty instance with the run's
   * `RunHooks` over its one snapshot; the other streams keep it. A foreground sub-agent reaches it as its host's hooks
   * (`ChildSession.hooks`).
   */
  hooks: RunHooks
  /** What the run hands to the runner when it is released (Phase 11: a `Stop` continuation, set by the `hookGate`). */
  followUp: RunReleaseFollowUp | null = null
  /** The writer of the run's UI stream (`bindWriter`), for transient chunks. */
  #writer: UIMessageStreamWriter<HarnessUIMessage> | null = null
  readonly ctx: RunContext

  constructor(ctx: RunContext) {
    this.ctx = ctx
    this.tracker = new RunTracker(ctx.now)
    this.startedAt = ctx.now()
    this.generated = new GeneratedFiles(ctx.prepared.continued?.parts.filter(part => part.type === 'file').length ?? 0)
    this.hooks = createRunHooks({
      snapshot: noHookSnapshot({
        chatId: ctx.run.chatId,
        projectId: ctx.prepared.chat?.projectId ?? null,
        workspace: null,
        toolMode: ctx.toolMode,
        origin: ctx.origin ?? 'request',
        modelRef: ctx.prepared.resolved.modelRef,
      }),
      host: this,
      continued: null,
      messageId: ctx.prepared.assistantId,
      logger: ctx.logger,
    })
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

  /** `{ modelRef, startedAt }`; an image turn adds `image: { n, aspectRatio?, inputs }` (placeholder tiles). */
  startMetadata(): MessageMetadata {
    const metadata: MessageMetadata = { modelRef: this.ctx.prepared.resolved.modelRef, startedAt: this.previous?.startedAt ?? this.startedAt }
    const target = this.ctx.prepared.target
    if (this.mode === 'image' && target.kind === 'image') {
      const { n, aspectRatio, inputFileIds } = target.options
      metadata.image = { n, ...(aspectRatio === undefined ? {} : { aspectRatio }), inputs: inputFileIds.length }
    }
    return metadata
  }

  /**
   * Adds an estimated extra cost to the message cost (Phase 9, generalizes the `generate_image` tool cost): a
   * `generate_image` output, a compaction summary, a sub-agent. Ignores values that are not finite and positive.
   */
  addExtraCost(usd: number): void {
    if (Number.isFinite(usd) && usd > 0)
      this.extraCostUsd = roundUsd(this.extraCostUsd + usd)
  }

  /**
   * The `finish` metadata once every chunk before `finish` was handled: rebuilt when extra costs were added (the
   * model's `finish` part may have been observed before the last tool output was handled).
   */
  finishWithExtraCost(metadata: MessageMetadata | undefined): MessageMetadata | undefined {
    if (this.extraCostUsd === 0 || metadata === undefined)
      return metadata
    this.finishMetadata = this.buildFinishMetadata(metadata.finishedAt ?? this.ctx.now(), 'completed')
    return this.finishMetadata
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
    if (this.mode === 'image' && this.image !== null)
      this.#addImageResult(metadata, this.image)
    if (this.extraCostUsd > 0)
      metadata.costUsd = roundUsd((metadata.costUsd ?? 0) + this.extraCostUsd)
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

  /** Usage, estimated cost and revised prompt of an image turn (`ImageService` wrote the usage row). */
  #addImageResult(metadata: MessageMetadata, result: ImageGenerationResult): void {
    if (result.usage !== null) {
      metadata.usage = {
        inputTokens: tokens(result.usage.inputTokens),
        outputTokens: tokens(result.usage.outputTokens),
        totalTokens: tokens(result.usage.totalTokens),
      }
    }
    if (result.costUsd !== null && Number.isFinite(result.costUsd) && result.costUsd >= 0)
      metadata.costUsd = roundUsd(result.costUsd)
    const revisedPrompt = result.revisedPrompt?.trim()
    if (metadata.image !== undefined && revisedPrompt !== undefined && revisedPrompt !== '')
      metadata.image = { ...metadata.image, revisedPrompt: cutText(revisedPrompt, LIMITS.imagePromptMaxChars) }
  }

  /**
   * Queues a chunk for the transcript at a step boundary (Phase 9): `stepInjector` emits it right before the
   * `start-step` of step `stepNumber` (the `prepareStep` step number; 0 = the first model call of this run), or when the
   * stream ends. Used for `data-steer` (W9.2), `data-compaction` and notices of the context guard (W9.1) and (Phase 10)
   * `data-task-result` (the steer step, W10.4) and (Phase 11) `data-hook` (`RunHooks.record`); not for transient chunks
   * (`writeTransient`). Steers, task results and hook records are tracked: the saved reply holds each of them exactly
   * once.
   */
  inject(chunk: HarnessDataChunk, stepNumber: number): void {
    this.#injections.push({ chunk, step: stepNumber })
    this.track(chunk)
  }

  /**
   * Tracks a `data-steer`, `data-task-result` or `data-hook` chunk that reaches the stream another way (Phase 11: the
   * `Stop` record the `hookGate` writes before `finish`), so a saved reply that lost it still holds it once. Other
   * chunks are ignored.
   */
  track(chunk: HarnessDataChunk): void {
    if (chunk.type === 'data-steer' || chunk.type === 'data-task-result' || chunk.type === 'data-hook')
      this.#injectedTracked.push(chunk)
  }

  /**
   * `StepInjectionSource` of `stepInjector`: removes and returns the pending chunks injected for steps
   * `<= finishedSteps` (`Number.POSITIVE_INFINITY`: all), in injection order.
   */
  takeInjections(finishedSteps: number): HarnessUIMessageChunk[] {
    const ready: HarnessUIMessageChunk[] = []
    const rest: { chunk: HarnessDataChunk, step: number }[] = []
    for (const entry of this.#injections) {
      if (entry.step <= finishedSteps)
        ready.push(entry.chunk)
      else
        rest.push(entry)
    }
    this.#injections = rest
    return ready
  }

  /** Records the writer of the run's UI stream (the `execute` of `createUIMessageStream`) for `writeTransient`. */
  bindWriter(writer: UIMessageStreamWriter<HarnessUIMessage>): void {
    this.#writer = writer
  }

  /**
   * Writes a transient data chunk (`transient: true`, e.g. `data-activity`) at once: it reaches only the client's
   * `onData` and is never stored. Dropped before a writer is bound and after the stream closed.
   */
  writeTransient(chunk: HarnessDataChunk): void {
    try {
      this.#writer?.write({ ...chunk, transient: true })
    }
    catch (error) {
      this.ctx.logger.debug('a transient chunk was not written', { err: error })
    }
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

  /**
   * The end callback of every run stream (`createUIMessageStream`). A failed outcome is a merged stream or `execute`
   * that threw (the stream already got an `error` chunk): it ends the run as failed.
   */
  readonly onEnd: UIMessageStreamOnEndCallback<HarnessUIMessage> = async ({ responseMessage, isAborted, outcome }) => {
    if (outcome?.status === 'failed' && outcome.error !== undefined)
      this.recordFatal(outcome.error)
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
    if (isAborted || (this.ctx.run.signal.aborted && this.fatal === null && this.tracker.finishReason === undefined && !this.finished))
      return 'aborted'
    return this.fatal === null ? 'completed' : 'failed'
  }

  /**
   * The message as saved: the streamed parts (streaming parts finalized), stored files named, no `data:` part left
   * (ADR-028), the notices of this run where its content starts, and the finish metadata.
   */
  finalMessage(responseMessage: HarnessUIMessage | undefined, ending: RunEnding): HarnessUIMessage {
    const base = responseMessage ?? this.ctx.prepared.continued ?? { id: this.assistantId, role: 'assistant' as const, parts: [] }
    // The continued message's parts come first; this run's parts follow (the notices go between them).
    const continuedLength = Math.min(this.ctx.prepared.continued?.parts.length ?? 0, base.parts.length)
    const head = this.generated.finalizeParts(base.parts.slice(0, continuedLength))
    const tail = this.generated.finalizeParts(base.parts.slice(continuedLength))
    let parts = finalizeParts([...head, ...tail], ending)
    if (this.notices.length > 0)
      parts = [...parts.slice(0, head.length), ...this.notices.map(data => ({ type: 'data-notice' as const, data })), ...parts.slice(head.length)]
    const missing = this.#missingInjections(parts)
    if (missing.length > 0)
      parts = [...parts, ...missing]
    const metadata = ending === 'completed' && this.finishMetadata !== null ? this.finishMetadata : this.buildFinishMetadata(this.ctx.now(), ending)
    return { id: this.assistantId, role: 'assistant', parts, metadata }
  }

  /**
   * Injected steers, task results and (Phase 11) hook records the response does not hold (the stream ended before they
   * were placed), as parts, in injection order. A steer is known by its id, a task result by its task id, a hook record
   * by its record id.
   */
  #missingInjections(parts: readonly HarnessUIMessagePart[]): HarnessUIMessagePart[] {
    const steers = new Set(parts.flatMap(part => (part.type === 'data-steer' ? [part.data.id] : [])))
    const results = new Set(parts.flatMap(part => (part.type === 'data-task-result' ? [part.data.taskId] : [])))
    const records = new Set(parts.flatMap(part => (part.type === 'data-hook' ? [part.data.id] : [])))
    const missing: HarnessUIMessagePart[] = []
    for (const chunk of this.#injectedTracked) {
      if (chunk.type === 'data-steer' && !steers.has(chunk.data.id)) {
        steers.add(chunk.data.id)
        missing.push({ type: 'data-steer', ...(chunk.id === undefined ? {} : { id: chunk.id }), data: chunk.data })
      }
      else if (chunk.type === 'data-task-result' && !results.has(chunk.data.taskId)) {
        results.add(chunk.data.taskId)
        missing.push({ type: 'data-task-result', ...(chunk.id === undefined ? {} : { id: chunk.id }), data: chunk.data })
      }
      else if (chunk.type === 'data-hook' && !records.has(chunk.data.id)) {
        records.add(chunk.data.id)
        missing.push({ type: 'data-hook', ...(chunk.id === undefined ? {} : { id: chunk.id }), data: chunk.data })
      }
    }
    return missing
  }

  /**
   * `RunContext.onReleased`, guarded. The follow-up (Phase 11) goes only with a completed run without a pending
   * approval whose signal did not abort.
   */
  #released(ending: RunEnding, awaitingApproval: boolean): void {
    const followUp = ending === 'completed' && !awaitingApproval && !this.ctx.run.signal.aborted ? this.followUp : null
    try {
      if (followUp === null)
        this.ctx.onReleased(ending, awaitingApproval)
      else
        this.ctx.onReleased(ending, awaitingApproval, followUp)
    }
    catch (error) {
      this.ctx.logger.error('run end: the release callback failed', { err: error })
    }
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
      const reply = this.finalMessage(responseMessage, ending)
      message = reply
      // The reply under its parent, and the active leaf moved to it only while the leaf is still the reply parent (or
      // the reply itself, a continuation): a leaf moved by someone else is never overwritten.
      let stored = false
      let shown = false
      try {
        shown = await deps.chats.transaction(async (store) => {
          await store.upsertMessage(this.chatId, reply, prepared.replyParentId)
          return store.setActiveLeaf(this.chatId, reply.id, [prepared.replyParentId, reply.id])
        })
        stored = true
      }
      catch (error) {
        logger.error('run end: message upsert failed', { err: error })
      }
      if (stored && !shown)
        logger.warn('the active leaf moved during the run; the reply is stored as a hidden version', { messageId: reply.id })
      awaitingApproval = shown && hasPendingApproval(reply)
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
      if (stored) {
        // `pending_approval` describes the active path: left alone when the reply is not on it. The chat keeps the
        // request's model (a command's model ran only this turn).
        await this.#step('chat touch', () => deps.chats.touch(this.chatId, {
          ...(shown ? { pendingApproval: awaitingApproval } : {}),
          modelRef: prepared.requestModelRef,
        }))
      }
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
        this.#released(ending, awaitingApproval)
        if (awaitingApproval)
          this.#notifyApproval(message)
      }
      if (message !== null)
        this.#fireMessageCompleted(message, ending)
    }
  }

  /**
   * Phase 11 (ADR-048): the `Notification` hooks of a run released waiting for an approval (`permission_prompt`),
   * fire-and-forget through the task tracker (aborted at shutdown); nothing without such hooks.
   */
  #notifyApproval(message: HarnessUIMessage | null): void {
    const text = permissionPromptMessage(message)
    if (text !== null && this.hooks.has('Notification'))
      this.ctx.tasks.track(this.hooks.notification({ message: text, notificationType: PERMISSION_PROMPT }, this.ctx.lifecycle))
  }

  /** The cost of this run (model or image turn, plus the extra costs), for `message.completed`. */
  #runCost(): number | undefined {
    const own = this.mode === 'model'
      ? this.tracker.cost(this.ctx.prepared.resolved.entry.cost)
      : this.mode === 'image' ? (this.image?.costUsd ?? undefined) : undefined
    if (own === undefined && this.extraCostUsd === 0)
      return undefined
    return roundUsd((own ?? 0) + this.extraCostUsd)
  }

  #fireMessageCompleted(message: HarnessUIMessage, ending: RunEnding): void {
    const { deps, prepared } = this.ctx
    const cost = this.#runCost()
    this.ctx.tasks.track(deps.registry.hooks.run('message.completed', {
      chatId: this.chatId,
      modelRef: prepared.resolved.modelRef,
      message,
      usage: this.mode === 'image' ? imageHookUsage(this.image?.usage ?? null) : this.tracker.usage,
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
      session.finished = true
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

/**
 * The context guard's kept user message (Phase 9): the run's turn user message (the last user message of the path) as
 * the model sees it, after its command expansion and files and without any merged summary; converted on the first call
 * only. Null when the path has no user message. Phase 10: the carrier message of a `task` turn is read as its task
 * result texts (`splitTaskResults`, as `buildModelHistory` does); Phase 11: its hook records as their model text
 * (`splitHooks`: a `UserPromptSubmit` / `SessionStart` context, the carrier of a `hook` turn), so they survive a
 * compaction.
 */
export function keptUserMessage(session: RunSession, model: ResolvedModel, tools: ToolSet): () => Promise<ModelMessage | null> {
  let converted: Promise<ModelMessage | null> | null = null
  return () => {
    converted ??= (async () => {
      const { deps, prepared, logger } = session.ctx
      const turn = prepared.history.findLast(message => message.role === 'user')
      const [user] = turn === undefined ? [] : splitHooks(splitTaskResults([turn]))
      if (user === undefined)
        return null
      const files = await prepareModelFiles(applyCommandExpansions([user]), { capabilities: model.entry.capabilities, files: deps.files, logger })
      const [message] = await convertToModelMessages<HarnessUIMessage>(files.messages, { tools, ignoreIncompleteToolCalls: true })
      return message ?? null
    })()
    return converted
  }
}

/**
 * The tool set the history is converted with (`convertToModelMessages`, Phase 9): the run's tools plus, for every other
 * registered tool with a `toModelOutput`, an entry that only converts outputs. Earlier outputs of a tool the run does
 * not offer (a write tool in `plan`, an executed `exit_plan_mode`, a tool switched off since) then still reach the model
 * as their model text, not as raw JSON. Never passed to `streamText`: the model may call only the run's tools.
 */
export function historyToolSet(runTools: ToolSet, registered: readonly RegisteredTool[], plugins: Pick<PluginHost, 'guard'>): ToolSet {
  const set: ToolSet = { ...runTools }
  for (const entry of registered) {
    const name = entry.definition.name
    if (Object.hasOwn(set, name) || entry.definition.toModelOutput === undefined)
      continue
    set[name] = { inputSchema: entry.definition.inputSchema, toModelOutput: wrapToModelOutput(entry, plugins) } as Tool
  }
  return set
}

/** `historyToolSet` over the registry (an unreadable registry converts with the run's tools only). */
export function conversionTools(deps: Pick<AppDeps, 'registry' | 'plugins'>, runTools: ToolSet, logger: Logger): ToolSet {
  try {
    return historyToolSet(runTools, deps.registry.tools.list(), deps.plugins)
  }
  catch (error) {
    logger.warn('cannot list the registered tools for the history', { err: error })
    return runTools
  }
}

/** The project MCP tools of a run (Phase 11, ADR-050): none for a chat without an open project folder. */
export interface RunProjectTools {
  readonly tools: readonly RegisteredTool[]
  readonly shadowed: ReadonlySet<string>
  readonly unavailable: readonly string[]
  readonly names: ReadonlyMap<string, string>
}

const NO_PROJECT_TOOLS: RunProjectTools = Object.freeze({ tools: [], shadowed: new Set<string>(), unavailable: [], names: new Map<string, string>() })

/**
 * The project MCP tools of a model run (Phase 11): asked only for a chat whose project folder opened, with tools on and
 * a model that supports tools (`toolsFor` waits at most `LIMITS.projectMcpConnectWaitMs`). A failure other than the
 * run's abort runs the turn without them (logged).
 */
export async function runProjectMcpTools(session: RunSession, model: ResolvedModel): Promise<RunProjectTools> {
  const { deps, run, prepared, logger, toolMode } = session.ctx
  const workspace = prepared.workspace
  if (workspace === null || toolMode === 'off' || !model.entry.capabilities.tools)
    return NO_PROJECT_TOOLS
  try {
    return await deps.projectMcp.toolsFor(workspace.projectId, { signal: run.signal, waitMs: LIMITS.projectMcpConnectWaitMs })
  }
  catch (error) {
    if (run.signal.aborted)
      throw error
    logger.warn('the project MCP tools are not available; the run goes on without them', { projectId: workspace.projectId, err: error })
    return NO_PROJECT_TOOLS
  }
}

/**
 * Tools, parameters, model messages and the `streamText` call of a model run, streamed through
 * `storeGeneratedFiles` inside `createUIMessageStream` (what is saved equals what is streamed, ADR-028).
 */
export async function modelStream(session: RunSession): Promise<ReadableStream<UIMessageChunk>> {
  const { deps, run, prepared, logger } = session.ctx
  const target = prepared.target
  if (target.kind !== 'chat')
    throw new Error('modelStream needs a chat model.')
  const resolved = target.model
  const chatId = run.chatId
  const modelRef = resolved.modelRef

  // One scope per run (Phase 8): a continuation after an approval keeps the assistant message id.
  const scope = await createRunScope(deps, { chatId, messageId: session.assistantId, workspace: prepared.workspace, history: prepared.history, logger })
  // The project MCP servers of a project chat (Phase 11, ADR-050): their tools join the run's candidates.
  const projectTools = await runProjectMcpTools(session, resolved)
  if (projectTools.unavailable.length > 0)
    session.notices.push(NOTICES.projectMcpUnavailable(projectTools.unavailable))
  // One hook snapshot per run (Phase 11, ADR-048): every hook seam of this run and its sub-agents reads it.
  const origin = session.ctx.origin ?? 'request'
  const snapshot = await deps.hooks.snapshot({
    chatId,
    projectId: prepared.chat.projectId,
    workspace: prepared.workspace,
    toolMode: session.ctx.toolMode,
    origin,
    modelRef,
  }, { signal: run.signal })
  // Phase 12: hook matchers also see the Claude names of plugin MCP servers (`mcp__plugin_<name>_<server>__*`).
  const mcpServerNames = hookMcpServerNames(deps.registry, projectTools.names)
  const hooks = createRunHooks({ snapshot, host: session, continued: prepared.continued, messageId: session.assistantId, mcpServerNames, logger })
  session.hooks = hooks
  // The run's catalog snapshot (Phase 10): agent types, skills, background launches.
  const catalog = prepared.catalog
  // The agent scope (Phase 9): the run's mode, its sub-agent runner and todos, bound to every tool call of this run;
  // Phase 10: the skill loader and the plan file writer.
  const subagents = createSubagentRunner({
    session,
    model: resolved,
    toolMode: session.ctx.toolMode,
    workspace: prepared.workspace,
    scope,
    catalog,
    background: session.ctx.background,
    origin,
    projectTools,
  })
  const agent: AgentRunScope = {
    chatId,
    messageId: session.assistantId,
    toolMode: session.ctx.toolMode,
    runSubagent: (input, options) => subagents.run(input, options),
    todos: () => latestTodos(prepared.history),
    loadSkill: (name, signal, options) => loadSkill({ deps, catalog, workspace: prepared.workspace, logger }, name, signal, options),
    savePlan: (plan, c) => savePlan({ deps, settings: prepared.settings, logger, now: session.ctx.now }, plan, c),
  }
  const skills = catalog.skills()
  const assembled = await assembleTools({
    chatId,
    messageId: session.assistantId,
    modelRef,
    toolMode: session.ctx.toolMode,
    modelSupportsTools: resolved.entry.capabilities.tools,
    registry: deps.registry,
    plugins: deps.plugins,
    toolService: deps.tools,
    mcp: deps.mcp,
    signal: run.signal,
    logger,
    workspace: prepared.workspace,
    scope,
    allowExecute: deps.env.workspaceShell,
    continuation: prepared.continued,
    agent,
    allowedTools: prepared.turnRestriction,
    skillsAvailable: modelInvocableSkills(skills).length > 0,
    hooks,
    extraTools: projectTools.tools,
    shadowedMcpServers: projectTools.shadowed,
  })
  if (assembled.unsupported) {
    const notice = NOTICES.toolsUnsupported()
    if (!alreadyNoticed(prepared.history, notice, modelRef))
      session.notices.push(notice)
  }

  // A chat model with image output gets the provider options of `imageParams` (e.g. Gemini's response modalities).
  const imageProviderOptions = resolved.entry.capabilities.imageOutput
    ? providerImageOptions(resolved, target.aspectRatio, logger)
    : undefined
  const params = await buildRunParams({
    chatId,
    modelRef,
    resolved,
    ...(imageProviderOptions === undefined ? {} : { imageProviderOptions }),
    reasoningEffort: session.ctx.reasoningEffort,
    toolMode: session.ctx.toolMode,
    globalInstructions: prepared.settings.instructions,
    chatInstructions: prepared.chat.settings.instructions,
    workspace: prepared.workspace,
    workspaceTools: [...assembled.byName.values()].filter(entry => toolWorkspaceAccess(entry.definition) !== null).map(entry => entry.definition.name),
    // The offered `core-agent` tools (Phase 9): the plan block, the todo hint and the `task` hint of the instructions.
    agentTools: offeredAgentTools(assembled),
    // The catalog's agent types and skills (Phase 10): their blocks, when `task` / `skill` are offered.
    agentTypes: catalog.agents(),
    skills,
    // The output style of the run (Phase 11, ADR-051; the main agent only).
    outputStyle: prepared.outputStyle ?? null,
    maxSteps: runMaxSteps(prepared.settings, prepared.chat.projectId),
    registry: deps.registry,
    logger,
  })

  const files = await prepareModelFiles(buildModelHistory(prepared.history), {
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
  // Outputs of tools the mode does not offer keep their model text (`historyToolSet`).
  const historyTools = tools === undefined ? assembled.tools : conversionTools(deps, assembled.tools, logger)
  const converted = await convertToModelMessages<HarnessUIMessage>(history, { tools: historyTools, ignoreIncompleteToolCalls: true })
  const messagesDraft: { messages: ModelMessage[] } = { messages: converted }
  await deps.registry.hooks.run('chat.messages', { chatId, modelRef }, messagesDraft)
  const hooked = validModelMessages(messagesDraft.messages)
  if (hooked === null)
    logger.warn('chat.messages hooks returned invalid messages; the original messages are sent')

  // The step composer (Phase 9): the context guard, then (Phase 11) the hooks piece, then the steer step, before every
  // model call (step 0 included). The guard compacts the context above 80 % of the window, or trims the oldest turns
  // before the first step when automatic compaction is off or failed (the v1.4 pre-stream trim moved there).
  const prepareStep = createPrepareStep({
    contextGuard: createContextGuard({ session, model: resolved, keptUser: keptUserMessage(session, resolved, assembled.tools) }),
    hooks: hooks.stepPiece(),
    steer: createSteerStep({ session, model: resolved, tools: assembled.tools }),
    logger,
  })

  const result = streamText({
    model: resolved.model,
    instructions: params.instructions,
    messages: hooked ?? converted,
    tools,
    ...(assembled.activeTools === undefined ? {} : { activeTools: assembled.activeTools }),
    prepareStep,
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
      workspace: assembled.workspace,
      scope: assembled.scope,
      hooks,
    }),
    experimental_toolApprovalSecret: deps.keyring.subkey('approval'),
    // Phase 11: a `continue: false` hook stops the run after the current step.
    stopWhen: [isStepCount(params.maxSteps), hooks.stopCondition],
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

  // No end callback here: `toUIMessageStream` would save the chunks it produced itself, before the generated files are
  // stored. The outer stream saves the transformed chunks.
  const ui = toUIMessageStream<ToolSet, HarnessUIMessage>({
    stream: catchStreamErrors(result.stream),
    ...(tools === undefined ? {} : { tools }),
    originalMessages: prepared.history,
    generateMessageId: () => session.assistantId,
    sendReasoning: true,
    sendSources: true,
    messageMetadata: ({ part }) => session.observe(part),
    onError: error => session.errorText(error),
  })
  const generatedFiles = storeGeneratedFiles({
    files: deps.files,
    generated: session.generated,
    logger,
    toolOwner: name => assembled.byName.get(name)?.pluginId,
    continued: prepared.continued,
    onToolCost: usd => session.addExtraCost(usd),
    finishMetadata: metadata => session.finishWithExtraCost(metadata),
  })
  return createUIMessageStream<HarnessUIMessage>({
    originalMessages: prepared.history,
    generateId: () => session.assistantId,
    execute: ({ writer }) => {
      session.bindWriter(writer)
      // Chunks injected at step boundaries are placed before the step's `start-step` (Phase 9, `steer.ts`); the `Stop`
      // hooks hold the `finish` chunk (Phase 11, `hooks.ts`).
      const gate = hooks.hookGate({
        signal: run.signal,
        origin,
        history: prepared.history,
        queued: () => session.ctx.queue.list(chatId).length > 0,
        followUp: (followUp) => {
          session.followUp = followUp
        },
        track: chunk => session.track(chunk),
      })
      writer.merge(ui.pipeThrough(stepInjector(session)).pipeThrough(gate).pipeThrough(generatedFiles))
    },
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
  // An image turn never asks its image model for a title: `titleModelRef`, else the provider's `smallModelId`, else the
  // default title stays (ADR-028).
  const includeRunModel = prepared.target.kind === 'chat'
  tasks.track(generateChatTitle(deps, { chatId: session.chatId, text, chatModel: prepared.resolved, includeRunModel, logger, signal: lifecycle }, titleTimeoutMs))
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
  const origin = ctx.origin ?? 'request'
  deps.events.emit('run.started', {
    chatId: run.chatId,
    messageId: prepared.assistantId,
    modelRef: prepared.resolved.modelRef,
    origin,
    ...(origin !== 'request' && prepared.userMessage !== null ? { userMessageId: prepared.userMessage.id } : {}),
  })
  try {
    // The chat keeps the request's model (a command's model runs only this turn).
    await deps.chats.touch(run.chatId, { pendingApproval: false, modelRef: prepared.requestModelRef })
  }
  catch (error) {
    logger.warn('cannot touch the chat', { err: error })
  }
  if (prepared.superseded > 0)
    session.notices.push(NOTICES.superseded(prepared.superseded))
  session.notices.push(...prepared.notices)
  startTitle(session)

  let stream: ReadableStream<UIMessageChunk>
  try {
    const command = prepared.command
    if (command?.kind === 'compact')
      stream = await compactStream(session, command.focus)
    else if (command?.kind === 'reply')
      stream = replyStream(session, command.markdown)
    else if (command?.kind === 'failed')
      stream = errorStream(session, command.error)
    else if (prepared.target.kind === 'image')
      stream = imageStream(session)
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
