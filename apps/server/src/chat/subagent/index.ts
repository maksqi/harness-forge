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
// Phase 10 (C31 seams, W10.3; ADR-045 / ADR-046, ARCHITECTURE.md 6.25 / 6.26): the host is the structural
// `ChildSession` (`./host.ts`; the parent run's `RunSession`, or a background task's detached session); the runner gets
// the run's catalog snapshot, its background manager and the run's origin.
// - Agent types (`resolveAgentType`): `task.type` trimmed, lowercased, `general-purpose` read as `general`; the builtins
//   `explore` / `general` keep the behavior above; any other name must be an active agent of the run's catalog
//   (`catalog.agent`), else the call ends `failed` at once ("Unknown agent type x. Available: explore, general, …", the
//   builtins first, then by name). A custom agent's definition is loaded again (`deps.customizations.load`; a definition
//   that is gone or no longer valid fails the call) and runs as a `general` child narrowed by its `tools`
//   (`childTools({ allowlist })`, never widened), with its model (a `provider:model` ref resolved for the child, one that
//   cannot be resolved falls back to the default below with a warning; `inherit` = the parent's model; none = the
//   default: `subagentModelRef ?? the parent's model`) and its body after the preamble:
//   `joinInstructions(SUBAGENT_PREAMBLE, body, settings.instructions)` (the marker stays first). Every output carries
//   the resolved `type` and the `agent` snapshot `{ source, description (≤ 200), path? }` of the entry used.
// - A `task` call with `background: true` resolves its type the same way (an unknown type fails without a launch), then
//   launches through `background.launch(…)` (the launch input carries everything the detached child needs), counts
//   toward the per-run cap (not the slots) and yields the launch output at once (`status: 'background'` with a `taskId`,
//   or `failed` past a cap).
// - `runDetachedChild` runs a background child on its detached host: the same child (type, tools, model, instructions,
//   snapshots, the usage row under the launching message, writes journaled through the copied run scope with
//   `<launching call>/<child call>` ids) without the run's slots, the per-run cap and the 570 s deadline, under the task's
//   own signal (`aborted` with `BACKGROUND_STOPPED_TEXT`; its `deadline` ends it `limit`).
import type { AgentDefinitionFields, CustomizationEntry, RunOrigin, Settings, TaskAgent, TaskInput, TaskOutput, TaskStatus, TaskType, ToolMode } from '@harness-forge/shared'
import type { ModelMessage, TextStreamPart, ToolSet } from 'ai'
import type { ResolvedModel } from '../../providers/types.ts'
import type { CustomizationCatalog } from '../../services/customizations/types.ts'
import type { OpenWorkspace } from '../../services/projects/types.ts'
import type { WorkspaceRunScopeInit } from '../../workspace/run-scope.ts'
import type { RunSubagentOptions } from '../agent-scope.ts'
import type { BackgroundLaunchInput, BackgroundTasks } from '../background/types.ts'
import type { StepPiece } from '../steps.ts'
import type { ChildSession } from './host.ts'
import { AGENT_TYPE_ALIASES, isHarnessError, LIMITS } from '@harness-forge/shared'
import { isStepCount, streamText } from 'ai'
import { BUILTIN_AGENT_DEFINITIONS, builtinAgentDefinition } from '../../builtin-plugins/core-agent/agents.ts'
import { toolWorkspaceAccess } from '../approval.ts'
import { BACKGROUND_STOPPED_TEXT } from '../background/types.ts'
import { createContextGuard } from '../compaction/guard.ts'
import { abortReason, isAbortError, mapRunError } from '../errors.ts'
import { SUBAGENT_INSTRUCTIONS_MARKER } from '../markers.ts'
import { buildRunParams, joinInstructions, orderAgentTypes } from '../params.ts'
import { createPrepareStep, noopStepPiece } from '../steps.ts'
import { RunTracker, toMessageUsage } from '../usage.ts'
import { oneLine, resultPreview, TaskProgress } from './progress.ts'
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

/** The error of a background child its deadline (`LIMITS.backgroundTaskTimeoutMs`) ended. */
export const BACKGROUND_DEADLINE_TEXT = `The background agent reached its time limit (${Math.round(LIMITS.backgroundTaskTimeoutMs / 60_000)} minutes).`

/** Characters of the description in `TaskOutput.agent` (the schema bound). */
export const TASK_AGENT_DESCRIPTION_MAX_CHARS = 200

/**
 * The error of a `task` call whose type is no active agent of the run's catalog (ARCHITECTURE.md 6.25): the available
 * types in listing order, at most `LIMITS.agentTypesListedMax` of them named.
 */
export function unknownAgentTypeText(type: string, available: readonly string[]): string {
  const shown = available.slice(0, LIMITS.agentTypesListedMax)
  const more = available.length - shown.length
  const list = shown.length === 0 ? 'none' : `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
  return `Unknown agent type ${type}. Available: ${list}.`
}

/** The error of a custom agent whose definition cannot be loaded (no safe message from the catalog). */
export function agentUnavailableText(name: string): string {
  return `The agent type ${name} could not be loaded.`
}

// ---------- agent types (Phase 10, ADR-045) ----------

/** The agent type a `task` call runs (`resolveAgentType`). */
export interface AgentChoice {
  /** The resolved name (`general-purpose` read as `general`): the output's `type`. */
  readonly name: string
  /** The builtin behavior the child keeps: `explore` (read-only) or `general` (every custom agent). */
  readonly base: TaskType
  /** The catalog entry of a custom agent (its definition is loaded when the child starts); null for a builtin. */
  readonly entry: CustomizationEntry | null
  /** The snapshot of the definition (`TaskOutput.agent`). */
  readonly agent: TaskAgent
}

/** `task.type` as the runner reads it: trimmed, lowercased, the alias resolved (`general-purpose` → `general`). */
export function normalizeAgentType(type: string): string {
  const name = type.trim().toLowerCase()
  return Object.hasOwn(AGENT_TYPE_ALIASES, name) ? AGENT_TYPE_ALIASES[name] ?? name : name
}

/** The `TaskOutput.agent` snapshot of an entry (the description on one line, at most 200 characters). */
export function agentSnapshot(entry: Pick<CustomizationEntry, 'source' | 'description' | 'path'> & { readonly pluginId?: string | null }): TaskAgent {
  return {
    source: entry.source,
    description: oneLine(entry.description, TASK_AGENT_DESCRIPTION_MAX_CHARS),
    ...(entry.path === undefined ? {} : { path: entry.path }),
    // P10-A CCR (W10.3): plugin agents name their plugin for the "From {plugin}" tooltip.
    ...(entry.source === 'plugin' && typeof entry.pluginId === 'string' ? { pluginId: entry.pluginId } : {}),
  }
}

/**
 * The agent a `task` type names (see the module comment): a builtin (always available, its catalog description when
 * listed), else the active catalog agent of that name; null when there is none (unknown, invalid, shadowed or off).
 */
export function resolveAgentType(catalog: CustomizationCatalog, type: string): AgentChoice | null {
  const name = normalizeAgentType(type)
  const builtin = builtinAgentDefinition(name)
  if (builtin !== null && builtin.name === name) {
    const listed = catalog.agent(name)
    const description = listed?.source === 'builtin' ? listed.description : builtin.description
    return { name, base: builtin.name, entry: null, agent: agentSnapshot({ source: 'builtin', description }) }
  }
  const entry = catalog.agent(name)
  if (entry === null || entry.kind !== 'agent' || entry.state !== 'active')
    return null
  return { name: entry.name, base: 'general', entry, agent: agentSnapshot(entry) }
}

/** The names a `task` type may take in a run, in listing order (the builtins first, then the catalog's by name). */
export function availableAgentTypes(catalog: CustomizationCatalog): string[] {
  const builtins = BUILTIN_AGENT_DEFINITIONS.map(definition => ({ name: definition.name, description: definition.description }))
  return orderAgentTypes([...builtins, ...catalog.agents()], Number.POSITIVE_INFINITY).map(entry => entry.name)
}

/** The model a child's first snapshot names before it is resolved (the agent's declared model, else the default). */
function plannedModelRef(choice: AgentChoice, settings: Pick<Settings, 'subagentModelRef'>, parent: ResolvedModel): string {
  const declared = choice.entry?.modelRef
  if (declared === 'inherit')
    return parent.modelRef
  return declared ?? settings.subagentModelRef ?? parent.modelRef
}

/** The single `failed` output of a call whose type is unknown (no model call, no slot). */
function unknownTypeOutput(session: ChildSession, parent: ResolvedModel, task: TaskInput, catalog: CustomizationCatalog): TaskOutput {
  const now = session.ctx.now()
  const type = normalizeAgentType(task.type)
  const progress = new TaskProgress({ ...task, type }, session.ctx.prepared.settings.subagentModelRef ?? parent.modelRef, now)
  return progress.snapshot('failed', { finishedAt: now, error: unknownAgentTypeText(type, availableAgentTypes(catalog)) })
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

/**
 * A custom agent's model (Phase 10, ADR-045): `inherit` = the parent's model; a `provider:model` ref resolved for the
 * child (one that cannot be resolved falls back to the default with a warning); none = the default
 * (`resolveChildModel`).
 */
async function resolveAgentModel(session: ChildSession, parent: ResolvedModel, declared: string | null, agentType: string, signal: AbortSignal): Promise<ResolvedModel> {
  if (declared === 'inherit' || declared === parent.modelRef)
    return parent
  if (declared !== null) {
    try {
      return await session.ctx.deps.providers.resolveModel(declared, { signal })
    }
    catch (error) {
      if (signal.aborted)
        throw error
      session.ctx.logger.warn('the agent\'s model cannot be resolved; the default model runs the sub-agent', {
        agentType,
        modelRef: declared,
        ...(isHarnessError(error) ? { code: error.code } : {}),
      })
    }
  }
  return resolveChildModel(session, parent, signal)
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

/** What a child run needs from its runner (foreground calls). */
interface ChildRun {
  readonly input: SubagentRunnerInput
  readonly slots: SubagentSlots
  readonly timeoutMs: number
}

/** How a child ended before it finished on its own (a stop or a deadline). */
interface ChildEnd {
  readonly status: TaskStatus
  readonly error: string
}

/** The host side of one child: a foreground child of a run, or a detached background child. */
interface ChildHost {
  readonly session: ChildSession
  /** The parent's model (the child's model when no other applies). */
  readonly model: ResolvedModel
  /** The parent's permission mode. */
  readonly toolMode: ToolMode
  readonly workspace: OpenWorkspace | null
  /** The parent run scope (copied for the child by `childTools`), or null. */
  readonly scope: WorkspaceRunScopeInit | null
  /** The launching `task` call (the prefix of the child's call ids). */
  readonly toolCallId: string
}

/** The control of one child: its signal, its slot and how an interruption reads. */
interface ChildControl {
  /** Aborted by a stop or a deadline. */
  readonly signal: AbortSignal
  /** The run's slots (a foreground child waits for one as `queued`); null = no slot (a background child). */
  readonly slots: SubagentSlots | null
  /** The end of an interrupted child (null while nothing interrupted it). */
  readonly interrupted: () => ChildEnd | null
  /** The error of a stop that `interrupted` does not name. */
  readonly stoppedText: string
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

/** A custom agent's definition fields, or the error that ends the call (an abort rethrows). */
async function loadAgent(session: ChildSession, choice: AgentChoice, signal: AbortSignal): Promise<{ fields: AgentDefinitionFields } | { error: string }> {
  const entry = choice.entry
  if (entry === null)
    return { error: agentUnavailableText(choice.name) }
  try {
    const loaded = await session.ctx.deps.customizations.load(entry, signal)
    if (loaded.definition.kind !== 'agent')
      return { error: agentUnavailableText(choice.name) }
    return { fields: loaded.definition.fields }
  }
  catch (error) {
    if (signal.aborted)
      throw error
    session.ctx.logger.warn('a custom agent definition cannot be loaded', { agentType: choice.name, source: entry.source, ...(isHarnessError(error) ? { code: error.code } : {}) })
    const message = isHarnessError(error) ? session.ctx.deps.redactor.redactText(error.message).trim() : ''
    return { error: message === '' ? agentUnavailableText(choice.name) : message }
  }
}

/** One child on its host (see the module comment); never throws. */
async function* executeChild(host: ChildHost, task: TaskInput, choice: AgentChoice, control: ChildControl): AsyncGenerator<TaskOutput, void, undefined> {
  const { session } = host
  const { logger } = session.ctx
  const { signal, slots } = control
  const now = (): number => session.ctx.now()
  const progress = new TaskProgress({ ...task, type: choice.name }, plannedModelRef(choice, session.ctx.prepared.settings, host.model), now(), choice.agent)

  let holding = false
  let model = host.model
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
    if (slots !== null) {
      holding = slots.tryAcquire()
      if (!holding) {
        yield progress.snapshot('queued')
        holding = await slots.acquire(signal)
        if (!holding) {
          const end = control.interrupted() ?? { status: 'aborted' as const, error: control.stoppedText }
          yield progress.snapshot(end.status, { finishedAt: now(), error: end.error })
          return
        }
      }
    }

    // A custom agent: its definition is read and validated again (a file changed since the catalog was built counts).
    let definition: AgentDefinitionFields | null = null
    if (choice.entry !== null) {
      const loaded = await loadAgent(session, choice, signal)
      if ('error' in loaded) {
        yield progress.snapshot('failed', { finishedAt: now(), error: loaded.error })
        return
      }
      definition = loaded.fields
    }

    model = definition === null
      ? await resolveChildModel(session, host.model, signal)
      : await resolveAgentModel(session, host.model, definition.model, choice.name, signal)
    progress.start(model.modelRef, now())
    yield progress.snapshot('running')

    const settings = session.ctx.prepared.settings
    const mode = childToolMode(choice.base, host.toolMode)
    const maxSteps = settings.subagentMaxSteps
    const tools = await childTools({
      session,
      type: choice.base,
      toolMode: host.toolMode,
      model,
      workspace: host.workspace,
      scope: host.scope,
      parentCallId: host.toolCallId,
      signal,
      allowlist: definition?.tools ?? null,
    })
    // The preamble (its marker first), then the agent's body (a builtin: the read-only line of `explore`), then the
    // user's global instructions.
    const agentText = definition !== null ? definition.instructions : choice.base === 'explore' ? SUBAGENT_EXPLORE_TEXT : undefined
    const params = await buildRunParams({
      chatId: session.chatId,
      modelRef: model.modelRef,
      resolved: model,
      reasoningEffort: session.ctx.reasoningEffort,
      toolMode: mode,
      globalInstructions: joinInstructions(SUBAGENT_PREAMBLE, agentText, settings.instructions),
      chatInstructions: session.ctx.prepared.chat.settings.instructions,
      workspace: host.workspace,
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
    const end = control.interrupted()
      ?? (failure !== null ? { status: 'failed' as const, error: failureText(session, model, failure) } : null)
      ?? (finalized ? { status: 'limit' as const, error: subagentStepLimitText(maxSteps) } : null)
    yield progress.snapshot(end?.status ?? 'completed', { finishedAt: now(), ...(end === null ? {} : { error: end.error }) })
  }
  catch (error) {
    // Anything unexpected (a failing tool assembly, a provider resolution aborted mid-way): one final output.
    await settleUsage().catch(() => {})
    progress.endOpenCalls(CALL_UNFINISHED_TEXT)
    const end = control.interrupted() ?? { status: 'failed' as const, error: failureText(session, model, error) }
    if (end.status === 'failed')
      logger.warn('a sub-agent failed', { modelRef: model.modelRef, ...(isHarnessError(error) ? { code: error.code } : {}) })
    yield progress.snapshot(end.status, { finishedAt: now(), error: end.error })
  }
  finally {
    if (holding)
      slots?.release()
  }
}

/** One foreground child of a run (see the module comment); never throws. */
async function* runChild(run: ChildRun, task: TaskInput, options: RunSubagentOptions): AsyncGenerator<TaskOutput, void, undefined> {
  const { input, slots, timeoutMs } = run
  const { session } = input
  const choice = resolveAgentType(input.catalog, task.type)
  if (choice === null) {
    yield unknownTypeOutput(session, input.model, task, input.catalog)
    return
  }

  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(abortReason(subagentDeadlineText(timeoutMs))), timeoutMs)
  timer.unref?.()
  const signal = AbortSignal.any([options.signal, session.ctx.run.signal, deadline.signal])
  const stopped = (): boolean => options.signal.aborted || session.ctx.run.signal.aborted
  const host: ChildHost = {
    session,
    model: input.model,
    toolMode: input.toolMode,
    workspace: input.workspace,
    scope: input.scope,
    toolCallId: options.toolCallId,
  }
  try {
    yield* executeChild(host, task, choice, {
      signal,
      slots,
      interrupted: () => {
        if (stopped())
          return { status: 'aborted', error: SUBAGENT_STOPPED_TEXT }
        if (deadline.signal.aborted)
          return { status: 'limit', error: subagentDeadlineText(timeoutMs) }
        return null
      },
      stoppedText: SUBAGENT_STOPPED_TEXT,
    })
  }
  finally {
    clearTimeout(timer)
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

/**
 * A background launch (Phase 10): the type is resolved first (an unknown type fails without a launch, the task input
 * carries the resolved name), then the manager's output is yielded at once (with the `agent` snapshot when it has
 * none); a launch that throws anyway is `failed`.
 */
async function* launchBackground(input: SubagentRunnerInput, task: TaskInput, options: RunSubagentOptions): AsyncGenerator<TaskOutput, void, undefined> {
  const { session } = input
  const choice = resolveAgentType(input.catalog, task.type)
  if (choice === null) {
    yield unknownTypeOutput(session, input.model, task, input.catalog)
    return
  }
  const resolved: TaskInput = { ...task, type: choice.name }
  let output: TaskOutput
  try {
    output = await input.background.launch(backgroundLaunchInput(input, resolved, options))
    if (output.agent === undefined && (output.status === 'background' || output.status === 'running'))
      output = { ...output, agent: choice.agent }
  }
  catch (error) {
    session.ctx.logger.warn('a background launch failed', { ...(isHarnessError(error) ? { code: error.code } : {}) })
    const now = session.ctx.now()
    const progress = new TaskProgress(resolved, plannedModelRef(choice, session.ctx.prepared.settings, input.model), now, choice.agent)
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
 * snapshots, the last one is the final output; never throws for a failed child. A stop ends it `aborted`
 * (`BACKGROUND_STOPPED_TEXT`), `input.deadline` ends it `limit` (`BACKGROUND_DEADLINE_TEXT`).
 */
export function runDetachedChild(input: DetachedChildInput): AsyncIterable<TaskOutput> {
  return detachedChild(input)
}

async function* detachedChild(input: DetachedChildInput): AsyncGenerator<TaskOutput, void, undefined> {
  const { session } = input
  const choice = resolveAgentType(input.catalog, input.task.type)
  if (choice === null) {
    yield unknownTypeOutput(session, input.model, input.task, input.catalog)
    return
  }
  const stop = session.ctx.run.signal
  const deadline = input.deadline
  const signal = deadline === undefined ? stop : AbortSignal.any([stop, deadline])
  const host: ChildHost = {
    session,
    model: input.model,
    toolMode: input.toolMode,
    workspace: input.workspace,
    scope: input.scope,
    toolCallId: input.toolCallId,
  }
  yield* executeChild(host, input.task, choice, {
    signal,
    slots: null,
    interrupted: () => {
      if (deadline?.aborted === true)
        return { status: 'limit', error: BACKGROUND_DEADLINE_TEXT }
      if (stop.aborted)
        return { status: 'aborted', error: BACKGROUND_STOPPED_TEXT }
      return null
    },
    stoppedText: BACKGROUND_STOPPED_TEXT,
  })
}

/** The sub-agent runner of a run (see the module comment). */
export function createSubagentRunner(input: SubagentRunnerInput): SubagentRunner {
  return createSubagentRunnerWith(input)
}
