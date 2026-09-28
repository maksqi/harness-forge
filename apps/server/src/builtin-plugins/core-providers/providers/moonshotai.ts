// Moonshot AI (Kimi): `@ai-sdk/moonshotai` (PROVIDERS.md sections 1-6). The console moved to platform.kimi.ai; the
// API host stays api.moonshot.ai.
import type { ModelInfo, ProviderDefinition, ReasoningEffort } from '@harness-forge/plugin-sdk'
import { createMoonshotAI } from '@ai-sdk/moonshotai'
import { apiKeyField, apiKeyOf, baseUrlField, baseUrlOf } from '../lib/credentials.ts'
import { mapProviderError } from '../lib/errors.ts'
import { requestJson, unexpectedListing } from '../lib/http.ts'
import { positiveIntOf, recordOf, stringOf } from '../lib/json.ts'
import { finalizeListing, modelInfo } from '../lib/models.ts'
import { ON_OFF_EFFORTS, topLevelReasoning } from '../lib/reasoning.ts'

const PROVIDER = { id: 'moonshotai', name: 'Moonshot AI' }
export const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1'

/**
 * Efforts offered for a model id: Kimi K3 always reasons with `low` / `high` / `max`; K2.5 and K2.6 switch thinking on
 * and off; K2.7 always thinks without controls. `undefined` for other models.
 */
export function moonshotReasoningEfforts(modelId: string): ReasoningEffort[] | undefined {
  if (/^kimi-k3(?:$|[-.])/.test(modelId))
    return ['low', 'high', 'max']
  if (/^kimi-k2\.[56](?:$|-)/.test(modelId))
    return [...ON_OFF_EFFORTS]
  if (/^kimi-k2\.7(?:$|-)/.test(modelId))
    return []
  return undefined
}

export const moonshotaiProvider: ProviderDefinition = {
  id: 'moonshotai',
  name: 'Moonshot AI (Kimi)',
  icon: 'lobe:kimi',
  credentials: [apiKeyField('MOONSHOT_API_KEY'), baseUrlField(MOONSHOT_BASE_URL)],
  modelsDevId: 'moonshotai',
  keyUrl: 'https://platform.kimi.ai/console/api-keys',
  smallModelId: 'kimi-k2.6',
  seedModels: [
    {
      id: 'kimi-k3',
      name: 'Kimi K3',
      contextWindow: 1_048_576,
      maxOutputTokens: 1_048_576,
      capabilities: { tools: true, vision: true, reasoning: true, structuredOutput: true },
      reasoningEfforts: ['low', 'high', 'max'],
      cost: { input: 3, output: 15, cacheRead: 0.3 },
    },
    {
      id: 'kimi-k2.6',
      name: 'Kimi K2.6',
      contextWindow: 262_144,
      maxOutputTokens: 262_144,
      capabilities: { tools: true, vision: true, reasoning: true, structuredOutput: true },
      reasoningEfforts: ['off', 'high'],
      cost: { input: 0.95, output: 4, cacheRead: 0.16 },
    },
  ],
  createLanguageModel(modelId, rt) {
    return createMoonshotAI({ apiKey: apiKeyOf(rt), baseURL: baseUrlOf(rt, MOONSHOT_BASE_URL), fetch: rt.fetch })(modelId)
  },
  async listModels(rt) {
    const body = recordOf(await requestJson(rt, `${baseUrlOf(rt, MOONSHOT_BASE_URL)}/models`, {
      headers: { authorization: `Bearer ${apiKeyOf(rt)}` },
    }))
    if (!body || !Array.isArray(body.data))
      throw unexpectedListing(PROVIDER.name)
    const models: ModelInfo[] = []
    for (const entry of body.data) {
      const record = recordOf(entry)
      const id = stringOf(record?.id)
      if (!record || !id)
        continue
      const efforts = moonshotReasoningEfforts(id)
      models.push(modelInfo({
        id,
        contextWindow: positiveIntOf(record.context_length),
        capabilities: { reasoning: efforts ? true : undefined },
        reasoningEfforts: efforts,
      }))
    }
    return finalizeListing(models)
  },
  reasoning(effort) {
    return topLevelReasoning(effort)
  },
  mapError(err) {
    return mapProviderError(err, PROVIDER)
  },
}
