// xAI (Grok): `@ai-sdk/xai` 5.x, Responses API only (PROVIDERS.md sections 1-6).
import type { ModelInfo, ProviderDefinition, ReasoningEffort } from '@harness-forge/plugin-sdk'
import { createXai } from '@ai-sdk/xai'
import { apiKeyField, apiKeyOf, baseUrlField, baseUrlOf } from '../lib/credentials.ts'
import { mapProviderError } from '../lib/errors.ts'
import { requestJson, unexpectedListing } from '../lib/http.ts'
import { recordOf, stringOf } from '../lib/json.ts'
import { finalizeListing, modelInfo } from '../lib/models.ts'
import { topLevelReasoning } from '../lib/reasoning.ts'

const PROVIDER = { id: 'xai', name: 'xAI' }
export const XAI_BASE_URL = 'https://api.x.ai/v1'
/** Image and video generation models of the listing. */
const NON_CHAT_IDS = /^grok-imagine/i
/** Variants without an effort parameter (`supportsReasoningEffort` of `@ai-sdk/xai` 5.0.10). */
const WITHOUT_EFFORT = /^grok-4\.20(?:-\d{4})?-(non-)?reasoning$/

/**
 * Efforts offered for a model id (`undefined` when unknown): `grok-4.3` accepts `none`-`high`, `grok-4.5` `low`-`high`,
 * `grok-4.6` `low`-`xhigh`, `grok-4.7` `low`-`high` (unverified), `grok-4.20-*` variants no effort at all.
 */
export function xaiReasoningEfforts(modelId: string): ReasoningEffort[] | undefined {
  const variant = modelId.match(WITHOUT_EFFORT)
  if (variant)
    return variant[1] ? undefined : []
  switch (modelId) {
    case 'grok-4.3':
      return ['off', 'low', 'medium', 'high']
    case 'grok-4.5':
    case 'grok-4.7':
      return ['low', 'medium', 'high']
    case 'grok-4.6':
      return ['low', 'medium', 'high', 'max']
    default:
      return undefined
  }
}

export const xaiProvider: ProviderDefinition = {
  id: 'xai',
  name: 'xAI (Grok)',
  icon: 'lobe:grok',
  credentials: [apiKeyField('XAI_API_KEY'), baseUrlField(XAI_BASE_URL)],
  modelsDevId: 'xai',
  keyUrl: 'https://console.x.ai/team/default/api-keys',
  smallModelId: 'grok-4.3',
  seedModels: [
    {
      id: 'grok-4.7',
      name: 'Grok 4.7',
      contextWindow: 500_000,
      maxOutputTokens: 500_000,
      capabilities: { tools: true, vision: true, pdf: true, reasoning: true, structuredOutput: true },
      reasoningEfforts: ['low', 'medium', 'high'],
      cost: { input: 2, output: 6, cacheRead: 0.5 },
    },
  ],
  createLanguageModel(modelId, rt) {
    return createXai({ apiKey: apiKeyOf(rt), baseURL: baseUrlOf(rt, XAI_BASE_URL), fetch: rt.fetch })(modelId)
  },
  async listModels(rt) {
    const body = recordOf(await requestJson(rt, `${baseUrlOf(rt, XAI_BASE_URL)}/models`, {
      headers: { authorization: `Bearer ${apiKeyOf(rt)}` },
    }))
    if (!body || !Array.isArray(body.data))
      throw unexpectedListing(PROVIDER.name)
    const models: ModelInfo[] = []
    for (const entry of body.data) {
      const id = stringOf(recordOf(entry)?.id)
      if (!id || NON_CHAT_IDS.test(id))
        continue
      const efforts = xaiReasoningEfforts(id)
      models.push(modelInfo({ id, capabilities: { reasoning: efforts ? true : undefined }, reasoningEfforts: efforts }))
    }
    return finalizeListing(models)
  },
  reasoning(effort) {
    return topLevelReasoning(effort)
  },
  mapError(err) {
    // xAI answers an invalid key with HTTP 400 "Incorrect API key provided", matched by the common auth rule.
    return mapProviderError(err, PROVIDER)
  },
}
