// OpenRouter: `@openrouter/ai-sdk-provider` (PROVIDERS.md sections 1-7). The model listing is public, so the key is
// checked with `GET /key`. Every request asks for usage accounting (the charged cost becomes `costUsd`). Images come
// from chat models with image output (PROVIDERS.md section 13); no dedicated image, transcription or speech models.
import type { ModelInfo, ProviderDefinition, ProviderRuntime, ReasoningEffort } from '@harness-forge/plugin-sdk'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { apiKeyField, apiKeyOf, baseUrlField, baseUrlOf } from '../lib/credentials.ts'
import { mapProviderError, paymentRequiredRule } from '../lib/errors.ts'
import { requestJson, unexpectedListing } from '../lib/http.ts'
import { booleanOf, positiveIntOf, recordOf, stringOf, stringsOf } from '../lib/json.ts'
import { checkOrPing, pingModel, withDefaultSettings } from '../lib/language-model.ts'
import { finalizeListing, modelInfo, perMillionTokens } from '../lib/models.ts'
import { TOP_LEVEL_REASONING } from '../lib/reasoning.ts'

const PROVIDER = { id: 'openrouter', name: 'OpenRouter' }
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const SMALL_MODEL_ID = 'openai/gpt-6-luna'
/** Sent as `X-OpenRouter-Title` (app attribution). */
export const OPENROUTER_APP_NAME = 'harness-forge'
/** Sent as `HTTP-Referer` (required for attribution). */
export const OPENROUTER_APP_URL = 'https://github.com/maksqi/harness-forge'

/** Efforts offered by the PROVIDERS.md default for reasoning models. */
const DEFAULT_EFFORTS: readonly ReasoningEffort[] = ['off', 'low', 'medium', 'high']

/**
 * Efforts of a reasoning model: from the listing's `reasoning.supported_efforts` when present (`none` -> `off` unless
 * reasoning is mandatory, `xhigh` -> `max`), else `off, low, medium, high`.
 */
export function openrouterReasoningEfforts(reasoning: unknown): ReasoningEffort[] {
  const info = recordOf(reasoning)
  const supported = stringsOf(info?.supported_efforts)
  if (supported.length === 0)
    return [...DEFAULT_EFFORTS]
  const efforts: ReasoningEffort[] = []
  if (supported.includes('none') && booleanOf(info?.mandatory) !== true)
    efforts.push('off')
  for (const level of ['low', 'medium', 'high'] as const) {
    if (supported.includes(level))
      efforts.push(level)
  }
  if (supported.includes('xhigh'))
    efforts.push('max')
  return efforts
}

function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
}

function createOpenRouterModel(modelId: string, rt: ProviderRuntime) {
  const model = createOpenRouter({
    apiKey: apiKeyOf(rt),
    baseURL: baseUrlOf(rt, OPENROUTER_BASE_URL),
    fetch: rt.fetch,
    compatibility: 'strict',
    appName: OPENROUTER_APP_NAME,
    appUrl: OPENROUTER_APP_URL,
  })(modelId)
  return withDefaultSettings(model, { providerOptions: { openrouter: { usage: { include: true } } } })
}

export const openrouterProvider: ProviderDefinition = {
  id: 'openrouter',
  name: 'OpenRouter',
  icon: 'lobe:openrouter',
  credentials: [apiKeyField('OPENROUTER_API_KEY'), baseUrlField(OPENROUTER_BASE_URL)],
  modelsDevId: 'openrouter',
  keyUrl: 'https://openrouter.ai/settings/keys',
  smallModelId: SMALL_MODEL_ID,
  createLanguageModel: createOpenRouterModel,
  async listModels(rt) {
    const body = recordOf(await requestJson(rt, `${baseUrlOf(rt, OPENROUTER_BASE_URL)}/models`, {
      headers: authHeaders(apiKeyOf(rt)),
    }))
    if (!body || !Array.isArray(body.data))
      throw unexpectedListing(PROVIDER.name)
    const models: ModelInfo[] = []
    for (const entry of body.data) {
      const record = recordOf(entry)
      const id = stringOf(record?.id)
      if (!record || !id)
        continue
      const architecture = recordOf(record.architecture)
      const outputs = stringsOf(architecture?.output_modalities)
      if (outputs.length > 0 && !outputs.includes('text'))
        continue
      const imageOutput = outputs.length > 0 ? outputs.includes('image') : undefined
      const inputs = stringsOf(architecture?.input_modalities)
      const parameters = stringsOf(record.supported_parameters)
      const known = parameters.length > 0
      const reasoning = known ? parameters.includes('reasoning') : undefined
      const pricing = recordOf(record.pricing)
      models.push(modelInfo({
        id,
        name: stringOf(record.name),
        // A chat model even when its id says "image" (e.g. `google/gemini-2.5-flash-image`): an explicit kind always
        // wins over the catalog's `classify()`.
        kind: imageOutput === true ? 'chat' : undefined,
        contextWindow: positiveIntOf(record.context_length),
        maxOutputTokens: positiveIntOf(recordOf(record.top_provider)?.max_completion_tokens),
        capabilities: {
          tools: known ? parameters.includes('tools') : undefined,
          vision: inputs.length > 0 ? inputs.includes('image') : undefined,
          pdf: inputs.length > 0 ? inputs.includes('file') : undefined,
          reasoning,
          structuredOutput: known ? parameters.includes('structured_outputs') : undefined,
          imageOutput,
        },
        reasoningEfforts: reasoning === true ? openrouterReasoningEfforts(record.reasoning) : undefined,
        // USD per token -> per 1M tokens; long-prompt `overrides` are ignored.
        cost: {
          input: perMillionTokens(pricing?.prompt),
          output: perMillionTokens(pricing?.completion),
          cacheRead: perMillionTokens(pricing?.input_cache_read),
          cacheWrite: perMillionTokens(pricing?.input_cache_write),
        },
      }))
    }
    return finalizeListing(models)
  },
  validate(rt) {
    // The listing answers without a valid key; `GET /key` does not (a proxy without it gets a tiny call instead).
    return checkOrPing(
      () => requestJson(rt, `${baseUrlOf(rt, OPENROUTER_BASE_URL)}/key`, { headers: authHeaders(apiKeyOf(rt)) }),
      () => pingModel(createOpenRouterModel(SMALL_MODEL_ID, rt), rt),
    )
  },
  reasoning(effort) {
    // The package ignores the top-level option; the effort goes to `providerOptions.openrouter.reasoning`.
    if (effort === 'auto')
      return undefined
    return { providerOptions: { openrouter: { reasoning: { effort: TOP_LEVEL_REASONING[effort] } } } }
  },
  mapError(err) {
    return mapProviderError(err, PROVIDER, [paymentRequiredRule('OpenRouter credits are exhausted. Add credits and try again.')])
  },
  imageParams(request) {
    // Only called for chat models with `capabilities.imageOutput`. The package has no typed option for this: it spreads
    // `providerOptions.openrouter` into the request body.
    const imageConfig = request.aspectRatio === undefined ? {} : { image_config: { aspect_ratio: request.aspectRatio } }
    return { providerOptions: { openrouter: { modalities: ['image', 'text'], ...imageConfig } } }
  },
}
