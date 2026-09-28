// Tool, MCP server and command DTOs (API.md section 4.9).
import { z } from 'zod'
import { mcpStatusSchema, toolOverrideSchema, toolPolicySchema } from '../enums.ts'
import { harnessErrorInitSchema } from '../errors.ts'
import { commandNameSchema, mcpServerIdSchema, pluginIdSchema, timestampSchema, toolNameSchema } from '../ids.ts'
import { hasControlChars } from '../util/text.ts'
import { secretStateSchema } from './common.ts'
import { envVarNameSchema, httpHeaderNameSchema, httpHeaderValueSchema, httpUrlSchema } from './plugin-data.ts'

export const toolSummarySchema = z.object({
  /** MCP tools: `mcp__<serverId>__<tool>`. */
  name: toolNameSchema,
  /** Display name (MCP annotations title), else null. */
  title: z.string().nullable(),
  description: z.string(),
  /** Owner (`core-tools`, `core-mcp`, or a plugin id). */
  pluginId: pluginIdSchema,
  /** Set for MCP tools. */
  mcpServerId: mcpServerIdSchema.nullable(),
  /** null = decided per call by the tool's policy function. */
  policy: toolPolicySchema.nullable(),
  /** `tool_prefs.enabled` (default true). */
  enabled: z.boolean(),
  /** `tool_prefs.override`. */
  override: toolOverrideSchema.nullable(),
  /** Owner active and, for MCP tools, server connected. */
  available: z.boolean(),
  /** JSON Schema of the input (display only). */
  inputSchema: z.record(z.string(), z.unknown()),
})
export type ToolSummary = z.infer<typeof toolSummarySchema>

/** Body of `PATCH /tools/:name`: at least one key; `override: null` removes the override. */
export const toolUpdateSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    override: toolOverrideSchema.nullable().optional(),
  })
  .refine(value => value.enabled !== undefined || value.override !== undefined, 'Send "enabled" or "override".')
export type ToolUpdate = z.infer<typeof toolUpdateSchema>

const stdioCommandSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine(value => !hasControlChars(value), 'The command cannot contain control characters.')
const stdioArgSchema = z.string().max(4096)
const envValueSchema = z.string().max(32_768)

/** Transport of a user-configured MCP server; header and env values are stored as secrets. */
export const mcpTransportInputSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.enum(['http', 'sse']),
    url: httpUrlSchema,
    headers: z.record(httpHeaderNameSchema, httpHeaderValueSchema).optional(),
  }),
  z.strictObject({
    type: z.literal('stdio'),
    command: stdioCommandSchema,
    args: z.array(stdioArgSchema).max(256).optional(),
    env: z.record(envVarNameSchema, envValueSchema).optional(),
  }),
])
export type McpTransportInput = z.infer<typeof mcpTransportInputSchema>

/** Body of `POST /mcp`. `policy` defaults to `ask`, `enabled` to true. */
export const mcpServerInputSchema = z.strictObject({
  id: mcpServerIdSchema,
  name: z.string().trim().min(1).max(100),
  transport: mcpTransportInputSchema,
  /** Per-tool MCP hints still apply. */
  policy: toolPolicySchema.optional(),
  enabled: z.boolean().optional(),
})
export type McpServerInput = z.infer<typeof mcpServerInputSchema>

/**
 * Replacement transport of `PATCH /mcp/:id`: in `headers` / `env` a null value keeps the stored secret and missing keys
 * are removed.
 */
export const mcpTransportUpdateSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.enum(['http', 'sse']),
    url: httpUrlSchema,
    headers: z.record(httpHeaderNameSchema, httpHeaderValueSchema.nullable()).optional(),
  }),
  z.strictObject({
    type: z.literal('stdio'),
    command: stdioCommandSchema,
    args: z.array(stdioArgSchema).max(256).optional(),
    env: z.record(envVarNameSchema, envValueSchema.nullable()).optional(),
  }),
])
export type McpTransportUpdate = z.infer<typeof mcpTransportUpdateSchema>

/** Body of `PATCH /mcp/:id`: at least one key. */
export const mcpServerUpdateSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100).optional(),
    policy: toolPolicySchema.optional(),
    enabled: z.boolean().optional(),
    /** Replaces the transport. */
    transport: mcpTransportUpdateSchema.optional(),
  })
  .refine(value => Object.keys(value).length > 0, 'Send at least one field.')
export type McpServerUpdate = z.infer<typeof mcpServerUpdateSchema>

export const mcpServerSchema = z.object({
  id: mcpServerIdSchema,
  name: z.string(),
  /** `core-mcp` for user-configured servers, else the declaring plugin. */
  pluginId: pluginIdSchema,
  /** True only for user-configured servers. */
  editable: z.boolean(),
  transport: z.discriminatedUnion('type', [
    z.object({
      type: z.enum(['http', 'sse']),
      url: z.string(),
      headers: z.record(z.string(), secretStateSchema),
    }),
    z.object({
      type: z.literal('stdio'),
      command: z.string(),
      args: z.array(z.string()),
      env: z.record(z.string(), secretStateSchema),
    }),
  ]),
  policy: toolPolicySchema,
  enabled: z.boolean(),
  status: mcpStatusSchema,
  error: harnessErrorInitSchema.nullable(),
  /** Registered tool names. */
  tools: z.array(toolNameSchema),
  connectedAt: timestampSchema.nullable(),
})
export type McpServer = z.infer<typeof mcpServerSchema>

/** A server-side slash command (client-only commands are not listed). */
export const commandSummarySchema = z.object({
  name: commandNameSchema,
  description: z.string(),
  pluginId: pluginIdSchema,
})
export type CommandSummary = z.infer<typeof commandSummarySchema>
