// Validation of registrations (PLUGINS.md 9 and 14): provider definitions, models, tools, commands, hooks and MCP server
// declarations. Invalid shapes throw `validation_error`; duplicate names and the reserved `mcp__` tool prefix throw
// `conflict` (checked by the registry). Plugin code reaches these checks through `ctx`, so messages name the field.
import type {
  CommandDefinition,
  HookName,
  McpServerDecl,
  ModelInfo,
  ProviderDefinition,
  ToolDefinition,
} from '@harness-forge/plugin-sdk'
import type { ToolRegisterOptions } from './types.ts'
import { Buffer } from 'node:buffer'
import {
  COMMAND_NAME_PATTERN,
  credentialFieldSchema,
  HarnessError,
  httpUrlSchema,
  isClientCommand,
  isPluginNamespacedId,
  LIMITS,
  MCP_TOOL_PREFIX,
  mcpServerDeclSchema,
  mcpServerIdSchema,
  modelIdSchema,
  modelInfoListSchema,
  providerIdSchema,
  TOOL_NAME_PATTERN,
  toolPolicySchema,
  validationError,
} from '@harness-forge/shared'
import { asSchema } from 'ai'
import { z } from 'zod'
import { isBuiltinPluginId } from './order.ts'

/** Maximum length of a tool description sent to the model (PLUGINS.md 9 "Tools"). */
export const TOOL_DESCRIPTION_MAX_CHARS = 1024
/** Maximum tool timeout (PLUGINS.md 9 `ToolDefinition.timeoutMs`). */
export const TOOL_TIMEOUT_MAX_MS = 600_000
/** Maximum length of a command description (PLUGINS.md 6). */
export const COMMAND_DESCRIPTION_MAX_CHARS = 120

/** Every hook of `HookMap`, in documentation order (the record makes the compiler check completeness). */
const HOOK_NAME_RECORD: Record<HookName, true> = {
  'chat.params': true,
  'chat.headers': true,
  'chat.messages': true,
  'tool.approve': true,
  'tool.before': true,
  'tool.after': true,
  'message.completed': true,
}
export const HOOK_NAMES = Object.keys(HOOK_NAME_RECORD) as HookName[]

export function isHookName(name: unknown): name is HookName {
  return typeof name === 'string' && Object.hasOwn(HOOK_NAME_RECORD, name)
}

/** A `validation_error` with one issue at `path`. */
export function invalid(message: string, path: readonly (string | number)[] = []): HarnessError {
  return new HarnessError({
    code: 'validation_error',
    message,
    details: { issues: [{ path: [...path], message, code: 'custom' }] },
  })
}

/** A `conflict` (`reason: 'exists'`). */
export function duplicate(message: string): HarnessError {
  return new HarnessError({ code: 'conflict', message, details: { reason: 'exists' } })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function describeValue(value: unknown): string {
  return typeof value === 'string' ? `"${value.length > 80 ? `${value.slice(0, 80)}...` : value}"` : typeof value
}

function checkFunction(owner: string, record: Record<string, unknown>, key: string, required: boolean): void {
  const value = record[key]
  if (value === undefined && !required)
    return
  if (typeof value !== 'function')
    throw invalid(`${owner}: "${key}" must be a function.`, [key])
}

function withPrefix(prefix: string, error: HarnessError): HarnessError {
  return new HarnessError({ code: error.code, message: `${prefix}: ${error.message}`, details: error.details })
}

// ---------- providers ----------

const iconSpecSchema = z.union([
  z.string().min(1).max(256),
  z.strictObject({ color: z.string().min(1).max(256).optional(), mono: z.string().min(1).max(256).optional() }),
])

const providerDataSchema = z.object({
  id: providerIdSchema,
  name: z.string().trim().min(1).max(64),
  icon: iconSpecSchema.optional(),
  credentials: z.array(credentialFieldSchema).max(50).superRefine((fields, ctx) => {
    const seen = new Set<string>()
    fields.forEach((field, index) => {
      if (seen.has(field.key))
        ctx.addIssue({ code: 'custom', path: [index, 'key'], message: `Duplicate credential key "${field.key}".` })
      seen.add(field.key)
    })
  }),
  modelsDevId: z.string().trim().min(1).max(64).optional(),
  smallModelId: modelIdSchema.optional(),
  seedModels: modelInfoListSchema.optional(),
  keyUrl: httpUrlSchema.optional(),
})

/**
 * Checks a provider definition: data fields, functions, and for plugins other than builtins the id namespace
 * (`<pluginId>` or `<pluginId>-<suffix>`).
 */
export function validateProviderDefinition(pluginId: string, definition: ProviderDefinition): void {
  if (!isObject(definition))
    throw invalid('A provider definition must be an object.')
  const label = `Provider ${describeValue(definition.id)}`
  const parsed = providerDataSchema.safeParse(definition)
  if (!parsed.success)
    throw withPrefix(label, validationError(parsed.error))
  const record = definition as unknown as Record<string, unknown>
  checkFunction(label, record, 'createLanguageModel', true)
  for (const key of ['listModels', 'validate', 'reasoning', 'mapError'])
    checkFunction(label, record, key, false)
  if (!isBuiltinPluginId(pluginId) && !isPluginNamespacedId(pluginId, definition.id))
    throw invalid(`Provider id "${definition.id}" must be "${pluginId}" or start with "${pluginId}-".`, ['id'])
}

// ---------- models ----------

/** Checks the provider id and the models of `models.register` (valid `ModelInfo`s with unique ids). */
export function validateModels(providerId: string, models: readonly ModelInfo[]): void {
  if (!providerIdSchema.safeParse(providerId).success)
    throw invalid(`Invalid provider id ${describeValue(providerId)}.`, ['providerId'])
  const parsed = modelInfoListSchema.safeParse(models)
  if (!parsed.success)
    throw withPrefix(`Models of provider "${providerId}"`, validationError(parsed.error))
}

// ---------- tools ----------

/** Null when `schema` is usable as a tool input schema, else the problem. */
export function inputSchemaProblem(schema: unknown): string | null {
  if (schema === null || (typeof schema !== 'object' && typeof schema !== 'function'))
    return '"inputSchema" must be a schema: ctx.ai.z.object({...}) or ctx.ai.jsonSchema({...}).'
  let json: unknown
  try {
    json = asSchema(schema as Parameters<typeof asSchema>[0]).jsonSchema
  }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return `"inputSchema" cannot be converted to JSON Schema (${reason}). Wrap plain JSON Schema with ctx.ai.jsonSchema().`
  }
  // An asynchronous JSON Schema is resolved (and checked) by the AI SDK when the tool is sent to a model.
  if (isObject(json) && typeof (json as { then?: unknown }).then === 'function')
    return null
  if (!isObject(json) || json.type !== 'object')
    return '"inputSchema" must describe a JSON object (JSON Schema type "object").'
  return null
}

/**
 * Checks a tool definition: name (`^[a-zA-Z0-9_-]{1,64}$`; the `mcp__` prefix is reserved for MCP tools and throws
 * `conflict` otherwise), description, input schema, policy, timeout and functions.
 */
export function validateToolDefinition(definition: ToolDefinition, options: ToolRegisterOptions = {}): void {
  if (!isObject(definition))
    throw invalid('A tool definition must be an object.')
  const name: unknown = definition.name
  if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name))
    throw invalid(`Invalid tool name ${describeValue(name)}: use 1-64 characters of a-z, A-Z, 0-9, "_" and "-".`, ['name'])
  const label = `Tool "${name}"`
  const mcp = options.mcpServerId !== undefined
  if (mcp) {
    if (!mcpServerIdSchema.safeParse(options.mcpServerId).success)
      throw invalid(`${label}: invalid MCP server id ${describeValue(options.mcpServerId)}.`, ['mcpServerId'])
    if (!name.startsWith(MCP_TOOL_PREFIX))
      throw invalid(`${label}: MCP tool names start with "${MCP_TOOL_PREFIX}".`, ['name'])
  }
  else if (name.startsWith(MCP_TOOL_PREFIX)) {
    throw duplicate(`${label}: the prefix "${MCP_TOOL_PREFIX}" is reserved for MCP tools.`)
  }
  if (options.title !== undefined && (typeof options.title !== 'string' || options.title.length > 256))
    throw invalid(`${label}: "title" must be a string of at most 256 characters.`, ['title'])

  const description: unknown = definition.description
  if (typeof description !== 'string')
    throw invalid(`${label}: "description" must be a string.`, ['description'])
  // MCP servers may omit or lengthen descriptions; plugin tools follow the documented limits.
  if (!mcp && (description.trim() === '' || description.length > TOOL_DESCRIPTION_MAX_CHARS))
    throw invalid(`${label}: "description" must have 1-${TOOL_DESCRIPTION_MAX_CHARS} characters.`, ['description'])

  const schemaProblem = inputSchemaProblem(definition.inputSchema)
  if (schemaProblem)
    throw invalid(`${label}: ${schemaProblem}`, ['inputSchema'])

  const policy: unknown = definition.policy
  if (policy !== undefined && typeof policy !== 'function' && !toolPolicySchema.safeParse(policy).success)
    throw invalid(`${label}: "policy" must be "safe", "ask", "always" or a function.`, ['policy'])

  const timeoutMs: unknown = definition.timeoutMs
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TOOL_TIMEOUT_MAX_MS))
    throw invalid(`${label}: "timeoutMs" must be an integer from 1 to ${TOOL_TIMEOUT_MAX_MS}.`, ['timeoutMs'])

  const record = definition as unknown as Record<string, unknown>
  checkFunction(label, record, 'execute', true)
  checkFunction(label, record, 'toModelOutput', false)
}

// ---------- commands ----------

/** Checks a command: name (not client-only), description and exactly one of `template` / `run`. */
export function validateCommandDefinition(definition: CommandDefinition): void {
  if (!isObject(definition))
    throw invalid('A command definition must be an object.')
  const name: unknown = definition.name
  if (typeof name !== 'string' || !COMMAND_NAME_PATTERN.test(name))
    throw invalid(`Invalid command name ${describeValue(name)}: start with a-z and use up to 32 characters of a-z, 0-9 and "-".`, ['name'])
  if (isClientCommand(name))
    throw invalid(`The command "/${name}" is reserved by the app.`, ['name'])
  const label = `Command "/${name}"`
  const description: unknown = definition.description
  if (typeof description !== 'string' || description.trim() === '' || description.length > COMMAND_DESCRIPTION_MAX_CHARS)
    throw invalid(`${label}: "description" must have 1-${COMMAND_DESCRIPTION_MAX_CHARS} characters.`, ['description'])
  const hasTemplate = definition.template !== undefined
  const hasRun = definition.run !== undefined
  if (hasTemplate === hasRun)
    throw invalid(`${label}: set exactly one of "template" and "run".`, [hasTemplate ? 'run' : 'template'])
  if (hasTemplate) {
    const template: unknown = definition.template
    if (typeof template !== 'string' || template === '' || Buffer.byteLength(template, 'utf8') > LIMITS.commandTemplateBytes)
      throw invalid(`${label}: "template" must be a non-empty string of at most 16 KB.`, ['template'])
  }
  else {
    checkFunction(label, definition as unknown as Record<string, unknown>, 'run', true)
  }
}

// ---------- hooks ----------

export function validateHook(name: unknown, handler: unknown, priority: unknown): void {
  if (!isHookName(name))
    throw invalid(`Unknown hook ${describeValue(name)}; use one of ${HOOK_NAMES.join(', ')}.`, ['name'])
  if (typeof handler !== 'function')
    throw invalid(`Hook "${name}": the handler must be a function.`, ['handler'])
  if (priority !== undefined && (typeof priority !== 'number' || !Number.isFinite(priority)))
    throw invalid(`Hook "${name}": "priority" must be a finite number.`, ['priority'])
}

// ---------- MCP server declarations ----------

/** `mcpServerDeclSchema` plus the id namespace for plugins other than builtins; returns the parsed declaration. */
export function validateMcpServerDecl(pluginId: string, decl: McpServerDecl): McpServerDecl {
  if (!isObject(decl))
    throw invalid('An MCP server declaration must be an object.')
  const parsed = mcpServerDeclSchema.safeParse(decl)
  if (!parsed.success)
    throw withPrefix(`MCP server ${describeValue(decl.id)}`, validationError(parsed.error))
  if (!isBuiltinPluginId(pluginId) && !isPluginNamespacedId(pluginId, parsed.data.id))
    throw invalid(`MCP server id "${parsed.data.id}" must be "${pluginId}" or start with "${pluginId}-".`, ['id'])
  return parsed.data
}
