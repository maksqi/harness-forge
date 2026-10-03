// Tool assembly (ARCHITECTURE.md 6.1 / 6.13, PLUGINS.md 9 "Tools"): registry tools (MCP tools included, registered by
// the MCP manager as `mcp__<serverId>__<tool>` and sent as AI SDK dynamic tools), filtered by the chat tool mode, the
// tool preferences (`enabled: false` and override `deny` are not sent), the owner plugin state, the workspace (Phase 7:
// a tool that declares `ToolDefinition.workspace` only when the run has an open project folder, an `execute` tool only
// while `HF_WORKSPACE_SHELL` is on), the MCP server state and the model capability `tools`. Every tool is wrapped:
//   1. owner plugin active, else "Tool unavailable";
//   2. (approval: `approval.ts`, decided by the SDK before `execute`);
//   3. `tool.before` hooks (a throw blocks the call), the input re-validated against `inputSchema`;
//   4. `execute` under the plugin guard (`timeoutMs`, default 60 s, max 600 s; aborts with the run), with the frozen
//      `ToolCallContext.workspace` (`{ projectId, name, root }`) for every tool of a run with a workspace;
//   5. `tool.after` hooks;
//   6. JSON-serializable output, capped at 64 KB of serialized JSON (`{ truncated, originalBytes, preview }`).
// `toModelOutput` is guarded (3 s); on failure, or for a truncated output, the output is sent as JSON.
import type { ToolCallContext, ToolDefinition, ToolResultOutput, ToolWorkspace } from '@harness-forge/plugin-sdk'
import type { McpServer, ToolMode } from '@harness-forge/shared'
import type { JSONValue, Tool, ToolExecutionOptions, ToolSet } from 'ai'
import type { Logger } from '../logger.ts'
import type { McpManager, ToolPref, ToolService } from '../mcp/types.ts'
import type { PluginHost } from '../plugins/types.ts'
import type { RegisteredTool, Registry } from '../registry/types.ts'
import type { ApprovalTool } from './approval.ts'
import { Buffer } from 'node:buffer'
import { LIMITS } from '@harness-forge/shared'
import { asSchema, dynamicTool, tool } from 'ai'
import { GUARD_TIMEOUT_MAX_MS, GUARD_TIMEOUTS } from '../plugins/guard.ts'
import { toolWorkspaceAccess } from './approval.ts'
import { isAbortError, ToolFailure } from './errors.ts'

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
}

/** The frozen `ToolCallContext.workspace` of a run: exactly `{ projectId, name, root }` (no other workspace fields). */
export function toolWorkspace(workspace: ToolWorkspace): ToolWorkspace {
  return Object.freeze({ projectId: workspace.projectId, name: workspace.name, root: workspace.root })
}

/** The `execute` of a registered tool with steps 1 and 3-6 of the host wrapper. */
export function wrapToolExecute(registered: Pick<RegisteredTool, 'pluginId' | 'definition'>, context: ToolWrapContext) {
  const { pluginId, definition } = registered
  const name = definition.name
  return async (input: unknown, options: ToolExecutionOptions<unknown>): Promise<unknown> => {
    const signal = options.abortSignal ?? context.signal
    const base = { chatId: context.chatId, modelRef: context.modelRef, tool: name, toolCallId: options.toolCallId }
    if (!context.plugins.isActive(pluginId))
      throw new ToolFailure(`Tool unavailable: the plugin "${pluginId}" is not active.`)

    const before = { input }
    try {
      await context.registry.hooks.run('tool.before', base, before)
    }
    catch (error) {
      throw new ToolFailure(failureMessage(error))
    }
    let finalInput = before.input
    const schema = asSchema(definition.inputSchema)
    if (schema.validate !== undefined) {
      const result = await schema.validate(finalInput)
      if (!result.success)
        throw new ToolFailure(`The tool input is invalid: ${failureMessage(result.error)}`)
      finalInput = result.value
    }

    let output: unknown
    try {
      output = await context.plugins.guard(
        pluginId,
        (guardSignal) => {
          const callContext: ToolCallContext = {
            chatId: context.chatId,
            modelRef: context.modelRef,
            toolCallId: options.toolCallId,
            messages: options.messages,
            signal: guardSignal,
            ...(context.workspace == null ? {} : { workspace: context.workspace }),
          }
          return definition.execute(finalInput, callContext)
        },
        { timeoutMs: clampToolTimeout(definition.timeoutMs), phase: 'tool', signal, label: name },
      )
    }
    catch (error) {
      if (signal.aborted && isAbortError(error))
        throw error
      throw new ToolFailure(failureMessage(error))
    }

    const after = { output }
    await context.registry.hooks.run('tool.after', { ...base, input: finalInput }, after)
    return capToolOutput(after.output)
  }
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
  /** `env.workspaceShell` (`HF_WORKSPACE_SHELL`): tools with workspace access `execute` are sent only when true. */
  allowExecute: boolean
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
  const empty: AssembledTools = { tools: {}, byName: new Map(), prefs, unsupported: false, workspace }
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
  if (usable.length === 0)
    return empty
  if (!input.modelSupportsTools)
    return { ...empty, unsupported: true }

  const context: ToolWrapContext = {
    chatId: input.chatId,
    modelRef: input.modelRef,
    registry: input.registry,
    plugins: input.plugins,
    signal: input.signal,
    workspace,
  }
  const tools: ToolSet = {}
  const byName = new Map<string, ApprovalTool>()
  for (const entry of usable) {
    tools[entry.definition.name] = toAiTool(entry, context)
    byName.set(entry.definition.name, { pluginId: entry.pluginId, definition: entry.definition as ToolDefinition })
  }
  return { tools, byName, prefs, unsupported: false, workspace }
}
