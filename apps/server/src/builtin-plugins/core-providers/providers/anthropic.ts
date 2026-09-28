// Anthropic (Claude): `@ai-sdk/anthropic` Messages API (PROVIDERS.md sections 1-6).
import type { ModelInfo, ProviderDefinition, ProviderRuntime, ReasoningEffort } from '@harness-forge/plugin-sdk'
import type { JsonRecord } from '../lib/json.ts'
import { createAnthropic } from '@ai-sdk/anthropic'
import { apiKeyField, apiKeyOf, baseUrlField, baseUrlOf } from '../lib/credentials.ts'
import { mapProviderError, overloadedRule } from '../lib/errors.ts'
import { requestJson, unexpectedListing } from '../lib/http.ts'
import { positiveIntOf, recordOf, stringOf, supportedOf } from '../lib/json.ts'
import { finalizeListing, modelInfo } from '../lib/models.ts'
import { topLevelReasoning } from '../lib/reasoning.ts'

const PROVIDER = { id: 'anthropic', name: 'Anthropic' }
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1'
export const ANTHROPIC_VERSION = '2023-06-01'
/** Safety cap of the `has_more` / `after_id` pagination. */
const MAX_PAGES = 20

/**
 * Adaptive thinking (`thinking: { type: 'adaptive' }` + `effort`) instead of budget thinking; the same model rules as
 * `getModelCapabilities` of `@ai-sdk/anthropic` 4.0.65: every `claude-*` model except the generations up to 4.5.
 */
export function supportsAdaptiveThinking(modelId: string): boolean {
  if (/claude-(?:opus-5|fable-5|opus-4-8|opus-4-7|sonnet-5|sonnet-4-6|opus-4-6)/.test(modelId))
    return true
  if (/claude-(?:sonnet-4-5|opus-4-5|haiku-4-5|opus-4-1)/.test(modelId))
    return false
  if (/claude-(?:sonnet|opus)-4(?:-|@)/.test(modelId) || modelId.includes('claude-3-haiku'))
    return false
  if (/claude-(?:instant(?:-|$)|v?2(?=$|[-.:])|3(?=$|[-.]))/.test(modelId))
    return false
  return modelId.includes('claude-')
}

/** Adaptive-only models reject disabled and budget thinking, so `off` is not offered (PROVIDERS.md section 4). */
export function isAdaptiveOnly(modelId: string): boolean {
  return /claude-(?:opus-5-5|fable-5)/.test(modelId)
}

/** Efforts from the listing: `thinking.types` (can thinking be disabled?) and `effort.{level}.supported`. */
function listedEfforts(modelId: string, capabilities: JsonRecord | undefined): ReasoningEffort[] {
  const types = recordOf(recordOf(capabilities?.thinking)?.types)
  const adaptiveOnly = isAdaptiveOnly(modelId)
    || (supportedOf(types?.enabled) === false && supportedOf(types?.adaptive) === true)
  const efforts: ReasoningEffort[] = adaptiveOnly ? [] : ['off']
  const effort = recordOf(capabilities?.effort)
  if (effort && supportedOf(effort) === true) {
    for (const level of ['low', 'medium', 'high', 'max'] as const) {
      if (supportedOf(effort[level]) === true)
        efforts.push(level)
    }
  }
  else {
    // Budget thinking: the package derives the budget from the level.
    efforts.push('low', 'medium', 'high')
  }
  return efforts
}

function toModelInfo(entry: JsonRecord): ModelInfo | undefined {
  const id = stringOf(entry.id)
  if (!id)
    return undefined
  const capabilities = recordOf(entry.capabilities)
  const reasoning = supportedOf(capabilities?.thinking)
  return modelInfo({
    id,
    name: stringOf(entry.display_name),
    contextWindow: positiveIntOf(entry.max_input_tokens),
    maxOutputTokens: positiveIntOf(entry.max_tokens),
    capabilities: {
      tools: true,
      vision: supportedOf(capabilities?.image_input),
      pdf: supportedOf(capabilities?.pdf_input),
      structuredOutput: supportedOf(capabilities?.structured_outputs),
      reasoning,
    },
    reasoningEfforts: reasoning === true ? listedEfforts(id, capabilities) : undefined,
  })
}

export interface AnthropicListingOptions {
  providerName: string
  baseUrl: string
  headers: Record<string, string>
  map: (entry: JsonRecord) => ModelInfo | undefined
}

/** `GET {baseUrl}/models?limit=1000`, following `has_more` with `after_id` (Anthropic and Anthropic-compatible APIs). */
export async function listAnthropicShapedModels(rt: ProviderRuntime, options: AnthropicListingOptions): Promise<ModelInfo[]> {
  const models: ModelInfo[] = []
  let afterId: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${options.baseUrl}/models`)
    url.searchParams.set('limit', '1000')
    if (afterId)
      url.searchParams.set('after_id', afterId)
    const body = recordOf(await requestJson(rt, url.toString(), { headers: options.headers }))
    if (!body || !Array.isArray(body.data))
      throw unexpectedListing(options.providerName)
    for (const entry of body.data) {
      const record = recordOf(entry)
      const model = record && options.map(record)
      if (model)
        models.push(model)
    }
    afterId = stringOf(body.last_id)
    if (body.has_more !== true || !afterId)
      break
  }
  return finalizeListing(models)
}

export const anthropicProvider: ProviderDefinition = {
  id: 'anthropic',
  name: 'Anthropic (Claude)',
  icon: 'lobe:claude',
  credentials: [apiKeyField('ANTHROPIC_API_KEY'), baseUrlField(ANTHROPIC_BASE_URL)],
  modelsDevId: 'anthropic',
  keyUrl: 'https://platform.claude.com/settings/keys',
  smallModelId: 'claude-haiku-4-5',
  seedModels: [
    {
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: { tools: true, vision: true, pdf: true, reasoning: true, structuredOutput: true },
      reasoningEfforts: ['low', 'medium', 'high', 'max'],
      cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    },
    {
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: { tools: true, vision: true, pdf: true, reasoning: true, structuredOutput: true },
      reasoningEfforts: ['off', 'low', 'medium', 'high', 'max'],
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    },
    {
      id: 'claude-haiku-4-5',
      name: 'Claude Haiku 4.5',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, vision: true, pdf: true, reasoning: true, structuredOutput: true },
      reasoningEfforts: ['off', 'low', 'medium', 'high'],
      cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    },
    {
      id: 'claude-fable-5-1',
      name: 'Claude Fable 5.1',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: { tools: true, vision: true, pdf: true, reasoning: true, structuredOutput: true },
      reasoningEfforts: ['low', 'medium', 'high', 'max'],
      cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    },
  ],
  createLanguageModel(modelId, rt) {
    return createAnthropic({ apiKey: apiKeyOf(rt), baseURL: baseUrlOf(rt, ANTHROPIC_BASE_URL), fetch: rt.fetch })(modelId)
  },
  listModels(rt) {
    return listAnthropicShapedModels(rt, {
      providerName: PROVIDER.name,
      baseUrl: baseUrlOf(rt, ANTHROPIC_BASE_URL),
      headers: { 'x-api-key': apiKeyOf(rt), 'anthropic-version': ANTHROPIC_VERSION },
      map: toModelInfo,
    })
  },
  reasoning(effort, model) {
    // `reasoning: 'xhigh'` would select effort `xhigh` on adaptive models, so `max` is explicit there.
    if (effort === 'max' && supportsAdaptiveThinking(model.id))
      return { providerOptions: { anthropic: { thinking: { type: 'adaptive', display: 'summarized' }, effort: 'max' } } }
    return topLevelReasoning(effort)
  },
  mapError(err) {
    return mapProviderError(err, PROVIDER, [overloadedRule])
  },
}
