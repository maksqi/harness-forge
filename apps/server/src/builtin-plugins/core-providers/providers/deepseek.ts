// DeepSeek: `@ai-sdk/deepseek` (PROVIDERS.md sections 1-6). The base URL has no `/v1`.
import type { ModelInfo, ProviderDefinition, ReasoningEffort } from '@harness-forge/plugin-sdk'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { apiKeyField, apiKeyOf, baseUrlField, baseUrlOf } from '../lib/credentials.ts'
import { mapProviderError, paymentRequiredRule } from '../lib/errors.ts'
import { requestJson, unexpectedListing } from '../lib/http.ts'
import { positiveIntOf, recordOf, stringOf, stringsOf } from '../lib/json.ts'
import { finalizeListing, modelInfo } from '../lib/models.ts'
import { topLevelReasoning } from '../lib/reasoning.ts'

const PROVIDER = { id: 'deepseek', name: 'DeepSeek' }
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
/** DeepSeek effort levels -> efforts of the menu. */
const LISTED_LEVELS: Readonly<Record<string, ReasoningEffort>> = { low: 'low', medium: 'medium', high: 'high', max: 'max' }

export const deepseekProvider: ProviderDefinition = {
  id: 'deepseek',
  name: 'DeepSeek',
  icon: 'lobe:deepseek',
  credentials: [apiKeyField('DEEPSEEK_API_KEY'), baseUrlField(DEEPSEEK_BASE_URL)],
  modelsDevId: 'deepseek',
  keyUrl: 'https://platform.deepseek.com/api_keys',
  smallModelId: 'deepseek-flash',
  seedModels: [
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      contextWindow: 1_048_576,
      maxOutputTokens: 393_216,
      capabilities: { tools: true, vision: false, reasoning: true, structuredOutput: true },
      reasoningEfforts: ['off', 'low', 'high', 'max'],
      cost: { input: 0.435, output: 0.87, cacheRead: 0.003625 },
    },
    {
      id: 'deepseek-flash',
      name: 'DeepSeek V4.1 Flash',
      contextWindow: 1_048_576,
      maxOutputTokens: 393_216,
      capabilities: { tools: true, vision: true, reasoning: true, structuredOutput: true },
      reasoningEfforts: ['off', 'low', 'high', 'max'],
      cost: { input: 0.15, output: 0.6, cacheRead: 0.003 },
    },
  ],
  createLanguageModel(modelId, rt) {
    return createDeepSeek({ apiKey: apiKeyOf(rt), baseURL: baseUrlOf(rt, DEEPSEEK_BASE_URL), fetch: rt.fetch })(modelId)
  },
  async listModels(rt) {
    const body = recordOf(await requestJson(rt, `${baseUrlOf(rt, DEEPSEEK_BASE_URL)}/models`, {
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
      const levels = stringsOf(recordOf(record.effort)?.supported_levels)
        .map(level => LISTED_LEVELS[level])
        .filter((effort): effort is ReasoningEffort => effort !== undefined)
      const inputModalities = stringsOf(record.input_modalities)
      models.push(modelInfo({
        id,
        name: stringOf(record.name),
        contextWindow: positiveIntOf(record.context_window),
        maxOutputTokens: positiveIntOf(record.max_output_tokens),
        capabilities: {
          vision: inputModalities.length > 0 ? inputModalities.includes('image') : undefined,
          reasoning: levels.length > 0 ? true : undefined,
        },
        reasoningEfforts: levels.length > 0 ? ['off', ...levels] : undefined,
      }))
    }
    return finalizeListing(models)
  },
  reasoning(effort) {
    // `medium` is not offered (DeepSeek has low / high / max); the package would map it to `high`.
    return topLevelReasoning(effort === 'medium' ? 'high' : effort)
  },
  mapError(err) {
    return mapProviderError(err, PROVIDER, [paymentRequiredRule('DeepSeek account balance is insufficient. Top up the account and try again.')])
  },
}
