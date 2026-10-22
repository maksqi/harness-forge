// Validation of registrations (PLUGINS.md 9 and 14): provider definitions, models, tools, commands, hooks and MCP server
// declarations, (plugin API 1.4.0, ADR-045) agent types and skills, and (plugin API 1.5.0, ADR-048 / ADR-051) output
// styles and the command hooks of a plugin (`contributes.hooks`, read with the shared `readHooksConfig`).
// Reserved names: client commands (`/remember` since Phase 10, `/output-style` since Phase 11, through
// `CLIENT_COMMANDS`) and harness commands are no plugin commands; the builtin agent types and the builtin output styles
// (`default`, `explanatory`, `learning`) are no plugin definitions. Invalid shapes throw `validation_error`;
// duplicate names and the reserved `mcp__` tool prefix throw `conflict` (checked by the registry). Plugin code reaches
// these checks through `ctx`, so messages name the field.
//
// Plugin API 1.6.0 (ADR-053, ADR-057, ADR-058; W12.1): commands, agents, skills and output styles may have a qualified
// name `<pluginId>:<seg>…:<name>` (`QUALIFIED_NAME_PATTERN`), accepted only when its first segment is the owner's id
// (harness plugins keep bare names; the reserved bare names stay reserved); a command may use the `markdown` syntax (a
// command-file body of at most 64 KiB) with `argumentHint`, `model` (a model ref or a Claude model name) and
// `allowedTools`; an agent may set `disallowedTools`, `maxTurns`, `color`, `skills` and a Claude model name as `model`;
// a skill may set `baseDir` (a folder inside the plugin; `.` = the plugin root), `argumentHint`, `userInvocable` and
// `modelInvocable`; a command hook registration may carry `env` (never a reserved runner variable) and prompt handlers
// (read with `prompts: true`, counted with the command handlers); an MCP server may carry its Claude Code name.
import type {
  AgentDefinition,
  CommandDefinition,
  HookName,
  McpServerDecl,
  ModelInfo,
  OutputStyleDefinition,
  ProviderDefinition,
  ProviderOptions,
  SkillDefinition,
  ToolDefinition,
  WebSearchParams,
} from '@harness-forge/plugin-sdk'
import type { HookDiagnostic, HookSpec, PromptHookSpec } from '@harness-forge/shared'
import type { Tool } from 'ai'
import type { HookCommandsRegistration, McpServerRegisterOptions, ToolRegisterOptions } from './types.ts'
import { Buffer } from 'node:buffer'
import { isAbsolute } from 'node:path'
import {
  AGENT_COLORS,
  ARGUMENT_NAME_PATTERN,
  BUILTIN_OUTPUT_STYLE_NAMES,
  claudeModelAlias,
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
  modelRefSchema,
  PROMPT_HOOK_EVENTS,
  providerIdSchema,
  readHooksConfig,
  safeParseModelRef,
  SEARCH_WEB_TOOL_NAME,
  splitQualifiedName,
  TOOL_ALLOWLIST_ENTRY_PATTERN,
  TOOL_NAME_PATTERN,
  toolPolicySchema,
  validationError,
  workspaceAccessSchema,
} from '@harness-forge/shared'
import { asSchema } from 'ai'
import { z } from 'zod'
import { SHELL_ENV_RESERVED } from '../workspace/shell.ts'
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
 * Optional functions of `ProviderDefinition`: the members of plugin API 1.0, the media members of 1.1.0 (ADR-028,
 * ADR-029) and the web search hook of 1.7.0 (ADR-062). The record makes the compiler check that every name is a member.
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
  webSearch: true,
} as const satisfies Partial<Record<keyof ProviderDefinition, true>>

/**
 * Checks a provider definition: data fields, functions (`createLanguageModel` is required; `listModels`, `validate`,
 * `reasoning`, `mapError`, `createImageModel`, `imageParams`, `createTranscriptionModel`, `createSpeechModel`,
 * `transcriptionOptions` and `webSearch` must be functions when present), and for plugins other than builtins the id
 * namespace (`<pluginId>` or `<pluginId>-<suffix>`).
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

// ---------- web search answers (plugin API 1.7.0, ADR-062) ----------

/** Most native tools one `ProviderDefinition.webSearch()` answer may add (extra entries are ignored). */
export const WEB_SEARCH_ANSWER_TOOLS_MAX = 4
/** Longest provider tool id (`<provider>.<tool>`, e.g. `anthropic.web_search_20250305`). */
const PROVIDER_TOOL_ID_MAX_CHARS = 128
/** `<provider>.<tool>`: no whitespace, a dot after a non-empty provider name. */
const PROVIDER_TOOL_ID_PATTERN = /^[^\s.]+\.\S+$/
/** Deepest nesting of a native search's provider options (the answer is ignored beyond it). */
const PROVIDER_OPTIONS_MAX_DEPTH = 16
/** Keys never copied from provider options (prototype pollution). */
const UNSAFE_OPTION_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/** What the host keeps of a `webSearch()` answer (`checkWebSearchParams`). */
export interface CheckedWebSearchParams {
  /**
   * The accepted answer: a fresh object with the valid provider tools (the provider's own tool objects), a copy of the
   * provider options and `exclusive: true` when set; undefined when the provider has nothing (usable) to add.
   */
  readonly params: WebSearchParams | undefined
  /** Why the answer, or a part of it, was ignored (never quotes a value); empty when everything was accepted. */
  readonly problems: readonly string[]
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** A JSON-compatible deep copy (plain objects, arrays, strings, finite numbers, booleans, null), else undefined. */
function jsonCopy(value: unknown, depth: number): unknown {
  if (depth > PROVIDER_OPTIONS_MAX_DEPTH)
    return undefined
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    const items: unknown[] = []
    for (const item of value) {
      const copy = jsonCopy(item, depth + 1)
      if (copy === undefined)
        return undefined
      items.push(copy)
    }
    return items
  }
  if (!isPlainRecord(value))
    return undefined
  const copy: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_OPTION_KEYS.has(key))
      return undefined
    if (item === undefined)
      continue
    const itemCopy = jsonCopy(item, depth + 1)
    if (itemCopy === undefined)
      return undefined
    copy[key] = itemCopy
  }
  return copy
}

/** A copy of `value` when it is provider options (an object of JSON objects keyed by provider), else undefined. */
function providerOptionsCopy(value: unknown): ProviderOptions | undefined {
  if (!isPlainRecord(value) || !Object.values(value).every(isPlainRecord))
    return undefined
  return jsonCopy(value, 0) as ProviderOptions | undefined
}

/**
 * A provider-defined tool as the AI SDK needs it (`type: 'provider'`, an `id` of the form `<provider>.<tool>`, an
 * `args` object). Executed by the provider or not: the approval function answers only provider-executed calls
 * (`nativeTools`), and a native tool that is not provider-executed (OpenRouter's `web_search` server tool) has no calls.
 */
export function isProviderToolShape(tool: unknown): tool is Tool {
  if (typeof tool !== 'object' || tool === null)
    return false
  const record = tool as { type?: unknown, id?: unknown, args?: unknown }
  return record.type === 'provider'
    && typeof record.id === 'string'
    && record.id.length <= PROVIDER_TOOL_ID_MAX_CHARS
    && PROVIDER_TOOL_ID_PATTERN.test(record.id)
    && typeof record.args === 'object'
    && record.args !== null
    && !Array.isArray(record.args)
}

/** Null when `name` may key a native search tool: a tool name, not an MCP name, never the builtin `search_web`. */
function nativeToolNameProblem(name: string): string | null {
  if (!TOOL_NAME_PATTERN.test(name))
    return `the tool key ${describeValue(name)} is not a valid tool name`
  if (name.startsWith(MCP_TOOL_PREFIX))
    return `the tool key ${describeValue(name)} uses the reserved prefix "${MCP_TOOL_PREFIX}"`
  if (name === SEARCH_WEB_TOOL_NAME)
    return `the tool key "${SEARCH_WEB_TOOL_NAME}" is reserved for the builtin search tool`
  return null
}

/**
 * Reads the answer of `ProviderDefinition.webSearch(model, request)` (plugin API 1.7.0, ADR-062) defensively: only
 * provider-defined tools (`isProviderToolShape`) under valid tool keys (`nativeToolNameProblem`), at most
 * `WEB_SEARCH_ANSWER_TOOLS_MAX` of them, provider options that are JSON objects keyed by provider (copied), and a
 * boolean `exclusive`. A bad tool entry is dropped; an answer that is not an object, has a `tools` that is not an
 * object, provider options that are not JSON objects or a non-boolean `exclusive` is ignored as a whole (a provider bug
 * must never decide whether function tools are dropped). An answer with nothing left to add is `params: undefined`.
 * Collisions with the turn's function tools are checked when the answer is applied (`webSearchToolCollisions`).
 * Never throws (a throwing getter ignores the answer).
 */
export function checkWebSearchParams(value: unknown): CheckedWebSearchParams {
  if (value === undefined)
    return { params: undefined, problems: [] }
  const ignored = (problem: string): CheckedWebSearchParams => ({ params: undefined, problems: [problem] })
  try {
    if (!isPlainRecord(value))
      return ignored('the answer is not an object')
    const { tools, providerOptions, exclusive } = value as { tools?: unknown, providerOptions?: unknown, exclusive?: unknown }
    if (exclusive !== undefined && typeof exclusive !== 'boolean')
      return ignored('"exclusive" is not a boolean')
    if (tools !== undefined && !isPlainRecord(tools))
      return ignored('"tools" is not an object keyed by tool name')
    let options: ProviderOptions | undefined
    if (providerOptions !== undefined) {
      options = providerOptionsCopy(providerOptions)
      if (options === undefined)
        return ignored('"providerOptions" is not an object of JSON objects keyed by provider')
    }
    const problems: string[] = []
    const accepted: Record<string, Tool> = {}
    let count = 0
    for (const [name, tool] of Object.entries(tools ?? {})) {
      const nameProblem = nativeToolNameProblem(name)
      if (nameProblem !== null) {
        problems.push(nameProblem)
        continue
      }
      if (!isProviderToolShape(tool)) {
        problems.push(`the tool "${name}" is not a provider-defined tool (type "provider", an id "<provider>.<tool>", args)`)
        continue
      }
      if (count >= WEB_SEARCH_ANSWER_TOOLS_MAX) {
        problems.push(`the tool "${name}" exceeds the limit of ${WEB_SEARCH_ANSWER_TOOLS_MAX} native tools`)
        continue
      }
      accepted[name] = tool
      count++
    }
    const hasOptions = options !== undefined && Object.keys(options).length > 0
    if (count === 0 && !hasOptions)
      return { params: undefined, problems }
    return {
      params: {
        ...(count > 0 ? { tools: accepted } : {}),
        ...(hasOptions ? { providerOptions: options } : {}),
        ...(exclusive === true ? { exclusive: true } : {}),
      },
      problems,
    }
  }
  catch {
    return ignored('the answer cannot be read')
  }
}

/**
 * The tool keys of an accepted answer that a tool of the turn already takes (`taken`: a function tool's name in the
 * tool set or the approval map): such a native tool is never added (the function tool keeps its name), so its turn
 * searches without it. Never throws.
 */
export function webSearchToolCollisions(params: WebSearchParams, taken: (name: string) => boolean): string[] {
  try {
    return Object.keys(params.tools ?? {}).filter(name => taken(name))
  }
  catch {
    return []
  }
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

// ---------- names (plugin API 1.6.0, ADR-053) ----------

/** A bare name stands in for a qualified one while the rest of a definition is checked with the bare-name schemas. */
const QUALIFIED_STAND_IN = 'qualified-name'

/** True when `name` is written as a qualified catalog name (it holds a `:`). */
export function isQualifiedForm(name: unknown): name is string {
  return typeof name === 'string' && name.includes(':')
}

/**
 * Checks a qualified name `<pluginId>:<seg>…:<name>` registered by `owner`: `QUALIFIED_NAME_PATTERN` (1-3 segments of
 * `^[a-z][a-z0-9-]{0,63}$`, at most 128 characters) and the first segment equal to the owner's id. Throws
 * `validation_error` on `['name']`.
 */
export function checkQualifiedName(label: string, name: string, owner: string | undefined): void {
  const parts = splitQualifiedName(name)
  if (parts === null)
    throw invalid(`${label}: name: Qualified names are "<pluginId>:<name>" with 1-3 segments of a-z, 0-9 and "-" (a letter first), at most 128 characters.`, ['name'])
  if (owner === undefined || parts.pluginId !== owner)
    throw invalid(`${label}: name: A qualified name must start with the plugin's own id${owner === undefined ? '' : ` ("${owner}:")`}.`, ['name'])
}

/** A model of a 1.6.0 definition: a model ref, or a Claude model name (normalized by `claudeModelAlias`). */
const commandModelSchema = z.string().max(256).transform((value, ctx) => {
  const text = value.trim()
  if (text.includes(':') && !/\s/.test(text) && safeParseModelRef(text) !== null)
    return text
  const alias = claudeModelAlias(text)
  if (alias !== null)
    return alias
  ctx.addIssue({ code: 'custom', message: 'Use "provider:model" or a Claude model name (sonnet, opus, haiku, fable, claude-...).' })
  return z.NEVER
})

/** A tool list of a 1.6.0 definition (`allowedTools`, `disallowedTools`): like an agent's `tools`. */
const toolListSchema = z
  .array(z.string().regex(TOOL_ALLOWLIST_ENTRY_PATTERN, 'Use tool names (or an "mcp__<server>__*" prefix).'))
  .max(64)
  .refine(list => new Set(list).size === list.length, 'Tools must be unique.')

// ---------- commands ----------

/** A definition an agent preloads or a fork runs (`skills`, `agent`): a bare or qualified name, lowercased. */
const DEFINITION_REF_PATTERN = /^[\da-z][\da-z-]{0,63}(?::[\da-z][\da-z-]{0,63}){0,3}$/

/** The named arguments of a command or skill (`arguments`): distinct `ARGUMENT_NAME_PATTERN` names, at most 9. */
const argumentNamesSchema = z
  .array(z.string().regex(ARGUMENT_NAME_PATTERN, 'Use lowercase names of a-z, 0-9 and "_" (a letter or "_" first).'))
  .max(LIMITS.definitionArgumentsMax)
  .refine(list => new Set(list).size === list.length, 'Argument names must be unique.')

/** The ADR-058 fields shared by commands and skills (`disallowedTools`, `arguments`, `whenToUse`, `context`, `agent`). */
const definitionExtras = {
  disallowedTools: toolListSchema.optional(),
  arguments: argumentNamesSchema.optional(),
  whenToUse: z.string().trim().min(1).max(1024).optional(),
  context: z.literal('fork').optional(),
  agent: z.string().max(128).regex(DEFINITION_REF_PATTERN, 'Use an agent name (lowercase, optionally "<pluginId>:<name>").').optional(),
}

/** The 1.6.0 fields of a command (`syntax`, `argumentHint`, `model`, `allowedTools` and the ADR-058 fields). */
const commandExtrasSchema = z.object({
  syntax: z.enum(['template', 'markdown']).optional(),
  argumentHint: z.string().trim().min(1).max(100).optional(),
  model: commandModelSchema.optional(),
  allowedTools: toolListSchema.optional(),
  ...definitionExtras,
})

/**
 * Checks a command: name (not client-only, `/remember` included since Phase 10, ADR-047, and `/output-style` since
 * Phase 11, ADR-051; not a harness command: `/compact` is run by the server itself, Phase 9, ADR-040; plugin API 1.6.0:
 * or a qualified name of `owner`), description and exactly one of `template` / `run`. Plugin API 1.6.0: `syntax`
 * (`markdown` only with a template, which may then hold 64 KiB), `argumentHint`, `model`, `allowedTools` and (ADR-058)
 * `disallowedTools`, `arguments`, `whenToUse`, `context: 'fork'` and `agent`.
 */
export function validateCommandDefinition(definition: CommandDefinition, owner?: string): void {
  if (!isObject(definition))
    throw invalid('A command definition must be an object.')
  const name: unknown = definition.name
  if (isQualifiedForm(name)) {
    checkQualifiedName(`Command "/${name.slice(0, 128)}"`, name, owner)
  }
  else {
    if (typeof name !== 'string' || !COMMAND_NAME_PATTERN.test(name))
      throw invalid(`Invalid command name ${describeValue(name)}: start with a-z and use up to 32 characters of a-z, 0-9 and "-".`, ['name'])
    if (isClientCommand(name) || isHarnessCommand(name))
      throw invalid(`The command "/${name}" is reserved by the app.`, ['name'])
  }
  const label = `Command "/${name}"`
  const description: unknown = definition.description
  if (typeof description !== 'string' || description.trim() === '' || description.length > COMMAND_DESCRIPTION_MAX_CHARS)
    throw invalid(`${label}: "description" must have 1-${COMMAND_DESCRIPTION_MAX_CHARS} characters.`, ['description'])
  const hasTemplate = definition.template !== undefined
  const hasRun = definition.run !== undefined
  if (hasTemplate === hasRun)
    throw invalid(`${label}: set exactly one of "template" and "run".`, [hasTemplate ? 'run' : 'template'])
  const extras = commandExtrasSchema.safeParse({
    syntax: definition.syntax,
    argumentHint: definition.argumentHint,
    model: definition.model,
    allowedTools: definition.allowedTools,
    disallowedTools: definition.disallowedTools,
    arguments: definition.arguments,
    whenToUse: definition.whenToUse,
    context: definition.context,
    agent: definition.agent,
  })
  if (!extras.success)
    throw withPrefix(label, validationError(extras.error))
  const markdown = extras.data.syntax === 'markdown'
  if (hasTemplate) {
    const template: unknown = definition.template
    const limit = markdown ? LIMITS.customizationContentBytes : LIMITS.commandTemplateBytes
    if (typeof template !== 'string' || template === '' || Buffer.byteLength(template, 'utf8') > limit)
      throw invalid(`${label}: "template" must be a non-empty string of at most ${limit / 1024} KB.`, ['template'])
  }
  else {
    if (markdown)
      throw invalid(`${label}: "syntax" applies only to a "template".`, ['syntax'])
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

/** A Claude Code server name (`RegisteredMcpServer.claudeName`): `plugin_<name>_<server>`, letters, digits, `_`, `-`. */
const CLAUDE_MCP_NAME_PATTERN = /^[\w-]{1,128}$/

/**
 * The options of `McpServerRegistry.register` (plugin API 1.6.0): `claudeName` is 1-128 characters of letters, digits,
 * `_` and `-` (the `mcp__<claudeName>__<tool>` alias). Returns the Claude name or undefined.
 */
export function validateMcpRegisterOptions(options: McpServerRegisterOptions | undefined): string | undefined {
  if (options === undefined || options === null)
    return undefined
  if (!isObject(options))
    throw invalid('MCP server options must be an object.')
  const claudeName: unknown = options.claudeName
  if (claudeName === undefined)
    return undefined
  if (typeof claudeName !== 'string' || !CLAUDE_MCP_NAME_PATTERN.test(claudeName))
    throw invalid('The Claude Code name of an MCP server uses 1-128 characters of A-Z, a-z, 0-9, "_" and "-".', ['claudeName'])
  return claudeName
}

// ---------- agents and skills (plugin API 1.4.0, ADR-045; 1.6.0 fields, ADR-058) ----------

/** `declarativeAgentSchema` with the plugin API 1.6.0 agent fields and a Claude model name as `model`. */
const agentDefinitionSchema = declarativeAgentSchema.extend({
  model: z.union([modelRefSchema, z.literal('inherit'), commandModelSchema]).optional(),
  disallowedTools: toolListSchema.optional(),
  maxTurns: z.int().min(1).max(LIMITS.agentMaxTurnsMax).optional(),
  color: z.enum(AGENT_COLORS).optional(),
  skills: z.array(z.string().max(128).regex(DEFINITION_REF_PATTERN, 'Use skill names (lowercase, optionally "<pluginId>:<name>").')).max(LIMITS.agentSkillsPreloadMax).optional(),
})

/** `definition` checked with `schema`; a qualified name (of `owner`) is checked apart and put back afterwards. */
function parseDefinitionShape<T extends { name: string }>(
  label: string,
  definition: Record<string, unknown>,
  owner: string | undefined,
  schema: z.ZodType<T>,
): T {
  const qualified = isQualifiedForm(definition.name)
  if (qualified)
    checkQualifiedName(label, definition.name as string, owner)
  const parsed = schema.safeParse(qualified ? { ...definition, name: QUALIFIED_STAND_IN } : definition)
  if (!parsed.success)
    throw withPrefix(label, validationError(parsed.error))
  return qualified ? { ...parsed.data, name: definition.name as string } : parsed.data
}

/**
 * Checks an agent type like `contributes.agents` (`declarativeAgentSchema`): the name pattern `AGENT_NAME_PATTERN`, not a
 * builtin type (`explore`, `general`) or its alias (`general-purpose`), the description (1-1024 characters after
 * trimming), the instructions (1 character to 64 KiB of UTF-8), at most 64 unique tool names or `mcp__<server>__*`
 * prefixes, and the model (`provider:model` or `inherit`); unknown keys are refused. Plugin API 1.6.0: a qualified name
 * of `owner`, a Claude model name as `model` (stored normalized), `disallowedTools`, `maxTurns` (1-200), `color` and
 * `skills` (at most 5). Returns a frozen copy (the description trimmed), so a plugin cannot change a definition after it
 * was checked.
 */
export function validateAgentDefinition(definition: AgentDefinition, owner?: string): AgentDefinition {
  if (!isObject(definition) || Array.isArray(definition))
    throw invalid('An agent definition must be an object.')
  const data = parseDefinitionShape(`Agent ${describeValue(definition.name)}`, definition as unknown as Record<string, unknown>, owner, agentDefinitionSchema)
  const { name, description, instructions, tools, model, disallowedTools, maxTurns, color, skills } = data
  return Object.freeze({
    name,
    description,
    instructions,
    ...(tools === undefined ? {} : { tools: Object.freeze([...tools]) as string[] }),
    ...(model === undefined ? {} : { model }),
    ...(disallowedTools === undefined ? {} : { disallowedTools: Object.freeze([...disallowedTools]) as string[] }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(color === undefined ? {} : { color }),
    ...(skills === undefined ? {} : { skills: Object.freeze([...skills]) as string[] }),
  })
}

/** Characters of a skill's `baseDir`. */
const BASE_DIR_MAX_CHARS = 512

/**
 * True for a plugin-relative folder (`SkillDefinition.baseDir`): `.` (the plugin root) or a relative POSIX path without
 * empty, `.` or `..` segments, backslashes or control characters, at most 512 characters.
 */
export function isPluginFolderPath(value: string): boolean {
  if (value === '.')
    return true
  if (value === '' || value.length > BASE_DIR_MAX_CHARS || value.startsWith('/') || value.includes('\\') || /[\p{Cc}\p{Cf}]/u.test(value))
    return false
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/** `declarativeSkillSchema` with the plugin API 1.6.0 skill fields. */
const skillDefinitionSchema = declarativeSkillSchema.extend({
  baseDir: z.string().refine(isPluginFolderPath, 'Use "." or a relative folder inside the plugin.').optional(),
  argumentHint: z.string().trim().min(1).max(100).optional(),
  userInvocable: z.boolean().optional(),
  modelInvocable: z.boolean().optional(),
  allowedTools: toolListSchema.optional(),
  model: commandModelSchema.optional(),
  ...definitionExtras,
})

/**
 * Checks a skill like `contributes.skills` (`declarativeSkillSchema`): the name pattern `AGENT_NAME_PATTERN`, the
 * description (1-1024 characters after trimming) and the content (1 character to 64 KiB of UTF-8); unknown keys are
 * refused. Plugin API 1.6.0: a qualified name of `owner`, `baseDir` (a folder inside the plugin, `.` = its root),
 * `argumentHint`, `userInvocable`, `modelInvocable` and (ADR-058) `allowedTools`, `disallowedTools`, `model` (a ref or a
 * Claude model name, normalized), `arguments`, `whenToUse`, `context: 'fork'` and `agent`. Returns a frozen copy (the
 * description trimmed).
 */
export function validateSkillDefinition(definition: SkillDefinition, owner?: string): SkillDefinition {
  if (!isObject(definition) || Array.isArray(definition))
    throw invalid('A skill definition must be an object.')
  const data = parseDefinitionShape(`Skill ${describeValue(definition.name)}`, definition as unknown as Record<string, unknown>, owner, skillDefinitionSchema)
  const { name, description, content, baseDir, argumentHint, userInvocable, modelInvocable, allowedTools, disallowedTools, model, whenToUse, context, agent } = data
  const list = (value: readonly string[] | undefined): string[] | undefined => value === undefined ? undefined : Object.freeze([...value]) as string[]
  return Object.freeze({
    name,
    description,
    content,
    ...(baseDir === undefined ? {} : { baseDir }),
    ...(argumentHint === undefined ? {} : { argumentHint }),
    ...(userInvocable === undefined ? {} : { userInvocable }),
    ...(modelInvocable === undefined ? {} : { modelInvocable }),
    ...(allowedTools === undefined ? {} : { allowedTools: list(allowedTools) }),
    ...(disallowedTools === undefined ? {} : { disallowedTools: list(disallowedTools) }),
    ...(model === undefined ? {} : { model }),
    ...(data.arguments === undefined ? {} : { arguments: list(data.arguments) }),
    ...(whenToUse === undefined ? {} : { whenToUse }),
    ...(context === undefined ? {} : { context }),
    ...(agent === undefined ? {} : { agent }),
  })
}

// ---------- output styles (plugin API 1.5.0, ADR-051) ----------

/**
 * Checks an output style like `contributes.outputStyles` (`declarativeOutputStyleSchema`): the name pattern
 * `AGENT_NAME_PATTERN`, not a builtin style (`default`, `explanatory`, `learning`: `validation_error` naming the
 * field), the description (1 to `LIMITS.customizationDescriptionMaxChars` characters after trimming), the content (1
 * character to 64 KiB of UTF-8) and `keepCodingInstructions` (a boolean, default false); unknown keys are refused.
 * Plugin API 1.6.0: a qualified name of `owner` (`<pluginId>:default` is no builtin name). Returns a frozen copy (the
 * description trimmed, `keepCodingInstructions` filled in), so a plugin cannot change a style after it was checked. A
 * name another plugin registered is the registry's `conflict`.
 */
export function validateOutputStyleDefinition(definition: OutputStyleDefinition, owner?: string): Required<OutputStyleDefinition> {
  if (!isObject(definition) || Array.isArray(definition))
    throw invalid('An output style definition must be an object.')
  if (typeof definition.name === 'string' && isBuiltinOutputStyle(definition.name))
    throw invalid(`The output style "${definition.name}" is a builtin style (${BUILTIN_OUTPUT_STYLE_NAMES.join(', ')}); choose another name.`, ['name'])
  const data = parseDefinitionShape(`Output style ${describeValue(definition.name)}`, definition as unknown as Record<string, unknown>, owner, declarativeOutputStyleSchema)
  const { name, description, content, keepCodingInstructions } = data
  return Object.freeze({ name, description, content, keepCodingInstructions: keepCodingInstructions ?? false })
}

// ---------- command hooks of plugins (plugin API 1.5.0, ADR-048) ----------

/** What `validateHookCommands` keeps of a registration: the handlers that may run and the reader's diagnostics. */
export interface ValidatedHookCommands {
  readonly root: string
  /** The valid handlers in declaration order (frozen); a handler with an `error` diagnostic is not listed. */
  readonly hooks: readonly HookSpec[]
  readonly diagnostics: readonly HookDiagnostic[]
  /** Phase 12: the extra environment of the plugin's command hooks (frozen; empty = none). */
  readonly env: Readonly<Record<string, string>>
  /** Phase 12: the valid prompt handlers (of `hooks`, then `registration.prompts`), in declaration order. */
  readonly prompts: readonly PromptHookSpec[]
}

/** Handlers declared in a raw `hooks` object (every event, every group), counted before anything is read. */
export function declaredHookHandlers(hooks: Record<string, unknown>): number {
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

/** Variables of the plugin hook environment the runner always sets itself (`snapshot.ts`: the folders win). */
const RUNNER_ENV_NAMES: ReadonlySet<string> = new Set(['HARNESS_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'HARNESS_PROJECT_DIR', 'CLAUDE_PROJECT_DIR', ...SHELL_ENV_RESERVED])
/** Entries of `HookCommandsRegistration.env` (a Claude Code plugin: `CLAUDE_PLUGIN_DATA` + 50 `userConfig` options). */
const HOOK_ENV_MAX = 64
/** Characters of one `HookCommandsRegistration.env` value. */
const HOOK_ENV_VALUE_MAX_CHARS = 16_384
const HOOK_ENV_NAME = /^[A-Z_]\w{0,127}$/i

/** Checks `HookCommandsRegistration.env` and returns a frozen copy (`validation_error` on `['env']`). */
function checkHookEnv(env: unknown): Readonly<Record<string, string>> {
  if (env === undefined || env === null)
    return Object.freeze({})
  if (!isObject(env) || Array.isArray(env))
    throw invalid('Command hooks: "env" must be an object of text values.', ['env'])
  const entries = Object.entries(env)
  if (entries.length > HOOK_ENV_MAX)
    throw invalid(`Command hooks: "env" can hold at most ${HOOK_ENV_MAX} variables.`, ['env'])
  const result: Record<string, string> = {}
  for (const [name, value] of entries) {
    if (!HOOK_ENV_NAME.test(name))
      throw invalid(`Command hooks: the variable name ${describeValue(name)} is not valid.`, ['env'])
    if (RUNNER_ENV_NAMES.has(name))
      throw invalid(`Command hooks: the variable "${name}" is set by the hook runner and cannot be overridden.`, ['env', name])
    if (typeof value !== 'string' || value.includes('\0') || value.length > HOOK_ENV_VALUE_MAX_CHARS)
      throw invalid(`Command hooks: the value of "${name}" must be text without NUL characters (at most ${HOOK_ENV_VALUE_MAX_CHARS} characters).`, ['env', name])
    Object.defineProperty(result, name, { value, enumerable: true, writable: true, configurable: true })
  }
  return Object.freeze(result)
}

const PROMPT_EVENT_SET: ReadonlySet<string> = new Set(PROMPT_HOOK_EVENTS)

/** Checks `HookCommandsRegistration.prompts` (already-read prompt handlers): a list of well-formed specs. */
function checkPromptSpecs(prompts: unknown): readonly PromptHookSpec[] {
  if (prompts === undefined || prompts === null)
    return []
  if (!Array.isArray(prompts))
    throw invalid('Command hooks: "prompts" must be a list of prompt hook handlers.', ['prompts'])
  prompts.forEach((spec: unknown, index: number) => {
    const record = isObject(spec) ? spec : null
    const valid = record !== null
      && typeof record.event === 'string' && PROMPT_EVENT_SET.has(record.event)
      && (record.matcher === null || typeof record.matcher === 'string')
      && typeof record.prompt === 'string' && record.prompt.trim() !== '' && !record.prompt.includes('\0')
      && (record.model === null || typeof record.model === 'string')
      && (record.timeoutSec === null || (typeof record.timeoutSec === 'number' && Number.isFinite(record.timeoutSec) && record.timeoutSec > 0))
      && typeof record.continueOnBlock === 'boolean'
      && Array.isArray(record.position)
    if (!valid)
      throw invalid('Command hooks: a prompt handler is not valid.', ['prompts', index])
  })
  return prompts as PromptHookSpec[]
}

/**
 * Checks the command hooks of a plugin (`HookCommandRegistry.register`): `root` is an absolute path (the plugin folder),
 * `hooks` an object keyed by event (the Claude Code `hooks` format) with at most `LIMITS.pluginHooksMax` handlers in
 * total, the prompt handlers of `prompts` counted too (`validation_error` naming the field otherwise); then reads it
 * with the shared `readHooksConfig(hooks, { source: 'plugin', prompts: true })`, whose diagnostics are kept (an unknown
 * event, an unsupported handler type or an invalid matcher is a diagnostic, not an error). Phase 12: `env` (names
 * `[A-Za-z_][A-Za-z0-9_]*`, never a variable the runner sets, text values) and `prompts` (prompt handlers read elsewhere,
 * listed after those of `hooks`). Never quotes a command or a prompt.
 */
export function validateHookCommands(registration: HookCommandsRegistration): ValidatedHookCommands {
  if (!isObject(registration))
    throw invalid('A command hook registration must be an object.')
  const { root, hooks } = registration as { root?: unknown, hooks?: unknown }
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0') || root.length > LIMITS.workspacePathMaxChars)
    throw invalid('Command hooks: "root" must be the absolute path of the plugin folder.', ['root'])
  if (!isObject(hooks) || Array.isArray(hooks))
    throw invalid('Command hooks: "hooks" must be an object keyed by event name.', ['hooks'])
  const env = checkHookEnv((registration as { env?: unknown }).env)
  const extraPrompts = checkPromptSpecs((registration as { prompts?: unknown }).prompts)
  const declared = declaredHookHandlers(hooks) + extraPrompts.length
  if (declared > LIMITS.pluginHooksMax)
    throw invalid(`Command hooks: a plugin can declare at most ${LIMITS.pluginHooksMax} hook handlers (found ${declared}).`, ['hooks'])
  const read = readHooksConfig(hooks, { source: 'plugin', prompts: true })
  return deepFreeze({
    root,
    hooks: [...read.items],
    diagnostics: [...read.diagnostics],
    env,
    prompts: [...read.prompts, ...extraPrompts.map(spec => structuredClone(spec))],
  })
}
