// Ollama (local): `@ai-sdk/openai-compatible` on Ollama's OpenAI-compatible API (PROVIDERS.md sections 1-7). No key;
// the base URL is the main field so remote hosts work. Local models come from `/api/tags`, enriched by `/api/show`.
import type { ModelInfo, ProviderDefinition, ProviderRuntime, ReasoningEffort } from '@harness-forge/plugin-sdk'
import type { ErrorRule } from '../lib/errors.ts'
import type { JsonRecord } from '../lib/json.ts'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { apiKeyOf, baseUrlOf } from '../lib/credentials.ts'
import { mapped, mapProviderError, originOf } from '../lib/errors.ts'
import { requestJson, statusOf, unexpectedListing } from '../lib/http.ts'
import { arrayOf, positiveIntOf, recordOf, stringOf, stringsOf } from '../lib/json.ts'
import { finalizeListing, modelInfo } from '../lib/models.ts'
import { topLevelReasoning } from '../lib/reasoning.ts'

const PROVIDER = { id: 'ollama', name: 'Ollama' }
export const OLLAMA_BASE_URL = 'http://localhost:11434/v1'
/** Parallel `/api/show` requests. */
const SHOW_CONCURRENCY = 4
/** Models enriched with `/api/show` (the listing is guarded by a 15 s timeout). */
const SHOW_LIMIT = 100
const NOT_INSTALLED = /model "?([^"]+?)"? not found/

/** The Ollama server origin: the base URL without a trailing `/v1`. */
export function ollamaOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
}

/**
 * Efforts from `/api/show` `thinking.values`: `false` (or `"none"`) -> `off`; named levels as reported; a boolean-only
 * control -> `off` / `high` (on). `undefined` without metadata (the host defaults apply).
 */
export function ollamaReasoningEfforts(values: readonly unknown[]): ReasoningEffort[] | undefined {
  if (values.length === 0)
    return undefined
  const levels = values.filter((value): value is string => typeof value === 'string').map(value => value.toLowerCase())
  const efforts: ReasoningEffort[] = []
  if (values.includes(false) || levels.includes('none'))
    efforts.push('off')
  if (levels.length > 0) {
    for (const level of ['low', 'medium', 'high', 'max'] as const) {
      if (levels.includes(level))
        efforts.push(level)
    }
  }
  else if (values.includes(true) && values.includes(false)) {
    efforts.push('high')
  }
  return efforts
}

/** `ModelInfo` of a local model; `undefined` for embedding-only models. */
export function ollamaModelInfo(name: string, show: JsonRecord | undefined): ModelInfo | undefined {
  if (!show)
    return modelInfo({ id: name })
  const capabilities = stringsOf(show.capabilities)
  if (capabilities.includes('embedding') && !capabilities.includes('completion'))
    return undefined
  const values = arrayOf(recordOf(show.thinking)?.values)
  const thinkingOff = values.length > 0 && values.every(value => value === false)
  const reasoning = thinkingOff
    ? false
    : capabilities.includes('thinking') || values.some(value => value === true || typeof value === 'string')
      ? true
      : capabilities.length > 0 ? false : undefined
  const info = recordOf(show.model_info)
  const architecture = stringOf(info?.['general.architecture'])
  const known = capabilities.length > 0
  return modelInfo({
    id: name,
    contextWindow: architecture ? positiveIntOf(info?.[`${architecture}.context_length`]) : undefined,
    capabilities: {
      tools: known ? capabilities.includes('tools') : undefined,
      vision: known ? capabilities.includes('vision') : undefined,
      reasoning,
    },
    reasoningEfforts: reasoning === true ? ollamaReasoningEfforts(values) : undefined,
  })
}

function authHeaders(rt: ProviderRuntime): Record<string, string> {
  const apiKey = apiKeyOf(rt)
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
}

/** Runs `task` over `items` with at most `limit` tasks in flight; keeps the order. */
async function mapLimited<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++
      results[index] = await task(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function showModel(rt: ProviderRuntime, origin: string, name: string): Promise<JsonRecord | undefined> {
  try {
    return recordOf(await requestJson(rt, `${origin}/api/show`, { method: 'POST', headers: authHeaders(rt), body: { model: name } }))
  }
  catch (error) {
    // Enrichment is optional; only an abort of the listing stops it.
    if (rt.signal?.aborted)
      throw error
    return undefined
  }
}

/** Fallback for OpenAI-compatible servers without `/api/tags`: `GET {baseURL}/models`. */
async function listCompatibleModels(rt: ProviderRuntime, baseUrl: string): Promise<ModelInfo[]> {
  const body = recordOf(await requestJson(rt, `${baseUrl}/models`, { headers: authHeaders(rt) }))
  if (!body || !Array.isArray(body.data))
    throw unexpectedListing(PROVIDER.name)
  const models = body.data.flatMap((entry) => {
    const id = stringOf(recordOf(entry)?.id)
    return id ? [modelInfo({ id })] : []
  })
  return finalizeListing(models)
}

/** Connection failures and models that are not pulled get Ollama-specific hints. */
const ollamaRule: ErrorRule = (facts, provider) => {
  if (facts.networkCode !== undefined && facts.status === undefined) {
    const origin = originOf(facts.url)
    return mapped(facts, provider, {
      code: 'provider_unreachable',
      message: origin ? `Cannot reach Ollama at ${origin}. Is Ollama running?` : 'Cannot reach Ollama. Is Ollama running?',
      action: 'retry',
    })
  }
  const missing = facts.text.match(NOT_INSTALLED)?.[1]
  if (facts.status === 404 && missing !== undefined) {
    const model = facts.modelId ?? missing
    return mapped(facts, provider, {
      code: 'model_not_found',
      message: `The model "${model}" is not installed in Ollama. Run "ollama pull ${model}" on the Ollama host.`,
      action: 'refresh-models',
    })
  }
  return undefined
}

export const ollamaProvider: ProviderDefinition = {
  id: 'ollama',
  name: 'Ollama (local)',
  icon: 'lobe:ollama',
  credentials: [
    { key: 'baseURL', label: 'Base URL', type: 'url', required: true, default: OLLAMA_BASE_URL },
    { key: 'apiKey', label: 'API key', type: 'secret', required: false, advanced: true },
  ],
  keyUrl: 'https://ollama.com/download',
  createLanguageModel(modelId, rt) {
    const apiKey = apiKeyOf(rt)
    return createOpenAICompatible({
      name: 'ollama',
      baseURL: baseUrlOf(rt, OLLAMA_BASE_URL),
      apiKey: apiKey === '' ? undefined : apiKey,
      fetch: rt.fetch,
      includeUsage: true,
    }).chatModel(modelId)
  },
  async listModels(rt) {
    const baseUrl = baseUrlOf(rt, OLLAMA_BASE_URL)
    const origin = ollamaOrigin(baseUrl)
    let names: string[]
    try {
      const body = recordOf(await requestJson(rt, `${origin}/api/tags`, { headers: authHeaders(rt) }))
      if (!body || !Array.isArray(body.models))
        throw unexpectedListing(PROVIDER.name)
      names = body.models.flatMap((entry) => {
        const record = recordOf(entry)
        const name = stringOf(record?.name) ?? stringOf(record?.model)
        return name ? [name] : []
      })
    }
    catch (error) {
      const status = statusOf(error)
      if (status !== 404 && status !== 405)
        throw error
      return listCompatibleModels(rt, baseUrl)
    }
    const shown = await mapLimited(names.slice(0, SHOW_LIMIT), SHOW_CONCURRENCY, name => showModel(rt, origin, name))
    const models = names.flatMap((name, index) => {
      const model = ollamaModelInfo(name, shown[index])
      return model ? [model] : []
    })
    return finalizeListing(models)
  },
  reasoning(effort) {
    // `max` goes as `reasoning_effort: 'max'` (the top-level `xhigh` would be sent verbatim).
    if (effort === 'max')
      return { providerOptions: { ollama: { reasoningEffort: 'max' } } }
    return topLevelReasoning(effort)
  },
  mapError(err) {
    return mapProviderError(err, PROVIDER, [ollamaRule])
  },
}
