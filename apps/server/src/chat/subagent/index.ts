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
// Phase 11 (C37 seam, ADR-048; W11.2 adds `SubagentStop`): a child takes its hooks from its host
// (`session.hooks?.forChild(childCallIdPrefix(toolCallId))`): `childTools({ hooks })` runs `PreToolUse` in its approval
// function (an `ask` is denied) and the `updatedInput` rewrite and `PostToolUse` in its tool wrapper, its step composer
// gets the hooks piece (guard → hooks → finalize: a `PostToolUse` context reaches the child's next step) and a
// `continue: false` hook stops it (an extra `stopWhen` condition); nothing of it is stored. A host without hooks: none.
// W11.2: `SubagentStop` runs when a child (foreground or background: a detached host carries the hooks its task took)
// would end `completed`, with the `task` call (its input and the report) for the code hooks; a block continues the child
// for one more round (`streamText` again with the messages so far, its response messages and a feedback user message
// `<hook-feedback event="SubagentStop">`; `stop_hook_active` from the second round), at most
// `LIMITS.subagentStopContinuationsMax` times and within the child's step budget (each round gets the steps left, the
// finalize nudge at its last one). Never stored; the rounds are logged without the reason. With such hooks the child's
// usage is the sum of its steps.
// W11.17 (ADR-050): the parent run's project MCP result (`SubagentRunnerInput.projectTools`) goes to every child's tool
// assembly (`childTools({ projectTools })`), and through the launch input to background children, so a child never sees
// a global MCP server its project shadows.
// Phase 12 (C44 seams, ADR-057 / ADR-058; W12.6 implements behind them): before step 0 a child with hooks runs
// `SubagentStart` (`hooks.subagentStart({ id: <parent task call id>, type }, signal)`) and its context joins the first
// user message (`childFirstMessage`, `./host.ts`); the child spec (`ChildAgentSpec`, `childSpec`) sets the step limit
// (`childMaxSteps`), the preloaded skills text (after the agent's body) and the `disallowedTools` of `childTools`. With
// the default spec (every builtin, every v1.7 agent) and no hooks every child runs as in v1.7.
// W12.6 (ADR-057 / ADR-058):
// - `childSpec` reads the loaded agent definition: `maxTurns` (the child's steps are `min(subagentMaxSteps, maxTurns)`,
//   `childMaxSteps`), `disallowedTools` (harness names, a Claude specifier already widened to its whole tool by the
//   shared parser; removed before `tools` narrows the set: restrict-only) and the `skills` preload (at most
//   `LIMITS.agentSkillsPreloadMax` names, each looked up in the run's catalog snapshot exactly like the `skill` tool
//   does, its body read again through `customizations.load`, the whole text at most `LIMITS.agentSkillsPreloadBytes`
//   UTF-8 bytes, appended to the child's instructions after the agent's body). A skill that is missing, turned off or
//   unreadable is skipped (names and counts at debug; bodies never logged). Builtins keep `DEFAULT_CHILD_SPEC`.
// - A custom agent whose `model` is a Claude model name (`modelAlias`: `sonnet`, `opus`, …; plugin agents included) runs
//   on the model `resolveClaudeModel` names (the setting `modelAliases`); an unmapped name falls back to the default
//   child model with a warning (the alias itself only at debug).
// - `SubagentStop` carries the child's agent (`ChildHooks.agent`: `agent_id` = the parent's `task` call id, `agent_type`
//   = the resolved type), so its matchers test the agent type and its Claude Code names; a prompt `SubagentStop` hook's
//   `ok: false` continues the child for one more round unless `impossible` (the shared `promptHookOutcome` turns it
//   into a block or not), within the Phase 11 cap of `LIMITS.subagentStopContinuationsMax` rounds.
import type { AgentDefinitionFields, CustomizationEntry, RunOrigin, Settings, TaskAgent, TaskInput, TaskOutput, TaskStatus, TaskType, ToolMode } from '@harness-forge/shared'
import type { ModelMessage, TextStreamPart, ToolSet } from 'ai'
import type { Logger } from '../../logger.ts'
import type { ResolvedModel } from '../../providers/types.ts'
import type { CustomizationCatalog } from '../../services/customizations/types.ts'
import type { HookEventResult } from '../../services/hooks/types.ts'
import type { OpenWorkspace } from '../../services/projects/types.ts'
import type { WorkspaceRunScopeInit } from '../../workspace/run-scope.ts'
import type { RunSubagentOptions } from '../agent-scope.ts'
import type { BackgroundLaunchInput, BackgroundTasks } from '../background/types.ts'
import type { ChildHooks } from '../hooks.ts'
import type { StepPiece } from '../steps.ts'
import type { ChildAgentSpec, ChildSession } from './host.ts'
import type { ChildProjectTools } from './tools.ts'
import { Buffer } from 'node:buffer'
import { AGENT_TYPE_ALIASES, hookModelText, isHarnessError, LIMITS } from '@harness-forge/shared'
import { isStepCount, streamText } from 'ai'
import { BUILTIN_AGENT_DEFINITIONS, builtinAgentDefinition } from '../../builtin-plugins/core-agent/agents.ts'
import { toolWorkspaceAccess } from '../approval.ts'
import { BACKGROUND_STOPPED_TEXT } from '../background/types.ts'
import { createContextGuard } from '../compaction/guard.ts'
import { abortReason, isAbortError, mapRunError } from '../errors.ts'
import { hookModelMessage } from '../hooks.ts'
import { SUBAGENT_INSTRUCTIONS_MARKER } from '../markers.ts'
import { resolveClaudeModel } from '../model-aliases.ts'
import { buildRunParams, joinInstructions, orderAgentTypes } from '../params.ts'
import { capUtf8, skillBody } from '../skills.ts'
import { createPrepareStep, noopStepPiece } from '../steps.ts'
import { RunTracker, toMessageUsage } from '../usage.ts'
import { childFirstMessage, childMaxSteps, DEFAULT_CHILD_SPEC } from './host.ts'
import { oneLine, resultPreview, TaskProgress } from './progress.ts'
import { childCallIdPrefix, childToolMode, childTools } from './tools.ts'

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
  /**
   * The parent run's project MCP tools (Phase 11, ADR-050; `RunProjectTools`): passed to every child's tool assembly
   * and to background launches. Null or absent = none.
   */
  readonly projectTools?: ChildProjectTools | null
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

/**
 * The model a custom agent declares (W12.6, ADR-058): its `model` (`inherit` or a `provider:model` ref) as it is; else a
 * Claude model name (`modelAlias`) through `resolveClaudeModel` (the setting `modelAliases`); null = the default child
 * model (no model, or a Claude name without a model: a warning, the name itself only at debug). Rejects only on abort.
 */
export async function agentModelRef(session: ChildSession, definition: Pick<AgentDefinitionFields, 'model' | 'modelAlias'>, agentType: string, signal: AbortSignal): Promise<string | null> {
  if (definition.model !== null)
    return definition.model
  const alias = typeof definition.modelAlias === 'string' ? definition.modelAlias.trim() : ''
  if (alias === '')
    return null
  const { deps, logger, prepared } = session.ctx
  let ref: string | null = null
  try {
    ref = await resolveClaudeModel(alias, { modelAliases: prepared.settings.modelAliases, providers: deps.providers, signal })
  }
  catch (error) {
    if (signal.aborted)
      throw error
    logger.debug('a Claude model name could not be resolved', { agentType, alias, ...(isHarnessError(error) ? { code: error.code } : {}) })
  }
  if (typeof ref === 'string' && ref !== '')
    return ref
  logger.warn('the agent\'s Claude model name has no model; the default model runs the sub-agent', { agentType })
  logger.debug('the unmapped Claude model name of an agent', { agentType, alias })
  return null
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
  /** The parent run's project MCP tools (shadowed global servers, project server tools), or null. */
  readonly projectTools: ChildProjectTools | null
  /** The run's catalog snapshot (W12.6: the skills an agent preloads). */
  readonly catalog: CustomizationCatalog
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

/** The first line of the preloaded skills text (W12.6). */
export const PRELOADED_SKILLS_HEADER = '# Preloaded skills'

/** The line after the header: how the child reads the skills below it. */
export const PRELOADED_SKILLS_INTRO = 'Your agent definition preloads these skills. Follow their instructions where they apply to your task.'

/** The heading of one preloaded skill. */
export function preloadedSkillHeading(name: string): string {
  return `## Skill: ${name}`
}

/** The identity of a catalog entry (a bare and a qualified name may resolve to the same skill). */
function entryIdentity(entry: Pick<CustomizationEntry, 'kind' | 'source' | 'name' | 'path' | 'pluginId'>): string {
  return `${entry.kind}\u0000${entry.source}\u0000${entry.name}\u0000${entry.path ?? ''}\u0000${entry.pluginId ?? ''}`
}

/**
 * The preloaded skills text of an agent (W12.6, ADR-058): the first `LIMITS.agentSkillsPreloadMax` names of `names`,
 * each the active skill of `catalog` (the run's snapshot, `catalog.skill(name)` as the `skill` tool reads it), its body
 * read again (`customizations.load`) and expanded like a skill the model loads (`skillBody`, no arguments); the whole
 * text at most `LIMITS.agentSkillsPreloadBytes` UTF-8 bytes (cut at a character boundary, later skills dropped). Missing,
 * invalid or unreadable skills are skipped. null when no skill was preloaded. Bodies are never logged; rejects only when
 * `signal` aborts.
 */
export async function preloadedSkillsText(session: ChildSession, names: readonly string[], catalog: CustomizationCatalog | null, signal: AbortSignal, agentType: string): Promise<string | null> {
  signal.throwIfAborted()
  const wanted = names.filter(name => typeof name === 'string' && name.trim() !== '').slice(0, LIMITS.agentSkillsPreloadMax)
  if (wanted.length === 0)
    return null
  const { deps, logger } = session.ctx
  if (catalog === null) {
    logger.debug('no catalog: the agent\'s skills are not preloaded', { agentType, skills: wanted.length })
    return null
  }
  const budget = LIMITS.agentSkillsPreloadBytes
  let text = `${PRELOADED_SKILLS_HEADER}\n\n${PRELOADED_SKILLS_INTRO}`
  const seen = new Set<string>()
  let preloaded = 0
  let skipped = 0
  let cut = false
  for (const name of wanted) {
    const entry = catalog.skill(name.trim().toLowerCase())
    if (entry === null || entry.kind !== 'skill') {
      skipped += 1
      continue
    }
    // A bare and a qualified name of the same skill preload it once.
    if (seen.has(entryIdentity(entry)))
      continue
    seen.add(entryIdentity(entry))
    let body: string
    try {
      const loaded = await deps.customizations.load(entry, signal)
      if (loaded.definition.kind !== 'skill') {
        skipped += 1
        continue
      }
      body = skillBody(loaded.definition.fields.content, loaded.definition.fields.arguments, {}).trim()
    }
    catch (error) {
      if (signal.aborted)
        throw error
      skipped += 1
      logger.debug('a preloaded skill could not be read; it is skipped', { agentType, skill: entry.name, ...(isHarnessError(error) ? { code: error.code } : {}) })
      continue
    }
    const next = `${text}\n\n${preloadedSkillHeading(entry.name)}${body === '' ? '' : `\n\n${body}`}`
    preloaded += 1
    if (Buffer.byteLength(next, 'utf8') > budget) {
      text = capUtf8(next, budget).text
      cut = true
      break
    }
    text = next
  }
  logger.debug('agent skills preloaded', { agentType, preloaded, skipped, cut })
  return preloaded === 0 ? null : text
}

/** `disallowedTools` of a definition as the child's tool filter: the non-empty names, or null for none. */
function disallowedOf(definition: AgentDefinitionFields): readonly string[] | null {
  const list = Array.isArray(definition.disallowedTools) ? definition.disallowedTools.filter(name => typeof name === 'string' && name.trim() !== '') : []
  return list.length === 0 ? null : [...list]
}

/**
 * The child spec of an agent (Phase 12, ADR-058; C44 signature, W12.6 implementation; see the module comment):
 * `maxTurns`, the preloaded `skills` text (`preloadedSkillsText` over `catalog`, the run's catalog snapshot; the
 * optional trailing parameter is a W12.6 addition: without it no skill is preloaded) and `disallowedTools` from
 * `definition`; `DEFAULT_CHILD_SPEC` for a builtin (null definition) and for a definition that sets none of them.
 * Rejects only when `signal` aborts.
 */
export async function childSpec(session: ChildSession, choice: AgentChoice, definition: AgentDefinitionFields | null, signal: AbortSignal, catalog: CustomizationCatalog | null = null): Promise<ChildAgentSpec> {
  signal.throwIfAborted()
  if (definition === null)
    return DEFAULT_CHILD_SPEC
  const maxTurns = typeof definition.maxTurns === 'number' && Number.isInteger(definition.maxTurns) ? definition.maxTurns : null
  const disallowedTools = disallowedOf(definition)
  const skillsText = await preloadedSkillsText(session, definition.skills ?? [], catalog, signal, choice.name)
  if (maxTurns === null && disallowedTools === null && skillsText === null)
    return DEFAULT_CHILD_SPEC
  return { maxTurns, skillsText, disallowedTools }
}

/** What `subagentStopFeedback` needs of the round that would complete. */
interface SubagentStopRound {
  /** 0 for the child's first round, then one more per continuation (`stop_hook_active` from round 1). */
  readonly round: number
  /** The `task` input with its resolved type. */
  readonly task: TaskInput
  /** The child's report so far. */
  readonly report: string
  /** The launching `task` call id. */
  readonly callId: string
}

/**
 * Runs `SubagentStop` for a child that would complete (Phase 11, ADR-048, W11.2) and answers the feedback user message
 * of a block (`hookModelText` of a `continued` record: `<hook-feedback event="SubagentStop">`), or null when the child
 * may end (no block, `continue: false`, a hook failure). Nothing is stored (`ChildHooks` only logs its records); the
 * reason is never logged. Rejects only on an abort of `signal`.
 * W12.6 (ADR-057): the input carries the child's agent (`hooks.agent`, named by `subagentStart`: `agent_id` /
 * `agent_type`, the matcher subject); a prompt hook's `ok: false` is a block (one more round) unless `impossible`.
 */
export async function subagentStopFeedback(hooks: ChildHooks, input: SubagentStopRound, signal: AbortSignal, logger: Logger): Promise<ModelMessage | null> {
  let result: HookEventResult
  try {
    const agent = hooks.agent
    result = await hooks.subagentStop({
      stopHookActive: input.round > 0,
      task: { callId: input.callId, input: input.task, output: input.report },
      ...(agent === null ? {} : { agent }),
    }, signal)
  }
  catch (error) {
    if (signal.aborted)
      throw error
    logger.warn('the SubagentStop hooks failed; the sub-agent ends', { err: error })
    return null
  }
  if (result.record !== null)
    logger.debug('a SubagentStop hook record is not stored', { outcome: result.record.outcome })
  if (!result.block || !result.continue)
    return null
  const reason = result.reason ?? result.record?.reason ?? ''
  const text = hookModelText({ event: 'SubagentStop', outcome: 'continued', reason }, 'user')
  return text === null ? null : hookModelMessage(text)
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
      : await resolveAgentModel(session, host.model, await agentModelRef(session, definition, choice.name, signal), choice.name, signal)
    progress.start(model.modelRef, now())
    yield progress.snapshot('running')

    const settings = session.ctx.prepared.settings
    const mode = childToolMode(choice.base, host.toolMode)
    // Phase 12 (ADR-058): what the agent definition adds (`maxTurns`, the skills preload, `disallowedTools`).
    const spec = await childSpec(session, choice, definition, signal, host.catalog)
    const maxSteps = childMaxSteps(settings.subagentMaxSteps, spec)
    // Phase 11 (C37, ADR-048): the child's hooks (PreToolUse, PostToolUse; SubagentStop is W11.2's), none without a host
    // handle.
    const hooks = session.hooks?.forChild(childCallIdPrefix(host.toolCallId)) ?? null
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
      disallowedTools: spec.disallowedTools,
      hooks,
      projectTools: host.projectTools,
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
      globalInstructions: joinInstructions(SUBAGENT_PREAMBLE, agentText, spec.skillsText, settings.instructions),
      chatInstructions: session.ctx.prepared.chat.settings.instructions,
      workspace: host.workspace,
      workspaceTools: [...tools.byName.values()].filter(entry => toolWorkspaceAccess(entry.definition) !== null).map(entry => entry.definition.name),
      agentTools: [],
      maxSteps,
      registry: session.ctx.deps.registry,
      logger,
    })

    // Phase 12 (ADR-057): `SubagentStart` before step 0; its context joins the first user message.
    const startContext = hooks === null ? null : await hooks.subagentStart({ id: host.toolCallId, type: choice.name }, signal)
    const user: ModelMessage = childFirstMessage(task.prompt, startContext)
    let finalized = false
    const hasTools = Object.keys(tools.tools).length > 0
    // Phase 11 (W11.2): with `SubagentStop` hooks the child may run more rounds, so its usage is the sum of its steps
    // (the `finish` total of one round would hide the others).
    const stopHooks = hooks !== null && hooks.has('SubagentStop')
    tracker = new RunTracker(now)
    const denials = new Map<string, string>()
    let failure: unknown = null
    let messages: ModelMessage[] = [user]
    let stepsUsed = 0
    for (let round = 0; ; round += 1) {
      // Each round gets the steps the child has left (the finalize nudge at its last one).
      const budget = Math.max(1, maxSteps - stepsUsed)
      const prepareStep = createPrepareStep({
        contextGuard: createContextGuard({ session, model, keptUser: async () => user, silent: true, signal }),
        ...(hooks === null ? {} : { hooks: hooks.stepPiece() }),
        steer: noopStepPiece,
        finalize: finalizeStep(budget, () => {
          finalized = true
        }),
        logger,
      })
      const result = streamText({
        model: model.model,
        instructions: params.instructions,
        messages,
        ...(hasTools ? { tools: tools.tools } : {}),
        prepareStep,
        toolApproval: tools.toolApproval,
        stopWhen: hooks === null ? isStepCount(budget) : [isStepCount(budget), hooks.stopCondition],
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

      try {
        for await (const part of result.stream) {
          if (part.type !== 'finish' || !stopHooks)
            tracker.observe(part)
          if (part.type === 'finish-step')
            stepsUsed += 1
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

      // `SubagentStop` (Phase 11, W11.2): only for a child that would complete.
      if (!stopHooks || hooks === null || failure !== null || finalized || control.interrupted() !== null)
        break
      const feedback = await subagentStopFeedback(hooks, { round, task: { ...task, type: choice.name }, report: progress.report, callId: host.toolCallId }, signal, logger)
      if (feedback === null)
        break
      if (round >= LIMITS.subagentStopContinuationsMax || stepsUsed >= maxSteps || hooks.stopRequested) {
        logger.info('a SubagentStop hook blocked again; the sub-agent ends', { rounds: round + 1, cap: LIMITS.subagentStopContinuationsMax })
        break
      }
      let responses: ModelMessage[]
      try {
        responses = await result.responseMessages
      }
      catch (error) {
        if (!(signal.aborted && isAbortError(error)))
          failure ??= error
        break
      }
      logger.info('a SubagentStop hook blocked; the sub-agent continues', { round: round + 1 })
      messages = [...messages, ...responses, feedback]
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
    projectTools: input.projectTools ?? null,
    catalog: input.catalog,
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
    projectTools: input.projectTools ?? null,
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
  /** The launching run's project MCP tools (Phase 11, `BackgroundLaunchInput.projectTools`); null or absent = none. */
  readonly projectTools?: ChildProjectTools | null
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
    projectTools: input.projectTools ?? null,
    catalog: input.catalog,
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
