// Plugin data shapes embedded by the API DTOs (ADR-018; PLUGINS.md sections 4-6 and 9): credential fields, model
// info, declarative providers, MCP server declarations, declarative commands, (plugin API 1.4.0) declarative agents
// and skills and (plugin API 1.5.0) declarative output styles. `@harness-forge/plugin-sdk` re-exports them unchanged.
// The Claude Code `hooks` format of `contributes.hooks` is `hooksConfigSchema` (`schemas/hooks.ts`).
import { z } from 'zod'
import { apiFormatSchema, credentialFieldTypeSchema, modelKindSchema, reasoningStyleSchema, toolPolicySchema } from '../enums.ts'
import {
  agentNameSchema,
  BUILTIN_AGENT_TYPES,
  CLIENT_COMMANDS,
  commandNameSchema,
  ENV_VAR_NAME_PATTERN,
  FIELD_KEY_PATTERN,
  HARNESS_COMMANDS,
  HTTP_HEADER_NAME_PATTERN,
  isClientCommand,
  isHarnessCommand,
  isReservedAgentName,
  mcpServerIdSchema,
  modelIdSchema,
  modelRefSchema,
  providerIdSchema,
} from '../ids.ts'
import { LIMITS } from '../limits.ts'
import { BUILTIN_OUTPUT_STYLE_NAMES } from '../util/output-styles.ts'
import { isSafeRelativePath } from '../util/paths.ts'
import { compileRegExp, duplicates, hasControlChars, isUnique, utf8ByteLength } from '../util/text.ts'
import { isHttpUrl, parseHttpUrl } from '../util/url.ts'
import { modelCapabilitiesSchema, modelCostSchema, reasoningEffortListSchema } from './models.ts'

// ---------- shared field schemas ----------

/** Credential field key and settings key: `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`. */
export const fieldKeySchema = z.string().regex(FIELD_KEY_PATTERN, 'Keys start with a letter and use up to 64 characters of a-z, A-Z, 0-9 and "_".')

/** Absolute http(s) URL without credentials. */
export const httpUrlSchema = z.string().refine(isHttpUrl, 'Expected an absolute http:// or https:// URL without credentials.')

/** HTTP header name (RFC 7230 token). */
export const httpHeaderNameSchema = z.string().regex(HTTP_HEADER_NAME_PATTERN, 'Invalid HTTP header name.')

/** Environment variable name. */
export const envVarNameSchema = z.string().regex(ENV_VAR_NAME_PATTERN, 'Invalid environment variable name.')

/** HTTP header value: no control characters other than tab (no header injection). */
export const httpHeaderValueSchema = z
  .string()
  .max(8192)
  .refine(value => !hasControlChars(value, true), 'Header values cannot contain control characters.')

/** `lobe:<slug>` icon reference. */
export const LOBE_ICON_PATTERN = /^lobe:[\da-z-]{1,64}$/
export const lobeIconRefSchema = z.string().regex(LOBE_ICON_PATTERN, 'Expected "lobe:<slug>".')

// ---------- credential fields ----------

/** One field of a provider's key dialog. */
export const credentialFieldSchema = z
  .strictObject({
    key: fieldKeySchema,
    label: z.string().trim().min(1).max(100),
    type: credentialFieldTypeSchema,
    /** Default false. */
    required: z.boolean().optional(),
    default: z.string().max(LIMITS.credentialValueMaxChars).optional(),
    /** Required for `select`. */
    options: z.array(z.string().min(1).max(200)).min(1).max(100).optional(),
    /** Env fallback names, first non-empty wins (builtin and code plugins only). */
    envVar: z.union([envVarNameSchema, z.array(envVarNameSchema).min(1).max(8)]).optional(),
    /** "Where do I get this" link. */
    helpUrl: httpUrlSchema.optional(),
    /** Rendered in the "Advanced" section. */
    advanced: z.boolean().optional(),
  })
  .superRefine((field, ctx) => {
    if (field.type === 'select') {
      if (!field.options)
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'Select fields need "options".' })
      else if (!isUnique(field.options))
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'Options must be unique.' })
      if (field.default !== undefined && field.options && !field.options.includes(field.default))
        ctx.addIssue({ code: 'custom', path: ['default'], message: 'The default must be one of the options.' })
    }
    if (field.type === 'secret' && field.default !== undefined)
      ctx.addIssue({ code: 'custom', path: ['default'], message: 'Secret fields cannot have a default.' })
    if (field.type === 'url' && field.default !== undefined && !isHttpUrl(field.default))
      ctx.addIssue({ code: 'custom', path: ['default'], message: 'The default must be an absolute http:// or https:// URL.' })
  })
export type CredentialField = z.infer<typeof credentialFieldSchema>

// ---------- model info ----------

/** A model contributed by a provider or plugin (seed, listing, manifest, `ctx.models.register`). */
export const modelInfoSchema = z.strictObject({
  /** Model id sent to the API; unique per provider; may contain `:` and `/`. */
  id: modelIdSchema,
  /** Display name (default: id). */
  name: z.string().trim().min(1).max(256).optional(),
  /**
   * Default `chat`; other kinds are hidden from the chat picker (`image` models are shown when the provider defines
   * `createImageModel`; `transcription` / `speech` models serve dictation and read-aloud).
   */
  kind: modelKindSchema.optional(),
  contextWindow: z.int().positive().optional(),
  maxOutputTokens: z.int().positive().optional(),
  capabilities: modelCapabilitiesSchema.partial().optional(),
  /** Efforts offered besides `auto`; when omitted on a reasoning model: off, low, medium, high. */
  reasoningEfforts: reasoningEffortListSchema.optional(),
  /** USD per 1M tokens. */
  cost: modelCostSchema.optional(),
  /** `speech` models: voice names to suggest (unique, <= 100; ADR-029). */
  voices: z.array(z.string().min(1).max(64)).max(100).refine(isUnique, 'Voices must be unique.').optional(),
})
export type ModelInfo = z.infer<typeof modelInfoSchema>

/** A list of models with unique ids. */
export const modelInfoListSchema = z.array(modelInfoSchema).max(5000).superRefine((models, ctx) => {
  const ids = models.map(model => model.id)
  for (const id of duplicates(ids))
    ctx.addIssue({ code: 'custom', path: [ids.lastIndexOf(id), 'id'], message: `Duplicate model id "${id}".` })
})

// ---------- templating ----------

const TEMPLATE = /\{\{([^{}]*)\}\}/g

/** Keys referenced by `{{<prefix>.<key>}}` placeholders, or `null` when a placeholder or brace is malformed. */
export function templateKeys(value: string, prefix: 'credentials' | 'settings'): string[] | null {
  const keys: string[] = []
  let malformed = false
  const rest = value.replace(TEMPLATE, (_match, inner: string) => {
    const dot = inner.indexOf('.')
    const key = inner.slice(dot + 1)
    if (dot < 0 || inner.slice(0, dot) !== prefix || !FIELD_KEY_PATTERN.test(key))
      malformed = true
    else
      keys.push(key)
    return ''
  })
  if (malformed || rest.includes('{{') || rest.includes('}}'))
    return null
  return keys
}

/** A string that may contain `{{settings.<key>}}` placeholders (MCP server declarations). */
const settingsTemplatedSchema = z
  .string()
  .max(8192)
  .refine(value => templateKeys(value, 'settings') !== null, 'Only "{{settings.<key>}}" placeholders are allowed.')

/** An http(s) URL that may contain `{{settings.<key>}}` placeholders. */
const settingsTemplatedUrlSchema = settingsTemplatedSchema.refine(
  value => isHttpUrl(value.replace(TEMPLATE, 'x')),
  'Expected an absolute http:// or https:// URL.',
)

/** A header value that may contain `{{settings.<key>}}` placeholders. */
const settingsTemplatedHeaderValueSchema = settingsTemplatedSchema.refine(
  value => !hasControlChars(value, true),
  'Header values cannot contain control characters.',
)

// ---------- declarative commands ----------

/** A slash command whose `{{input}}` placeholders are replaced with the text after `/name `. */
export const declarativeCommandSchema = z.strictObject({
  name: commandNameSchema
    .refine(
      name => !isClientCommand(name),
      `Reserved client-only command (${CLIENT_COMMANDS.map(name => `/${name}`).join(', ')}).`,
    )
    .refine(
      name => !isHarnessCommand(name),
      `Reserved harness command (${HARNESS_COMMANDS.map(name => `/${name}`).join(', ')}).`,
    ),
  description: z.string().trim().min(1).max(120),
  template: z
    .string()
    .min(1)
    .refine(value => utf8ByteLength(value) <= LIMITS.commandTemplateBytes, 'Templates are limited to 16 KB.'),
})
export type DeclarativeCommand = z.infer<typeof declarativeCommandSchema>

// ---------- declarative agents and skills (plugin API 1.4.0, ADR-045) ----------

/** A tool of an agent's `tools` list: a tool name, or a `mcp__<server>__*` prefix (only ever a restriction). */
export const TOOL_ALLOWLIST_ENTRY_PATTERN = /^(?:[\w-]{1,64}|mcp__[\w-]{1,58}\*)$/

/** Markdown of at most 64 KiB of UTF-8 (agent instructions, skill content). */
const definitionBodySchema = z
  .string()
  .min(1)
  .refine(value => utf8ByteLength(value) <= LIMITS.customizationContentBytes, 'Limited to 64 KB.')

/**
 * An agent type contributed by a plugin (`contributes.agents`, `ctx.agents.register`): the same fields as an agent file
 * (ADR-045). The builtin types and their aliases are reserved; a name another plugin registered is a `conflict`.
 */
export const declarativeAgentSchema = z.strictObject({
  name: agentNameSchema.refine(
    name => !isReservedAgentName(name),
    `Reserved agent type (${BUILTIN_AGENT_TYPES.join(', ')}, general-purpose).`,
  ),
  /** When to use the agent (shown to the model and in the UI). */
  description: z.string().trim().min(1).max(LIMITS.customizationDescriptionMaxChars),
  /** The child's instructions (after the sub-agent preamble). */
  instructions: definitionBodySchema,
  /** Narrows the child's tools (never widens the ADR-043 ceiling); omitted = every tool the parent's mode allows. */
  tools: z
    .array(z.string().regex(TOOL_ALLOWLIST_ENTRY_PATTERN, 'Use tool names (or an "mcp__<server>__*" prefix).'))
    .max(64)
    .refine(isUnique, 'Tools must be unique.')
    .optional(),
  /** `provider:model`, or `inherit` (the parent run's model); omitted = the sub-agent model setting. */
  model: z.union([modelRefSchema, z.literal('inherit')]).optional(),
})
export type DeclarativeAgent = z.infer<typeof declarativeAgentSchema>

/** A skill contributed by a plugin (`contributes.skills`, `ctx.skills.register`): listed to the model, loaded by `skill`. */
export const declarativeSkillSchema = z.strictObject({
  name: agentNameSchema,
  /** When to use the skill (shown to the model and in the UI). */
  description: z.string().trim().min(1).max(LIMITS.customizationDescriptionMaxChars),
  /** The skill body (Markdown). */
  content: definitionBodySchema,
  /**
   * Plugin API 1.6.0 (ADR-053): the plugin-relative folder of the skill's supporting files (`skills/pdf`); the `skill`
   * tool lists them and reads one with `file` (inside that folder only).
   */
  baseDir: z.string().refine(isSafeRelativePath, 'Use a relative folder inside the plugin (segments of A-Z, a-z, 0-9, ".", "_", "-").').optional(),
})
export type DeclarativeSkill = z.infer<typeof declarativeSkillSchema>

// ---------- declarative output styles (plugin API 1.5.0, ADR-051) ----------

/**
 * An output style contributed by a plugin (`contributes.outputStyles`, `ctx.outputStyles.register`): the fields of a
 * style file (ADR-051). The builtin style names (`default`, `explanatory`, `learning`) are reserved; a name another
 * plugin registered is a `conflict`.
 */
export const declarativeOutputStyleSchema = z.strictObject({
  name: agentNameSchema.refine(
    name => !(BUILTIN_OUTPUT_STYLE_NAMES as readonly string[]).includes(name),
    `Reserved output style (${BUILTIN_OUTPUT_STYLE_NAMES.join(', ')}).`,
  ),
  /** What the style does (shown in the style menu). */
  description: z.string().trim().min(1).max(LIMITS.customizationDescriptionMaxChars),
  /** The style body (Markdown): added first to the main agent's instructions while the style is active. */
  content: definitionBodySchema,
  /** Keep the workspace tool rules and the todo / task hints (default false). */
  keepCodingInstructions: z.boolean().optional(),
})
export type DeclarativeOutputStyle = z.infer<typeof declarativeOutputStyleSchema>

// ---------- MCP server declarations ----------

export const mcpServerDeclSchema = z.strictObject({
  /** `<pluginId>` or `<pluginId>-<suffix>` (checked by the manifest schema). */
  id: mcpServerIdSchema,
  /** Shown as the MCP server badge on tool rows. */
  name: z.string().trim().min(1).max(64),
  /** Policy of tools without annotations; default `ask`. */
  policy: toolPolicySchema.optional(),
  transport: z.discriminatedUnion('type', [
    z.strictObject({
      type: z.enum(['http', 'sse']),
      url: settingsTemplatedUrlSchema,
      headers: z.record(httpHeaderNameSchema, settingsTemplatedHeaderValueSchema).optional(),
    }),
    z.strictObject({
      type: z.literal('stdio'),
      /** Not templated; spawned without a shell. */
      command: z
        .string()
        .trim()
        .min(1)
        .max(4096)
        .refine(value => !value.includes('{{') && !hasControlChars(value), 'The command cannot contain placeholders or control characters.'),
      args: z.array(settingsTemplatedSchema).max(256).optional(),
      env: z.record(envVarNameSchema, settingsTemplatedSchema).optional(),
    }),
  ]),
})
export type McpServerDecl = z.infer<typeof mcpServerDeclSchema>

/** `{{settings.<key>}}` keys referenced by an MCP server declaration (url, header values, args, env values). */
export function mcpServerDeclSettingsKeys(server: McpServerDecl): string[] {
  const values = server.transport.type === 'stdio'
    ? [...(server.transport.args ?? []), ...Object.values(server.transport.env ?? {})]
    : [server.transport.url, ...Object.values(server.transport.headers ?? {})]
  return [...new Set(values.flatMap(value => templateKeys(value, 'settings') ?? []))]
}

// ---------- declarative providers ----------

/** Auth of a declarative provider: `bearer` (Authorization: Bearer), `header` (custom header) or `none`. */
export const declarativeAuthSchema = z
  .strictObject({
    type: z.enum(['bearer', 'header', 'none']),
    /** Required with `type: 'header'`, forbidden otherwise. */
    header: httpHeaderNameSchema.optional(),
  })
  .superRefine((auth, ctx) => {
    if (auth.type === 'header' && auth.header === undefined)
      ctx.addIssue({ code: 'custom', path: ['header'], message: '"header" is required with type "header".' })
    if (auth.type !== 'header' && auth.header !== undefined)
      ctx.addIssue({ code: 'custom', path: ['header'], message: '"header" is only allowed with type "header".' })
  })
export type DeclarativeAuth = z.infer<typeof declarativeAuthSchema>

const regexSourceSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(value => compileRegExp(value, 'i') !== null, 'Invalid regular expression.')

/** Live model listing: `true` (default, `GET {baseURL}/models`), `false`, or a custom path with id filters. */
export const declarativeListModelsSchema = z.union([
  z.boolean(),
  z.strictObject({
    /** Path starting with `/` appended to `baseURL`, or an absolute URL with the same origin as `baseURL`. */
    path: z.string().min(1).max(2048).optional(),
    /** Regular expression source tested against model ids (flag `i`). */
    include: regexSourceSchema.optional(),
    /** Regular expression source tested against model ids (flag `i`); wins over `include`. */
    exclude: regexSourceSchema.optional(),
  }),
])
export type DeclarativeListModels = z.infer<typeof declarativeListModelsSchema>

/** Default `auth` per `apiFormat` (PLUGINS.md section 4). */
export const DECLARATIVE_AUTH_DEFAULTS = {
  'openai-chat': { type: 'bearer' },
  'openai-responses': { type: 'bearer' },
  'anthropic': { type: 'header', header: 'x-api-key' },
  'google': { type: 'header', header: 'x-goog-api-key' },
} as const satisfies Record<z.infer<typeof apiFormatSchema>, DeclarativeAuth>

/** Default `credentials` of a declarative provider whose auth is not `none`. */
export const DEFAULT_DECLARATIVE_CREDENTIALS = [
  { key: 'apiKey', label: 'API key', type: 'secret', required: true },
] as const satisfies readonly CredentialField[]

/** Header names a declarative provider cannot set (compared case-insensitively). */
export const FORBIDDEN_PROVIDER_HEADERS = ['host', 'content-length', 'connection', 'transfer-encoding', 'cookie'] as const

/** The `reasoningStyle` values allowed per `apiFormat` (`none` is always allowed). */
export const REASONING_STYLES_BY_API_FORMAT = {
  'openai-chat': ['openai-effort', 'none'],
  'openai-responses': ['openai-effort', 'none'],
  'anthropic': ['anthropic-thinking', 'none'],
  'google': ['google-thinking', 'none'],
} as const satisfies Record<z.infer<typeof apiFormatSchema>, readonly z.infer<typeof reasoningStyleSchema>[]>

/** Header sent by an auth style, lowercase (`null` for `none`). */
function authHeaderName(auth: DeclarativeAuth): string | null {
  if (auth.type === 'none')
    return null
  return auth.type === 'bearer' ? 'authorization' : (auth.header ?? '').toLowerCase()
}

/** Absolute http(s) base URL without credentials, query or fragment. */
const baseUrlSchema = z
  .string()
  .refine(
    value => parseHttpUrl(value, { query: false, fragment: false }) !== null,
    'Expected an absolute http:// or https:// URL without credentials, query or fragment.',
  )

/** An HTTP API in one of four wire formats turned into a provider without code (PLUGINS.md section 4). */
export const declarativeProviderSchema = z
  .strictObject({
    /** `<pluginId>` or `<pluginId>-<suffix>` (checked by the manifest schema). */
    id: providerIdSchema,
    name: z.string().trim().min(1).max(64),
    /** `lobe:<slug>` only; default: the plugin icon. */
    icon: lobeIconRefSchema.optional(),
    /** A trailing `/` is ignored. */
    baseURL: baseUrlSchema,
    apiFormat: apiFormatSchema,
    /** Default per `apiFormat` (`DECLARATIVE_AUTH_DEFAULTS`). */
    auth: declarativeAuthSchema.optional(),
    /** Default `DEFAULT_DECLARATIVE_CREDENTIALS` (`[]` when `auth.type` is `none`); `envVar` is not allowed. */
    credentials: z.array(credentialFieldSchema).max(20).optional(),
    /** Extra request headers; values may contain `{{credentials.<key>}}`. */
    headers: z.record(httpHeaderNameSchema, httpHeaderValueSchema).optional(),
    /** Always listed for this provider. */
    models: modelInfoListSchema.optional(),
    /** Default `true`. */
    listModels: declarativeListModelsSchema.optional(),
    /** Default `none`. */
    reasoningStyle: reasoningStyleSchema.optional(),
    /** models.dev provider key (default: the provider id). */
    modelsDevId: z.string().trim().min(1).max(64).optional(),
    /** Cheap model for chat titles and the 1-token credential test. */
    smallModelId: modelIdSchema.optional(),
  })
  .superRefine((provider, ctx) => {
    const credentials = provider.credentials
    if (credentials) {
      const keys = credentials.map(field => field.key)
      for (const key of duplicates(keys))
        ctx.addIssue({ code: 'custom', path: ['credentials', keys.lastIndexOf(key), 'key'], message: `Duplicate credential key "${key}".` })
      credentials.forEach((field, index) => {
        if (field.envVar !== undefined)
          ctx.addIssue({ code: 'custom', path: ['credentials', index, 'envVar'], message: '"envVar" is not allowed in declarative providers.' })
      })
    }

    const resolved = applyDeclarativeProviderDefaults(provider)
    if (resolved.auth.type !== 'none' && !resolved.credentials.some(field => field.key === 'apiKey')) {
      ctx.addIssue({ code: 'custom', path: ['credentials'], message: `Auth "${resolved.auth.type}" needs a credential field with key "apiKey".` })
    }

    const authHeader = authHeaderName(resolved.auth)
    const credentialKeys = new Set(resolved.credentials.map(field => field.key))
    for (const [name, value] of Object.entries(provider.headers ?? {})) {
      const lower = name.toLowerCase()
      if ((FORBIDDEN_PROVIDER_HEADERS as readonly string[]).includes(lower))
        ctx.addIssue({ code: 'custom', path: ['headers', name], message: `The header "${name}" cannot be set.` })
      else if (lower === authHeader)
        ctx.addIssue({ code: 'custom', path: ['headers', name], message: `The header "${name}" is set by "auth".` })
      const keys = templateKeys(value, 'credentials')
      if (keys === null) {
        ctx.addIssue({ code: 'custom', path: ['headers', name], message: 'Only "{{credentials.<key>}}" placeholders are allowed.' })
      }
      else {
        for (const key of keys) {
          if (!credentialKeys.has(key))
            ctx.addIssue({ code: 'custom', path: ['headers', name], message: `Unknown credential "${key}".` })
        }
      }
    }

    if (typeof provider.listModels === 'object' && provider.listModels.path !== undefined) {
      const path = provider.listModels.path
      const base = parseHttpUrl(provider.baseURL, { query: false, fragment: false })
      const absolute = path.startsWith('/') ? null : parseHttpUrl(path)
      if (!path.startsWith('/') && (!absolute || !base || absolute.origin !== base.origin))
        ctx.addIssue({ code: 'custom', path: ['listModels', 'path'], message: 'Use a path starting with "/" or an absolute URL with the same origin as baseURL.' })
    }

    const styles: readonly string[] = REASONING_STYLES_BY_API_FORMAT[provider.apiFormat]
    if (provider.reasoningStyle !== undefined && !styles.includes(provider.reasoningStyle))
      ctx.addIssue({ code: 'custom', path: ['reasoningStyle'], message: `Reasoning style "${provider.reasoningStyle}" does not fit apiFormat "${provider.apiFormat}".` })
  })
export type DeclarativeProvider = z.infer<typeof declarativeProviderSchema>

/** A declarative provider with every PLUGINS.md default applied. */
export interface ResolvedDeclarativeProvider extends DeclarativeProvider {
  /** Without a trailing `/`. */
  baseURL: string
  auth: DeclarativeAuth
  credentials: CredentialField[]
  headers: Record<string, string>
  models: ModelInfo[]
  listModels: DeclarativeListModels
  reasoningStyle: z.infer<typeof reasoningStyleSchema>
  modelsDevId: string
}

/** Applies the defaults of PLUGINS.md section 4 (auth, credentials, headers, models, listing, reasoning style). */
export function applyDeclarativeProviderDefaults(provider: DeclarativeProvider): ResolvedDeclarativeProvider {
  const auth: DeclarativeAuth = provider.auth ?? { ...DECLARATIVE_AUTH_DEFAULTS[provider.apiFormat] }
  return {
    ...provider,
    baseURL: provider.baseURL.replace(/\/+$/, ''),
    auth,
    credentials: provider.credentials ?? (auth.type === 'none' ? [] : DEFAULT_DECLARATIVE_CREDENTIALS.map(field => ({ ...field }))),
    headers: provider.headers ?? {},
    models: provider.models ?? [],
    listModels: provider.listModels ?? true,
    reasoningStyle: provider.reasoningStyle ?? 'none',
    modelsDevId: provider.modelsDevId ?? provider.id,
  }
}
