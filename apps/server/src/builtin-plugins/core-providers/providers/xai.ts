// xAI (Grok): `@ai-sdk/xai` 5.x, Responses API only for chat (PROVIDERS.md sections 1-6); image, transcription and
// speech models (PROVIDERS.md section 13).
import type { ModelInfo, ProviderDefinition, ProviderRuntime, ReasoningEffort } from '@harness-forge/plugin-sdk'
import { createXai } from '@ai-sdk/xai'
import { apiKeyField, apiKeyOf, baseUrlField, baseUrlOf } from '../lib/credentials.ts'
import { mapProviderError } from '../lib/errors.ts'
import { requestJson, unexpectedListing } from '../lib/http.ts'
import { recordOf, stringOf } from '../lib/json.ts'
import { imageSeed, speechSeed, transcriptionLanguage, transcriptionSeed } from '../lib/media.ts'
import { finalizeListing, modelInfo } from '../lib/models.ts'
import { topLevelReasoning } from '../lib/reasoning.ts'

const PROVIDER = { id: 'xai', name: 'xAI' }
export const XAI_BASE_URL = 'https://api.x.ai/v1'
/** Image models of the listing (`.image(id)`), kept before the filter below. */
const IMAGE_IDS = /^grok-imagine-image/i
/** The other generation models of the listing (video): dropped. */
const NON_CHAT_IDS = /^grok-imagine/i
/** Variants without an effort parameter (`supportsReasoningEffort` of `@ai-sdk/xai` 5.0.10). */
const WITHOUT_EFFORT = /^grok-4\.20(?:-\d{4})?-(non-)?reasoning$/

/** Catalog key of the speech-to-text model: `.transcription()` takes no model id (one `/stt` endpoint). */
export const XAI_TRANSCRIPTION_MODEL_ID = 'stt'
/** Catalog key of the text-to-speech model: `.speech()` takes no model id (one `/tts` endpoint). */
export const XAI_SPEECH_MODEL_ID = 'tts'
/** Voices of the text-to-speech model, `eve` first (the package default; vendor docs, unverified). */
export const XAI_VOICES: readonly string[] = ['eve', 'ara', 'leo', 'rex', 'sal']

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

function client(rt: ProviderRuntime) {
  return createXai({ apiKey: apiKeyOf(rt), baseURL: baseUrlOf(rt, XAI_BASE_URL), fetch: rt.fetch })
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
    imageSeed('grok-imagine-image', 'Grok Imagine Image'),
    transcriptionSeed(XAI_TRANSCRIPTION_MODEL_ID, 'xAI Speech to Text'),
    speechSeed(XAI_SPEECH_MODEL_ID, 'xAI Text to Speech', XAI_VOICES),
  ],
  createLanguageModel(modelId, rt) {
    return client(rt)(modelId)
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
      if (!id)
        continue
      if (IMAGE_IDS.test(id)) {
        models.push(modelInfo({ id, kind: 'image', capabilities: { vision: true } }))
        continue
      }
      if (NON_CHAT_IDS.test(id))
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
  createImageModel(modelId, rt) {
    return client(rt).image(modelId)
  },
  imageParams(request) {
    // The package ignores `size` and sends `aspect_ratio`; it splits `n` into calls of at most 3 images.
    return request.aspectRatio === undefined ? undefined : { aspectRatio: request.aspectRatio }
  },
  createTranscriptionModel(_modelId, rt) {
    // Every transcription id (the catalog key `stt`) is the one speech-to-text endpoint.
    return client(rt).transcription()
  },
  createSpeechModel(_modelId, rt) {
    // Every speech id (the catalog key `tts`) is the one text-to-speech endpoint.
    return client(rt).speech()
  },
  transcriptionOptions(hints) {
    const language = transcriptionLanguage(hints)
    return language === undefined ? undefined : { xai: { language } }
  },
}
