// The hooks of a run (Phase 11, ADR-048, ARCHITECTURE.md 6.28). COMPLETE and FROZEN after P11-0b (C37).
//
// One `RunHooks` per model run, over ONE `HookSnapshot` (`deps.hooks.snapshot(scope)`, taken in `modelStream`): the
// pipeline seams reach the command hooks (and the plugin code hooks of the same events) only through it.
// - `PreToolUse` (`approval.ts`, `createToolApproval`): `preToolUse(call)` runs the event once per tool call. The AI SDK
//   re-runs the approval function for every approved call of an approval continuation, so a call answered in
//   `continued` (`answered`) is never run again: its decision is replayed from the stored `data-hook` record of the
//   continued message (`decisions`, keyed by tool call id). The decision of a call run in this run is kept the same way.
// - `updatedInput` (`tools.ts`, `prepareInput`): the input a `PreToolUse` hook rewrote, applied before `tool.before`
//   and the schema re-validation (fail closed); the tool part keeps the model's input (the approval HMAC signs it), the
//   record shows the rewritten one.
// - `PostToolUse` (`tools.ts`, after `tool.after`, successful calls only): `postToolUse(result)`; the model text of
//   its record (`hookModelText(record, 'assistant')`: a context, a block reason) is queued for the next step, and
//   `continue: false` asks the run to stop (`stopCondition`, an extra `stopWhen` condition).
// - Records (`record(data)`): a `data-hook` chunk injected for the next step boundary (`session.inject(chunk,
//   session.stepNumber + 1)`, tracked by `RunSession`, so a reply that lost it still holds it once); a silent success
//   has no record.
// - The hooks piece of the step composer (`stepPiece()`, `steps.ts`: guard → hooks → steer → finalize) records the
//   step number on the host and appends the queued model texts as user messages: exactly what `splitHooks` rebuilds
//   from the saved reply (the record lies between the step that ran the tool and the next one).
// - `Stop` (`hookGate(input)`, piped by `pipeline.ts` after `stepInjector`): holds the `finish` chunk of a model run that
//   ends normally (no `error`, no approval request asking the user, not aborted, no hook stop, no queued message) while
//   the snapshot has `Stop` hooks; writes the transient activity, runs them (`stop_hook_active` = the run is itself a
//   hook turn), writes the record before `finish` and, for a block, hands a follow-up turn to the runner
//   (`RunReleaseFollowUp`), or the notice `hook-continuation-limit` after `LIMITS.hookContinuationsMax` hook turns in a
//   row (`hookChainLength`). A Stop during the hooks cancels the follow-up.
// - Sub-agents: `forChild(callIdPrefix)` (`ChildHooks`): `PreToolUse` (an `ask` is denied by the child's approval
//   wrapper, `denyUserApproval`), `PostToolUse` (the model text goes into the child's own composer) and `SubagentStop`
//   (`subagentStop`, W11.2); a child never runs `UserPromptSubmit`, `SessionStart` or `Stop`, and nothing of it is
//   stored. `detachedHooks(…)` builds the same handle from a snapshot for a background child.
// - `PreCompact` (`preCompact`, W11.2: the context guard reaches it through `HostSession.hooks`): observe only, its
//   record placed next to the compaction marker. `Notification` (`notification`): `pipeline.ts` fires it (tracked,
//   fire-and-forget, never stored) once a run is released waiting for an approval (`permission_prompt`, the message
//   naming the tools, `permissionPromptMessage`).
// - Transient activity: `data-activity { kind: 'hooks', event, toolCallId? }` while the hooks of an event run, then
//   `{ kind: 'idle' }` (chat runs only).
// Every event is free without hooks (`snapshot.has(event)` false: no payload, no process). Payloads, outputs and
// contexts are never logged.
import type { HarnessUIMessage, HookData, HookEvent, HookPermissionDecision, RunOrigin } from '@harness-forge/shared'
import type { ModelMessage, StopCondition, ToolSet } from 'ai'
import type { Logger } from '../logger.ts'
import type { HookEventResult, HookRunInput, HookRunOptions, HookScope, HookSnapshot } from '../services/hooks/types.ts'
import type { HarnessUIMessageChunk } from './generated-files.ts'
import type { HarnessDataChunk } from './pipeline.ts'
import type { StepPiece } from './steps.ts'
import type { RunReleaseFollowUp } from './types.ts'
import { claudeToolName, HOOK_PART_TYPE, hookChainLength, hookDataSchema, hookModelText, hookTargetNames, LIMITS } from '@harness-forge/shared'
import { isAbortError } from './errors.ts'
import { isToolPart } from './history.ts'
import { NOTICES } from './notices.ts'

/** The result of an event for which no hook ran. */
export const NO_HOOK_RESULT: HookEventResult = Object.freeze({
  ran: false,
  decision: null,
  reason: null,
  context: null,
  block: false,
  continue: true,
  stopReason: null,
  record: null,
})

/** A snapshot without any hook (`has()` false for every event, `run()` answers `NO_HOOK_RESULT`). */
export function noHookSnapshot(scope: HookScope): HookSnapshot {
  return Object.freeze({
    scope,
    has: (_event: HookEvent) => false,
    run: async (_event: HookEvent, _input: HookRunInput, options: HookRunOptions) => {
      options.signal.throwIfAborted()
      return NO_HOOK_RESULT
    },
  })
}

/** A tool call the tool hooks run for (a sub-agent's call carries its prefixed id). */
export interface HookToolCall {
  readonly toolName: string
  readonly toolCallId: string
  /** `PreToolUse`: the model's input; `PostToolUse`: the input the tool ran with. */
  readonly input: unknown
}

/** A settled successful call (`PostToolUse`). */
export interface HookToolResult extends HookToolCall {
  /** The tool's output after `tool.after` (before the 64 KB cap). */
  readonly output: unknown
}

/** What `PreToolUse` decided for one call (run in this run, or replayed from the stored record). */
export interface PreToolUseDecision {
  /** deny > ask > allow; null = no hook decided. A blocking hook (exit 2) is a `deny`. */
  readonly decision: HookPermissionDecision | null
  readonly reason: string | null
  /** The input the tool runs with instead of the model's; absent = unchanged (never set with `deny`). */
  readonly updatedInput?: unknown
}

/**
 * The hook seams of one tool set: `createToolApproval` calls `preToolUse`, the tool wrapper `updatedInput` and
 * `postToolUse` (a run's `RunHooks`, or a sub-agent's `ChildHooks`).
 */
export interface ToolHooks {
  /** Runs `PreToolUse` once per call, or replays the stored decision; null = no hook applies. Rejects on abort. */
  readonly preToolUse: (call: HookToolCall, signal: AbortSignal) => Promise<PreToolUseDecision | null>
  /** The input a `PreToolUse` hook rewrote for the call, or null. Synchronous. */
  readonly updatedInput: (toolCallId: string) => { readonly input: unknown } | null
  /** Runs `PostToolUse` for a successful call (queues the model text, may ask the run to stop). Never rejects. */
  readonly postToolUse: (result: HookToolResult, signal: AbortSignal) => Promise<void>
}

/** What `RunHooks` needs of its run (`RunSession` satisfies it). */
export interface RunHookHost {
  /** The step the run is in (`prepareStep`'s step number; -1 before the first model call). Set by the hooks piece. */
  stepNumber: number
  /** Queues a chunk for the transcript right before the `start-step` of `stepNumber` (`RunSession.inject`). */
  readonly inject: (chunk: HarnessDataChunk, stepNumber: number) => void
  /** Writes a transient chunk (`RunSession.writeTransient`). */
  readonly writeTransient: (chunk: HarnessDataChunk) => void
}

/** What `createRunHooks` builds a run's hooks from. */
export interface RunHooksInput {
  /** The run's one snapshot. */
  readonly snapshot: HookSnapshot
  readonly host: RunHookHost
  /** The continued assistant message of an approval continuation (answered calls, stored decisions), else null. */
  readonly continued: HarnessUIMessage | null
  /** The assistant message of the run (`harness.messageId`). */
  readonly messageId: string
  /**
   * The project MCP servers of the run: server id → name as written in `.mcp.json` (`ProjectMcpTools.names`); a tool of
   * such a server is also matched as `mcp__<name>__<tool>`.
   */
  readonly mcpServerNames?: ReadonlyMap<string, string>
  readonly logger: Logger
}

/** What the `Stop` gate of a run needs (`pipeline.ts` builds it from the session). */
export interface HookGateInput {
  /** The run's signal: an abort skips the hooks, or kills them and cancels the follow-up. */
  readonly signal: AbortSignal
  /** The run's origin (`stop_hook_active` when `hook`). */
  readonly origin: RunOrigin
  /** The path the run started from (`hookChainLength`). */
  readonly history: readonly HarnessUIMessage[]
  /** True while messages are queued for the chat: the next queued item goes before a hook turn (no `Stop` hooks). */
  readonly queued: () => boolean
  /** Hands the follow-up turn to the session (`RunSession.followUp`). */
  readonly followUp: (followUp: RunReleaseFollowUp) => void
  /** Tracks a chunk the gate writes itself (`RunSession.track`): a saved reply that lost it still holds it once. */
  readonly track: (chunk: HarnessDataChunk) => void
}

/** What a sub-agent's host offers it (`RunSession.hooks`, or `detachedHooks` for a background child). */
export interface ChildHooksSource {
  /** The hooks of one child; `callIdPrefix` is the child's call id prefix (`<parent task call id>/`). */
  readonly forChild: (callIdPrefix: string) => ChildHooks
}

/** The `SubagentStop` input of a child (the payload carries `stop_hook_active`; the `task` call goes to code hooks). */
export interface SubagentStopInput {
  /** True when this round already continues after a `SubagentStop` block. */
  readonly stopHookActive: boolean
  /** The child's `task` call: `callId`, `input` (the task input with its `type`), `output` (the report). */
  readonly task?: { readonly callId: string, readonly input: unknown, readonly output?: unknown }
}

/** The `PreCompact` input of a compaction (`trigger`; `custom_instructions` = the `/compact` focus). */
export interface PreCompactInput {
  readonly trigger: 'manual' | 'auto'
  readonly customInstructions: string | null
}

/** The `Notification` input of a run waiting for an approval. */
export interface NotificationInput {
  readonly message: string
  /** `permission_prompt` for an approval request (Claude Code's notification types). */
  readonly notificationType: string
}

/** The notification type of an approval request (`Notification` matcher subject). */
export const PERMISSION_PROMPT = 'permission_prompt'

/**
 * The `Notification` message of a reply waiting for approvals: "The agent needs your permission to use <tools>." (the
 * Claude Code names when there are, else the harness names; at most three, then "and N more"); null without a pending
 * approval.
 */
export function permissionPromptMessage(message: HarnessUIMessage | null | undefined): string | null {
  const names: string[] = []
  for (const part of message?.parts ?? []) {
    if (!isToolPart(part) || part.state !== 'approval-requested')
      continue
    const raw = part.type === 'dynamic-tool' ? (part as { toolName?: unknown }).toolName : part.type.slice('tool-'.length)
    if (typeof raw !== 'string' || raw === '')
      continue
    const name = claudeToolName(raw) ?? raw
    if (!names.includes(name))
      names.push(name)
  }
  if (names.length === 0)
    return null
  const shown = names.slice(0, 3).join(', ')
  return `The agent needs your permission to use ${shown}${names.length > 3 ? ` and ${names.length - 3} more` : ''}.`
}

/** The data of a valid `data-hook` part (the stored records of a continued message), else null. */
function hookRecordOf(part: unknown): HookData | null {
  if (typeof part !== 'object' || part === null || (part as { type?: unknown }).type !== HOOK_PART_TYPE)
    return null
  const parsed = hookDataSchema.safeParse((part as { data?: unknown }).data)
  return parsed.success ? parsed.data : null
}

/** The tool call ids of `continued` that carry an approval response (the calls the SDK re-runs the approval for). */
export function answeredToolCalls(continued: HarnessUIMessage | null): Set<string> {
  const answered = new Set<string>()
  for (const part of continued?.parts ?? []) {
    if (!isToolPart(part))
      continue
    const approval = part.approval as { approved?: unknown } | undefined
    const toolCallId = (part as { toolCallId?: unknown }).toolCallId
    if (typeof approval === 'object' && approval !== null && typeof approval.approved === 'boolean' && typeof toolCallId === 'string')
      answered.add(toolCallId)
  }
  return answered
}

const OUTCOME_DECISIONS: Readonly<Partial<Record<HookData['outcome'], HookPermissionDecision>>> = {
  denied: 'deny',
  asked: 'ask',
  allowed: 'allow',
}

/** The decision a stored `PreToolUse` record replays. */
export function storedDecision(data: HookData): PreToolUseDecision {
  return {
    decision: OUTCOME_DECISIONS[data.outcome] ?? null,
    reason: data.reason ?? null,
    ...(data.updatedInput === undefined ? {} : { updatedInput: data.updatedInput }),
  }
}

/** The stored `PreToolUse` decisions of `continued`, by tool call id (the last record of a call wins). */
export function storedDecisions(continued: HarnessUIMessage | null): Map<string, PreToolUseDecision> {
  const decisions = new Map<string, PreToolUseDecision>()
  for (const part of continued?.parts ?? []) {
    const data = hookRecordOf(part)
    if (data !== null && data.event === 'PreToolUse' && data.toolCallId !== undefined)
      decisions.set(data.toolCallId, storedDecision(data))
  }
  return decisions
}

const MCP_PREFIX = 'mcp__'

/** The server id of an MCP tool name (`mcp__<id>__<tool>`), else null. */
function mcpServerIdOf(toolName: string): string | null {
  if (!toolName.startsWith(MCP_PREFIX))
    return null
  const rest = toolName.slice(MCP_PREFIX.length)
  const separator = rest.indexOf('__')
  return separator > 0 ? rest.slice(0, separator) : null
}

/** A user model message with one text part (what `splitHooks` + `convertToModelMessages` make of a record). */
export function hookModelMessage(text: string): ModelMessage {
  return { role: 'user', content: [{ type: 'text', text }] }
}

/** What a runtime does with records and activity (a chat run places them; a child drops them). */
interface RuntimeSink {
  readonly record: (data: HookData) => void
  readonly activity: (event: HookEvent, toolCallId?: string) => void
  readonly idle: () => void
}

interface RuntimeInput {
  readonly snapshot: HookSnapshot
  readonly messageId: string
  readonly mcpServerNames: ReadonlyMap<string, string>
  readonly logger: Logger
  readonly answered: ReadonlySet<string>
  readonly decisions: Map<string, PreToolUseDecision>
  readonly sink: RuntimeSink
}

/** The tool hooks, the queued model texts and the stop request shared by a run and its children. */
class ToolHookRuntime implements ToolHooks {
  readonly snapshot: HookSnapshot
  protected readonly messageId: string
  protected readonly logger: Logger
  readonly #mcpServerNames: ReadonlyMap<string, string>
  readonly #answered: ReadonlySet<string>
  readonly #decisions: Map<string, PreToolUseDecision>
  readonly #sink: RuntimeSink
  #queued: ModelMessage[] = []
  #stop: { readonly reason: string | null } | null = null

  constructor(input: RuntimeInput) {
    this.snapshot = input.snapshot
    this.messageId = input.messageId
    this.logger = input.logger
    this.#mcpServerNames = input.mcpServerNames
    this.#answered = input.answered
    this.#decisions = input.decisions
    this.#sink = input.sink
  }

  /** The snapshot has hooks of `event` (matchers not applied). */
  has(event: HookEvent): boolean {
    return this.snapshot.has(event)
  }

  /** A `continue: false` hook asked the agent to stop (the extra `stopWhen` condition). */
  get stopRequested(): boolean {
    return this.#stop !== null
  }

  /** The `stopReason` of the hook that asked to stop, if any. */
  get stopReason(): string | null {
    return this.#stop?.reason ?? null
  }

  /** The extra `stopWhen` condition of the run: true once a hook answered `continue: false`. */
  readonly stopCondition: StopCondition<ToolSet> = () => this.stopRequested

  /** Records `continue: false` (the first reason is kept). */
  requestStop(reason: string | null): void {
    this.#stop ??= { reason }
  }

  /** The tool call `toolCallId` answered in the continued message (the SDK re-runs its approval). */
  isAnswered(toolCallId: string): boolean {
    return this.#answered.has(toolCallId)
  }

  /** Every name a tool matcher is tested against (the harness name, its Claude Code aliases, a project MCP name). */
  aliases(toolName: string): string[] {
    const serverId = mcpServerIdOf(toolName)
    const name = serverId === null ? undefined : this.#mcpServerNames.get(serverId)
    return hookTargetNames(toolName, name === undefined ? undefined : { mcpServerName: name })
  }

  /** Stores a record (a chat run injects it; a child drops it). */
  record(data: HookData): void {
    this.#sink.record(data)
  }

  /** Queues a model text for the next step (a user message). */
  queue(text: string): void {
    this.#queued.push(hookModelMessage(text))
  }

  /** Removes and returns the queued model messages, in order. */
  takeQueued(): ModelMessage[] {
    const queued = this.#queued
    this.#queued = []
    return queued
  }

  /** Runs `event` with the activity around it; rejects like `snapshot.run` (an abort). */
  protected async runEvent(event: HookEvent, input: HookRunInput, options: HookRunOptions, toolCallId?: string): Promise<HookEventResult> {
    this.#sink.activity(event, toolCallId)
    try {
      return await this.snapshot.run(event, input, options)
    }
    finally {
      this.#sink.idle()
    }
  }

  async preToolUse(call: HookToolCall, signal: AbortSignal): Promise<PreToolUseDecision | null> {
    const id = call.toolCallId
    const known = this.#decisions.get(id)
    // An answered call (the SDK's re-run on an approved continuation) or a call already decided: replayed, never run.
    if (known !== undefined || this.#answered.has(id))
      return known ?? null
    if (!this.has('PreToolUse'))
      return null
    const result = await this.runEvent(
      'PreToolUse',
      { messageId: this.messageId, tool: { name: call.toolName, callId: id, input: call.input } },
      { signal, target: call.toolName, aliases: this.aliases(call.toolName) },
      id,
    )
    if (result.record !== null)
      this.record(result.record)
    if (!result.continue)
      this.requestStop(result.stopReason)
    const decision: HookPermissionDecision | null = result.block ? 'deny' : result.decision
    const rewritten = decision !== 'deny' && result.updatedInput !== undefined
    const decided: PreToolUseDecision = { decision, reason: result.reason, ...(rewritten ? { updatedInput: result.updatedInput } : {}) }
    this.#decisions.set(id, decided)
    return decided
  }

  updatedInput(toolCallId: string): { readonly input: unknown } | null {
    const decided = this.#decisions.get(toolCallId)
    return decided !== undefined && Object.hasOwn(decided, 'updatedInput') ? { input: decided.updatedInput } : null
  }

  async postToolUse(result: HookToolResult, signal: AbortSignal): Promise<void> {
    if (!this.has('PostToolUse'))
      return
    let outcome: HookEventResult
    try {
      outcome = await this.runEvent(
        'PostToolUse',
        { messageId: this.messageId, tool: { name: result.toolName, callId: result.toolCallId, input: result.input, output: result.output } },
        { signal, target: result.toolName, aliases: this.aliases(result.toolName) },
        result.toolCallId,
      )
    }
    catch (error) {
      if (!(signal.aborted && isAbortError(error)))
        this.logger.warn('the PostToolUse hooks failed; the tool result goes on without them', { tool: result.toolName, err: error })
      return
    }
    if (outcome.record !== null) {
      this.record(outcome.record)
      const text = hookModelText(outcome.record, 'assistant')
      if (text !== null)
        this.queue(text)
    }
    if (!outcome.continue)
      this.requestStop(outcome.stopReason)
  }

  /** The composer piece of a child: appends the queued model texts (a chat run's piece also records the step). */
  stepPiece(): StepPiece {
    return ({ messages }) => {
      const queued = this.takeQueued()
      return queued.length === 0 ? undefined : { messages: [...messages, ...queued] }
    }
  }
}

/** The hooks of one sub-agent (see the module comment): nothing is stored, no activity is written. */
export class ChildHooks extends ToolHookRuntime {
  /** The child's call id prefix (`<parent task call id>/`). */
  readonly callIdPrefix: string

  constructor(input: { snapshot: HookSnapshot, messageId: string, mcpServerNames: ReadonlyMap<string, string>, logger: Logger, callIdPrefix: string }) {
    super({
      snapshot: input.snapshot,
      messageId: input.messageId,
      mcpServerNames: input.mcpServerNames,
      logger: input.logger,
      answered: new Set(),
      decisions: new Map(),
      sink: {
        record: data => input.logger.debug('a sub-agent hook record is not stored', { event: data.event, outcome: data.outcome }),
        activity: () => {},
        idle: () => {},
      },
    })
    this.callIdPrefix = input.callIdPrefix
  }

  /**
   * Runs `SubagentStop` when the child would complete (W11.2 decides the extra rounds: a block continues the child with
   * the reason, at most `LIMITS.subagentStopContinuationsMax` times). `NO_HOOK_RESULT` without such hooks; rejects only
   * on abort.
   */
  async subagentStop(input: SubagentStopInput, signal: AbortSignal): Promise<HookEventResult> {
    if (!this.has('SubagentStop'))
      return NO_HOOK_RESULT
    const task = input.task
    return this.runEvent('SubagentStop', {
      messageId: this.messageId,
      stopHookActive: input.stopHookActive,
      ...(task === undefined ? {} : { tool: { name: 'task', callId: task.callId, input: task.input, ...(task.output === undefined ? {} : { output: task.output }) } }),
    }, { signal })
  }
}

/** The hooks of one chat run (see the module comment). */
export class RunHooks extends ToolHookRuntime implements ChildHooksSource {
  readonly #host: RunHookHost
  readonly #mcpNames: ReadonlyMap<string, string>

  constructor(input: RunHooksInput) {
    const host = input.host
    const mcpServerNames = input.mcpServerNames ?? new Map<string, string>()
    super({
      snapshot: input.snapshot,
      messageId: input.messageId,
      mcpServerNames,
      logger: input.logger,
      answered: answeredToolCalls(input.continued),
      decisions: storedDecisions(input.continued),
      sink: {
        record: data => host.inject({ type: 'data-hook', data }, host.stepNumber + 1),
        activity: (event, toolCallId) => host.writeTransient({ type: 'data-activity', data: { kind: 'hooks', event, ...(toolCallId === undefined ? {} : { toolCallId }) } }),
        idle: () => host.writeTransient({ type: 'data-activity', data: { kind: 'idle' } }),
      },
    })
    this.#host = host
    this.#mcpNames = mcpServerNames
  }

  /** The hooks piece of the step composer: records the step number, then appends the queued model texts. */
  override stepPiece(): StepPiece {
    return ({ stepNumber, messages }) => {
      this.#host.stepNumber = stepNumber
      const queued = this.takeQueued()
      return queued.length === 0 ? undefined : { messages: [...messages, ...queued] }
    }
  }

  forChild(callIdPrefix: string): ChildHooks {
    return new ChildHooks({ snapshot: this.snapshot, messageId: this.messageId, mcpServerNames: this.#mcpNames, logger: this.logger, callIdPrefix })
  }

  /**
   * `PreCompact` right before a compaction of this run (W11.2: the context guard's `auto` compaction reaches it through
   * `HostSession.hooks`, `/compact` (`manual`) through the run hooks it builds): observe only (`continue: false` changes
   * nothing); the record is placed for the next step boundary, next to the compaction marker. `NO_HOOK_RESULT` without
   * such hooks; rejects only on abort.
   */
  async preCompact(input: PreCompactInput, signal: AbortSignal): Promise<HookEventResult> {
    if (!this.has('PreCompact'))
      return NO_HOOK_RESULT
    const result = await this.runEvent('PreCompact', { messageId: this.messageId, trigger: input.trigger, customInstructions: input.customInstructions }, { signal })
    if (result.record !== null)
      this.record(result.record)
    return result
  }

  /**
   * `Notification` once the run was released waiting for an approval (`pipeline.ts`, `notification_type:
   * permission_prompt`, the message naming the tools): observe only, fire-and-forget (tracked by the run's task tracker,
   * aborted at shutdown), never stored, no activity (the stream has ended). Never rejects.
   */
  async notification(input: NotificationInput, signal: AbortSignal): Promise<void> {
    if (!this.has('Notification'))
      return
    try {
      await this.snapshot.run('Notification', { messageId: this.messageId, message: input.message, notificationType: input.notificationType }, { signal })
    }
    catch (error) {
      if (!(signal.aborted && isAbortError(error)))
        this.logger.warn('the Notification hooks failed', { err: error })
    }
  }

  /** The `Stop` gate of the run's UI stream (see the module comment); a pass-through without `Stop` hooks. */
  hookGate(input: HookGateInput): TransformStream<HarnessUIMessageChunk, HarnessUIMessageChunk> {
    let mayStop = true
    return new TransformStream<HarnessUIMessageChunk, HarnessUIMessageChunk>({
      transform: async (chunk, controller) => {
        if (chunk.type === 'error' || (chunk.type === 'tool-approval-request' && chunk.isAutomatic !== true))
          mayStop = false
        if (chunk.type === 'finish' && mayStop && this.#runsStop(input))
          await this.#stopHooks(input, controller)
        controller.enqueue(chunk)
      },
    })
  }

  #runsStop(input: HookGateInput): boolean {
    if (input.signal.aborted || this.stopRequested || !this.has('Stop'))
      return false
    try {
      return !input.queued()
    }
    catch {
      return false
    }
  }

  async #stopHooks(input: HookGateInput, controller: TransformStreamDefaultController<HarnessUIMessageChunk>): Promise<void> {
    let result: HookEventResult
    try {
      result = await this.runEvent('Stop', { messageId: this.messageId, stopHookActive: input.origin === 'hook' }, { signal: input.signal })
    }
    catch (error) {
      if (!(input.signal.aborted && isAbortError(error)))
        this.logger.warn('the Stop hooks failed; the run ends without them', { err: error })
      return
    }
    if (result.record !== null) {
      const chunk: HarnessDataChunk = { type: 'data-hook', data: result.record }
      input.track(chunk)
      controller.enqueue(chunk)
    }
    // A Stop during the hooks ends the chain; `continue: false` wins over a block.
    if (input.signal.aborted || !result.block || !result.continue || result.record === null)
      return
    if (hookChainLength(input.history) >= LIMITS.hookContinuationsMax) {
      controller.enqueue({ type: 'data-notice', data: NOTICES.hookContinuationLimit() })
      return
    }
    input.followUp({ kind: 'hook', data: result.record })
  }
}

/** The hooks of a run over `input.snapshot` (one per model run). */
export function createRunHooks(input: RunHooksInput): RunHooks {
  return new RunHooks(input)
}

/** What `detachedHooks` needs (a background child: no transcript, no continuation). */
export interface DetachedHooksInput {
  readonly snapshot: HookSnapshot
  /** The launching assistant message (`harness.messageId`). */
  readonly messageId: string
  readonly mcpServerNames?: ReadonlyMap<string, string>
  readonly logger: Logger
}

/** The child hooks source of a background child's detached host (`createDetachedSession({ hooks })`, W11.2). */
export function detachedHooks(input: DetachedHooksInput): ChildHooksSource {
  const mcpServerNames = input.mcpServerNames ?? new Map<string, string>()
  return Object.freeze({
    forChild: (callIdPrefix: string) => new ChildHooks({ snapshot: input.snapshot, messageId: input.messageId, mcpServerNames, logger: input.logger, callIdPrefix }),
  })
}
