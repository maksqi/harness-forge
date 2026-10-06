// Identifiers: patterns, primitive schemas, builtin ids, model refs, MCP tool names and id generators
// (DECISIONS.md "Identifiers", API.md sections 1 and 4.1).
import { z } from 'zod'
import { HarnessError } from './errors.ts'
import { fnv1a32Hex } from './util/hash.ts'
import { randomBytes, randomString } from './util/random.ts'
import { excerpt } from './util/text.ts'

// ---------- patterns ----------

/** uuidv7, lowercase. */
export const CHAT_ID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/
/** `msg_` + 16 characters of `[0-9A-Za-z]`. */
export const MESSAGE_ID_PATTERN = /^msg_[\dA-Za-z]{16}$/
/** `file_` + 16 characters of `[0-9A-Za-z]`. */
export const FILE_ID_PATTERN = /^file_[\dA-Za-z]{16}$/
/** `shr_` + 16 characters of `[0-9A-Za-z]` (ADR-025). */
export const SHARE_ID_PATTERN = /^shr_[\dA-Za-z]{16}$/
/** `prj_` + 16 characters of `[0-9A-Za-z]` (ADR-031). */
export const PROJECT_ID_PATTERN = /^prj_[\dA-Za-z]{16}$/
/** `srl_` + 16 characters of `[0-9A-Za-z]`: a shell rule (ADR-038). */
export const SHELL_RULE_ID_PATTERN = /^srl_[\dA-Za-z]{16}$/
/** `wcb_` + 16 characters of `[0-9A-Za-z]`: a workspace change batch, one revert, rewind or undo (ADR-036). */
export const CHANGE_BATCH_ID_PATTERN = /^wcb_[\dA-Za-z]{16}$/
/** `cus_` + 16 characters of `[0-9A-Za-z]`: a personal agent, command or skill (table `customizations`, ADR-044). */
export const CUSTOMIZATION_ID_PATTERN = /^cus_[\dA-Za-z]{16}$/
/** `bgt_` + 16 characters of `[0-9A-Za-z]`: a background task (table `background_tasks`, ADR-046). */
export const BACKGROUND_TASK_ID_PATTERN = /^bgt_[\dA-Za-z]{16}$/
/** `hok_` + 16 characters of `[0-9A-Za-z]`: a personal command hook (table `hooks`, Phase 11, ADR-048). */
export const HOOK_ID_PATTERN = /^hok_[\dA-Za-z]{16}$/
/**
 * `hev_` + 16 characters of `[0-9A-Za-z]`: a hook record (Phase 11, ADR-048): one `data-hook` part, and one entry of the
 * hook run log (`GET /hooks/runs`).
 */
export const HOOK_RECORD_ID_PATTERN = /^hev_[\dA-Za-z]{16}$/
/** `mkt_` + 16 characters of `[0-9A-Za-z]`: a plugin marketplace (table `marketplaces`, Phase 12, ADR-054). */
export const MARKETPLACE_ID_PATTERN = /^mkt_[\dA-Za-z]{16}$/
/**
 * `cip_` + 16 characters of `[0-9A-Za-z]`: a Claude Code import plan (Phase 12, ADR-055; held in memory by the server
 * for 10 minutes, never stored).
 */
export const IMPORT_PLAN_ID_PATTERN = /^cip_[\dA-Za-z]{16}$/
/**
 * Share token (ADR-025): the 16-character suffix of the share id + the first 22 base64url characters of
 * `HMAC-SHA256(subkey 'share', 'harness-forge/share/v1:' + shareId)`. Never stored; the share page is `/share/<token>`.
 */
export const SHARE_TOKEN_PATTERN = /^[\dA-Z]{16}[\w-]{22}$/i
/** Plugin id: 1..40 characters of `[a-z0-9-]`, no leading or trailing `-`. */
export const PLUGIN_ID_PATTERN = /^[\da-z](?:[\da-z-]{0,38}[\da-z])?$/
/** Provider id: 1..64 characters of `[a-z0-9-]`, no leading or trailing `-`. */
export const PROVIDER_ID_PATTERN = /^[\da-z](?:[\da-z-]{0,62}[\da-z])?$/
/** Tool name: 1..64 characters of `[a-zA-Z0-9_-]`. */
export const TOOL_NAME_PATTERN = /^[\w-]{1,64}$/
/** Slash command name (typed as `/name`). */
export const COMMAND_NAME_PATTERN = /^[a-z][\da-z-]{0,31}$/
/** Agent type and skill name (Phase 10, ADR-044): 1..64 characters of `[a-z0-9-]`, starting with a-z. */
export const AGENT_NAME_PATTERN = /^[a-z][\da-z-]{0,63}$/
/**
 * A slash name typed as `/name` (Phase 11, ADR-052): a command (`COMMAND_NAME_PATTERN`, at most 32 characters) or a
 * user-invocable skill (`AGENT_NAME_PATTERN`, at most 64 characters). Equal to `AGENT_NAME_PATTERN`.
 */
export const SLASH_NAME_PATTERN = AGENT_NAME_PATTERN
/** Characters of a qualified catalog name (Phase 12, ADR-053). */
export const QUALIFIED_NAME_MAX_CHARS = 128
/** Segments after the plugin id of a qualified catalog name (Phase 12, ADR-053). */
export const QUALIFIED_NAME_SEGMENTS_MAX = 3
/**
 * A qualified catalog name (Phase 12, ADR-053): `<pluginId>:<segment>[:<segment>…]`, the plugin id
 * (`PLUGIN_ID_PATTERN`) and 1..3 segments of `^[a-z][a-z0-9-]{0,63}$`, at most 128 characters. The commands, agents,
 * skills and output styles of Claude Code plugins use it (command subfolders add segments, `review-kit:db:migrate`);
 * harness plugin entries keep bare names and can also be called `<pluginId>:<name>`.
 */
export const QUALIFIED_NAME_PATTERN = /^(?=[\s\S]{1,128}$)[\da-z](?:[\da-z-]{0,38}[\da-z])?(?::[a-z][\da-z-]{0,63}){1,3}$/
/**
 * A catalog name (Phase 12, ADR-053): a bare name (`AGENT_NAME_PATTERN`, which also covers command names) or a
 * qualified name (`QUALIFIED_NAME_PATTERN`). Names of slash commands, skills, `task.type` and output styles.
 */
export const CATALOG_NAME_PATTERN = /^(?:[a-z][\da-z-]{0,63}|(?=[\s\S]{1,128}$)[\da-z](?:[\da-z-]{0,38}[\da-z])?(?::[a-z][\da-z-]{0,63}){1,3})$/
/** MCP server id: 1..32 characters of `[a-z0-9-]`, no leading or trailing `-`. */
export const MCP_SERVER_ID_PATTERN = /^[\da-z](?:[\da-z-]{0,30}[\da-z])?$/
/** LobeHub icon slug (variants are separate slugs: `claude`, `claude-color`). */
export const ICON_SLUG_PATTERN = /^[\da-z-]{1,64}$/
/** Lowercase hex SHA-256. */
export const SHA256_HEX_PATTERN = /^[\da-f]{64}$/
/** Credential field key and settings property key. */
export const FIELD_KEY_PATTERN = /^[a-z]\w{0,63}$/i
/** Environment variable name. */
export const ENV_VAR_NAME_PATTERN = /^[a-z_]\w{0,127}$/i
/** HTTP header name (RFC 7230 token). */
export const HTTP_HEADER_NAME_PATTERN = /^[\w!#$%&'*+.^`|~-]{1,256}$/

/** Maximum length of a model id. */
export const MODEL_ID_MAX_LENGTH = 256
/** The prefix reserved for MCP tool names. */
export const MCP_TOOL_PREFIX = 'mcp__'

// ---------- primitive schemas ----------

/** Integer >= 0, Unix epoch milliseconds. */
export const timestampSchema = z.int().min(0)
export type Timestamp = z.infer<typeof timestampSchema>

export const chatIdSchema = z.string().regex(CHAT_ID_PATTERN, 'Expected a lowercase uuidv7 chat id.')
export type ChatId = z.infer<typeof chatIdSchema>

export const messageIdSchema = z.string().regex(MESSAGE_ID_PATTERN, 'Expected a message id "msg_" + 16 characters.')
export type MessageId = z.infer<typeof messageIdSchema>

export const fileIdSchema = z.string().regex(FILE_ID_PATTERN, 'Expected a file id "file_" + 16 characters.')
export type FileId = z.infer<typeof fileIdSchema>

export const shareIdSchema = z.string().regex(SHARE_ID_PATTERN, 'Expected a share id "shr_" + 16 characters.')
export type ShareId = z.infer<typeof shareIdSchema>

export const shareTokenSchema = z.string().regex(SHARE_TOKEN_PATTERN, 'Expected a share token of 38 characters.')
export type ShareToken = z.infer<typeof shareTokenSchema>

export const projectIdSchema = z.string().regex(PROJECT_ID_PATTERN, 'Expected a project id "prj_" + 16 characters.')
export type ProjectId = z.infer<typeof projectIdSchema>

export const shellRuleIdSchema = z.string().regex(SHELL_RULE_ID_PATTERN, 'Expected a shell rule id "srl_" + 16 characters.')
export type ShellRuleId = z.infer<typeof shellRuleIdSchema>

export const changeBatchIdSchema = z.string().regex(CHANGE_BATCH_ID_PATTERN, 'Expected a change batch id "wcb_" + 16 characters.')
export type ChangeBatchId = z.infer<typeof changeBatchIdSchema>

export const customizationIdSchema = z.string().regex(CUSTOMIZATION_ID_PATTERN, 'Expected a customization id "cus_" + 16 characters.')
export type CustomizationId = z.infer<typeof customizationIdSchema>

export const backgroundTaskIdSchema = z.string().regex(BACKGROUND_TASK_ID_PATTERN, 'Expected a background task id "bgt_" + 16 characters.')
export type BackgroundTaskId = z.infer<typeof backgroundTaskIdSchema>

export const hookIdSchema = z.string().regex(HOOK_ID_PATTERN, 'Expected a hook id "hok_" + 16 characters.')
export type HookId = z.infer<typeof hookIdSchema>

export const hookRecordIdSchema = z.string().regex(HOOK_RECORD_ID_PATTERN, 'Expected a hook record id "hev_" + 16 characters.')
export type HookRecordId = z.infer<typeof hookRecordIdSchema>

export const marketplaceIdSchema = z.string().regex(MARKETPLACE_ID_PATTERN, 'Expected a marketplace id "mkt_" + 16 characters.')
export type MarketplaceId = z.infer<typeof marketplaceIdSchema>

export const importPlanIdSchema = z.string().regex(IMPORT_PLAN_ID_PATTERN, 'Expected an import plan id "cip_" + 16 characters.')
export type ImportPlanId = z.infer<typeof importPlanIdSchema>

export const pluginIdSchema = z.string().regex(PLUGIN_ID_PATTERN, 'Plugin ids use 1-40 characters of a-z, 0-9 and "-", without a leading or trailing "-".')
export type PluginId = z.infer<typeof pluginIdSchema>

export const providerIdSchema = z.string().regex(PROVIDER_ID_PATTERN, 'Provider ids use 1-64 characters of a-z, 0-9 and "-", without a leading or trailing "-".')
export type ProviderId = z.infer<typeof providerIdSchema>

/** A model id: 1..256 characters without control characters; may contain `:` and `/`. */
export const modelIdSchema = z.string().min(1).max(MODEL_ID_MAX_LENGTH).regex(/^\P{Cc}*$/u, 'Model ids cannot contain control characters.')
export type ModelId = z.infer<typeof modelIdSchema>

export const toolNameSchema = z.string().regex(TOOL_NAME_PATTERN, 'Tool names use 1-64 characters of a-z, A-Z, 0-9, "_" and "-".')
export type ToolName = z.infer<typeof toolNameSchema>

export const agentNameSchema = z.string().regex(AGENT_NAME_PATTERN, 'Names start with a-z and use up to 64 characters of a-z, 0-9 and "-".')
export type AgentName = z.infer<typeof agentNameSchema>

export const commandNameSchema = z.string().regex(COMMAND_NAME_PATTERN, 'Command names start with a-z and use up to 32 characters of a-z, 0-9 and "-".')
export type CommandName = z.infer<typeof commandNameSchema>

/** A slash name (Phase 11, ADR-052): a command (up to 32 characters) or a user-invocable skill (up to 64). */
export const slashNameSchema = z.string().regex(SLASH_NAME_PATTERN, 'Slash names start with a-z and use up to 64 characters of a-z, 0-9 and "-".')
export type SlashName = z.infer<typeof slashNameSchema>

/** A qualified catalog name (Phase 12, ADR-053): `<pluginId>:<segment>[:<segment>…]`, at most 128 characters. */
export const qualifiedNameSchema = z.string().regex(QUALIFIED_NAME_PATTERN, 'Qualified names are "<pluginId>:<name>" with 1-3 segments of a-z, 0-9 and "-" (at most 128 characters).')
export type QualifiedName = z.infer<typeof qualifiedNameSchema>

/**
 * A catalog name (Phase 12, ADR-053): a bare name (up to 64 characters of a-z, 0-9 and "-", starting with a-z) or a
 * qualified `<pluginId>:<name>` name. Slash commands, skills, agent types (`task.type`) and output styles.
 */
export const catalogNameSchema = z.string().regex(CATALOG_NAME_PATTERN, 'Names start with a-z and use up to 64 characters of a-z, 0-9 and "-", or are qualified "<pluginId>:<name>" (at most 128 characters).')
export type CatalogName = z.infer<typeof catalogNameSchema>

export const mcpServerIdSchema = z.string().regex(MCP_SERVER_ID_PATTERN, 'MCP server ids use 1-32 characters of a-z, 0-9 and "-", without a leading or trailing "-".')
export type McpServerId = z.infer<typeof mcpServerIdSchema>

export const iconSlugSchema = z.string().regex(ICON_SLUG_PATTERN, 'Icon slugs use 1-64 characters of a-z, 0-9 and "-".')
export type IconSlug = z.infer<typeof iconSlugSchema>

export const sha256HexSchema = z.string().regex(SHA256_HEX_PATTERN, 'Expected a lowercase hex SHA-256.')
export type Sha256Hex = z.infer<typeof sha256HexSchema>

// ---------- builtin ids ----------

/** The 13 builtin provider ids (models.dev keys), without the dev-only `mock`. */
export const BUILTIN_PROVIDER_IDS = [
  'anthropic',
  'openai',
  'google',
  'xai',
  'deepseek',
  'moonshotai',
  'alibaba',
  'zai',
  'minimax',
  'mistral',
  'groq',
  'openrouter',
  'ollama',
] as const
export type BuiltinProviderId = (typeof BUILTIN_PROVIDER_IDS)[number]

/**
 * Builtin plugins in load order (`core-workspace`: the workspace tools of Phase 7, ADR-032; `core-agent`: the agent
 * tools `todo_write`, `exit_plan_mode` and `task` of Phase 9, ADR-041 / ADR-043; `mock` only with
 * `HF_MOCK_PROVIDER=1`).
 */
export const BUILTIN_PLUGIN_IDS = ['core-providers', 'core-tools', 'core-commands', 'core-mcp', 'core-workspace', 'core-agent', 'mock'] as const
export type BuiltinPluginId = (typeof BUILTIN_PLUGIN_IDS)[number]

/** Id of the dev-only mock provider and plugin. */
export const MOCK_PROVIDER_ID = 'mock'

/**
 * Client-only slash commands: handled by the web app, never sent to the server, not registrable by plugins (and never
 * the name of a custom command). `remember` (Phase 10, ADR-047) opens the Remember dialog (`POST /memory`);
 * `output-style` (Phase 11, ADR-051) sets the chat's output style (a plugin command `/output-style` is refused since
 * v1.7).
 */
export const CLIENT_COMMANDS = ['new', 'model', 'effort', 'mode', 'help', 'remember', 'output-style'] as const
export type ClientCommand = (typeof CLIENT_COMMANDS)[number]

/**
 * Harness commands (Phase 9, ADR-040): run by the server itself, listed by `GET /commands`, not registrable by plugins.
 * `/compact [focus]` summarizes the conversation.
 */
export const HARNESS_COMMANDS = ['compact'] as const
export type HarnessCommand = (typeof HARNESS_COMMANDS)[number]

/** Builtin sub-agent types (Phase 9 ADR-043; reserved names in the Phase 10 catalog, ADR-045). */
export const BUILTIN_AGENT_TYPES = ['explore', 'general'] as const
export type BuiltinAgentType = (typeof BUILTIN_AGENT_TYPES)[number]

/** Accepted aliases of agent type names (Claude Code's `general-purpose`). */
export const AGENT_TYPE_ALIASES: Readonly<Record<string, BuiltinAgentType>> = { 'general-purpose': 'general' }

const BUILTIN_PROVIDER_ID_SET: ReadonlySet<string> = new Set(BUILTIN_PROVIDER_IDS)
const BUILTIN_AGENT_TYPE_SET: ReadonlySet<string> = new Set(BUILTIN_AGENT_TYPES)
const CLIENT_COMMAND_SET: ReadonlySet<string> = new Set(CLIENT_COMMANDS)
const HARNESS_COMMAND_SET: ReadonlySet<string> = new Set(HARNESS_COMMANDS)

export function isBuiltinProviderId(id: string): id is BuiltinProviderId {
  return BUILTIN_PROVIDER_ID_SET.has(id)
}

/**
 * Plugin ids taken by web routes under `/plugins/` (Phase 12): `/plugins/new` (the install dialog) and
 * `/plugins/marketplaces` (the Marketplaces page).
 */
export const RESERVED_PLUGIN_IDS = ['new', 'marketplaces'] as const

const RESERVED_PLUGIN_ID_SET: ReadonlySet<string> = new Set(RESERVED_PLUGIN_IDS)

/**
 * Reserved plugin ids: every id starting with `core-`, `mock`, every builtin provider id and (Phase 12)
 * `RESERVED_PLUGIN_IDS` (`new`, `marketplaces`).
 */
export function isReservedPluginId(id: string): boolean {
  return id.startsWith('core-') || id === MOCK_PROVIDER_ID || BUILTIN_PROVIDER_ID_SET.has(id) || RESERVED_PLUGIN_ID_SET.has(id)
}

export function isClientCommand(name: string): name is ClientCommand {
  return CLIENT_COMMAND_SET.has(name)
}

export function isHarnessCommand(name: string): name is HarnessCommand {
  return HARNESS_COMMAND_SET.has(name)
}

/** True for the builtin agent types and their aliases (a catalog entry with such a name gets `reserved-name`). */
export function isReservedAgentName(name: string): boolean {
  return BUILTIN_AGENT_TYPE_SET.has(name) || Object.hasOwn(AGENT_TYPE_ALIASES, name)
}

/**
 * True when `id` is `<pluginId>` or `<pluginId>-<suffix>` with `<suffix>` of `[a-z0-9-]+` (namespace rule of plugin
 * provider ids and plugin MCP server ids). The id format itself is checked by the respective schema.
 */
export function isPluginNamespacedId(pluginId: string, id: string): boolean {
  if (id === pluginId)
    return true
  return id.startsWith(`${pluginId}-`) && /^[\da-z-]+$/.test(id.slice(pluginId.length + 1))
}

// ---------- qualified catalog names (Phase 12, ADR-053) ----------

/** The parts of a qualified catalog name. */
export interface QualifiedNameParts {
  /** The plugin id (the namespace). */
  pluginId: PluginId
  /** The segments after the plugin id (1..3; command subfolders add segments). */
  segments: string[]
  /** The last segment: the bare name a unique qualified entry also answers to. */
  name: string
}

/**
 * `<pluginId>:<segment>[:<segment>…]`. Throws a `HarnessError` (`validation_error`) when the result is not a valid
 * qualified name (an invalid plugin id or segment, no segment or more than 3, longer than 128 characters).
 */
export function qualifiedName(pluginId: string, ...segments: string[]): QualifiedName {
  const name = [pluginId, ...segments].join(':')
  if (segments.length === 0 || !QUALIFIED_NAME_PATTERN.test(name)) {
    throw new HarnessError({
      code: 'validation_error',
      message: `Invalid qualified name "${excerpt(name)}": expected "<pluginId>:<name>" with 1-${QUALIFIED_NAME_SEGMENTS_MAX} segments (at most ${QUALIFIED_NAME_MAX_CHARS} characters).`,
    })
  }
  return name
}

/** Splits a qualified catalog name; null for a bare name or an invalid one. */
export function splitQualifiedName(name: string): QualifiedNameParts | null {
  if (typeof name !== 'string' || !QUALIFIED_NAME_PATTERN.test(name))
    return null
  const [pluginId = '', ...segments] = name.split(':')
  return { pluginId, segments, name: segments[segments.length - 1] ?? '' }
}

// ---------- model refs ----------

export interface ModelRefParts {
  providerId: ProviderId
  modelId: ModelId
}

function isValidModelId(modelId: string): boolean {
  return modelIdSchema.safeParse(modelId).success
}

/** Splits `providerId:modelId` on the first `:`; returns `null` when either part is invalid. */
export function safeParseModelRef(ref: string): ModelRefParts | null {
  if (typeof ref !== 'string')
    return null
  const index = ref.indexOf(':')
  if (index <= 0)
    return null
  const providerId = ref.slice(0, index)
  const modelId = ref.slice(index + 1)
  if (!PROVIDER_ID_PATTERN.test(providerId) || !isValidModelId(modelId))
    return null
  return { providerId, modelId }
}

function invalidModelRef(ref: string): HarnessError {
  return new HarnessError({
    code: 'validation_error',
    message: `Invalid model ref "${excerpt(String(ref))}": expected "<providerId>:<modelId>".`,
  })
}

/**
 * Splits a model ref on the first `:` (`ollama:llama3:8b` -> `ollama` + `llama3:8b`). Throws a `HarnessError`
 * (`validation_error`) when the ref has no `:` or a part is invalid.
 */
export function parseModelRef(ref: string): ModelRefParts {
  const parts = safeParseModelRef(ref)
  if (!parts)
    throw invalidModelRef(ref)
  return parts
}

/** `providerId:modelId`. Throws a `HarnessError` (`validation_error`) when a part is invalid. */
export function formatModelRef(providerId: string, modelId: string): string {
  const ref = `${providerId}:${modelId}`
  if (!PROVIDER_ID_PATTERN.test(providerId) || !isValidModelId(modelId))
    throw invalidModelRef(ref)
  return ref
}

/** `<providerId>:<modelId>`, split on the first `:`, both parts valid. Only in bodies and queries, never in paths. */
export const modelRefSchema = z
  .string()
  .max(64 + 1 + MODEL_ID_MAX_LENGTH)
  .refine(value => safeParseModelRef(value) !== null, 'Expected a model ref "<providerId>:<modelId>".')
export type ModelRef = z.infer<typeof modelRefSchema>

// ---------- MCP tool names ----------

const MCP_TOOL_NAME_MAX = 64
const MCP_TOOL_NAME_HEAD = 55

/**
 * Registered name of an MCP tool: `mcp__<serverId>__<tool>` with every character outside `[a-zA-Z0-9_-]` replaced by
 * `_`. Names longer than 64 characters become the first 55 characters + `_` + 8 lowercase hex characters of the
 * FNV-1a 32 hash of the full (sanitized) name.
 */
export function mcpToolName(serverId: string, tool: string): ToolName {
  const full = `${MCP_TOOL_PREFIX}${serverId}__${tool}`.replace(/[^\w-]/gu, '_')
  if (full.length <= MCP_TOOL_NAME_MAX)
    return full
  return `${full.slice(0, MCP_TOOL_NAME_HEAD)}_${fnv1a32Hex(full)}`
}

// ---------- id generators ----------

let lastTimestamp = -1
let lastSequence = 0

/**
 * A new chat id: lowercase uuidv7 (RFC 9562) with a 48-bit millisecond timestamp. Ids created by one process are
 * strictly increasing (the 12-bit `rand_a` field is a counter within a millisecond).
 */
export function createChatId(): ChatId {
  const bytes = randomBytes(16)
  let timestamp = Date.now()
  let sequence: number
  if (timestamp > lastTimestamp) {
    // Start each millisecond in the lower half of the counter space, leaving room to count up.
    sequence = ((bytes[6] ?? 0) << 3 | (bytes[7] ?? 0) >> 5) & 0x7FF
  }
  else {
    timestamp = lastTimestamp
    sequence = lastSequence + 1
    if (sequence > 0xFFF) {
      timestamp += 1
      sequence = 0
    }
  }
  lastTimestamp = timestamp
  lastSequence = sequence

  bytes[0] = Math.floor(timestamp / 2 ** 40) & 0xFF
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xFF
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xFF
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xFF
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xFF
  bytes[5] = timestamp & 0xFF
  bytes[6] = 0x70 | (sequence >> 8)
  bytes[7] = sequence & 0xFF
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3F)

  let hex = ''
  for (const byte of bytes)
    hex += byte.toString(16).padStart(2, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * A new message id: `msg_` + 16 random characters of `[0-9A-Za-z]` (crypto random). User message ids are generated by
 * the client (`useChat({ generateId: createMessageId })`), assistant ids by the server (`generateMessageId`), ADR-019.
 */
export function createMessageId(): MessageId {
  return `msg_${randomString(16)}`
}

/** A new file id: `file_` + 16 random characters of `[0-9A-Za-z]`. */
export function createFileId(): FileId {
  return `file_${randomString(16)}`
}

/** A new share id: `shr_` + 16 random characters of `[0-9A-Za-z]` (its suffix starts the share token, ADR-025). */
export function createShareId(): ShareId {
  return `shr_${randomString(16)}`
}

/** A new project id: `prj_` + 16 random characters of `[0-9A-Za-z]` (ADR-031). */
export function createProjectId(): ProjectId {
  return `prj_${randomString(16)}`
}

/** A new shell rule id: `srl_` + 16 random characters of `[0-9A-Za-z]` (ADR-038; generated by the server). */
export function createShellRuleId(): ShellRuleId {
  return `srl_${randomString(16)}`
}

/**
 * A new change batch id: `wcb_` + 16 random characters of `[0-9A-Za-z]` (ADR-036; one revert, rewind or undo,
 * generated by the server).
 */
export function createChangeBatchId(): ChangeBatchId {
  return `wcb_${randomString(16)}`
}

/** A new customization id: `cus_` + 16 random characters of `[0-9A-Za-z]` (ADR-044; generated by the server). */
export function createCustomizationId(): CustomizationId {
  return `cus_${randomString(16)}`
}

/** A new background task id: `bgt_` + 16 random characters of `[0-9A-Za-z]` (ADR-046; generated by the server). */
export function createBackgroundTaskId(): BackgroundTaskId {
  return `bgt_${randomString(16)}`
}

/** A new personal hook id: `hok_` + 16 random characters of `[0-9A-Za-z]` (ADR-048; generated by the server). */
export function createHookId(): HookId {
  return `hok_${randomString(16)}`
}

/** A new hook record id: `hev_` + 16 random characters of `[0-9A-Za-z]` (ADR-048; generated by the server). */
export function createHookRecordId(): HookRecordId {
  return `hev_${randomString(16)}`
}

/** A new marketplace id: `mkt_` + 16 random characters of `[0-9A-Za-z]` (ADR-054; generated by the server). */
export function createMarketplaceId(): MarketplaceId {
  return `mkt_${randomString(16)}`
}

/** `createMarketplaceId` under the name of the Phase 12 design (ADR-054). */
export const newMarketplaceId: () => MarketplaceId = createMarketplaceId

/** A new import plan id: `cip_` + 16 random characters of `[0-9A-Za-z]` (ADR-055; generated by the server). */
export function createImportPlanId(): ImportPlanId {
  return `cip_${randomString(16)}`
}

/** `createImportPlanId` under the name of the Phase 12 design (ADR-055). */
export const newImportPlanId: () => ImportPlanId = createImportPlanId
