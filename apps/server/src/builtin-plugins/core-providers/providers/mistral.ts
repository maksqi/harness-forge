// Mistral: `@ai-sdk/mistral` (PROVIDERS.md sections 1-6). Only some models accept an effort, and only `none` / `high`.
// Voxtral models serve transcription and speech (PROVIDERS.md section 13).
import type { ModelInfo, ProviderDefinition, ProviderRuntime, ReasoningEffort } from '@harness-forge/plugin-sdk'
import type { JsonRecord } from '../lib/json.ts'
import { createMistral } from '@ai-sdk/mistral'
import { apiKeyField, apiKeyOf, baseUrlField, baseUrlOf } from '../lib/credentials.ts'
import { mapProviderError } from '../lib/errors.ts'
import { requestJson, unexpectedListing } from '../lib/http.ts'
import { booleanOf, positiveIntOf, recordOf, stringOf } from '../lib/json.ts'
import { speechSeed, transcriptionLanguage, transcriptionSeed } from '../lib/media.ts'
import { finalizeListing, modelInfo } from '../lib/models.ts'
import { ON_OFF_EFFORTS } from '../lib/reasoning.ts'

const PROVIDER = { id: 'mistral', name: 'Mistral' }
export const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1'

/** Model ids that accept `reasoning_effort` (`reasoningEffortModelIds` of `@ai-sdk/mistral` 4.0.52). */
const EFFORT_MODEL_IDS: ReadonlySet<string> = new Set([
  'glm-5-2',
  'labs-leanstral-1-5',
  'labs-leanstral-1-5-1',
  'magistral-medium-latest',
  'magistral-small-latest',
  'mistral-medium',
  'mistral-medium-2604',
  'mistral-medium-3',
  'mistral-medium-3-5',
  'mistral-medium-3.5',
  'mistral-medium-latest',
  'mistral-small-2603',
  'mistral-small-latest',
  'mistral-vibe-cli-fast',
  'mistral-vibe-cli-latest',
  'mistral-vibe-cli-with-tools',
  'zai-glm-5-2',
])

/** `off` / `high` for the models with an effort parameter, `undefined` otherwise. */
export function mistralReasoningEfforts(modelId: string): ReasoningEffort[] | undefined {
  return EFFORT_MODEL_IDS.has(modelId) ? [...ON_OFF_EFFORTS] : undefined
}

/** A deprecation date in the past retires the model; a future date only announces it. */
function isRetired(entry: JsonRecord, now: number): boolean {
  if (booleanOf(entry.archived) === true)
    return true
  const deprecation = stringOf(entry.deprecation)
  const date = deprecation === undefined ? Number.NaN : Date.parse(deprecation)
  return !Number.isNaN(date) && date <= now
}

/** Chat models of the listing, without retired ones and with one entry per canonical model (aliases hidden). */
export function mistralModels(data: readonly unknown[], now: number = Date.now()): ModelInfo[] {
  const canonical = new Map<string, JsonRecord>()
  for (const item of data) {
    const entry = recordOf(item)
    const id = stringOf(entry?.id)
    if (!entry || !id || booleanOf(recordOf(entry.capabilities)?.completion_chat) !== true || isRetired(entry, now))
      continue
    // Aliases share the canonical `name`; prefer the entry whose id is that name.
    const key = stringOf(entry.name) ?? id
    const current = canonical.get(key)
    if (!current || (stringOf(current.id) !== key && id === key))
      canonical.set(key, entry)
  }
  const models: ModelInfo[] = []
  for (const entry of canonical.values()) {
    const id = stringOf(entry.id) ?? ''
    const capabilities = recordOf(entry.capabilities)
    const efforts = mistralReasoningEfforts(id)
    models.push(modelInfo({
      id,
      contextWindow: positiveIntOf(entry.max_context_length),
      capabilities: {
        tools: booleanOf(capabilities?.function_calling),
        vision: booleanOf(capabilities?.vision),
        reasoning: efforts ? true : undefined,
      },
      reasoningEfforts: efforts,
    }))
  }
  return finalizeListing(models)
}

function client(rt: ProviderRuntime) {
  return createMistral({ apiKey: apiKeyOf(rt), baseURL: baseUrlOf(rt, MISTRAL_BASE_URL), fetch: rt.fetch })
}

export const mistralProvider: ProviderDefinition = {
  id: 'mistral',
  name: 'Mistral',
  icon: 'lobe:mistral',
  credentials: [apiKeyField('MISTRAL_API_KEY'), baseUrlField(MISTRAL_BASE_URL)],
  modelsDevId: 'mistral',
  keyUrl: 'https://console.mistral.ai/api-keys',
  smallModelId: 'mistral-small-latest',
  seedModels: [
    {
      id: 'mistral-medium-2604',
      name: 'Mistral Medium 3.5',
      contextWindow: 262_144,
      maxOutputTokens: 262_144,
      capabilities: { tools: true, vision: true, reasoning: true, structuredOutput: true },
      reasoningEfforts: ['off', 'high'],
      cost: { input: 1.5, output: 7.5 },
    },
    {
      id: 'mistral-large-2512',
      name: 'Mistral Large 3',
      contextWindow: 262_144,
      maxOutputTokens: 262_144,
      capabilities: { tools: true, vision: true, reasoning: false },
      cost: { input: 0.5, output: 1.5 },
    },
    transcriptionSeed('voxtral-mini-latest', 'Voxtral Mini (latest)'),
    // No voice list is known: the voice field takes a voice id from the Mistral console.
    speechSeed('voxtral-mini-tts-latest', 'Voxtral Mini TTS (latest)'),
  ],
  createLanguageModel(modelId, rt) {
    return client(rt)(modelId)
  },
  async listModels(rt) {
    const body = recordOf(await requestJson(rt, `${baseUrlOf(rt, MISTRAL_BASE_URL)}/models`, {
      headers: { authorization: `Bearer ${apiKeyOf(rt)}` },
    }))
    if (!body || !Array.isArray(body.data))
      throw unexpectedListing(PROVIDER.name)
    return mistralModels(body.data)
  },
  reasoning(effort) {
    if (effort === 'auto')
      return undefined
    // Mistral accepts `none` and `high` only; the package maps every other level to `high`.
    return { reasoning: effort === 'off' ? 'none' : 'high' }
  },
  mapError(err) {
    return mapProviderError(err, PROVIDER)
  },
  createTranscriptionModel(modelId, rt) {
    return client(rt).transcription(modelId)
  },
  createSpeechModel(modelId, rt) {
    return client(rt).speech(modelId)
  },
  transcriptionOptions(hints) {
    const language = transcriptionLanguage(hints)
    return language === undefined ? undefined : { mistral: { language } }
  },
}
