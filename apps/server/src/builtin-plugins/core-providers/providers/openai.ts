// OpenAI (ChatGPT): `@ai-sdk/openai`, always the Responses API (PROVIDERS.md sections 1-6).
import type { ModelInfo, ProviderDefinition, ReasoningEffort } from '@harness-forge/plugin-sdk'
import { createOpenAI } from '@ai-sdk/openai'
import { apiKeyField, apiKeyOf, baseUrlField, baseUrlOf } from '../lib/credentials.ts'
import { mapProviderError } from '../lib/errors.ts'
import { requestJson, unexpectedListing } from '../lib/http.ts'
import { recordOf, stringOf } from '../lib/json.ts'
import { finalizeListing, modelInfo } from '../lib/models.ts'
import { topLevelReasoning } from '../lib/reasoning.ts'

const PROVIDER = { id: 'openai', name: 'OpenAI' }
export const OPENAI_BASE_URL = 'https://api.openai.com/v1'

/** Listed ids that are not chat models (PROVIDERS.md section 3). */
const NON_CHAT_IDS = /embedding|tts|whisper|transcribe|dall-e|gpt-image|moderation|realtime|audio|sora|babbage|davinci|computer-use|search/i
const O_SERIES = /^o\d+(?:-|$)/
const GPT_VERSION = /^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$/

/**
 * Efforts offered for a model id, `undefined` for models that do not reason. Reasoning models and the GPT-6 effort
 * lists follow `getOpenAILanguageModelCapabilities` of `@ai-sdk/openai` 4.0.78; `none` exists from GPT-5.1 on, `max`
 * on GPT-5.6 and GPT-6 (PROVIDERS.md section 4).
 */
export function openaiReasoningEfforts(modelId: string): ReasoningEffort[] | undefined {
  if (O_SERIES.test(modelId))
    return ['low', 'medium', 'high']
  const match = modelId.match(GPT_VERSION)
  if (!match)
    return undefined
  const major = Number(match[1])
  const minor = match[2] === undefined ? undefined : Number(match[2])
  const chatModel = minor === undefined && (match[3]?.startsWith('chat') ?? false)
  if (major < 5 || chatModel)
    return undefined
  if (modelId === 'gpt-6-sol' || modelId === 'gpt-6-luna')
    return ['off', 'low', 'medium', 'high', 'max']
  if (major >= 6)
    return ['low', 'medium', 'high', 'max']
  const efforts: ReasoningEffort[] = []
  if ((minor ?? 0) >= 1)
    efforts.push('off')
  efforts.push('low', 'medium', 'high')
  if ((minor ?? 0) >= 6)
    efforts.push('max')
  return efforts
}

export const openaiProvider: ProviderDefinition = {
  id: 'openai',
  name: 'OpenAI (ChatGPT)',
  icon: 'lobe:openai',
  credentials: [apiKeyField('OPENAI_API_KEY'), baseUrlField(OPENAI_BASE_URL)],
  modelsDevId: 'openai',
  keyUrl: 'https://platform.openai.com/api-keys',
  smallModelId: 'gpt-6-luna',
  seedModels: [
    {
      id: 'gpt-6-astra',
      name: 'GPT-6 Astra',
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      capabilities: { tools: true, vision: true, pdf: true, reasoning: true, structuredOutput: true },
      reasoningEfforts: ['low', 'medium', 'high', 'max'],
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    },
    {
      id: 'gpt-6-sol',
      name: 'GPT-6 Sol',
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      capabilities: { tools: true, vision: true, pdf: true, reasoning: true, structuredOutput: true },
      reasoningEfforts: ['off', 'low', 'medium', 'high', 'max'],
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    },
    {
      id: 'gpt-6-luna',
      name: 'GPT-6 Luna',
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      capabilities: { tools: true, vision: true, pdf: true, reasoning: true, structuredOutput: true },
      reasoningEfforts: ['off', 'low', 'medium', 'high', 'max'],
      cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    },
  ],
  createLanguageModel(modelId, rt) {
    return createOpenAI({ apiKey: apiKeyOf(rt), baseURL: baseUrlOf(rt, OPENAI_BASE_URL), fetch: rt.fetch }).responses(modelId)
  },
  async listModels(rt) {
    const body = recordOf(await requestJson(rt, `${baseUrlOf(rt, OPENAI_BASE_URL)}/models`, {
      headers: { authorization: `Bearer ${apiKeyOf(rt)}` },
    }))
    if (!body || !Array.isArray(body.data))
      throw unexpectedListing(PROVIDER.name)
    const models: ModelInfo[] = []
    for (const entry of body.data) {
      const id = stringOf(recordOf(entry)?.id)
      if (!id || NON_CHAT_IDS.test(id))
        continue
      const efforts = openaiReasoningEfforts(id)
      models.push(modelInfo({ id, capabilities: { reasoning: efforts ? true : undefined }, reasoningEfforts: efforts }))
    }
    return finalizeListing(models)
  },
  reasoning(effort) {
    if (effort === 'max')
      return { providerOptions: { openai: { reasoningEffort: 'max' } } }
    return topLevelReasoning(effort)
  },
  mapError(err) {
    return mapProviderError(err, PROVIDER)
  },
}
