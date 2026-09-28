// Groq: `@ai-sdk/groq` (PROVIDERS.md sections 1-6). Reasoning models other than gpt-oss always get
// `reasoningFormat: 'parsed'` (Groq defaults to `raw`, which puts `<think>` text into the answer). Whisper models serve
// transcription (PROVIDERS.md section 13); the package has no speech models.
import type { ModelInfo, ProviderDefinition, ProviderRuntime, ReasoningEffort } from '@harness-forge/plugin-sdk'
import { createGroq } from '@ai-sdk/groq'
import { apiKeyField, apiKeyOf, baseUrlField, baseUrlOf } from '../lib/credentials.ts'
import { mapProviderError } from '../lib/errors.ts'
import { requestJson, unexpectedListing } from '../lib/http.ts'
import { booleanOf, positiveIntOf, recordOf, stringOf } from '../lib/json.ts'
import { withDefaultSettings } from '../lib/language-model.ts'
import { transcriptionLanguage, transcriptionSeed } from '../lib/media.ts'
import { finalizeListing, modelInfo } from '../lib/models.ts'
import { TOP_LEVEL_REASONING } from '../lib/reasoning.ts'

const PROVIDER = { id: 'groq', name: 'Groq' }
export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1'
/** Speech, guard and safety models of the listing (PROVIDERS.md section 3); Whisper models are kept before this filter. */
const NON_CHAT_IDS = /whisper|orpheus|tts|prompt-guard|safeguard/i
/** Transcription models of the listing (`.transcription(id)`). */
const TRANSCRIPTION_IDS = /^whisper-/i
/** gpt-oss reasons but rejects `reasoning_format` and cannot disable reasoning. */
const GPT_OSS = /(?:^|\/)gpt-oss/i
/** Reasoning models that emit `<think>` text unless `reasoning_format` is `parsed`. */
const THINK_TAG_MODELS = /(?:^|\/)(?:qwen3|qwen-qwq|qwq|deepseek-r1)/i
/** Qwen models that accept `reasoning_effort: 'none'`. */
const QWEN_WITH_NONE = /^qwen\/qwen3\.\d+/i

/** True when every request to the model gets `providerOptions.groq.reasoningFormat = 'parsed'`. */
export function usesParsedReasoningFormat(modelId: string): boolean {
  return THINK_TAG_MODELS.test(modelId) && !GPT_OSS.test(modelId)
}

/** Efforts offered for a model id; `undefined` when unknown. */
export function groqReasoningEfforts(modelId: string): ReasoningEffort[] | undefined {
  if (GPT_OSS.test(modelId))
    return ['low', 'medium', 'high']
  if (QWEN_WITH_NONE.test(modelId))
    return ['off', 'low', 'medium', 'high']
  return undefined
}

function client(rt: ProviderRuntime) {
  return createGroq({ apiKey: apiKeyOf(rt), baseURL: baseUrlOf(rt, GROQ_BASE_URL), fetch: rt.fetch })
}

function createGroqModel(modelId: string, rt: ProviderRuntime) {
  const model = client(rt)(modelId)
  if (!usesParsedReasoningFormat(modelId))
    return model
  return withDefaultSettings(model, { providerOptions: { groq: { reasoningFormat: 'parsed' } } })
}

export const groqProvider: ProviderDefinition = {
  id: 'groq',
  name: 'Groq',
  icon: 'lobe:groq',
  credentials: [apiKeyField('GROQ_API_KEY'), baseUrlField(GROQ_BASE_URL)],
  modelsDevId: 'groq',
  keyUrl: 'https://console.groq.com/keys',
  smallModelId: 'openai/gpt-oss-20b',
  seedModels: [
    {
      id: 'openai/gpt-oss-120b',
      name: 'GPT OSS 120B',
      contextWindow: 131_072,
      maxOutputTokens: 65_536,
      capabilities: { tools: true, vision: false, reasoning: true, structuredOutput: true },
      reasoningEfforts: ['low', 'medium', 'high'],
      cost: { input: 0.15, output: 0.6, cacheRead: 0.075 },
    },
    {
      id: 'qwen/qwen3.8-27b',
      name: 'Qwen3.8 27B',
      contextWindow: 131_072,
      maxOutputTokens: 16_384,
      capabilities: { tools: true, vision: true, reasoning: true, structuredOutput: true },
      reasoningEfforts: ['off', 'low', 'medium', 'high'],
      cost: { input: 0.8, output: 4 },
    },
    transcriptionSeed('whisper-large-v3-turbo', 'Whisper Large V3 Turbo'),
    transcriptionSeed('whisper-large-v3', 'Whisper Large V3'),
  ],
  createLanguageModel: createGroqModel,
  async listModels(rt) {
    const body = recordOf(await requestJson(rt, `${baseUrlOf(rt, GROQ_BASE_URL)}/models`, {
      headers: { authorization: `Bearer ${apiKeyOf(rt)}` },
    }))
    if (!body || !Array.isArray(body.data))
      throw unexpectedListing(PROVIDER.name)
    const models: ModelInfo[] = []
    for (const entry of body.data) {
      const record = recordOf(entry)
      const id = stringOf(record?.id)
      if (!record || !id || booleanOf(record.active) === false)
        continue
      if (TRANSCRIPTION_IDS.test(id)) {
        models.push(modelInfo({ id, kind: 'transcription' }))
        continue
      }
      if (NON_CHAT_IDS.test(id))
        continue
      const efforts = groqReasoningEfforts(id)
      models.push(modelInfo({
        id,
        contextWindow: positiveIntOf(record.context_window),
        maxOutputTokens: positiveIntOf(record.max_completion_tokens),
        capabilities: { reasoning: efforts ? true : undefined },
        reasoningEfforts: efforts,
      }))
    }
    return finalizeListing(models)
  },
  reasoning(effort) {
    if (effort === 'auto')
      return undefined
    // The package sends `none` only for qwen/qwen3.6-27b; Groq also accepts it on newer Qwen models.
    if (effort === 'off')
      return { providerOptions: { groq: { reasoningEffort: 'none' } } }
    // `max` is not offered; the package maps `xhigh` to `high`.
    return { reasoning: TOP_LEVEL_REASONING[effort] }
  },
  mapError(err) {
    return mapProviderError(err, PROVIDER)
  },
  createTranscriptionModel(modelId, rt) {
    return client(rt).transcription(modelId)
  },
  transcriptionOptions(hints) {
    const language = transcriptionLanguage(hints)
    return language === undefined ? undefined : { groq: { language } }
  },
}
