// Alibaba (Qwen): `@ai-sdk/alibaba` on the DashScope OpenAI-compatible endpoint (PROVIDERS.md sections 1-6). Keys are
// regional; the default is the international (Singapore) endpoint.
import type { ModelInfo, ProviderDefinition } from '@harness-forge/plugin-sdk'
import { createAlibaba } from '@ai-sdk/alibaba'
import { apiKeyField, apiKeyOf, baseUrlField, baseUrlOf } from '../lib/credentials.ts'
import { mapProviderError } from '../lib/errors.ts'
import { requestJson, unexpectedListing } from '../lib/http.ts'
import { recordOf, stringOf } from '../lib/json.ts'
import { finalizeListing, modelInfo } from '../lib/models.ts'
import { topLevelReasoning } from '../lib/reasoning.ts'

const PROVIDER = { id: 'alibaba', name: 'Alibaba Cloud' }
export const ALIBABA_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
/** Chat model families of the listing. */
const CHAT_IDS = /^(?:qwen|qwq)/i
/** Non-chat models of those families (PROVIDERS.md section 3). */
const NON_CHAT_IDS = /embed|tts|asr|image|wan|realtime|livetranslate|-mt-/i

export const alibabaProvider: ProviderDefinition = {
  id: 'alibaba',
  name: 'Alibaba (Qwen)',
  icon: 'lobe:qwen',
  credentials: [apiKeyField(['ALIBABA_API_KEY', 'DASHSCOPE_API_KEY']), baseUrlField(ALIBABA_BASE_URL)],
  modelsDevId: 'alibaba',
  keyUrl: 'https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key',
  smallModelId: 'qwen3.8-flash',
  seedModels: [
    {
      id: 'qwen3.8-max',
      name: 'Qwen3.8 Max',
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      capabilities: { tools: true, vision: true, pdf: true, reasoning: true, structuredOutput: true },
      reasoningEfforts: ['off', 'low', 'medium', 'high'],
      cost: { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5 },
    },
    {
      id: 'qwen3.7-plus',
      name: 'Qwen3.7 Plus',
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      capabilities: { tools: true, vision: true, reasoning: true },
      reasoningEfforts: ['off', 'low', 'medium', 'high'],
      cost: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.625 },
    },
  ],
  createLanguageModel(modelId, rt) {
    return createAlibaba({ apiKey: apiKeyOf(rt), baseURL: baseUrlOf(rt, ALIBABA_BASE_URL), fetch: rt.fetch })(modelId)
  },
  async listModels(rt) {
    const body = recordOf(await requestJson(rt, `${baseUrlOf(rt, ALIBABA_BASE_URL)}/models`, {
      headers: { authorization: `Bearer ${apiKeyOf(rt)}` },
    }))
    if (!body || !Array.isArray(body.data))
      throw unexpectedListing(PROVIDER.name)
    const models: ModelInfo[] = []
    for (const entry of body.data) {
      const id = stringOf(recordOf(entry)?.id)
      if (id && CHAT_IDS.test(id) && !NON_CHAT_IDS.test(id))
        models.push(modelInfo({ id }))
    }
    return finalizeListing(models)
  },
  reasoning(effort) {
    // The package turns the level into `enable_thinking` + `thinking_budget` (2 / 10 / 30 / 60 / 90 % of 16384).
    return topLevelReasoning(effort)
  },
  mapError(err) {
    return mapProviderError(err, PROVIDER)
  },
}
