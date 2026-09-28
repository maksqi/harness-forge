// `classify()` (ARCHITECTURE.md 9, PROVIDERS.md 3 / 13): the kind of a model, which decides whether it is hidden by
// default (`model_prefs.hidden` overrides it). An explicit `kind` of any catalog layer wins over it (merge.ts). Order
// (Phase 6): the image id pattern first (models.dev lists some OpenAI image models with a text output), then models.dev
// modalities when models.dev knows the model, else the id alone.
//
// Also here: the media kinds (ADR-028, ADR-029) and the provider factory that serves each of them. The catalog lists a
// media model only when its provider defines the matching factory (user custom models excepted) and the resolvers
// refuse a model of the wrong kind.
import type { ProviderDefinition } from '@harness-forge/plugin-sdk'
import type { ModelKind } from '@harness-forge/shared'
import { NON_CHAT_ID_PATTERN } from './models-dev.ts'

export { NON_CHAT_ID_PATTERN }

/**
 * Ids of dedicated image models (`kind: 'image'`), checked before the modalities: models.dev lists `gpt-image-1-mini`,
 * `gpt-image-1.5` and `chatgpt-image-latest` with a `[text, image]` output, which alone would make them chat models.
 * Other ids that merely contain "image" (Gemini `*-image` chat models with image output) are not matched.
 */
export const IMAGE_MODEL_ID_PATTERN = /(?:^|\/)(?:gpt-image|chatgpt-image|dall-e|imagen|grok-imagine-image)/i

/** Input / output modalities of a model (models.dev `modalities`). */
export interface ModalityHints {
  input?: readonly string[]
  output?: readonly string[]
}

/**
 * The kind of a model id alone (models.dev does not know the model): the image id pattern -> `image`, `embed` ->
 * `embedding`, `tts` -> `speech`, `whisper|transcri` -> `transcription`, other `audio` -> `audio`, `moderation|rerank`
 * -> `other`, else `chat`.
 */
export function classifyId(id: string): ModelKind {
  if (IMAGE_MODEL_ID_PATTERN.test(id))
    return 'image'
  if (/embed/i.test(id))
    return 'embedding'
  if (/tts/i.test(id))
    return 'speech'
  if (/whisper|transcri/i.test(id))
    return 'transcription'
  if (/audio/i.test(id))
    return 'audio'
  if (/moderation|rerank/i.test(id))
    return 'other'
  return 'chat'
}

/**
 * The kind of a model: the image id pattern -> `image`; with models.dev modalities, no text output -> `image` (image
 * output), `speech` (audio output with a text input), `audio` (other audio output) or `other`; audio input without a
 * text input and with a text output -> `transcription` (another non-text input -> `other`); models.dev lists
 * embedding, moderation and rerank models with a text output, so those ids are still recognized; every other model
 * with text in and text out is `chat`. Without modalities the id decides (`classifyId`).
 */
export function classify(id: string, modalities?: ModalityHints): ModelKind {
  if (IMAGE_MODEL_ID_PATTERN.test(id))
    return 'image'
  const output = modalities?.output ?? []
  if (output.length === 0)
    return classifyId(id)
  const input = modalities?.input ?? []
  if (!output.includes('text')) {
    if (output.includes('image'))
      return 'image'
    if (output.includes('audio'))
      return input.includes('text') ? 'speech' : 'audio'
    return 'other'
  }
  if (input.length > 0 && !input.includes('text'))
    return input.includes('audio') ? 'transcription' : 'other'
  if (/embed/i.test(id))
    return 'embedding'
  if (/moderation|rerank/i.test(id))
    return 'other'
  return 'chat'
}

// ---------- media kinds ----------

/** The kinds served by an optional provider factory (plugin API 1.1.0). */
export type MediaModelKind = 'image' | 'transcription' | 'speech'

/** The factory of `ProviderDefinition` that creates the model instances of each media kind. */
export const MEDIA_MODEL_FACTORIES = {
  image: 'createImageModel',
  transcription: 'createTranscriptionModel',
  speech: 'createSpeechModel',
} as const satisfies Record<MediaModelKind, keyof ProviderDefinition>

export const MEDIA_MODEL_KINDS = Object.keys(MEDIA_MODEL_FACTORIES) as MediaModelKind[]

export function isMediaModelKind(kind: unknown): kind is MediaModelKind {
  return typeof kind === 'string' && Object.hasOwn(MEDIA_MODEL_FACTORIES, kind)
}

/** True when the provider defines the factory of `kind` (`createImageModel`, `createTranscriptionModel`, ...). */
export function providerServesKind(definition: ProviderDefinition, kind: MediaModelKind): boolean {
  return typeof definition[MEDIA_MODEL_FACTORIES[kind]] === 'function'
}
