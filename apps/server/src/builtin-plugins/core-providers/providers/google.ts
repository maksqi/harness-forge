// Google (Gemini): `@ai-sdk/google` Generative Language API (PROVIDERS.md sections 1-6); image output of chat models,
// transcription and speech models (PROVIDERS.md section 13).
import type { ModelInfo, ProviderDefinition, ProviderRuntime, ReasoningEffort } from '@harness-forge/plugin-sdk'
import type { ErrorRule } from '../lib/errors.ts'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { apiKeyField, apiKeyOf, baseUrlField, baseUrlOf } from '../lib/credentials.ts'
import { mapped, mapProviderError } from '../lib/errors.ts'
import { requestJson, unexpectedListing } from '../lib/http.ts'
import { booleanOf, positiveIntOf, recordOf, stringOf, stringsOf } from '../lib/json.ts'
import { speechSeed, transcriptionLanguage } from '../lib/media.ts'
import { finalizeListing, modelInfo } from '../lib/models.ts'
import { TOP_LEVEL_REASONING } from '../lib/reasoning.ts'

const PROVIDER = { id: 'google', name: 'Google' }
export const GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
/** Safety cap of the `nextPageToken` pagination. */
const MAX_PAGES = 20
/** Listed models that are not chat models (PROVIDERS.md section 3); the media ids below are kept before this filter. */
const NON_CHAT_IDS = /embedding|aqa|imagen|veo|tts|live|native-audio|-image/i
/** Live API models (WebSocket only): never kept, not even as media models. */
const LIVE_IDS = /live|native-audio/i
/** Text-to-speech models of the listing (`.speech(id)`). */
const SPEECH_IDS = /-tts/i
/**
 * Chat models that answer with images (`capabilities.imageOutput`): kept with an explicit `chat` kind, because the id
 * fallback of the catalog's `classify()` would take an id containing "image" for a dedicated image model.
 */
const IMAGE_OUTPUT_IDS = /^(?:gemini-.*-image|nano-banana)/i

/** The prebuilt voices of the Gemini text-to-speech models, `Kore` being the package default (unverified). */
export const GEMINI_TTS_VOICES: readonly string[] = [
  'Zephyr',
  'Puck',
  'Charon',
  'Kore',
  'Fenrir',
  'Leda',
  'Orus',
  'Aoede',
  'Callirrhoe',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba',
  'Despina',
  'Erinome',
  'Algenib',
  'Rasalgethi',
  'Laomedeia',
  'Achernar',
  'Alnilam',
  'Schedar',
  'Gacrux',
  'Pulcherrima',
  'Achird',
  'Zubenelgenubi',
  'Vindemiatrix',
  'Sadachbia',
  'Sadaltager',
  'Sulafat',
]

const GEMINI_25 = /(?:^|\/)gemini-2\.5(?:[.-]|$)/i
const GEMINI_25_PRO = /(?:^|\/)gemini-2\.5-pro(?:-|$)/i
const GEMINI = /(?:^|\/)gemini-/i
const PRE_GEMINI_3 = /(?:^|\/)gemini-(?:1|2)(?:[.-]|$)|(?:^|\/)gemini-pro(?:-vision)?$/i

/**
 * Efforts offered for a thinking model id (same model families as `@ai-sdk/google` 4.0.82): Gemini 3 and later cannot
 * disable thinking and top out at `high`; Gemini 2.5 uses budgets (`off` = budget 0, which 2.5 Pro rejects).
 */
export function googleReasoningEfforts(modelId: string): ReasoningEffort[] | undefined {
  if (GEMINI_25.test(modelId))
    return GEMINI_25_PRO.test(modelId) ? ['low', 'medium', 'high', 'max'] : ['off', 'low', 'medium', 'high', 'max']
  if (GEMINI.test(modelId) && !PRE_GEMINI_3.test(modelId))
    return ['low', 'medium', 'high']
  return undefined
}

function client(rt: ProviderRuntime) {
  return createGoogleGenerativeAI({ apiKey: apiKeyOf(rt), baseURL: baseUrlOf(rt, GOOGLE_BASE_URL), fetch: rt.fetch })
}

/** HTTP 400 with reason `API_KEY_INVALID` is an invalid key, not a bad request. */
const apiKeyInvalidRule: ErrorRule = (facts, provider) => {
  if (!facts.codes.has('api_key_invalid'))
    return undefined
  return mapped(facts, provider, {
    code: 'auth_invalid',
    message: 'The Google API key was rejected. Check the key in Settings > Providers.',
    action: 'configure-provider',
  })
}

export const googleProvider: ProviderDefinition = {
  id: 'google',
  name: 'Google (Gemini)',
  icon: 'lobe:gemini',
  credentials: [apiKeyField(['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']), baseUrlField(GOOGLE_BASE_URL)],
  modelsDevId: 'google',
  keyUrl: 'https://aistudio.google.com/app/apikey',
  smallModelId: 'gemini-3.5-flash-lite',
  seedModels: [
    {
      id: 'gemini-3.8-flash',
      name: 'Gemini 3.8 Flash',
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      capabilities: { tools: true, vision: true, pdf: true, reasoning: true, structuredOutput: true },
      reasoningEfforts: ['low', 'medium', 'high'],
      cost: { input: 0.75, output: 3.75, cacheRead: 0.075 },
    },
    {
      id: 'gemini-3.1-pro-preview',
      name: 'Gemini 3.1 Pro Preview',
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      capabilities: { tools: true, vision: true, pdf: true, reasoning: true, structuredOutput: true },
      reasoningEfforts: ['low', 'medium', 'high'],
      cost: { input: 2, output: 12, cacheRead: 0.2 },
    },
    // No transcription seed: `gemini-3.5-transcribe` exists only in the package's id union (unverified).
    speechSeed('gemini-3.1-flash-tts-preview', 'Gemini 3.1 Flash TTS Preview', GEMINI_TTS_VOICES),
    speechSeed('gemini-2.5-flash-preview-tts', 'Gemini 2.5 Flash Preview TTS', GEMINI_TTS_VOICES),
    speechSeed('gemini-2.5-pro-preview-tts', 'Gemini 2.5 Pro Preview TTS', GEMINI_TTS_VOICES),
  ],
  createLanguageModel(modelId, rt) {
    return client(rt)(modelId)
  },
  async listModels(rt) {
    const models: ModelInfo[] = []
    let pageToken: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${baseUrlOf(rt, GOOGLE_BASE_URL)}/models`)
      url.searchParams.set('pageSize', '1000')
      if (pageToken)
        url.searchParams.set('pageToken', pageToken)
      const body = recordOf(await requestJson(rt, url.toString(), { headers: { 'x-goog-api-key': apiKeyOf(rt) } }))
      if (!body || (body.models !== undefined && !Array.isArray(body.models)))
        throw unexpectedListing(PROVIDER.name)
      for (const entry of Array.isArray(body.models) ? body.models : []) {
        const record = recordOf(entry)
        const id = stringOf(record?.name)?.replace(/^models\//, '')
        if (!record || !id || LIVE_IDS.test(id) || !stringsOf(record.supportedGenerationMethods).includes('generateContent'))
          continue
        const name = stringOf(record.displayName)
        if (SPEECH_IDS.test(id)) {
          models.push(modelInfo({ id, name, kind: 'speech', voices: GEMINI_TTS_VOICES }))
          continue
        }
        const imageOutput = IMAGE_OUTPUT_IDS.test(id)
        if (!imageOutput && NON_CHAT_IDS.test(id))
          continue
        const thinking = booleanOf(record.thinking)
        models.push(modelInfo({
          id,
          name,
          kind: imageOutput ? 'chat' : undefined,
          contextWindow: positiveIntOf(record.inputTokenLimit),
          maxOutputTokens: positiveIntOf(record.outputTokenLimit),
          capabilities: { reasoning: thinking, imageOutput: imageOutput ? true : undefined },
          reasoningEfforts: thinking === true ? googleReasoningEfforts(id) : undefined,
        }))
      }
      pageToken = stringOf(body.nextPageToken)
      if (!pageToken)
        break
    }
    return finalizeListing(models)
  },
  reasoning(effort) {
    if (effort === 'auto')
      return undefined
    if (effort === 'off')
      return { reasoning: 'none' }
    // Thought summaries need `includeThoughts`; the package merges it with the level derived from `reasoning`.
    return { reasoning: TOP_LEVEL_REASONING[effort], providerOptions: { google: { thinkingConfig: { includeThoughts: true } } } }
  },
  mapError(err) {
    return mapProviderError(err, PROVIDER, [apiKeyInvalidRule])
  },
  // No `createImageModel`: images come from the chat models with image output (the package's `.image()` is not wired).
  imageParams(request) {
    // Only called for chat models with `capabilities.imageOutput`: ask for text and images, at the aspect ratio if any.
    const imageConfig = request.aspectRatio === undefined ? {} : { imageConfig: { aspectRatio: request.aspectRatio } }
    return { providerOptions: { google: { responseModalities: ['TEXT', 'IMAGE'], ...imageConfig } } }
  },
  createTranscriptionModel(modelId, rt) {
    return client(rt).transcription(modelId)
  },
  createSpeechModel(modelId, rt) {
    return client(rt).speech(modelId)
  },
  transcriptionOptions(hints) {
    const language = transcriptionLanguage(hints)
    return language === undefined ? undefined : { google: { languageCodes: [language] } }
  },
}
