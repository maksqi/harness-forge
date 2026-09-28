// Registry tool definitions of MCP tools (PLUGINS.md 9 "Tools", 10, 14): names `mcp__<serverId>__<tool>` (sanitized and
// truncated with a hash by `mcpToolName`), policy from the annotations, the MCP input schema as a JSON schema, `execute`
// through the server's client, and `toModelOutput` converting MCP content parts for the model.
import type { CallToolResult, ListToolsResult } from '@ai-sdk/mcp'
import type { ToolCallContext, ToolDefinition, ToolResultOutput } from '@harness-forge/plugin-sdk'
import type { ToolPolicy } from '@harness-forge/shared'
import type { JSONSchema7 } from 'ai'
import type { OfflineMcpTool } from './internal.ts'
import { mcpToolName } from '@harness-forge/shared'
import { jsonSchema } from 'ai'
import { mcpToolPolicy } from './policy.ts'

/** One tool of a `tools/list` answer. */
export type McpListedTool = ListToolsResult['tools'][number]

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
 * JSON text); outputs without content (structured-only results, the 64 KB truncation marker) are sent as JSON.
 */
export function mcpModelOutput(output: unknown): ToolResultOutput {
  const content = isRecord(output) && Array.isArray(output.content) ? output.content : null
  if (content === null || content.length === 0) {
    const value = isRecord(output) && output.structuredContent !== undefined ? output.structuredContent : output
    return { type: 'json', value: (value ?? null) as never }
  }
  return {
    type: 'content',
    value: content.map((part) => {
      if (isRecord(part) && part.type === 'text' && typeof part.text === 'string')
        return { type: 'text' as const, text: part.text }
      if (isRecord(part) && part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string')
        return { type: 'file' as const, mediaType: part.mimeType, data: { type: 'data' as const, data: part.data } }
      return { type: 'text' as const, text: JSON.stringify(part) }
    }),
  }
}

export interface McpToolBinding {
  serverId: string
  pluginId: string
  /** Policy of tools without annotations. */
  serverPolicy: ToolPolicy
  /** Calls the tool on the connected server (throws when it is not connected). */
  call: (toolName: string, input: Record<string, unknown>, c: ToolCallContext) => Promise<CallToolResult>
}

/** The registry definition of one MCP tool. */
export function mcpToolDefinition(tool: McpListedTool, binding: McpToolBinding): ToolDefinition<Record<string, unknown>, Record<string, unknown>> {
  const name = mcpToolName(binding.serverId, tool.name)
  return {
    name,
    description: mcpToolDescription(tool),
    inputSchema: jsonSchema<Record<string, unknown>>(mcpInputSchema(tool) as JSONSchema7),
    policy: mcpToolPolicy(tool.annotations, binding.serverPolicy),
    async execute(input, c) {
      const result = await binding.call(tool.name, isRecord(input) ? input : {}, c)
      if ((result as { isError?: unknown }).isError === true)
        throw new Error(mcpErrorText(result))
      return mcpToolOutput(result)
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
