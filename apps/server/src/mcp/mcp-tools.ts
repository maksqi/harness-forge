// Registry tool definitions of MCP tools (PLUGINS.md 9 "Tools", 10, 14): names `mcp__<serverId>__<tool>` (sanitized and
// truncated with a hash by `mcpToolName`), policy from the annotations, the MCP input schema as a JSON schema, `execute`
// through the server's client, and `toModelOutput` converting MCP content parts for the model.
//
// Phase 14 (ADR-060, C51-T5; owner in P14-A: W14.3): `execute` is an async generator (the streaming tool path of
// `chat/tools.ts`), so a call can show an elicitation card while it waits for the user:
// - the call is registered with the elicitation broker (`binding.elicitation.broker.begin`, `interactive` = the call
//   runs in the chat's main agent, `agentScopeOf(c) !== null`) before `callTool` and removed (`end()`) in `finally`;
// - while the handle reports a pending request the generator yields `{ status: 'input-required', elicitation }`, after
//   it settled `{ status: 'running' }` (`McpToolProgress`); the last yield is the final output: the v1.8 output
//   (`mcpToolOutput`) plus `elicitations` (the call's records: message, field names, action, reason; never a value),
//   which `mcpModelOutput` keeps from the model;
// - timeouts: the definition's `timeoutMs` is the 600 s outer guard (`MCP_TOOL_TIMEOUT_MS`); the work itself has an
//   active budget of `LIMITS.mcpToolActiveMs` (60 s) on `callTool`'s own signal (`createActiveBudget`), paused while a
//   request waits for the user, so a call that never elicits times out after 60 s as before.
// W14.3 adds the 25 s keep-alive re-yield of a pending card.
import type { CallToolResult, ListToolsResult } from '@ai-sdk/mcp'
import type { ToolCallContext, ToolDefinition, ToolResultOutput } from '@harness-forge/plugin-sdk'
import type { McpToolProgress, ToolPolicy } from '@harness-forge/shared'
import type { JSONSchema7 } from 'ai'
import type { ElicitationBroker, ElicitationCallHandle } from './elicitation/types.ts'
import type { OfflineMcpTool } from './internal.ts'
import { LIMITS, mcpToolName } from '@harness-forge/shared'
import { jsonSchema } from 'ai'
import { agentScopeOf } from '../chat/agent-scope.ts'
import { GUARD_TIMEOUT_MAX_MS } from '../plugins/guard.ts'
import { mcpContentText } from './content.ts'
import { mcpToolPolicy } from './policy.ts'

/** One tool of a `tools/list` answer. */
export type McpListedTool = ListToolsResult['tools'][number]

/** The outer timeout of an MCP tool call (the tool guard, 600 s); the work itself has the active budget. */
export const MCP_TOOL_TIMEOUT_MS = GUARD_TIMEOUT_MAX_MS

/** Longest description / title kept (registry titles are limited to 256 characters). */
const DESCRIPTION_MAX_CHARS = 8192
const TITLE_MAX_CHARS = 256
/** Longest error text of a failed MCP tool result. */
const ERROR_TEXT_MAX_CHARS = 2000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The input JSON schema sent to the model: an object schema without undeclared properties. */
export function mcpInputSchema(tool: McpListedTool): Record<string, unknown> {
  const input = isRecord(tool.inputSchema) ? tool.inputSchema : {}
  const properties = isRecord(input.properties) ? input.properties : {}
  return { ...input, type: 'object', properties, additionalProperties: false }
}

export function mcpToolTitle(tool: McpListedTool): string | null {
  const title = tool.title ?? (isRecord(tool.annotations) && typeof tool.annotations.title === 'string' ? tool.annotations.title : undefined)
  const trimmed = title?.trim()
  return trimmed ? trimmed.slice(0, TITLE_MAX_CHARS) : null
}

export function mcpToolDescription(tool: McpListedTool): string {
  const text = (tool.description ?? mcpToolTitle(tool) ?? '').trim()
  return text.length > DESCRIPTION_MAX_CHARS ? `${text.slice(0, DESCRIPTION_MAX_CHARS)}...` : text
}

/** The stored output of a tool call: the MCP result without protocol metadata. */
export function mcpToolOutput(result: CallToolResult): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (key !== '_meta' && key !== 'resultType' && key !== 'isError' && value !== undefined)
      output[key] = value
  }
  return output
}

/** The text of an `isError` result (its text parts), capped. */
export function mcpErrorText(result: CallToolResult): string {
  const content = (result as { content?: unknown }).content
  const texts = Array.isArray(content)
    ? content.filter(isRecord).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text as string)
    : []
  const text = texts.join('\n').trim() || 'The MCP tool reported an error.'
  return text.length > ERROR_TEXT_MAX_CHARS ? `${text.slice(0, ERROR_TEXT_MAX_CHARS)}...` : text
}

/**
 * Model output of a stored MCP tool output: content parts become `content` (text, images as files, other parts as
 * text through `mcpContentText`); outputs without content (structured-only results, the 64 KB truncation marker) are
 * sent as JSON. Phase 14: the elicitation records (`elicitations`) are never sent to the model.
 */
export function mcpModelOutput(output: unknown): ToolResultOutput {
  const content = isRecord(output) && Array.isArray(output.content) ? output.content : null
  if (content === null || content.length === 0) {
    let value: unknown = isRecord(output) && output.structuredContent !== undefined ? output.structuredContent : output
    if (value === output && isRecord(output) && 'elicitations' in output) {
      const { elicitations: _records, ...rest } = output
      value = rest
    }
    return { type: 'json', value: (value ?? null) as never }
  }
  return {
    type: 'content',
    value: content.map((part) => {
      if (isRecord(part) && part.type === 'text' && typeof part.text === 'string')
        return { type: 'text' as const, text: part.text }
      if (isRecord(part) && part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string')
        return { type: 'file' as const, mediaType: part.mimeType, data: { type: 'data' as const, data: part.data } }
      return { type: 'text' as const, text: mcpContentText(part) }
    }),
  }
}

// ---------- the active budget (ADR-060) ----------

/** The active budget of one MCP tool call: `callTool`'s own signal, paused while the call waits for the user. */
export interface McpActiveBudget {
  /** Aborts when the parent signal aborts (Stop, the outer timeout) or when the active time is used up. */
  readonly signal: AbortSignal
  /** Stops counting (a request of the call waits for the user). Idempotent. */
  readonly pause: () => void
  /** Counts again with the time that is left. Idempotent. */
  readonly resume: () => void
  /** True once the active time was used up (the call is aborted). */
  readonly expired: () => boolean
  /** Clears the timer and the parent listener; aborts the signal when it is still open (the call ended). */
  readonly dispose: () => void
}

/** A pausable budget of `ms` active milliseconds whose signal also follows `parent`; counting starts at once. */
export function createActiveBudget(ms: number, parent: AbortSignal): McpActiveBudget {
  const controller = new AbortController()
  let remaining = Math.max(0, ms)
  let startedAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let ranOut = false
  let disposed = false
  const onParent = (): void => {
    controller.abort(parent.reason)
  }
  if (parent.aborted)
    controller.abort(parent.reason)
  else
    parent.addEventListener('abort', onParent, { once: true })

  function resume(): void {
    if (disposed || timer !== null || controller.signal.aborted)
      return
    startedAt = Date.now()
    timer = setTimeout(() => {
      timer = null
      ranOut = true
      controller.abort(new Error(`The MCP tool call used up its ${Math.round(ms / 1000)} s of work time.`))
    }, remaining)
    timer.unref?.()
  }

  function pause(): void {
    if (timer === null)
      return
    clearTimeout(timer)
    timer = null
    remaining = Math.max(0, remaining - (Date.now() - startedAt))
  }

  resume()
  return {
    signal: controller.signal,
    pause,
    resume,
    expired: () => ranOut,
    dispose: () => {
      if (disposed)
        return
      disposed = true
      pause()
      parent.removeEventListener('abort', onParent)
      if (!controller.signal.aborted)
        controller.abort(new Error('The MCP tool call ended.'))
    },
  }
}

// ---------- the definition ----------

/** Phase 14 (ADR-060): how a manager's tools reach the elicitation broker. */
export interface McpToolElicitation {
  /** `deps.elicitations` (only `begin` is used here). */
  readonly broker: Pick<ElicitationBroker, 'begin'>
  /** The key the client's `onElicitationRequest` handler was registered with (`ElicitationCall.runtimeKey`). */
  readonly runtimeKey: string
  /** The server's display name (the card). */
  readonly serverName: string
}

export interface McpToolBinding {
  serverId: string
  pluginId: string
  /** Policy of tools without annotations. */
  serverPolicy: ToolPolicy
  /**
   * Calls the tool on the connected server (throws when it is not connected). `signal` is the call's active-budget
   * signal (it also aborts with `c.signal`): the request must use it.
   */
  call: (toolName: string, input: Record<string, unknown>, c: ToolCallContext, signal: AbortSignal) => Promise<CallToolResult>
  /** Phase 14: registers every call with the elicitation broker; absent = the calls are not registered (requests decline). */
  elicitation?: McpToolElicitation
}

/** Registers the call with the broker (null without a broker, or when `begin` fails: the call runs without a card). */
function beginCall(binding: McpToolBinding, c: ToolCallContext): ElicitationCallHandle | null {
  const elicitation = binding.elicitation
  if (elicitation === undefined)
    return null
  try {
    return elicitation.broker.begin({
      runtimeKey: elicitation.runtimeKey,
      chatId: c.chatId,
      toolCallId: c.toolCallId,
      serverId: binding.serverId,
      serverName: elicitation.serverName,
      interactive: agentScopeOf(c) !== null,
      signal: c.signal,
    })
  }
  catch {
    return null
  }
}

/**
 * The preliminary outputs of a call while `call` runs: `input-required` when a request of the call starts waiting,
 * `running` when it settled; the budget pauses while the call waits for the user. Ends when `call` settles.
 */
async function* progressOf(handle: ElicitationCallHandle, call: Promise<unknown>, budget: McpActiveBudget): AsyncGenerator<McpToolProgress, void, undefined> {
  // Set by the callbacks below (a holder: the loop condition reads it after every wake-up).
  const state = { settled: false, dirty: true }
  let wake: (() => void) | null = null
  const notify = (): void => {
    state.dirty = true
    const resolve = wake
    wake = null
    resolve?.()
  }
  const unsubscribe = handle.onChange(notify)
  const settle = (): void => {
    state.settled = true
    notify()
  }
  void call.then(settle, settle)
  let shown: string | null = null
  try {
    while (!state.settled) {
      if (!state.dirty) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        continue
      }
      state.dirty = false
      if (handle.waiting())
        budget.pause()
      else
        budget.resume()
      const pending = handle.pending()
      if (pending !== null && pending.id !== shown) {
        shown = pending.id
        yield { status: 'input-required', elicitation: pending }
      }
      else if (pending === null && shown !== null) {
        shown = null
        yield { status: 'running' }
      }
    }
  }
  finally {
    unsubscribe()
  }
}

/** The registry definition of one MCP tool (an async generator `execute`, see the module comment). */
export function mcpToolDefinition(tool: McpListedTool, binding: McpToolBinding): ToolDefinition<Record<string, unknown>, Record<string, unknown>> {
  const name = mcpToolName(binding.serverId, tool.name)
  return {
    name,
    description: mcpToolDescription(tool),
    inputSchema: jsonSchema<Record<string, unknown>>(mcpInputSchema(tool) as JSONSchema7),
    policy: mcpToolPolicy(tool.annotations, binding.serverPolicy),
    timeoutMs: MCP_TOOL_TIMEOUT_MS,
    async* execute(input, c) {
      const budget = createActiveBudget(LIMITS.mcpToolActiveMs, c.signal)
      const handle = beginCall(binding, c)
      try {
        const call = binding.call(tool.name, isRecord(input) ? input : {}, c, budget.signal)
        if (handle !== null)
          yield* progressOf(handle, call, budget)
        let result: CallToolResult
        try {
          result = await call
        }
        catch (error) {
          if (budget.expired() && !c.signal.aborted)
            throw new Error(`The MCP tool "${tool.name}" did not finish within ${Math.round(LIMITS.mcpToolActiveMs / 1000)} s.`)
          throw error
        }
        if ((result as { isError?: unknown }).isError === true)
          throw new Error(mcpErrorText(result))
        const output = mcpToolOutput(result)
        const records = handle?.records() ?? []
        yield records.length > 0 ? { ...output, elicitations: records } : output
      }
      finally {
        handle?.end()
        budget.dispose()
      }
    },
    toModelOutput: output => mcpModelOutput(output),
  }
}

/** The offline listing entry of a tool (kept after the server disconnects). */
export function offlineToolOf(tool: McpListedTool, binding: Pick<McpToolBinding, 'serverId' | 'pluginId' | 'serverPolicy'>): OfflineMcpTool {
  return {
    name: mcpToolName(binding.serverId, tool.name),
    title: mcpToolTitle(tool),
    description: mcpToolDescription(tool),
    pluginId: binding.pluginId,
    mcpServerId: binding.serverId,
    policy: mcpToolPolicy(tool.annotations, binding.serverPolicy),
    inputSchema: mcpInputSchema(tool),
  }
}
