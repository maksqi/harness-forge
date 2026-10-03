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

export const pluginIdSchema = z.string().regex(PLUGIN_ID_PATTERN, 'Plugin ids use 1-40 characters of a-z, 0-9 and "-", without a leading or trailing "-".')
export type PluginId = z.infer<typeof pluginIdSchema>

export const providerIdSchema = z.string().regex(PROVIDER_ID_PATTERN, 'Provider ids use 1-64 characters of a-z, 0-9 and "-", without a leading or trailing "-".')
export type ProviderId = z.infer<typeof providerIdSchema>

/** A model id: 1..256 characters without control characters; may contain `:` and `/`. */
export const modelIdSchema = z.string().min(1).max(MODEL_ID_MAX_LENGTH).regex(/^\P{Cc}*$/u, 'Model ids cannot contain control characters.')
export type ModelId = z.infer<typeof modelIdSchema>

export const toolNameSchema = z.string().regex(TOOL_NAME_PATTERN, 'Tool names use 1-64 characters of a-z, A-Z, 0-9, "_" and "-".')
export type ToolName = z.infer<typeof toolNameSchema>

export const commandNameSchema = z.string().regex(COMMAND_NAME_PATTERN, 'Command names start with a-z and use up to 32 characters of a-z, 0-9 and "-".')
export type CommandName = z.infer<typeof commandNameSchema>

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
 * Builtin plugins in load order (`core-workspace`: the workspace tools of Phase 7, ADR-032; `mock` only with
 * `HF_MOCK_PROVIDER=1`).
 */
export const BUILTIN_PLUGIN_IDS = ['core-providers', 'core-tools', 'core-commands', 'core-mcp', 'core-workspace', 'mock'] as const
export type BuiltinPluginId = (typeof BUILTIN_PLUGIN_IDS)[number]

/** Id of the dev-only mock provider and plugin. */
export const MOCK_PROVIDER_ID = 'mock'

/** Client-only slash commands: handled by the web app, never sent to the server, not registrable by plugins. */
export const CLIENT_COMMANDS = ['new', 'model', 'effort', 'mode', 'help'] as const
export type ClientCommand = (typeof CLIENT_COMMANDS)[number]

const BUILTIN_PROVIDER_ID_SET: ReadonlySet<string> = new Set(BUILTIN_PROVIDER_IDS)
const CLIENT_COMMAND_SET: ReadonlySet<string> = new Set(CLIENT_COMMANDS)

export function isBuiltinProviderId(id: string): id is BuiltinProviderId {
  return BUILTIN_PROVIDER_ID_SET.has(id)
}

/** Reserved plugin ids: every id starting with `core-`, `mock`, and every builtin provider id. */
export function isReservedPluginId(id: string): boolean {
  return id.startsWith('core-') || id === MOCK_PROVIDER_ID || BUILTIN_PROVIDER_ID_SET.has(id)
}

export function isClientCommand(name: string): name is ClientCommand {
  return CLIENT_COMMAND_SET.has(name)
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
