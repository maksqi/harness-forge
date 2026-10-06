// Validation of registrations (PLUGINS.md 9 and 14): provider definitions, models, tools, commands, hooks and MCP server
// declarations, (plugin API 1.4.0, ADR-045) agent types and skills, and (plugin API 1.5.0, ADR-048 / ADR-051) output
// styles and the command hooks of a plugin (`contributes.hooks`, read with the shared `readHooksConfig`).
// Reserved names: client commands (`/remember` since Phase 10, `/output-style` since Phase 11, through
// `CLIENT_COMMANDS`) and harness commands are no plugin commands; the builtin agent types and the builtin output styles
// (`default`, `explanatory`, `learning`) are no plugin definitions. Invalid shapes throw `validation_error`;
// duplicate names and the reserved `mcp__` tool prefix throw `conflict` (checked by the registry). Plugin code reaches
// these checks through `ctx`, so messages name the field.
import type {
  AgentDefinition,
  CommandDefinition,
  HookName,
  McpServerDecl,
  ModelInfo,
  OutputStyleDefinition,
  ProviderDefinition,
  SkillDefinition,
  ToolDefinition,
} from '@harness-forge/plugin-sdk'
import type { HookDiagnostic, HookSpec } from '@harness-forge/shared'
import type { HookCommandsRegistration, ToolRegisterOptions } from './types.ts'
import { Buffer } from 'node:buffer'
import { isAbsolute } from 'node:path'
import {
  BUILTIN_OUTPUT_STYLE_NAMES,
  COMMAND_NAME_PATTERN,
  credentialFieldSchema,
  declarativeAgentSchema,
  declarativeOutputStyleSchema,
  declarativeSkillSchema,
  HarnessError,
  httpUrlSchema,
  isBuiltinOutputStyle,
  isClientCommand,
  isHarnessCommand,
  isPluginNamespacedId,
  LIMITS,
  MCP_TOOL_PREFIX,
  mcpServerDeclSchema,
  mcpServerIdSchema,
  modelIdSchema,
  modelInfoListSchema,
  providerIdSchema,
  readHooksConfig,
  TOOL_NAME_PATTERN,
  toolPolicySchema,
  validationError,
  workspaceAccessSchema,
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
  // Plugin API 1.5.0 (ADR-048): accepted at registration; the chat pipeline calls them from P11-A on.
  'prompt.submit': true,
  'session.start': true,
  'run.stop': true,
  'subagent.stop': true,
  'compact.before': true,
  'notification': true,
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
 * Optional functions of `ProviderDefinition`: the members of plugin API 1.0 and the media members of 1.1.0 (ADR-028,
 * ADR-029). The record makes the compiler check that every name is a member.
 */
const OPTIONAL_PROVIDER_FUNCTIONS = {
  listModels: true,
  validate: true,
  reasoning: true,
  mapError: true,
  createImageModel: true,
  imageParams: true,
  createTranscriptionModel: true,
  createSpeechModel: true,
  transcriptionOptions: true,
} as const satisfies Partial<Record<keyof ProviderDefinition, true>>

/**
 * Checks a provider definition: data fields, functions (`createLanguageModel` is required; `listModels`, `validate`,
 * `reasoning`, `mapError`, `createImageModel`, `imageParams`, `createTranscriptionModel`, `createSpeechModel` and
 * `transcriptionOptions` must be functions when present), and for plugins other than builtins the id namespace
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
  for (const key of Object.keys(OPTIONAL_PROVIDER_FUNCTIONS))
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
 * `conflict` otherwise), description, input schema, policy, timeout, workspace access (plugin API 1.2.0, ADR-032:
 * `read`, `write` or `execute` when present) and functions.
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

  const workspace: unknown = definition.workspace
  if (workspace !== undefined && !workspaceAccessSchema.safeParse(workspace).success)
    throw invalid(`${label}: "workspace" must be "read", "write" or "execute" (got ${describeValue(workspace)}).`, ['workspace'])

  const record = definition as unknown as Record<string, unknown>
  checkFunction(label, record, 'execute', true)
  checkFunction(label, record, 'toModelOutput', false)
}

// ---------- commands ----------

/**
 * Checks a command: name (not client-only, `/remember` included since Phase 10, ADR-047, and `/output-style` since
 * Phase 11, ADR-051; not a harness command: `/compact` is run by the server itself, Phase 9, ADR-040), description and
 * exactly one of `template` / `run`.
 */
export function validateCommandDefinition(definition: CommandDefinition): void {
  if (!isObject(definition))
    throw invalid('A command definition must be an object.')
  const name: unknown = definition.name
  if (typeof name !== 'string' || !COMMAND_NAME_PATTERN.test(name))
    throw invalid(`Invalid command name ${describeValue(name)}: start with a-z and use up to 32 characters of a-z, 0-9 and "-".`, ['name'])
  if (isClientCommand(name) || isHarnessCommand(name))
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

// ---------- agents and skills (plugin API 1.4.0, ADR-045) ----------

/**
 * Checks an agent type like `contributes.agents` (`declarativeAgentSchema`): the name pattern `AGENT_NAME_PATTERN`, not a
 * builtin type (`explore`, `general`) or its alias (`general-purpose`), the description (1-1024 characters after
 * trimming), the instructions (1 character to 64 KiB of UTF-8), at most 64 unique tool names or `mcp__<server>__*`
 * prefixes, and the model (`provider:model` or `inherit`); unknown keys are refused. Returns a frozen copy (the
 * description trimmed), so a plugin cannot change a definition after it was checked.
 */
export function validateAgentDefinition(definition: AgentDefinition): AgentDefinition {
  if (!isObject(definition) || Array.isArray(definition))
    throw invalid('An agent definition must be an object.')
  const parsed = declarativeAgentSchema.safeParse(definition)
  if (!parsed.success)
    throw withPrefix(`Agent ${describeValue(definition.name)}`, validationError(parsed.error))
  const { name, description, instructions, tools, model } = parsed.data
  return Object.freeze({
    name,
    description,
    instructions,
    ...(tools === undefined ? {} : { tools: Object.freeze([...tools]) as string[] }),
    ...(model === undefined ? {} : { model }),
  })
}

/**
 * Checks a skill like `contributes.skills` (`declarativeSkillSchema`): the name pattern `AGENT_NAME_PATTERN`, the
 * description (1-1024 characters after trimming) and the content (1 character to 64 KiB of UTF-8); unknown keys are
 * refused. Returns a frozen copy (the description trimmed).
 */
export function validateSkillDefinition(definition: SkillDefinition): SkillDefinition {
  if (!isObject(definition) || Array.isArray(definition))
    throw invalid('A skill definition must be an object.')
  const parsed = declarativeSkillSchema.safeParse(definition)
  if (!parsed.success)
    throw withPrefix(`Skill ${describeValue(definition.name)}`, validationError(parsed.error))
  const { name, description, content } = parsed.data
  return Object.freeze({ name, description, content })
}

// ---------- output styles (plugin API 1.5.0, ADR-051) ----------

/**
 * Checks an output style like `contributes.outputStyles` (`declarativeOutputStyleSchema`): the name pattern
 * `AGENT_NAME_PATTERN`, not a builtin style (`default`, `explanatory`, `learning`: `validation_error` naming the
 * field), the description (1 to `LIMITS.customizationDescriptionMaxChars` characters after trimming), the content (1
 * character to 64 KiB of UTF-8) and `keepCodingInstructions` (a boolean, default false); unknown keys are refused.
 * Returns a frozen copy (the description trimmed, `keepCodingInstructions` filled in), so a plugin cannot change a style
 * after it was checked. A name another plugin registered is the registry's `conflict`.
 */
export function validateOutputStyleDefinition(definition: OutputStyleDefinition): Required<OutputStyleDefinition> {
  if (!isObject(definition) || Array.isArray(definition))
    throw invalid('An output style definition must be an object.')
  if (typeof definition.name === 'string' && isBuiltinOutputStyle(definition.name))
    throw invalid(`The output style "${definition.name}" is a builtin style (${BUILTIN_OUTPUT_STYLE_NAMES.join(', ')}); choose another name.`, ['name'])
  const parsed = declarativeOutputStyleSchema.safeParse(definition)
  if (!parsed.success)
    throw withPrefix(`Output style ${describeValue(definition.name)}`, validationError(parsed.error))
  const { name, description, content, keepCodingInstructions } = parsed.data
  return Object.freeze({ name, description, content, keepCodingInstructions: keepCodingInstructions ?? false })
}

// ---------- command hooks of plugins (plugin API 1.5.0, ADR-048) ----------

/** What `validateHookCommands` keeps of a registration: the handlers that may run and the reader's diagnostics. */
export interface ValidatedHookCommands {
  readonly root: string
  /** The valid handlers in declaration order (frozen); a handler with an `error` diagnostic is not listed. */
  readonly hooks: readonly HookSpec[]
  readonly diagnostics: readonly HookDiagnostic[]
}

/** Handlers declared in a raw `hooks` object (every event, every group), counted before anything is read. */
function declaredHookHandlers(hooks: Record<string, unknown>): number {
  let count = 0
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups))
      continue
    for (const group of groups) {
      const handlers = isObject(group) ? group.hooks : undefined
      if (Array.isArray(handlers))
        count += handlers.length
    }
  }
  return count
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value))
      deepFreeze(item)
  }
  return value
}

/**
 * Checks the command hooks of a plugin (`HookCommandRegistry.register`): `root` is an absolute path (the plugin folder),
 * `hooks` an object keyed by event (the Claude Code `hooks` format) with at most `LIMITS.pluginHooksMax` handlers in
 * total (`validation_error` naming the field otherwise); then reads it with the shared `readHooksConfig(hooks, {
 * source: 'plugin' })`, whose diagnostics are kept (an unknown event, a `prompt` handler or an invalid matcher is a
 * diagnostic, not an error). Never quotes a command.
 */
export function validateHookCommands(registration: HookCommandsRegistration): ValidatedHookCommands {
  if (!isObject(registration))
    throw invalid('A command hook registration must be an object.')
  const { root, hooks } = registration as { root?: unknown, hooks?: unknown }
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0') || root.length > LIMITS.workspacePathMaxChars)
    throw invalid('Command hooks: "root" must be the absolute path of the plugin folder.', ['root'])
  if (!isObject(hooks) || Array.isArray(hooks))
    throw invalid('Command hooks: "hooks" must be an object keyed by event name.', ['hooks'])
  const declared = declaredHookHandlers(hooks)
  if (declared > LIMITS.pluginHooksMax)
    throw invalid(`Command hooks: a plugin can declare at most ${LIMITS.pluginHooksMax} hook handlers (found ${declared}).`, ['hooks'])
  const read = readHooksConfig(hooks, { source: 'plugin' })
  return deepFreeze({ root, hooks: [...read.items], diagnostics: [...read.diagnostics] })
}
