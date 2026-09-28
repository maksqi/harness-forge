// OpenAI (ChatGPT): `@ai-sdk/openai`, always the Responses API for chat (PROVIDERS.md sections 1-6); image,
// transcription and speech models (PROVIDERS.md section 13).
import type { ImageAspectRatio, ModelInfo, ProviderDefinition, ProviderRuntime, ReasoningEffort } from '@harness-forge/plugin-sdk'
import { createOpenAI } from '@ai-sdk/openai'
import { apiKeyField, apiKeyOf, baseUrlField, baseUrlOf } from '../lib/credentials.ts'
import { mapProviderError } from '../lib/errors.ts'
import { requestJson, unexpectedListing } from '../lib/http.ts'
import { recordOf, stringOf } from '../lib/json.ts'
import { imageSeed, speechSeed, transcriptionLanguage, transcriptionSeed } from '../lib/media.ts'
import { finalizeListing, modelInfo } from '../lib/models.ts'
import { topLevelReasoning } from '../lib/reasoning.ts'

const PROVIDER = { id: 'openai', name: 'OpenAI' }
export const OPENAI_BASE_URL = 'https://api.openai.com/v1'

/** Listed ids that are not chat models (PROVIDERS.md section 3); the media ids below are kept before this filter. */
const NON_CHAT_IDS = /embedding|tts|whisper|transcribe|dall-e|gpt-image|moderation|realtime|audio|sora|babbage|davinci|computer-use|search/i
/** Realtime models (WebSocket only): never kept, not even as media models. */
const REALTIME_IDS = /realtime/i
/** Image models of the listing (`.image(id)`). */
const IMAGE_IDS = /^(?:gpt-image|chatgpt-image)/i
/** Transcription models of the listing (`.transcription(id)`), besides `whisper-1`. */
const TRANSCRIPTION_IDS = /transcribe/i
/** Speech models of the listing (`.speech(id)`). */
const SPEECH_IDS = /^tts-|-tts/i
const O_SERIES = /^o\d+(?:-|$)/
const GPT_VERSION = /^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$/

/** Voices of `tts-1` and `tts-1-hd` (vendor docs, unverified; PROVIDERS.md section 13). */
export const OPENAI_TTS_VOICES: readonly string[] = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer']
/** Voices of `gpt-4o-mini-tts` (and other `*-tts*` models): the `tts-1` voices plus four more (unverified). */
export const OPENAI_GPT_TTS_VOICES: readonly string[] = [...OPENAI_TTS_VOICES, 'ballad', 'verse', 'marin', 'cedar']

/** `size` by aspect ratio (square, portrait, landscape): the package ignores `aspectRatio` and sends `size`. */
const IMAGE_SIZES: Readonly<Record<ImageAspectRatio, `${number}x${number}`>> = {
  '1:1': '1024x1024',
  '2:3': '1024x1536',
  '3:4': '1024x1536',
  '9:16': '1024x1536',
  '3:2': '1536x1024',
  '4:3': '1536x1024',
  '16:9': '1536x1024',
}

/** The image size of an aspect ratio; `undefined` for Auto (no aspect ratio: the model picks the size). */
export function openaiImageSize(aspectRatio: ImageAspectRatio | undefined): `${number}x${number}` | undefined {
  return aspectRatio !== undefined && Object.hasOwn(IMAGE_SIZES, aspectRatio) ? IMAGE_SIZES[aspectRatio] : undefined
}

/** Voice suggestions of a speech model id: the `tts-1` voices for `tts-*`, the extended list otherwise. */
export function openaiVoices(modelId: string): readonly string[] {
  return /^tts-/i.test(modelId) ? OPENAI_TTS_VOICES : OPENAI_GPT_TTS_VOICES
}

/**
 * The listing entry of a media id the package can run (PROVIDERS.md sections 3 and 13): `gpt-image*` and
 * `chatgpt-image*` (kind `image`, input images accepted), `*transcribe*` and `whisper-1` (`transcription`), `tts-*` and
 * `*-tts*` (`speech`, with voices); `undefined` for every other id, realtime models included.
 */
export function openaiMediaModel(id: string): ModelInfo | undefined {
  if (REALTIME_IDS.test(id))
    return undefined
  if (IMAGE_IDS.test(id))
    return modelInfo({ id, kind: 'image', capabilities: { vision: true } })
  if (TRANSCRIPTION_IDS.test(id) || id === 'whisper-1')
    return modelInfo({ id, kind: 'transcription' })
  if (SPEECH_IDS.test(id))
    return modelInfo({ id, kind: 'speech', voices: openaiVoices(id) })
  return undefined
}

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

function client(rt: ProviderRuntime) {
  return createOpenAI({ apiKey: apiKeyOf(rt), baseURL: baseUrlOf(rt, OPENAI_BASE_URL), fetch: rt.fetch })
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
    imageSeed('gpt-image-1', 'GPT Image 1'),
    imageSeed('gpt-image-1-mini', 'GPT Image 1 Mini'),
    imageSeed('gpt-image-1.5', 'GPT Image 1.5'),
    transcriptionSeed('gpt-4o-mini-transcribe', 'GPT-4o mini Transcribe'),
    transcriptionSeed('gpt-4o-transcribe', 'GPT-4o Transcribe'),
    transcriptionSeed('whisper-1', 'Whisper'),
    speechSeed('gpt-4o-mini-tts', 'GPT-4o mini TTS', OPENAI_GPT_TTS_VOICES),
    speechSeed('tts-1', 'TTS-1', OPENAI_TTS_VOICES),
    speechSeed('tts-1-hd', 'TTS-1 HD', OPENAI_TTS_VOICES),
  ],
  createLanguageModel(modelId, rt) {
    return client(rt).responses(modelId)
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
      if (!id)
        continue
      const media = openaiMediaModel(id)
      if (media) {
        models.push(media)
        continue
      }
      if (NON_CHAT_IDS.test(id))
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
  createImageModel(modelId, rt) {
    return client(rt).image(modelId)
  },
  imageParams(request) {
    const size = openaiImageSize(request.aspectRatio)
    return size === undefined ? undefined : { size }
  },
  createTranscriptionModel(modelId, rt) {
    return client(rt).transcription(modelId)
  },
  createSpeechModel(modelId, rt) {
    return client(rt).speech(modelId)
  },
  transcriptionOptions(hints) {
    const language = transcriptionLanguage(hints)
    return language === undefined ? undefined : { openai: { language } }
  },
}
