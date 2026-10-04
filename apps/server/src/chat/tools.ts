// Tool assembly (ARCHITECTURE.md 6.1 / 6.13, PLUGINS.md 9 "Tools"): registry tools (MCP tools included, registered by
// the MCP manager as `mcp__<serverId>__<tool>` and sent as AI SDK dynamic tools), filtered by the chat tool mode, the
// tool preferences (`enabled: false` and override `deny` are not sent), the owner plugin state, the workspace (Phase 7:
// a tool that declares `ToolDefinition.workspace` only when the run has an open project folder, an `execute` tool only
// while `HF_WORKSPACE_SHELL` is on), the MCP server state and the model capability `tools`. Every tool is wrapped:
//   1. owner plugin active, else "Tool unavailable";
//   2. (approval: `approval.ts`, decided by the SDK before `execute`);
//   3. `tool.before` hooks (a throw blocks the call), the input re-validated against `inputSchema`;
//   4. `execute` under the plugin guard (`timeoutMs`, default 60 s, max 600 s; aborts with the run), with the frozen
//      `ToolCallContext.workspace` (`{ projectId, name, root }`) for every tool of a run with a workspace; Phase 8
//      (ADR-036 / ADR-038): the run scope (`workspace/run-scope.ts`) is bound with the call's `toolCallId` to the call
//      context right before `definition.execute` (a server-internal side channel: no property of the context exposes
//      it), and once the call settles (success or failure) the run's journal records it: a `shell` row for the core
//      `shell`, an `untracked` row for any other tool with workspace access `write` or `execute` (the core
//      `write_file` / `edit_file` journal themselves; MCP tools declare no access and record nothing);
//   5. `tool.after` hooks;
//   6. JSON-serializable output, capped at 64 KB of serialized JSON (`{ truncated, originalBytes, preview }`).
// `toModelOutput` is guarded (3 s); on failure, or for a truncated output, the output is sent as JSON.
// Phase 9 (C26 seams): the candidate tools pass `applyToolMode` (`modes.ts`: the tool set of a permission mode, and the
// `activeTools` the model may call, `AssembledTools.activeTools`); the agent scope of the run (`agent-scope.ts`: the
// mode, the sub-agent runner, the todos) is bound to every call context next to the run scope (never in sub-agents).
// Phase 9 (W9.5, ADR-043, plugin API 1.3.0) streaming tools: an `execute` written as an async generator function makes
// the wrapped `execute` an async generator too. The plugin's whole iteration runs inside one `plugins.guard` call (the
// timeout and the abort cover it) and hands its values over to the wrapper; preliminary values go out at most once per
// `PRELIMINARY_INTERVAL_MS` (the latest wins; the first at once), each through the 64 KB cap, at most
// `PRELIMINARY_OUTPUTS_MAX` per call; once the iteration settled the journal records the call, `tool.after` runs on the
// final value (the last one yielded) only, and the capped final value is yielded last (the SDK re-emits the last yield
// as the final output). A value still waiting when the iteration ends is dropped: the final value supersedes it. A
// non-generator `execute` whose result is an `AsyncIterable` is drained (the last value counts, no preliminary output).
// Sub-agent calls (`subagent/tools.ts`) set `callIdPrefix` (`<parent call id>/`): the hooks, the call context, the run
// scope and the journal see the prefixed call id.
// Phase 10 (C31, ADR-045; COMPLETE and FROZEN after P10-0b): after `applyToolMode`, `restrictTools` narrows the set:
// - `core-agent`'s `skill` is sent only when the run catalog has skills (`skillsAvailable`; never in sub-agents, which
//   pass none);
// - a turn's `allowedTools` (the `allowed-tools` of a command file, `metadata.command.allowedTools`, re-read on every
//   continuation and regenerate of the turn) keeps only the tools it matches (`matchToolAllowlist`: exact names,
//   `mcp__server__*` prefixes): it only ever narrows, never adds a tool or changes a policy; `core-agent`'s
//   `exit_plan_mode` is exempt (`applyToolMode` keeps it in plan mode, or not callable for an approved plan's
//   continuation); an empty list leaves no other tool; null or absent = no restriction.
import type { ToolCallContext, ToolDefinition, ToolResultOutput, ToolWorkspace } from '@harness-forge/plugin-sdk'
import type { AgentToolName, HarnessUIMessage, McpServer, ToolMode } from '@harness-forge/shared'
import type { JSONValue, Tool, ToolExecutionOptions, ToolSet } from 'ai'
import type { Logger } from '../logger.ts'
import type { McpManager, ToolPref, ToolService } from '../mcp/types.ts'
import type { PluginHost } from '../plugins/types.ts'
import type { RegisteredTool, Registry } from '../registry/types.ts'
import type { WorkspaceRunScopeInit } from '../workspace/run-scope.ts'
import type { AgentRunScope } from './agent-scope.ts'
import type { ApprovalTool } from './approval.ts'
import type { ModeTool, ToolModeResult } from './modes.ts'
import { Buffer } from 'node:buffer'
import { LIMITS, matchToolAllowlist } from '@harness-forge/shared'
import { asSchema, dynamicTool, tool } from 'ai'
import { CORE_AGENT_PLUGIN_ID } from '../builtin-plugins/core-agent/index.ts'
import { GUARD_TIMEOUT_MAX_MS, GUARD_TIMEOUTS } from '../plugins/guard.ts'
import { bindRunScope } from '../workspace/run-scope.ts'
import { bindAgentScope } from './agent-scope.ts'
import { isPlanExitTool, toolWorkspaceAccess } from './approval.ts'
import { abortReason, isAbortError, ToolFailure } from './errors.ts'
import { applyToolMode } from './modes.ts'

/** Preliminary outputs of a streaming tool go out at most once per this interval (the latest value wins). */
export const PRELIMINARY_INTERVAL_MS = 250
/** Preliminary outputs one streaming call sends at most; later ones are dropped (the final value always goes out). */
export const PRELIMINARY_OUTPUTS_MAX = 2000

/** The marker that replaces a tool output larger than `LIMITS.toolOutputBytes` (DECISIONS.md "Tool output cap"). */
export interface TruncatedToolOutput {
  truncated: true
  originalBytes: number
  preview: string
}

export function isTruncatedToolOutput(value: unknown): value is TruncatedToolOutput {
  return typeof value === 'object' && value !== null && (value as { truncated?: unknown }).truncated === true
    && typeof (value as { originalBytes?: unknown }).originalBytes === 'number'
    && typeof (value as { preview?: unknown }).preview === 'string'
}

/** The first `maxBytes` UTF-8 bytes of `text`, cut on a code point boundary. */
export function utf8Prefix(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes)
    return text
  let bytes = 0
  let end = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > maxBytes)
      break
    bytes += size
    end += char.length
  }
  return text.slice(0, end)
}

/**
 * The stored form of a tool output: a JSON round trip (so the stored, streamed and model values agree), or the
 * truncation marker when the serialized JSON is larger than `maxBytes`. Throws `ToolFailure` for an output that cannot
 * be serialized.
 */
export function capToolOutput(output: unknown, maxBytes: number = LIMITS.toolOutputBytes): unknown {
  let json: string | undefined
  try {
    json = JSON.stringify(output)
  }
  catch {
    throw new ToolFailure('The tool returned an output that is not JSON-serializable.')
  }
  if (json === undefined)
    return null
  const bytes = Buffer.byteLength(json, 'utf8')
  if (bytes <= maxBytes)
    return JSON.parse(json) as unknown
  return { truncated: true, originalBytes: bytes, preview: utf8Prefix(json, maxBytes) } satisfies TruncatedToolOutput
}

export function clampToolTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
    return GUARD_TIMEOUTS.tool
  return Math.min(Math.floor(timeoutMs), GUARD_TIMEOUT_MAX_MS)
}

function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : typeof error === 'string' ? error.trim() : ''
  return message === '' ? 'The tool call failed.' : message
}

export interface ToolWrapContext {
  chatId: string
  /** The assistant message of the run (Phase 8; a continuation after an approval keeps the id). */
  messageId: string
  modelRef: string
  registry: Pick<Registry, 'hooks'>
  plugins: Pick<PluginHost, 'guard' | 'isActive'>
  /** The run signal (the SDK passes it, merged with its own timeout, as `abortSignal`). */
  signal: AbortSignal
  /**
   * The project folder of the run (Phase 7): passed as `ToolCallContext.workspace` to every tool; null or absent = the
   * run has no workspace (`workspace` is then absent from the call context). Use `toolWorkspace()` (frozen).
   */
  workspace?: ToolWorkspace | null
  /**
   * The run scope of a run with a workspace (Phase 8, `workspace/run-scope.ts`): bound with the call's `toolCallId` to
   * the call context of every tool, and its journal records the settled calls (`settledCallRecord`). Null or absent =
   * nothing is bound or recorded.
   */
  scope?: WorkspaceRunScopeInit | null
  /**
   * The agent scope of the run (Phase 9, `agent-scope.ts`): bound to the call context of every tool (`agentScopeOf(c)`
   * of the `core-agent` tools). Null or absent (sub-agents) = nothing is bound.
   */
  agent?: AgentRunScope | null
  /**
   * The prefix of the call ids of a sub-agent's calls (Phase 9: `<parent call id>/`): the hooks, the call context, the
   * bound run scope and the journal see `<prefix><call id>`. Absent = the SDK's call id as it is.
   */
  callIdPrefix?: string
  /** Warnings of the journal step (default: none). */
  logger?: Logger
}

/** The builtin plugin of the workspace tools (`builtin-plugins/core-workspace`). */
export const CORE_WORKSPACE_PLUGIN_ID = 'core-workspace'
/** The core-workspace tools that journal their own writes (`journaledWrite`, `workspace/journal.ts`). */
const SELF_JOURNALED_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file'])
/** The core-workspace shell (its calls are journaled as `shell` rows with the command). */
const CORE_SHELL_TOOL = 'shell'

/** What the journal records for a settled call (Phase 8, ADR-036): nothing, a `shell` row or an `untracked` row. */
export type SettledCallRecord = { kind: 'shell', command: string } | { kind: 'untracked' } | null

/**
 * The journal row of a settled call of `registered` with its final `input`: the core `shell` -> `shell` with the
 * command; the core `write_file` / `edit_file` -> nothing (they journal themselves); any other tool with workspace
 * access `write` or `execute` (an unknown access counts as `execute`) -> `untracked`; everything else (no access, `read`,
 * MCP tools) -> nothing.
 */
export function settledCallRecord(registered: Pick<RegisteredTool, 'pluginId' | 'definition'>, input: unknown): SettledCallRecord {
  const { pluginId, definition } = registered
  if (pluginId === CORE_WORKSPACE_PLUGIN_ID) {
    if (definition.name === CORE_SHELL_TOOL) {
      const command = typeof input === 'object' && input !== null ? (input as { command?: unknown }).command : undefined
      return { kind: 'shell', command: typeof command === 'string' ? command : '' }
    }
    if (SELF_JOURNALED_TOOLS.has(definition.name))
      return null
  }
  const access = toolWorkspaceAccess(definition)
  return access === 'write' || access === 'execute' ? { kind: 'untracked' } : null
}

/** Records a settled call in the run's journal (`recordShell` / `recordUntracked` never reject; guarded anyway). */
async function recordSettledCall(context: ToolWrapContext, registered: Pick<RegisteredTool, 'pluginId' | 'definition'>, toolCallId: string, input: unknown): Promise<void> {
  const journal = context.scope?.journal ?? null
  if (journal === null)
    return
  const record = settledCallRecord(registered, input)
  if (record === null)
    return
  try {
    if (record.kind === 'shell')
      await journal.recordShell({ toolCallId, command: record.command })
    else
      await journal.recordUntracked({ toolCallId, tool: registered.definition.name })
  }
  catch (error) {
    context.logger?.warn('the tool call was not journaled', { tool: registered.definition.name, messageId: context.messageId, err: error })
  }
}

/** The frozen `ToolCallContext.workspace` of a run: exactly `{ projectId, name, root }` (no other workspace fields). */
export function toolWorkspace(workspace: ToolWorkspace): ToolWorkspace {
  return Object.freeze({ projectId: workspace.projectId, name: workspace.name, root: workspace.root })
}

/** `fn` is an `async function*` (or an async generator method): its call returns an async generator at once. */
export function isAsyncGeneratorFunction(fn: unknown): boolean {
  return typeof fn === 'function' && Object.prototype.toString.call(fn) === '[object AsyncGeneratorFunction]'
}

/** `value` can be iterated with `for await` (`Symbol.asyncIterator`). */
export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
}

/** The wrapped `execute`: a promise, or an async generator for a streaming tool (`isAsyncGeneratorFunction`). */
export type WrappedToolExecute = (input: unknown, options: ToolExecutionOptions<unknown>) => Promise<unknown> | AsyncGenerator<unknown, void, undefined>

type WrappedTool = Pick<RegisteredTool, 'pluginId' | 'definition'>

/** The hook context of one call (`tool.before` / `tool.after`). */
interface CallBase {
  chatId: string
  modelRef: string
  tool: string
  toolCallId: string
}

/** The call id the hooks, the call context, the run scope and the journal see (`ToolWrapContext.callIdPrefix`). */
function callIdOf(context: ToolWrapContext, options: Pick<ToolExecutionOptions<unknown>, 'toolCallId'>): string {
  return `${context.callIdPrefix ?? ''}${options.toolCallId}`
}

/** Steps 1 and 3 before the plugin's code runs: the owner is active, `tool.before`, the input re-validated. */
async function prepareInput(registered: WrappedTool, context: ToolWrapContext, base: CallBase, input: unknown): Promise<unknown> {
  const { pluginId, definition } = registered
  if (!context.plugins.isActive(pluginId))
    throw new ToolFailure(`Tool unavailable: the plugin "${pluginId}" is not active.`)
  const before = { input }
  try {
    await context.registry.hooks.run('tool.before', base, before)
  }
  catch (error) {
    throw new ToolFailure(failureMessage(error))
  }
  const schema = asSchema(definition.inputSchema)
  if (schema.validate === undefined)
    return before.input
  const result = await schema.validate(before.input)
  if (!result.success)
    throw new ToolFailure(`The tool input is invalid: ${failureMessage(result.error)}`)
  return result.value
}

/** The `ToolCallContext` of one call, with the run scope and the agent scope bound to it (server-internal). */
function callContextOf(context: ToolWrapContext, options: ToolExecutionOptions<unknown>, toolCallId: string, signal: AbortSignal): ToolCallContext {
  const callContext: ToolCallContext = {
    chatId: context.chatId,
    modelRef: context.modelRef,
    toolCallId,
    messages: options.messages,
    signal,
    ...(context.workspace == null ? {} : { workspace: context.workspace }),
  }
  if (context.scope != null)
    bindRunScope(callContext, { ...context.scope, toolCallId })
  if (context.agent != null)
    bindAgentScope(callContext, context.agent)
  return callContext
}

/** The error a failed guarded call rethrows: the abort of a stopped run as it is, anything else as a `ToolFailure`. */
function settledError(error: unknown, signal: AbortSignal): unknown {
  return signal.aborted && isAbortError(error) ? error : new ToolFailure(failureMessage(error))
}

/** The last value of an async iterable (undefined when it yields nothing); stops early when `signal` aborts. */
async function drain(iterable: AsyncIterable<unknown>, signal: AbortSignal): Promise<unknown> {
  let last: unknown
  for await (const value of iterable) {
    last = value
    if (signal.aborted)
      break
  }
  return last
}

/** The promise path of `wrapToolExecute` (a plain `execute`; an `AsyncIterable` result is drained). */
async function runToolCall(registered: WrappedTool, context: ToolWrapContext, input: unknown, options: ToolExecutionOptions<unknown>): Promise<unknown> {
  const { pluginId, definition } = registered
  const signal = options.abortSignal ?? context.signal
  const toolCallId = callIdOf(context, options)
  const base: CallBase = { chatId: context.chatId, modelRef: context.modelRef, tool: definition.name, toolCallId }
  const finalInput = await prepareInput(registered, context, base, input)

  let output: unknown
  let started = false
  try {
    output = await context.plugins.guard(
      pluginId,
      async (guardSignal) => {
        const callContext = callContextOf(context, options, toolCallId, guardSignal)
        started = true
        const result: unknown = await definition.execute(finalInput, callContext)
        return isAsyncIterable(result) ? drain(result, guardSignal) : result
      },
      { timeoutMs: clampToolTimeout(definition.timeoutMs), phase: 'tool', signal, label: definition.name },
    )
  }
  catch (error) {
    throw settledError(error, signal)
  }
  finally {
    // Journaled once the call settled, success or failure (a call that never started records nothing).
    if (started)
      await recordSettledCall(context, registered, toolCallId, finalInput)
  }

  const after = { output }
  await context.registry.hooks.run('tool.after', { ...base, input: finalInput }, after)
  return capToolOutput(after.output)
}

/**
 * The hand-over between the plugin's iteration (inside the guard) and the wrapper's generator: only the latest value
 * waits (`put` replaces it), and `wait` resolves on the next `put` / `wake` or after `ms`.
 */
class LatestValue {
  #value: { readonly current: unknown } | null = null
  #waiter: (() => void) | null = null
  #woken = false

  put(value: unknown): void {
    this.#value = { current: value }
    this.wake()
  }

  /** Removes and returns the waiting value (null when none waits). */
  take(): { readonly current: unknown } | null {
    const value = this.#value
    this.#value = null
    return value
  }

  get waiting(): boolean {
    return this.#value !== null
  }

  wake(): void {
    const waiter = this.#waiter
    if (waiter === null) {
      this.#woken = true
      return
    }
    this.#waiter = null
    waiter()
  }

  /** Resolves on the next `put` / `wake` (at once when one came since the last wait), or after `ms` when given. */
  wait(ms?: number): Promise<void> {
    if (this.#woken) {
      this.#woken = false
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      this.#waiter = () => {
        if (timer !== undefined)
          clearTimeout(timer)
        resolve()
      }
      if (ms !== undefined) {
        timer = setTimeout(() => {
          this.#waiter = null
          resolve()
        }, ms)
        timer.unref?.()
      }
    })
  }
}

type IterationOutcome = { ok: true, last: unknown } | { ok: false, error: unknown }

/** The streaming path of `wrapToolExecute` (an async generator `execute`; see the module comment). */
async function* streamToolCall(registered: WrappedTool, context: ToolWrapContext, input: unknown, options: ToolExecutionOptions<unknown>): AsyncGenerator<unknown, void, undefined> {
  const { pluginId, definition } = registered
  const signal = options.abortSignal ?? context.signal
  const toolCallId = callIdOf(context, options)
  const base: CallBase = { chatId: context.chatId, modelRef: context.modelRef, tool: definition.name, toolCallId }
  const finalInput = await prepareInput(registered, context, base, input)

  const latest = new LatestValue()
  // Ends the plugin's iteration when this generator ends before it (a value that cannot be capped, a consumer that
  // stops reading): the guard rejects and the plugin's `c.signal` aborts.
  const stop = new AbortController()
  let started = false
  // Set once the guarded iteration settled (a holder: the callbacks below assign it).
  const state: { outcome: IterationOutcome | null } = { outcome: null }
  void context.plugins.guard(
    pluginId,
    async (guardSignal) => {
      const callContext = callContextOf(context, options, toolCallId, guardSignal)
      started = true
      let last: unknown
      for await (const value of definition.execute(finalInput, callContext) as AsyncIterable<unknown>) {
        last = value
        if (guardSignal.aborted)
          break
        latest.put(value)
      }
      return last
    },
    { timeoutMs: clampToolTimeout(definition.timeoutMs), phase: 'tool', signal: AbortSignal.any([signal, stop.signal]), label: definition.name },
  ).then(
    (last) => {
      state.outcome = { ok: true, last }
      latest.wake()
    },
    (error: unknown) => {
      state.outcome = { ok: false, error }
      latest.wake()
    },
  )

  let recorded = false
  const record = async (): Promise<void> => {
    if (!started || recorded)
      return
    recorded = true
    await recordSettledCall(context, registered, toolCallId, finalInput)
  }
  try {
    let sent = 0
    let lastSentAt = Number.NEGATIVE_INFINITY
    while (state.outcome === null) {
      if (!latest.waiting) {
        await latest.wait()
        continue
      }
      if (sent >= PRELIMINARY_OUTPUTS_MAX) {
        latest.take()
        continue
      }
      const due = lastSentAt + PRELIMINARY_INTERVAL_MS - Date.now()
      if (due > 0) {
        await latest.wait(due)
        continue
      }
      const value = latest.take()
      if (value === null)
        continue
      sent += 1
      lastSentAt = Date.now()
      yield capToolOutput(value.current)
    }
    // Journaled once the iteration settled, success or failure.
    await record()
    const settled = state.outcome
    if (!settled.ok)
      throw settledError(settled.error, signal)
    const after = { output: settled.last }
    await context.registry.hooks.run('tool.after', { ...base, input: finalInput }, after)
    yield capToolOutput(after.output)
  }
  finally {
    if (state.outcome === null)
      stop.abort(abortReason('The tool call ended before its iteration.'))
    await record()
  }
}

/** The `execute` of a registered tool with steps 1 and 3-6 of the host wrapper (streaming: see the module comment). */
export function wrapToolExecute(registered: WrappedTool, context: ToolWrapContext): WrappedToolExecute {
  if (isAsyncGeneratorFunction(registered.definition.execute))
    return (input, options) => streamToolCall(registered, context, input, options)
  return (input, options) => runToolCall(registered, context, input, options)
}

/** The guarded `toModelOutput` of a tool; JSON of the output on failure or for a truncated output. */
export function wrapToModelOutput(registered: Pick<RegisteredTool, 'pluginId' | 'definition'>, plugins: Pick<PluginHost, 'guard'>) {
  const { pluginId, definition } = registered
  const convert = definition.toModelOutput
  return async ({ toolCallId, input, output }: { toolCallId: string, input: unknown, output: unknown }): Promise<ToolResultOutput> => {
    const json: ToolResultOutput = { type: 'json', value: (output ?? null) as JSONValue }
    if (convert === undefined || isTruncatedToolOutput(output))
      return json
    try {
      return await plugins.guard(
        pluginId,
        () => convert.call(definition, output, { toolCallId, input }),
        { timeoutMs: GUARD_TIMEOUTS.hook, phase: 'tool', label: `${definition.name} toModelOutput` },
      )
    }
    catch {
      return json
    }
  }
}

export interface ToolAssemblyInput {
  chatId: string
  /** The assistant message of the run (`session.assistantId`; a continuation keeps the id). */
  messageId: string
  modelRef: string
  toolMode: ToolMode
  /** `capabilities.tools` of the model. */
  modelSupportsTools: boolean
  registry: Pick<Registry, 'tools' | 'hooks'>
  plugins: Pick<PluginHost, 'guard' | 'isActive'>
  toolService: Pick<ToolService, 'prefs'>
  mcp: Pick<McpManager, 'list'>
  signal: AbortSignal
  logger: Logger
  /**
   * The project folder of the run (Phase 7; `OpenWorkspace` fits): tools that declare `ToolDefinition.workspace` are
   * sent only with one, and every tool gets it as `ToolCallContext.workspace` (frozen `{ projectId, name, root }`).
   * Null or absent = no workspace.
   */
  workspace?: ToolWorkspace | null
  /**
   * The run scope (Phase 8, `createRunScope` of ./scope.ts): bound to the call context of every tool and to the context
   * of every policy function (`AssembledTools.scope`). Used only together with `workspace`; null or absent = none.
   */
  scope?: WorkspaceRunScopeInit | null
  /** `env.workspaceShell` (`HF_WORKSPACE_SHELL`): tools with workspace access `execute` are sent only when true. */
  allowExecute: boolean
  /**
   * The continued assistant message of an approval continuation (`prepared.continued`), for `applyToolMode` (Phase 9:
   * an approved `exit_plan_mode` call stays executable); null or absent otherwise.
   */
  continuation?: HarnessUIMessage | null
  /** The agent scope of the run (Phase 9), bound to every call context; null or absent (sub-agents) = none. */
  agent?: AgentRunScope | null
  /** The call id prefix of a sub-agent's tools (`ToolWrapContext.callIdPrefix`, Phase 9); absent for chat runs. */
  callIdPrefix?: string
  /**
   * The tool restriction of the turn (Phase 10, `PreparedRun.turnRestriction`: a command file's `allowed-tools`): only
   * the tools it matches are sent (`restrictTools`); null or absent = no restriction.
   */
  allowedTools?: readonly string[] | null
  /**
   * The run catalog has skills (Phase 10): `core-agent`'s `skill` is sent only then. Absent = false (sub-agents never
   * get `skill`).
   */
  skillsAvailable?: boolean
}

export interface AssembledTools {
  /** The AI SDK tool set (empty when no tool is sent). */
  tools: ToolSet
  /** Tools sent to the model, for the approval function. */
  byName: Map<string, ApprovalTool>
  prefs: ReadonlyMap<string, ToolPref>
  /** Tools would have been sent, but the model does not support tools (`tools-unsupported` notice). */
  unsupported: boolean
  /** The frozen `ToolCallContext.workspace` given to the tools (and to the policy functions), or null. */
  workspace: ToolWorkspace | null
  /** The run scope bound to the tools' call contexts (and to the policy functions' contexts), or null (Phase 8). */
  scope: WorkspaceRunScopeInit | null
  /**
   * The tools the model may call (`streamText({ activeTools })`, Phase 9 `applyToolMode`); absent = every tool of
   * `tools`.
   */
  activeTools?: string[]
}

/** The name of `core-agent`'s skill loader (Phase 10, ADR-045). */
const SKILL_TOOL_NAME: AgentToolName = 'skill'

/** `core-agent`'s `skill` (recognized by owner and name, like `isPlanExitTool`). */
export function isSkillTool(tool: { readonly pluginId: string, readonly definition: { readonly name: string } }): boolean {
  return tool.pluginId === CORE_AGENT_PLUGIN_ID && tool.definition.name === SKILL_TOOL_NAME
}

/** The Phase 10 narrowing of a tool set (`restrictTools`). */
export interface ToolRestriction {
  /** The turn's allowlist (`ToolAssemblyInput.allowedTools`); null = no restriction. */
  readonly allowedTools: readonly string[] | null
  /** The run catalog has skills (`ToolAssemblyInput.skillsAvailable`). */
  readonly skillsAvailable: boolean
}

/**
 * The tool set of `applyToolMode`, narrowed (see the module comment): `skill` only with `skillsAvailable`; with an
 * `allowedTools` list only the tools it matches, `exit_plan_mode` exempt. Never adds a tool; `activeTools` (when set)
 * keeps only names of the kept tools.
 */
export function restrictTools<T extends ModeTool>(moded: ToolModeResult<T>, restriction: ToolRestriction): ToolModeResult<T> {
  const allowed = restriction.allowedTools
  const tools = moded.tools.filter((tool) => {
    if (isSkillTool(tool) && !restriction.skillsAvailable)
      return false
    return allowed === null || isPlanExitTool(tool) || matchToolAllowlist(tool.definition.name, allowed)
  })
  if (tools.length === moded.tools.length)
    return moded
  if (moded.activeTools === undefined)
    return { tools }
  const kept = new Set(tools.map(tool => tool.definition.name))
  return { tools, activeTools: moded.activeTools.filter(name => kept.has(name)) }
}

/** The workspace filter of a tool (see `ToolAssemblyInput.workspace` / `allowExecute`). */
export function offersWorkspaceTool(definition: Pick<ToolDefinition, 'workspace'>, hasWorkspace: boolean, allowExecute: boolean): boolean {
  const access = toolWorkspaceAccess(definition)
  if (access === null)
    return true
  return hasWorkspace && (access !== 'execute' || allowExecute)
}

async function readPrefs(input: ToolAssemblyInput): Promise<ReadonlyMap<string, ToolPref>> {
  try {
    return await input.toolService.prefs()
  }
  catch (error) {
    input.logger.warn('cannot read the tool preferences', { err: error })
    return new Map()
  }
}

/** Connected MCP servers, or null when the MCP manager cannot tell (no filtering then). */
async function connectedMcpServers(input: ToolAssemblyInput): Promise<ReadonlySet<string> | null> {
  try {
    const servers: McpServer[] = await input.mcp.list()
    return new Set(servers.filter(server => server.status === 'connected').map(server => server.id))
  }
  catch {
    return null
  }
}

/** Builds the AI SDK tool of a registered tool. */
export function toAiTool(registered: RegisteredTool, context: ToolWrapContext): Tool {
  const base = {
    description: registered.definition.description,
    inputSchema: registered.definition.inputSchema,
    execute: wrapToolExecute(registered, context),
    toModelOutput: wrapToModelOutput(registered, context.plugins),
  }
  if (registered.mcpServerId !== null)
    return dynamicTool({ ...base, metadata: { mcpServerId: registered.mcpServerId } }) as Tool
  return tool(base as Tool<unknown, unknown>) as Tool
}

/** The tools of a run (see the header comment for the filters). */
export async function assembleTools(input: ToolAssemblyInput): Promise<AssembledTools> {
  const prefs = await readPrefs(input)
  const workspace = input.workspace == null ? null : toolWorkspace(input.workspace)
  const scope = workspace === null ? null : (input.scope ?? null)
  const empty: AssembledTools = { tools: {}, byName: new Map(), prefs, unsupported: false, workspace, scope }
  if (input.toolMode === 'off')
    return empty

  let registered: RegisteredTool[]
  try {
    registered = input.registry.tools.list()
  }
  catch (error) {
    input.logger.warn('cannot list the registered tools', { err: error })
    return empty
  }
  const candidates = registered.filter((entry) => {
    const pref = prefs.get(entry.definition.name)
    if (pref?.enabled === false || pref?.override === 'deny')
      return false
    if (!offersWorkspaceTool(entry.definition, workspace !== null, input.allowExecute))
      return false
    return input.plugins.isActive(entry.pluginId)
  })
  let usable = candidates
  if (candidates.some(entry => entry.mcpServerId !== null)) {
    const connected = await connectedMcpServers(input)
    if (connected !== null)
      usable = candidates.filter(entry => entry.mcpServerId === null || connected.has(entry.mcpServerId))
  }
  const moded = restrictTools(
    applyToolMode(usable, { toolMode: input.toolMode, continuation: input.continuation ?? null }),
    { allowedTools: input.allowedTools ?? null, skillsAvailable: input.skillsAvailable === true },
  )
  if (moded.tools.length === 0)
    return empty
  if (!input.modelSupportsTools)
    return { ...empty, unsupported: true }

  const context: ToolWrapContext = {
    chatId: input.chatId,
    messageId: input.messageId,
    modelRef: input.modelRef,
    registry: input.registry,
    plugins: input.plugins,
    signal: input.signal,
    workspace,
    scope,
    agent: input.agent ?? null,
    ...(input.callIdPrefix === undefined ? {} : { callIdPrefix: input.callIdPrefix }),
    logger: input.logger,
  }
  const tools: ToolSet = {}
  const byName = new Map<string, ApprovalTool>()
  for (const entry of moded.tools) {
    tools[entry.definition.name] = toAiTool(entry, context)
    byName.set(entry.definition.name, { pluginId: entry.pluginId, definition: entry.definition as ToolDefinition })
  }
  return { tools, byName, prefs, unsupported: false, workspace, scope, ...(moded.activeTools === undefined ? {} : { activeTools: moded.activeTools }) }
}
