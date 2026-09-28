// models.dev metadata (ARCHITECTURE.md 9, ADR-011): the trimmed snapshot format shared by the bundled file
// (`apps/server/assets/catalog/models-dev.json`, written by `scripts/update-catalog.ts`) and the weekly refresh in
// `data/cache/models-dev.json`. Only the fields the catalog uses are kept. This module has no runtime imports so the
// update script can import it directly.

/** Source of the snapshot. */
export const MODELS_DEV_URL = 'https://models.dev/api.json'

/** Snapshot format version (bump on incompatible changes; older files are ignored). */
export const MODELS_DEV_SCHEMA_VERSION = 1

/** Model ids that `classify()` hides when models.dev does not know the model (PROVIDERS.md 3). */
export const NON_CHAT_ID_PATTERN = /embed|tts|whisper|transcri|image|moderation|rerank|audio/i

/**
 * models.dev keys kept in full in the bundled snapshot: the builtin providers (`ollama` has no entry, models.dev only
 * has `ollama-cloud`).
 */
export const BUNDLED_MODELS_DEV_PROVIDERS = [
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
] as const

/**
 * Providers kept partially in the bundled snapshot. The public OpenRouter listing already carries names, limits,
 * capabilities and prices, so only the models whose ids would be misclassified by `NON_CHAT_ID_PATTERN` (chat models
 * such as `google/gemini-2.5-flash-image`) are kept, for their modalities.
 */
export const BUNDLED_MODELS_DEV_PARTIAL: Readonly<Record<string, RegExp>> = { openrouter: NON_CHAT_ID_PATTERN }

/** The metadata of one model (fields absent when unknown). */
export interface ModelsDevModel {
  name?: string
  reasoning?: boolean
  /** models.dev `tool_call`. */
  tools?: boolean
  /** models.dev `structured_output`. */
  structuredOutput?: boolean
  /** models.dev `modalities.input` (`text`, `image`, `pdf`, `audio`, `video`). */
  input?: string[]
  /** models.dev `modalities.output`. */
  output?: string[]
  /** models.dev `limit.context` (positive only). */
  contextWindow?: number
  /** models.dev `limit.output` (positive only). */
  maxOutputTokens?: number
  /** USD per 1M tokens. */
  cost?: { input?: number, output?: number, cacheRead?: number, cacheWrite?: number }
}

export interface ModelsDevSnapshot {
  schemaVersion: typeof MODELS_DEV_SCHEMA_VERSION
  source: string
  /** Epoch ms of the download. */
  fetchedAt: number
  /** Every models.dev provider is included (a refresh), not only `BUNDLED_MODELS_DEV_PROVIDERS`. */
  complete: boolean
  /** models.dev provider key -> model id -> metadata. */
  providers: Record<string, Record<string, ModelsDevModel>>
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Printable text without control characters or Cyrillic (the repository is English-only), else undefined. */
function cleanName(value: unknown): string | undefined {
  if (typeof value !== 'string')
    return undefined
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point.
  const name = value.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 256)
  return name === '' || /\p{Script=Cyrillic}/u.test(name) ? undefined : name
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function price(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function modalities(value: unknown): string[] | undefined {
  if (!Array.isArray(value))
    return undefined
  const list = value.filter((item): item is string => typeof item === 'string' && /^[a-z]{1,16}$/.test(item))
  return list.length > 0 ? [...new Set(list)] : undefined
}

/** One raw models.dev model -> the trimmed metadata. */
export function trimModelsDevModel(raw: unknown): ModelsDevModel {
  const model: ModelsDevModel = {}
  if (!isRecord(raw))
    return model
  const name = cleanName(raw.name)
  if (name !== undefined)
    model.name = name
  if (typeof raw.reasoning === 'boolean')
    model.reasoning = raw.reasoning
  if (typeof raw.tool_call === 'boolean')
    model.tools = raw.tool_call
  if (typeof raw.structured_output === 'boolean')
    model.structuredOutput = raw.structured_output
  const kinds = isRecord(raw.modalities) ? raw.modalities : undefined
  const input = modalities(kinds?.input)
  if (input)
    model.input = input
  const output = modalities(kinds?.output)
  if (output)
    model.output = output
  const limit = isRecord(raw.limit) ? raw.limit : undefined
  const contextWindow = positiveInt(limit?.context)
  if (contextWindow !== undefined)
    model.contextWindow = contextWindow
  const maxOutputTokens = positiveInt(limit?.output)
  if (maxOutputTokens !== undefined)
    model.maxOutputTokens = maxOutputTokens
  const rawCost = isRecord(raw.cost) ? raw.cost : undefined
  const cost: NonNullable<ModelsDevModel['cost']> = {}
  const inputPrice = price(rawCost?.input)
  const outputPrice = price(rawCost?.output)
  const cacheRead = price(rawCost?.cache_read)
  const cacheWrite = price(rawCost?.cache_write)
  if (inputPrice !== undefined)
    cost.input = inputPrice
  if (outputPrice !== undefined)
    cost.output = outputPrice
  if (cacheRead !== undefined)
    cost.cacheRead = cacheRead
  if (cacheWrite !== undefined)
    cost.cacheWrite = cacheWrite
  if (Object.keys(cost).length > 0)
    model.cost = cost
  return model
}

/** Model ids: 1..256 characters without control characters (`modelIdSchema`). */
function isModelId(id: string): boolean {
  // eslint-disable-next-line no-control-regex -- model ids cannot contain control characters.
  return id.length > 0 && id.length <= 256 && !/[\u0000-\u001F\u007F-\u009F]/.test(id)
}

export interface TrimModelsDevOptions {
  /** Provider keys to keep; default: every provider (`complete`). */
  providers?: readonly string[]
  /** Keeps only the models accepted here (default: all models of the kept providers). */
  include?: (providerKey: string, modelId: string) => boolean
  fetchedAt: number
  source?: string
}

/** The raw `api.json` (provider key -> `{ models: { [id]: model } }`) -> a trimmed snapshot. Throws on a wrong shape. */
export function trimModelsDev(raw: unknown, options: TrimModelsDevOptions): ModelsDevSnapshot {
  if (!isRecord(raw))
    throw new Error('models.dev returned an unexpected document.')
  const keep = options.providers === undefined ? null : new Set(options.providers)
  const providers: ModelsDevSnapshot['providers'] = {}
  for (const key of Object.keys(raw).sort()) {
    if (keep !== null && !keep.has(key))
      continue
    const provider = raw[key]
    const models = isRecord(provider) && isRecord(provider.models) ? provider.models : undefined
    if (!models)
      continue
    const trimmed: Record<string, ModelsDevModel> = {}
    for (const id of Object.keys(models).sort()) {
      if (isModelId(id) && (options.include?.(key, id) ?? true))
        trimmed[id] = trimModelsDevModel(models[id])
    }
    providers[key] = trimmed
  }
  if (Object.keys(providers).length === 0)
    throw new Error('models.dev returned no providers.')
  return {
    schemaVersion: MODELS_DEV_SCHEMA_VERSION,
    source: options.source ?? MODELS_DEV_URL,
    fetchedAt: options.fetchedAt,
    complete: keep === null && options.include === undefined,
    providers,
  }
}

/** The bundled snapshot: the builtin providers in full plus the partial providers (`BUNDLED_MODELS_DEV_PARTIAL`). */
export function trimModelsDevForBundle(raw: unknown, fetchedAt: number): ModelsDevSnapshot {
  const full = new Set<string>(BUNDLED_MODELS_DEV_PROVIDERS)
  return trimModelsDev(raw, {
    fetchedAt,
    providers: [...BUNDLED_MODELS_DEV_PROVIDERS, ...Object.keys(BUNDLED_MODELS_DEV_PARTIAL)],
    include: (key, id) => full.has(key) || (BUNDLED_MODELS_DEV_PARTIAL[key]?.test(id) ?? false),
  })
}

/** Validates a parsed snapshot file; null when it is not a snapshot of this schema version. */
export function parseModelsDevSnapshot(value: unknown): ModelsDevSnapshot | null {
  if (!isRecord(value) || value.schemaVersion !== MODELS_DEV_SCHEMA_VERSION || !isRecord(value.providers))
    return null
  if (typeof value.fetchedAt !== 'number' || !Number.isFinite(value.fetchedAt))
    return null
  const providers: ModelsDevSnapshot['providers'] = {}
  for (const [key, models] of Object.entries(value.providers)) {
    if (!isRecord(models))
      continue
    const entries: Record<string, ModelsDevModel> = {}
    for (const [id, model] of Object.entries(models)) {
      if (isModelId(id) && isRecord(model))
        entries[id] = model as ModelsDevModel
    }
    providers[key] = entries
  }
  return {
    schemaVersion: MODELS_DEV_SCHEMA_VERSION,
    source: typeof value.source === 'string' ? value.source : MODELS_DEV_URL,
    fetchedAt: value.fetchedAt,
    complete: value.complete === true,
    providers,
  }
}

/** A value on one line in the repository JSON style (`{ "a": 1, "b": ["x", "y"] }`). */
function inlineJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(inlineJson).join(', ')}]`
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
    return entries.length === 0 ? '{}' : `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${inlineJson(item)}`).join(', ')} }`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * JSON with one model per line, in the formatting the repository linter expects (the bundled file is committed);
 * keys are already sorted by `trimModelsDev`.
 */
export function serializeModelsDevSnapshot(snapshot: ModelsDevSnapshot): string {
  const lines = [
    '{',
    `  "schemaVersion": ${snapshot.schemaVersion},`,
    `  "source": ${JSON.stringify(snapshot.source)},`,
    `  "fetchedAt": ${snapshot.fetchedAt},`,
    `  "complete": ${snapshot.complete},`,
  ]
  const providers = Object.entries(snapshot.providers)
  if (providers.length === 0) {
    lines.push('  "providers": {}')
  }
  else {
    lines.push('  "providers": {')
    providers.forEach(([key, models], providerIndex) => {
      const providerComma = providerIndex < providers.length - 1 ? ',' : ''
      const entries = Object.entries(models)
      if (entries.length === 0) {
        lines.push(`    ${JSON.stringify(key)}: {}${providerComma}`)
        return
      }
      lines.push(`    ${JSON.stringify(key)}: {`)
      entries.forEach(([id, model], index) => {
        lines.push(`      ${JSON.stringify(id)}: ${inlineJson(model)}${index < entries.length - 1 ? ',' : ''}`)
      })
      lines.push(`    }${providerComma}`)
    })
    lines.push('  }')
  }
  lines.push('}')
  return `${lines.join('\n')}\n`
}

/** Number of models in a snapshot. */
export function modelsDevModelCount(snapshot: ModelsDevSnapshot): number {
  return Object.values(snapshot.providers).reduce((total, models) => total + Object.keys(models).length, 0)
}
