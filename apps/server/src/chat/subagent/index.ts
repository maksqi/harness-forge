// Sub-agents (Phase 9, ADR-043 amends ADR-036, ARCHITECTURE.md 6.22): the child runner of a run, created per run in
// `modelStream` (`pipeline.ts`) and reached by the `task` tool through the agent scope (`agentScopeOf(c).runSubagent`).
// Signatures FROZEN after P9-0b (C26); the implementation is W9.5's.
//
// One `run(input, { toolCallId, signal })` call runs one child and yields `TaskOutput` snapshots (`./progress.ts`):
// - per run at most `LIMITS.subagentsPerRunMax` children (a later call yields one `failed` output) and at most
//   `LIMITS.subagentParallelMax` at the same time: a call without a free slot yields `queued` and waits (first come,
//   first served; an abort or the deadline ends the wait);
// - the signal of the child is `AbortSignal.any([options.signal, the run signal, the deadline])`; the deadline is
//   `LIMITS.subagentTimeoutMs` (570 s, below the 600 s guard of `task`) counted from the call, queue included, so a
//   partial report still comes back before the guard fires;
// - the model is `settings.subagentModelRef` (resolved for the child; one that cannot be resolved falls back to the run
//   model, logged), else the run model; the tools come from `childTools` (`./tools.ts`: never `task`, depth 1; nothing
//   can ask); the instructions are `buildRunParams` with the child's mode (`ask` for `explore` and below a `plan`
//   parent), no agent tools, and a preamble carrying `SUBAGENT_INSTRUCTIONS_MARKER` before the global instructions; the
//   messages are `[user: prompt]`; `stopWhen: isStepCount(settings.subagentMaxSteps)`; the step composer runs the
//   context guard in silent mode, no steer step, and the finalize nudge: the last allowed step gets `activeTools: []`
//   and "Write the final report now." (the output status is then `limit`);
// - a snapshot at the start (`running`), on every tool call start and end and on every step end; the final one is
//   `completed`, `limit` (the step limit or the deadline ended it, with the partial report), `aborted` (Stop) or `failed`
//   (the model call failed; the error mapped like a run error);
// - one usage row (purpose `subagent`, the child's provider and model) per child that used tokens, its cost added to the
//   reply through `session.addExtraCost` and shown in the output (`usage`, `costUsd`).
// No agent scope is bound in a child (depth 1). The prompt, the steps and the report are never logged (warnings carry
// model refs and error codes only).
// Phase 10 (C31 seams, ADR-045 / ADR-046): the host is the structural `ChildSession` (`./host.ts`; the parent run's
// `RunSession`, or a background task's detached session); the runner gets the run's catalog snapshot (custom agent
// types: W10.3), its background manager and the run's origin. A `task` call with `background: true` launches through
// `background.launch(…)` (the launch input carries everything the detached child needs), counts toward the per-run cap
// (not the slots) and yields the launch output at once (`status: 'background'` with a `taskId`, or `failed`; until
// W10.4 every launch fails with "Background agents are not available yet."). `runDetachedChild` (W10.3; a stub until
// then) runs a background child on its detached host.
import type { RunOrigin, TaskInput, TaskOutput, TaskStatus, ToolMode } from '@harness-forge/shared'
import type { ModelMessage, TextStreamPart, ToolSet } from 'ai'
import type { ResolvedModel } from '../../providers/types.ts'
import type { CustomizationCatalog } from '../../services/customizations/types.ts'
import type { OpenWorkspace } from '../../services/projects/types.ts'
import type { WorkspaceRunScopeInit } from '../../workspace/run-scope.ts'
import type { RunSubagentOptions } from '../agent-scope.ts'
import type { BackgroundLaunchInput, BackgroundTasks } from '../background/types.ts'
import type { StepPiece } from '../steps.ts'
import type { ChildSession } from './host.ts'
import { AGENT_TYPE_ALIASES, BUILTIN_AGENT_TYPES, HarnessError, isHarnessError, LIMITS, taskTypeSchema } from '@harness-forge/shared'
import { isStepCount, streamText } from 'ai'
import { toolWorkspaceAccess } from '../approval.ts'
import { createContextGuard } from '../compaction/guard.ts'
import { abortReason, isAbortError, mapRunError } from '../errors.ts'
import { SUBAGENT_INSTRUCTIONS_MARKER } from '../markers.ts'
import { buildRunParams, joinInstructions } from '../params.ts'
import { createPrepareStep, noopStepPiece } from '../steps.ts'
import { RunTracker, toMessageUsage } from '../usage.ts'
import { resultPreview, TaskProgress } from './progress.ts'
import { childToolMode, childTools } from './tools.ts'

/** The preamble of every child's instructions (before the global instructions); the mocks recognize the marker. */
export const SUBAGENT_PREAMBLE = [
  SUBAGENT_INSTRUCTIONS_MARKER,
  'You are a sub-agent: another agent gave you one self-contained task, and only your final answer goes back to it, as your report.',
  'You cannot talk to the user and cannot ask for approval: a tool call that would need approval is denied, so work with the tools that run.',
  'Work on your own until the task is done. Then answer with a concise report in Markdown: what you found or did, with the relevant paths, names and facts. Do not ask questions back.',
].join('\n')

/** Added to the preamble of an `explore` child. */
export const SUBAGENT_EXPLORE_TEXT = 'This task is read-only: search and read; never try to change files or run commands that change anything.'

/** The instruction of the last allowed step (the finalize nudge; no tools are offered in it). */
export const SUBAGENT_FINALIZE_TEXT = 'You have reached your step limit and cannot call tools any more. Write the final report now, from what you found so far.'

/** The error of a child stopped by the user (Stop) or by the end of the run. */
export const SUBAGENT_STOPPED_TEXT = 'The sub-agent was stopped.'

/** The error of a call over the per-run limit. */
export const SUBAGENT_RUN_LIMIT_TEXT = `A reply can start at most ${LIMITS.subagentsPerRunMax} sub-agents.`

/** The error of a model call that failed without a message. */
const SUBAGENT_FAILED_TEXT = 'The sub-agent failed.'

/** The preview of a child's tool call that was still running when the child ended. */
const CALL_UNFINISHED_TEXT = 'The sub-agent ended before the tool finished.'

/** Retries of a failed model call of a child before it streams (as for runs). */
const CHILD_MAX_RETRIES = 2

/** The error of a child the deadline ended. */
export function subagentDeadlineText(timeoutMs: number): string {
  return `The sub-agent reached its time limit (${Math.round(timeoutMs / 1000)} s).`
}

/** The error of a child the step limit ended (its report was written in the last allowed step). */
export function subagentStepLimitText(maxSteps: number): string {
  return `The sub-agent reached its step limit (${maxSteps} ${maxSteps === 1 ? 'step' : 'steps'}).`
}

export interface SubagentRunnerInput {
  /**
   * The host (`./host.ts`; the parent run): deps, settings (`subagentModelRef`, `subagentMaxSteps`), chat and reply ids,
   * `addExtraCost`, the run signal, the clock and the logger.
   */
  readonly session: ChildSession
  /** The parent's model (the model of a child when `subagentModelRef` is unset or cannot be resolved). */
  readonly model: ResolvedModel
  /** The parent's permission mode (a child's tools and approvals follow it, `childTools`). */
  readonly toolMode: ToolMode
  /** The parent run's open project folder (`prepared.workspace`), or null. */
  readonly workspace: OpenWorkspace | null
  /** The parent run scope (journal, shell rules, shell folder), or null without a workspace. */
  readonly scope: WorkspaceRunScopeInit | null
  /** The run's catalog snapshot (Phase 10, `PreparedRun.catalog`): the agent types a `task` call may name (W10.3). */
  readonly catalog: CustomizationCatalog
  /** The runner's background manager (Phase 10, `RunContext.background`): where `task { background: true }` launches. */
  readonly background: BackgroundTasks
  /** The origin of the parent run (Phase 10, `RunContext.origin`): stored with a background task (the chain rule). */
  readonly origin: RunOrigin
}

export interface SubagentRunner {
  /**
   * `AgentRunScope.runSubagent`: runs one child and yields `TaskOutput` snapshots; the last one is the final output.
   * Never throws for a failed child (it yields a `failed` / `aborted` / `limit` output).
   */
  readonly run: (input: TaskInput, options: RunSubagentOptions) => AsyncIterable<TaskOutput>
}

/** The limits of a runner (tests lower them; default the `LIMITS` values). */
export interface SubagentRunnerLimits {
  /** Children of one run at the same time (`LIMITS.subagentParallelMax`). */
  parallelMax?: number
  /** Children of one run (`LIMITS.subagentsPerRunMax`). */
  perRunMax?: number
  /** Deadline of one child, from its call (`LIMITS.subagentTimeoutMs`). */
  timeoutMs?: number
}

/** The slots of a run's children: at most `size` held at once, waiters served first come, first served. */
export class SubagentSlots {
  #free: number
  readonly #waiters: Array<() => void> = []

  constructor(size: number) {
    this.#free = Math.max(1, Math.floor(size))
  }

  /** Takes a free slot at once (true), or none (false). */
  tryAcquire(): boolean {
    if (this.#free === 0)
      return false
    this.#free -= 1
    return true
  }

  /** Waits for a slot: true once held, false when `signal` aborted first (nothing held). */
  acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted)
      return Promise.resolve(false)
    if (this.tryAcquire())
      return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const waiters = this.#waiters
      const leave = (): void => {
        const index = waiters.indexOf(grant)
        if (index !== -1)
          waiters.splice(index, 1)
        resolve(false)
      }
      function grant(): void {
        signal.removeEventListener('abort', leave)
        resolve(true)
      }
      waiters.push(grant)
      signal.addEventListener('abort', leave, { once: true })
    })
  }

  /** Hands the slot to the first waiter, or frees it. */
  release(): void {
    const next = this.#waiters.shift()
    if (next === undefined)
      this.#free += 1
    else
      next()
  }

  /** Slots free now (tests). */
  get free(): number {
    return this.#free
  }

  /** Calls waiting for a slot (tests). */
  get waiting(): number {
    return this.#waiters.length
  }
}

/**
 * The finalize piece of a child's step composer: the last allowed step (`maxSteps - 1`) offers no tool and adds
 * `SUBAGENT_FINALIZE_TEXT` to the instructions; `onFinalize` is called when it applies.
 */
export function finalizeStep(maxSteps: number, onFinalize: () => void): StepPiece {
  return (step) => {
    if (step.stepNumber < maxSteps - 1)
      return undefined
    onFinalize()
    return { activeTools: [], instructions: joinInstructions(step.instructions, SUBAGENT_FINALIZE_TEXT) }
  }
}

/** The child's model: `subagentModelRef` when set and resolvable, else the run model (see the module comment). */
async function resolveChildModel(session: ChildSession, parent: ResolvedModel, signal: AbortSignal): Promise<ResolvedModel> {
  const ref = session.ctx.prepared.settings.subagentModelRef
  if (ref === null || ref === undefined || ref === parent.modelRef)
    return parent
  try {
    return await session.ctx.deps.providers.resolveModel(ref, { signal })
  }
  catch (error) {
    if (signal.aborted)
      throw error
    session.ctx.logger.warn('the sub-agent model cannot be resolved; the chat model runs the sub-agent', {
      modelRef: ref,
      ...(isHarnessError(error) ? { code: error.code } : {}),
    })
    return parent
  }
}

/** The error text of a failed child (the run error mapping; redacted, never empty). */
function failureText(session: ChildSession, model: ResolvedModel, error: unknown): string {
  try {
    const mapped = mapRunError(session.ctx.deps.providers, model.providerId, error)
    const text = session.ctx.deps.redactor.redactText(mapped.message).trim()
    return text === '' ? SUBAGENT_FAILED_TEXT : text
  }
  catch {
    return SUBAGENT_FAILED_TEXT
  }
}

/** The text of a tool error of a child (redacted). */
function toolErrorPreview(session: ChildSession, error: unknown): string | undefined {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return resultPreview(session.ctx.deps.redactor.redactText(text))
}

/** Writes the usage row of a child and adds its cost to the reply; returns the cost (undefined when unknown). */
async function recordUsage(session: ChildSession, model: ResolvedModel, tracker: RunTracker): Promise<number | undefined> {
  if (!tracker.hasUsage)
    return undefined
  const usage = tracker.usage
  const cost = tracker.cost(model.entry.cost)
  try {
    await session.ctx.deps.chats.addUsage({
      chatId: session.chatId,
      messageId: session.assistantId,
      purpose: 'subagent',
      providerId: model.providerId,
      modelId: model.modelId,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
      cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
      costUsd: cost ?? null,
    })
  }
  catch (error) {
    session.ctx.logger.warn('the sub-agent usage row was not written', { modelRef: model.modelRef, err: error })
  }
  if (cost !== undefined)
    session.addExtraCost(cost)
  return cost
}

/** What a child run needs from its runner. */
interface ChildRun {
  readonly input: SubagentRunnerInput
  readonly slots: SubagentSlots
  readonly timeoutMs: number
}

/**
 * Applies one part of the child's stream to `progress`; true when a snapshot is due (a tool call started or ended, a
 * step ended). `denials` keeps the reasons of denied approvals for the step previews.
 */
function observePart(part: TextStreamPart<ToolSet>, progress: TaskProgress, denials: Map<string, string>, session: ChildSession): boolean {
  switch (part.type) {
    case 'start-step':
      progress.startStep()
      return false
    case 'text-delta':
      progress.text(part.text)
      return false
    case 'tool-call':
      progress.startCall(part.toolCallId, part.toolName, part.input)
      return true
    case 'tool-result':
      if ((part as { preliminary?: boolean }).preliminary === true)
        return false
      progress.finishCall(part.toolCallId, 'done', resultPreview(part.output))
      return true
    case 'tool-error':
      progress.finishCall(part.toolCallId, 'error', toolErrorPreview(session, part.error))
      return true
    case 'tool-approval-response':
      if (!part.approved && typeof part.reason === 'string')
        denials.set(part.toolCall.toolCallId, part.reason)
      return false
    case 'tool-approval-request':
      // Never expected (the child's approval function cannot ask); a request that slips through is a skipped call.
      if ((part as { isAutomatic?: boolean }).isAutomatic !== true) {
        progress.finishCall(part.toolCall.toolCallId, 'denied', undefined)
        return true
      }
      return false
    case 'tool-output-denied':
      progress.finishCall(part.toolCallId, 'denied', resultPreview(denials.get(part.toolCallId)))
      return true
    case 'finish-step':
      progress.endStep()
      return true
    default:
      return false
  }
}

/** One child (see the module comment); never throws. */
async function* runChild(run: ChildRun, task: TaskInput, options: RunSubagentOptions): AsyncGenerator<TaskOutput, void, undefined> {
  const { input, slots, timeoutMs } = run
  const { session } = input
  const { logger } = session.ctx
  const now = (): number => session.ctx.now()
  const progress = new TaskProgress(task, session.ctx.prepared.settings.subagentModelRef ?? input.model.modelRef, now())

  // P10-0a (C28) compile fix: `task.type` names any catalog agent since Phase 10 (ADR-045). Until the catalog reaches the
  // runner, only the builtin types run (`general-purpose` is `general`); any other name fails the call, as v1.5 did.
  const builtinType = taskTypeSchema.safeParse(AGENT_TYPE_ALIASES[task.type] ?? task.type)
  if (!builtinType.success) {
    yield progress.snapshot('failed', { finishedAt: now(), error: `Unknown agent type "${task.type}". Available types: ${BUILTIN_AGENT_TYPES.join(', ')}.` })
    return
  }
  const type = builtinType.data

  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(abortReason(subagentDeadlineText(timeoutMs))), timeoutMs)
  timer.unref?.()
  const signal = AbortSignal.any([options.signal, session.ctx.run.signal, deadline.signal])
  const stopped = (): boolean => options.signal.aborted || session.ctx.run.signal.aborted
  const interrupted = (): { status: TaskStatus, error: string } | null => {
    if (stopped())
      return { status: 'aborted', error: SUBAGENT_STOPPED_TEXT }
    if (deadline.signal.aborted)
      return { status: 'limit', error: subagentDeadlineText(timeoutMs) }
    return null
  }

  let holding = false
  let model = input.model
  let tracker: RunTracker | null = null
  let usageRecorded = false
  const settleUsage = async (): Promise<void> => {
    if (tracker === null || usageRecorded)
      return
    usageRecorded = true
    const usage = tracker.hasUsage ? toMessageUsage(tracker.usage, tracker.finalStepUsage) : undefined
    const cost = await recordUsage(session, model, tracker)
    progress.setUsage(usage, cost)
  }
  try {
    holding = slots.tryAcquire()
    if (!holding) {
      yield progress.snapshot('queued')
      holding = await slots.acquire(signal)
      if (!holding) {
        const end = interrupted() ?? { status: 'aborted' as const, error: SUBAGENT_STOPPED_TEXT }
        yield progress.snapshot(end.status, { finishedAt: now(), error: end.error })
        return
      }
    }

    model = await resolveChildModel(session, input.model, signal)
    progress.start(model.modelRef, now())
    yield progress.snapshot('running')

    const settings = session.ctx.prepared.settings
    const mode = childToolMode(type, input.toolMode)
    const maxSteps = settings.subagentMaxSteps
    const tools = await childTools({
      session,
      type,
      toolMode: input.toolMode,
      model,
      workspace: input.workspace,
      scope: input.scope,
      parentCallId: options.toolCallId,
      signal,
    })
    const params = await buildRunParams({
      chatId: session.chatId,
      modelRef: model.modelRef,
      resolved: model,
      reasoningEffort: session.ctx.reasoningEffort,
      toolMode: mode,
      globalInstructions: joinInstructions(SUBAGENT_PREAMBLE, type === 'explore' ? SUBAGENT_EXPLORE_TEXT : undefined, settings.instructions),
      chatInstructions: session.ctx.prepared.chat.settings.instructions,
      workspace: input.workspace,
      workspaceTools: [...tools.byName.values()].filter(entry => toolWorkspaceAccess(entry.definition) !== null).map(entry => entry.definition.name),
      agentTools: [],
      maxSteps,
      registry: session.ctx.deps.registry,
      logger,
    })

    const user: ModelMessage = { role: 'user', content: [{ type: 'text', text: task.prompt }] }
    let finalized = false
    const prepareStep = createPrepareStep({
      contextGuard: createContextGuard({ session, model, keptUser: async () => user, silent: true, signal }),
      steer: noopStepPiece,
      finalize: finalizeStep(maxSteps, () => {
        finalized = true
      }),
      logger,
    })
    const hasTools = Object.keys(tools.tools).length > 0
    const result = streamText({
      model: model.model,
      instructions: params.instructions,
      messages: [user],
      ...(hasTools ? { tools: tools.tools } : {}),
      prepareStep,
      toolApproval: tools.toolApproval,
      stopWhen: isStepCount(maxSteps),
      abortSignal: signal,
      maxRetries: CHILD_MAX_RETRIES,
      providerOptions: params.providerOptions,
      ...(Object.keys(params.headers).length > 0 ? { headers: params.headers } : {}),
      ...(params.reasoning === undefined ? {} : { reasoning: params.reasoning }),
      ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
      ...(params.maxOutputTokens === undefined ? {} : { maxOutputTokens: params.maxOutputTokens }),
      onError: ({ error }) => {
        if (!(signal.aborted && isAbortError(error)))
          logger.debug('sub-agent model stream error', { modelRef: model.modelRef, err: error })
      },
    })

    tracker = new RunTracker(now)
    const denials = new Map<string, string>()
    let failure: unknown = null
    try {
      for await (const part of result.stream) {
        tracker.observe(part)
        if (part.type === 'error') {
          if (!(signal.aborted && isAbortError(part.error)))
            failure ??= part.error
          continue
        }
        if (!observePart(part, progress, denials, session))
          continue
        if (part.type === 'finish-step')
          progress.setUsage(toMessageUsage(tracker.usage, tracker.finalStepUsage), tracker.cost(model.entry.cost))
        yield progress.snapshot('running')
      }
    }
    catch (error) {
      if (!(signal.aborted && isAbortError(error)))
        failure ??= error
    }

    await settleUsage()
    progress.endOpenCalls(CALL_UNFINISHED_TEXT)
    const end = interrupted()
      ?? (failure !== null ? { status: 'failed' as const, error: failureText(session, model, failure) } : null)
      ?? (finalized ? { status: 'limit' as const, error: subagentStepLimitText(maxSteps) } : null)
    yield progress.snapshot(end?.status ?? 'completed', { finishedAt: now(), ...(end === null ? {} : { error: end.error }) })
  }
  catch (error) {
    // Anything unexpected (a failing tool assembly, a provider resolution aborted mid-way): one final output.
    await settleUsage().catch(() => {})
    progress.endOpenCalls(CALL_UNFINISHED_TEXT)
    const end = interrupted() ?? { status: 'failed' as const, error: failureText(session, model, error) }
    if (end.status === 'failed')
      logger.warn('a sub-agent failed', { modelRef: model.modelRef, ...(isHarnessError(error) ? { code: error.code } : {}) })
    yield progress.snapshot(end.status, { finishedAt: now(), error: end.error })
  }
  finally {
    clearTimeout(timer)
    if (holding)
      slots.release()
  }
}

/** The launch input of a background `task` call: the parent's values (see `BackgroundLaunchInput`). */
export function backgroundLaunchInput(input: SubagentRunnerInput, task: TaskInput, options: RunSubagentOptions): BackgroundLaunchInput {
  const { session } = input
  return {
    chatId: session.chatId,
    messageId: session.assistantId,
    toolCallId: options.toolCallId,
    task,
    origin: input.origin,
    model: input.model,
    toolMode: input.toolMode,
    workspace: input.workspace,
    scope: input.scope,
    settings: session.ctx.prepared.settings,
    reasoningEffort: session.ctx.reasoningEffort,
    chatInstructions: session.ctx.prepared.chat.settings.instructions,
    catalog: input.catalog,
    logger: session.ctx.logger,
  }
}

/** A background launch (Phase 10): the manager's output, yielded at once; a launch that throws anyway is `failed`. */
async function* launchBackground(input: SubagentRunnerInput, task: TaskInput, options: RunSubagentOptions): AsyncGenerator<TaskOutput, void, undefined> {
  const { session } = input
  let output: TaskOutput
  try {
    output = await input.background.launch(backgroundLaunchInput(input, task, options))
  }
  catch (error) {
    session.ctx.logger.warn('a background launch failed', { ...(isHarnessError(error) ? { code: error.code } : {}) })
    const now = session.ctx.now()
    const progress = new TaskProgress(task, session.ctx.prepared.settings.subagentModelRef ?? input.model.modelRef, now)
    output = progress.snapshot('failed', { finishedAt: now, error: isHarnessError(error) ? error.message : 'The background agent could not start.' })
  }
  yield output
}

/** The sub-agent runner of a run with explicit limits (see the module comment; `createSubagentRunner` uses `LIMITS`). */
export function createSubagentRunnerWith(input: SubagentRunnerInput, limits: SubagentRunnerLimits = {}): SubagentRunner {
  const slots = new SubagentSlots(limits.parallelMax ?? LIMITS.subagentParallelMax)
  const perRunMax = limits.perRunMax ?? LIMITS.subagentsPerRunMax
  const timeoutMs = limits.timeoutMs ?? LIMITS.subagentTimeoutMs
  let started = 0
  return {
    run(task, options) {
      started += 1
      if (started > perRunMax) {
        const now = input.session.ctx.now()
        const progress = new TaskProgress(task, input.session.ctx.prepared.settings.subagentModelRef ?? input.model.modelRef, now)
        const output = progress.snapshot('failed', { finishedAt: now, error: SUBAGENT_RUN_LIMIT_TEXT })
        return (async function* () {
          yield output
        })()
      }
      if (task.background === true)
        return launchBackground(input, task, options)
      return runChild({ input, slots, timeoutMs }, task, options)
    },
  }
}

/** What `runDetachedChild` runs (W10.4 builds it for a background task from its `BackgroundLaunchInput`). */
export interface DetachedChildInput {
  /** The task's host (`createDetachedSession`, `./host.ts`): the task's own signal as the run signal. */
  readonly session: ChildSession
  /** The launching run's model (the child's model when no other applies). */
  readonly model: ResolvedModel
  /** The launching run's permission mode (the child's tools and approvals follow it). */
  readonly toolMode: ToolMode
  /** The launching run's open project folder, or null. */
  readonly workspace: OpenWorkspace | null
  /** The launching run's scope (copied for the child: its writes are journaled under the launching message), or null. */
  readonly scope: WorkspaceRunScopeInit | null
  /** The launching run's catalog snapshot (the agent type and its body). */
  readonly catalog: CustomizationCatalog
  /** The validated `task` input (`background: true`). */
  readonly task: TaskInput
  /** The launching `task` call id: the child's call ids are `<toolCallId>/<child call id>`. */
  readonly toolCallId: string
  /**
   * Aborted when the task's deadline (`LIMITS.backgroundTaskTimeoutMs`) passed; the run signal aborts with it. The child
   * then ends `limit` instead of `aborted`. Absent = every abort of the run signal is a stop.
   */
  readonly deadline?: AbortSignal
}

/**
 * Runs one background child on its detached host (Phase 10, ADR-046; W10.3): the child of a foreground `task` call (type
 * resolution, tools, model, instructions, snapshots, the usage row) without the run's slots, the per-run cap and the
 * 570 s child deadline, under `session.ctx.run.signal` (the task's Stop and deadline; no tool guard). Yields `TaskOutput`
 * snapshots, the last one is the final output; never throws for a failed child.
 * P10-0b (C31) stub: throws `not_implemented` (no launch reaches it before W10.4).
 */
export function runDetachedChild(input: DetachedChildInput): AsyncIterable<TaskOutput> {
  void input
  throw new HarnessError({ code: 'not_implemented', message: 'Background agents are not available yet.' })
}

/** The sub-agent runner of a run (see the module comment). */
export function createSubagentRunner(input: SubagentRunnerInput): SubagentRunner {
  return createSubagentRunnerWith(input)
}
