// Declarative adapter (PLUGINS.md 4-6). Owner: W1.3 (W1.3-T6).
//
// `createDeclarativeProvider()` turns a `DeclarativeProvider` of a manifest into a `ProviderDefinition`:
//   openai-chat      -> createOpenAICompatible({ name, baseURL, fetch, includeUsage: true }).chatModel(id)
//   openai-responses -> createOpenAI({ name, baseURL, apiKey, fetch }).responses(id)
//   anthropic        -> createAnthropic({ name, baseURL, apiKey, fetch })(id)
//   google           -> createGoogleGenerativeAI({ name, baseURL, apiKey, fetch })(id)
// Security rules (normative): credentials are always passed explicitly, so no SDK environment fallback
// (`OPENAI_API_KEY`, `ANTHROPIC_BASE_URL`, ...) ever applies to a plugin provider. The SDKs receive a non-secret
// placeholder key; the fetch wrapper removes every header carrying the placeholder and sets the real auth header
// (`bearer`, a custom `header`, or nothing) and the templated `headers` itself, so the wire format is exactly the
// declared one. Provider requests go through `rt.fetch` (same-origin redirects only).
//
// `registerDeclaredContributions()` registers a manifest's `contributes` through the plugin's own `ctx`: providers
// (+ their `models`), `models`, MCP server declarations, template commands, (plugin API 1.4.0, ADR-045) agent types
// and skills, and (plugin API 1.5.0, ADR-051) output styles. A command, agent, skill or output style whose name another
// plugin already registered is skipped and logged (`warn`), as PLUGINS.md 6 specifies; every other failure fails the
// load. The command hooks of 1.5.0 (`contributes.hooks`, ADR-048) have no `ctx` API: the host passes
// `DeclaredContributionHost.registerHookCommands` (its runtime's), which registers them in `registry.hookCommands` with
// the plugin folder as the root. The host loads such a plugin only while it is trusted (`manifestRequiresTrust`), so an
// untrusted plugin never gets here; the trust pin covers `plugin.json` only (scripts a hook calls are not pinned).
// Plugin API 1.6.0 (ADR-053, ADR-057; W12.1): `contributes.skills[].baseDir` is passed on, and the prompt handlers of
// `contributes.hooks` register with the command handlers (the registry reads them with prompts on; a plugin with
// prompt-only hooks needs no trust). Claude Code plugins never come here: `plugins/claude/register.ts` registers them.
import type {
  DeclarativeProvider,
  Disposable,
  HooksConfig,
  ModelInfo,
  PluginContext,
  PluginManifest,
  ProviderDefinition,
  ProviderRuntime,
  ReasoningEffort,
  ReasoningParams,
} from '@harness-forge/plugin-sdk'
import type { ResolvedDeclarativeProvider } from '@harness-forge/shared'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { APICallError } from '@ai-sdk/provider'
import {
  applyDeclarativeProviderDefaults,
  countHookHandlers,
  declarativeProviderSchema,
  isHarnessError,
  modelInfoSchema,
  validationError,
} from '@harness-forge/shared'

/** Sent to the SDKs instead of a key; every header containing it is removed before the request leaves. */
export const PLACEHOLDER_API_KEY = 'harness-forge-no-key'

/** Timeout of one model listing request. */
export const LISTING_TIMEOUT_MS = 15_000
/** Pages followed by paginated listings (`anthropic`, `google`). */
export const LISTING_MAX_PAGES = 10
/** Models kept from one listing. */
export const LISTING_MAX_MODELS = 5000

// ---------- headers ----------

const TEMPLATE = /\{\{credentials\.([a-z]\w{0,63})\}\}/gi

/** Credential value of `key`: resolved value (stored -> default) or the field default. */
function credentialValue(provider: ResolvedDeclarativeProvider, rt: ProviderRuntime, key: string): string {
  const value = rt.credentials[key]
  if (typeof value === 'string' && value !== '')
    return value
  return provider.credentials.find(field => field.key === key)?.default ?? ''
}

/**
 * Extra headers resolved for one request: each `{{credentials.<key>}}` is replaced by its value; a header with any
 * empty referenced value is omitted.
 */
export function resolveTemplatedHeaders(provider: ResolvedDeclarativeProvider, rt: ProviderRuntime): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, template] of Object.entries(provider.headers)) {
    let empty = false
    const value = template.replace(TEMPLATE, (_match, key: string) => {
      const resolved = credentialValue(provider, rt, key)
      if (resolved === '')
        empty = true
      return resolved
    })
    if (!empty)
      headers[name] = value
  }
  return headers
}

/** The header sent by `auth` with the resolved `apiKey`, or null (`none`, or an empty optional key). */
export function authHeader(provider: ResolvedDeclarativeProvider, rt: ProviderRuntime): [string, string] | null {
  if (provider.auth.type === 'none')
    return null
  const key = credentialValue(provider, rt, 'apiKey').trim()
  if (key === '')
    return null
  return provider.auth.type === 'bearer' ? ['Authorization', `Bearer ${key}`] : [provider.auth.header ?? 'x-api-key', key]
}

/** Every header of a provider request: templated headers first, auth last (validation keeps them disjoint). */
export function providerHeaders(provider: ResolvedDeclarativeProvider, rt: ProviderRuntime): Record<string, string> {
  const headers = resolveTemplatedHeaders(provider, rt)
  const auth = authHeader(provider, rt)
  if (auth)
    headers[auth[0]] = auth[1]
  return headers
}

/** `fetch` that removes placeholder headers and sets `headers` (replacing SDK defaults of the same name). */
export function withProviderHeaders(fetchImpl: typeof globalThis.fetch, headers: Record<string, string>): typeof globalThis.fetch {
  return async (input, init) => {
    const merged = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, name) => merged.set(name, value))
    for (const [name, value] of [...merged]) {
      if (value.includes(PLACEHOLDER_API_KEY))
        merged.delete(name)
    }
    for (const [name, value] of Object.entries(headers))
      merged.set(name, value)
    return fetchImpl(input, { ...init, headers: merged })
  }
}

// ---------- reasoning (PLUGINS.md 4 "reasoningStyle") ----------

type Effort = Exclude<ReasoningEffort, 'auto'>

const EFFORT_LEVELS = { off: 'none', low: 'low', medium: 'medium', high: 'high', max: 'xhigh' } as const satisfies Record<Effort, string>
const THINKING_BUDGETS = { low: 2048, medium: 8192, high: 16_384, max: 32_768 } as const

/** The effort -> request mapping of a declarative provider, or undefined for `reasoningStyle: 'none'`. */
export function declarativeReasoning(provider: ResolvedDeclarativeProvider): ProviderDefinition['reasoning'] {
  switch (provider.reasoningStyle) {
    case 'none':
      return undefined
    case 'openai-effort':
      return (effort): ReasoningParams | undefined => {
        if (effort === 'auto')
          return undefined
        const params: ReasoningParams = { reasoning: EFFORT_LEVELS[effort] }
        if (provider.apiFormat === 'openai-responses') {
          // `@ai-sdk/openai` sends `reasoning.effort` only for ids it knows as reasoning models; `forceReasoning` marks
          // any id as one. Its options key is `azure` when the provider name contains "azure".
          params.providerOptions = { openai: { forceReasoning: true } }
          if (provider.id.includes('azure'))
            params.providerOptions.azure = { forceReasoning: true }
        }
        return params
      }
    case 'anthropic-thinking':
      return (effort): ReasoningParams | undefined => {
        if (effort === 'auto')
          return undefined
        const thinking = effort === 'off'
          ? { type: 'disabled' }
          : { type: 'enabled', budgetTokens: THINKING_BUDGETS[effort] }
        return { providerOptions: { anthropic: { thinking } } }
      }
    case 'google-thinking':
      return (effort): ReasoningParams | undefined => {
        if (effort === 'auto')
          return undefined
        if (effort === 'off')
          return { reasoning: 'none' }
        return { reasoning: EFFORT_LEVELS[effort], providerOptions: { google: { thinkingConfig: { includeThoughts: true } } } }
      }
  }
}

// ---------- model listing (PLUGINS.md 4 "listModels") ----------

type ListingShape = 'data' | 'models' | 'array'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '')
      return value.trim()
  }
  return undefined
}

function positiveIntField(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
      return value
  }
  return undefined
}

function kindOf(type: unknown): ModelInfo['kind'] | undefined {
  if (typeof type !== 'string')
    return undefined
  switch (type.toLowerCase()) {
    case 'chat':
    case 'language':
    case 'text':
      return 'chat'
    case 'embedding':
    case 'embeddings':
      return 'embedding'
    case 'image':
      return 'image'
    case 'audio':
    case 'tts':
    case 'stt':
    case 'transcribe':
      return 'audio'
    default:
      return 'other'
  }
}

/** The items of a listing response and their shape (first matching shape wins), or null for an unknown shape. */
export function listingItems(body: unknown): { shape: ListingShape, items: unknown[] } | null {
  if (Array.isArray(body))
    return { shape: 'array', items: body }
  if (isRecord(body)) {
    if (Array.isArray(body.data))
      return { shape: 'data', items: body.data }
    if (Array.isArray(body.models))
      return { shape: 'models', items: body.models }
  }
  return null
}

/** One listed model as `ModelInfo`, or undefined when it has no usable id or is not a generation model (Google). */
export function listedModel(shape: ListingShape, item: unknown): ModelInfo | undefined {
  if (typeof item === 'string')
    return shape === 'array' && item.trim() !== '' ? { id: item.trim() } : undefined
  if (!isRecord(item))
    return undefined
  let id: string | undefined
  if (shape === 'models') {
    const methods = item.supportedGenerationMethods
    if (Array.isArray(methods) && !methods.includes('generateContent'))
      return undefined
    id = stringField(item, ['name'])?.replace(/^models\//, '') ?? stringField(item, ['id'])
  }
  else {
    id = stringField(item, ['id'])
  }
  if (id === undefined)
    return undefined
  const model: ModelInfo = { id }
  const name = stringField(item, shape === 'models' ? ['display_name', 'displayName'] : ['display_name', 'displayName', 'name'])
  if (name !== undefined && name !== id)
    model.name = name.slice(0, 256)
  const contextWindow = positiveIntField(item, ['context_length', 'context_window', 'max_context_length', 'inputTokenLimit', 'max_input_tokens'])
  if (contextWindow !== undefined)
    model.contextWindow = contextWindow
  const maxOutputTokens = positiveIntField(item, ['max_output_tokens', 'max_completion_tokens', 'outputTokenLimit', 'max_tokens'])
  if (maxOutputTokens !== undefined)
    model.maxOutputTokens = maxOutputTokens
  const kind = kindOf(item.type)
  if (kind !== undefined)
    model.kind = kind
  return modelInfoSchema.safeParse(model).success ? model : undefined
}

/** The listing URL: `path` (default `/models`) appended to the base URL, or an absolute same-origin URL. */
export function listingUrl(provider: ResolvedDeclarativeProvider): string {
  const path = typeof provider.listModels === 'object' ? provider.listModels.path ?? '/models' : '/models'
  return path.startsWith('/') ? `${provider.baseURL}${path}` : path
}

function compileFilter(source: string | undefined): RegExp | null {
  if (source === undefined)
    return null
  try {
    return new RegExp(source, 'i')
  }
  catch {
    return null
  }
}

async function readJson(response: Response, url: string): Promise<unknown> {
  const text = await response.text()
  if (!response.ok) {
    const headers: Record<string, string> = {}
    response.headers.forEach((value, name) => {
      headers[name] = value
    })
    throw new APICallError({
      message: `Model listing failed with HTTP ${response.status}.`,
      url,
      requestBodyValues: {},
      statusCode: response.status,
      responseHeaders: headers,
      responseBody: text.slice(0, 8192),
      isRetryable: response.status === 408 || response.status === 429 || response.status >= 500,
    })
  }
  try {
    return JSON.parse(text) as unknown
  }
  catch (error) {
    throw new APICallError({ message: 'The model listing is not valid JSON.', url, requestBodyValues: {}, statusCode: response.status, cause: error })
  }
}

/** `GET` the listing (with auth and headers, 15 s per request, format-specific paging) and parse it. */
export async function listDeclarativeModels(provider: ResolvedDeclarativeProvider, rt: ProviderRuntime): Promise<ModelInfo[]> {
  const include = typeof provider.listModels === 'object' ? compileFilter(provider.listModels.include) : null
  const exclude = typeof provider.listModels === 'object' ? compileFilter(provider.listModels.exclude) : null
  const headers = { accept: 'application/json', ...providerHeaders(provider, rt) }
  const base = new URL(listingUrl(provider))
  const models: ModelInfo[] = []
  const seen = new Set<string>()
  let cursor: string | undefined

  for (let page = 0; page < LISTING_MAX_PAGES; page++) {
    const url = new URL(base)
    if (provider.apiFormat === 'anthropic') {
      url.searchParams.set('limit', '1000')
      if (cursor)
        url.searchParams.set('after_id', cursor)
    }
    else if (provider.apiFormat === 'google') {
      url.searchParams.set('pageSize', '1000')
      if (cursor)
        url.searchParams.set('pageToken', cursor)
    }
    const signals = [AbortSignal.timeout(LISTING_TIMEOUT_MS), ...(rt.signal ? [rt.signal] : [])]
    const href = url.toString()
    const response = await rt.fetch(href, { method: 'GET', headers, signal: AbortSignal.any(signals) })
    const body = await readJson(response, href)
    const listing = listingItems(body)
    if (!listing)
      throw new Error(`${provider.name} returned an unexpected model list.`)
    for (const item of listing.items) {
      const model = listedModel(listing.shape, item)
      if (!model || seen.has(model.id))
        continue
      if (exclude?.test(model.id) || (include !== null && !include.test(model.id)))
        continue
      seen.add(model.id)
      models.push(model)
      if (models.length >= LISTING_MAX_MODELS)
        return models
    }
    cursor = undefined
    if (provider.apiFormat === 'anthropic' && isRecord(body) && body.has_more === true && typeof body.last_id === 'string')
      cursor = body.last_id
    if (provider.apiFormat === 'google' && isRecord(body) && typeof body.nextPageToken === 'string' && body.nextPageToken !== '')
      cursor = body.nextPageToken
    if (!cursor)
      break
  }
  return models
}

// ---------- provider definition ----------

export interface DeclarativeProviderOptions {
  /** The manifest icon, used when the provider declares none and it is a `lobe:` reference. */
  manifestIcon?: string
}

/** Validates (`declarativeProviderSchema`) and applies the defaults of PLUGINS.md 4; throws `validation_error`. */
export function resolveDeclarativeProvider(provider: DeclarativeProvider): ResolvedDeclarativeProvider {
  const parsed = declarativeProviderSchema.safeParse(provider)
  if (!parsed.success)
    throw validationError(parsed.error)
  return applyDeclarativeProviderDefaults(parsed.data)
}

/** The `ProviderDefinition` of a declarative provider (not registered). */
export function createDeclarativeProvider(provider: DeclarativeProvider, options: DeclarativeProviderOptions = {}): ProviderDefinition {
  const resolved = resolveDeclarativeProvider(provider)
  const icon = resolved.icon ?? (options.manifestIcon?.startsWith('lobe:') ? options.manifestIcon : undefined)
  const keyUrl = resolved.credentials.find(field => field.key === 'apiKey')?.helpUrl
  const reasoning = declarativeReasoning(resolved)

  const definition: ProviderDefinition = {
    id: resolved.id,
    name: resolved.name,
    credentials: resolved.credentials.map(field => ({ ...field })),
    modelsDevId: resolved.modelsDevId,
    createLanguageModel(modelId, rt) {
      const fetch = withProviderHeaders(rt.fetch, providerHeaders(resolved, rt))
      const common = { name: resolved.id, baseURL: resolved.baseURL, fetch }
      switch (resolved.apiFormat) {
        case 'openai-chat':
          return createOpenAICompatible({ ...common, includeUsage: true }).chatModel(modelId)
        case 'openai-responses':
          return createOpenAI({ ...common, apiKey: PLACEHOLDER_API_KEY }).responses(modelId)
        case 'anthropic':
          return createAnthropic({ ...common, apiKey: PLACEHOLDER_API_KEY })(modelId)
        case 'google':
          return createGoogleGenerativeAI({ ...common, apiKey: PLACEHOLDER_API_KEY })(modelId)
      }
    },
  }
  if (icon !== undefined)
    definition.icon = icon
  if (resolved.smallModelId !== undefined)
    definition.smallModelId = resolved.smallModelId
  if (keyUrl !== undefined)
    definition.keyUrl = keyUrl
  if (resolved.listModels !== false)
    definition.listModels = rt => listDeclarativeModels(resolved, rt)
  if (reasoning !== undefined)
    definition.reasoning = reasoning
  return definition
}

// ---------- contributions of a manifest ----------

/** Runs one registration; a `conflict` (the name is taken by another plugin) is logged as skipped instead of thrown. */
function registerOrSkip(ctx: PluginContext, what: string, register: () => void): void {
  try {
    register()
  }
  catch (error) {
    if (!isHarnessError(error) || error.code !== 'conflict')
      throw error
    ctx.logger.warn(`${what} was skipped: ${error.message}`)
  }
}

/** Host-only registrations of manifest contributions that have no `ctx` API (`PluginRuntime`'s). */
export interface DeclaredContributionHost {
  /** Plugin API 1.5.0: registers `contributes.hooks` in `registry.hookCommands` (owned by the plugin). */
  readonly registerHookCommands: (hooks: HooksConfig) => Disposable
}

/**
 * Registers `manifest.contributes` through `ctx` (so the plugin's `DisposableStore` removes everything on disable):
 * providers and their models, models for other providers, MCP server declarations, template commands, agent types,
 * skills and output styles, and through `host` the command hooks (only when it declares at least one handler; without a
 * `host` they are not registered). A duplicate command, agent, skill or output style is skipped with a `warn` log
 * entry; other failures throw and fail the load.
 */
export function registerDeclaredContributions(ctx: PluginContext, manifest: PluginManifest, host?: DeclaredContributionHost): void {
  const contributes = manifest.contributes
  if (!contributes)
    return
  for (const provider of contributes.providers ?? []) {
    ctx.providers.register(createDeclarativeProvider(provider, { manifestIcon: manifest.icon }))
    if (provider.models && provider.models.length > 0)
      ctx.models.register(provider.id, provider.models)
  }
  for (const entry of contributes.models ?? [])
    ctx.models.register(entry.providerId, entry.models)
  for (const server of contributes.mcpServers ?? [])
    ctx.mcp.register(server)
  for (const command of contributes.commands ?? []) {
    registerOrSkip(ctx, `The command "/${command.name}"`, () => {
      ctx.commands.register({ name: command.name, description: command.description, template: command.template })
    })
  }
  // Plugin API 1.4.0 (ADR-045). A manifest without these keys (every plugin written for 1.3.0 or older) registers
  // exactly what it did before.
  for (const agent of contributes.agents ?? []) {
    registerOrSkip(ctx, `The agent "${agent.name}"`, () => {
      ctx.agents.register({
        name: agent.name,
        description: agent.description,
        instructions: agent.instructions,
        ...(agent.tools === undefined ? {} : { tools: [...agent.tools] }),
        ...(agent.model === undefined ? {} : { model: agent.model }),
      })
    })
  }
  for (const skill of contributes.skills ?? []) {
    registerOrSkip(ctx, `The skill "${skill.name}"`, () => {
      ctx.skills.register({
        name: skill.name,
        description: skill.description,
        content: skill.content,
        // Plugin API 1.6.0 (ADR-053): the folder of the skill's supporting files (relative to the plugin folder).
        ...(skill.baseDir === undefined ? {} : { baseDir: skill.baseDir }),
      })
    })
  }
  // Plugin API 1.5.0 (ADR-048, ADR-051). A manifest without these keys (every plugin written for 1.4.0 or older)
  // registers exactly what it did before.
  for (const style of contributes.outputStyles ?? []) {
    registerOrSkip(ctx, `The output style "${style.name}"`, () => {
      ctx.outputStyles.register({
        name: style.name,
        description: style.description,
        content: style.content,
        ...(style.keepCodingInstructions === undefined ? {} : { keepCodingInstructions: style.keepCodingInstructions }),
      })
    })
  }
  if (host !== undefined && contributes.hooks !== undefined && countHookHandlers(contributes.hooks) > 0)
    host.registerHookCommands(contributes.hooks as HooksConfig)
}
