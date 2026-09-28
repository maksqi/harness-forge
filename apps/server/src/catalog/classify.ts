// `classify()` (ARCHITECTURE.md 9, PROVIDERS.md 3): the kind of a model, which decides whether it is hidden by default
// (`model_prefs.hidden` overrides it). models.dev modalities decide when models.dev knows the model, else the id
// pattern `embed|tts|whisper|transcri|image|moderation|rerank|audio`.
import type { ModelKind } from '@harness-forge/shared'
import { NON_CHAT_ID_PATTERN } from './models-dev.ts'

export { NON_CHAT_ID_PATTERN }

/** Input / output modalities of a model (models.dev `modalities`). */
export interface ModalityHints {
  input?: readonly string[]
  output?: readonly string[]
}

/** The kind of a model id alone (models.dev does not know the model). */
export function classifyId(id: string): ModelKind {
  if (!NON_CHAT_ID_PATTERN.test(id))
    return 'chat'
  if (/embed/i.test(id))
    return 'embedding'
  if (/tts|whisper|transcri|audio/i.test(id))
    return 'audio'
  if (/image/i.test(id))
    return 'image'
  return 'other'
}

/**
 * The kind of a model: without a text output it is `image`, `audio` or `other`; without a text input (speech to text)
 * `audio`. models.dev lists embedding, moderation and rerank models with a text output, so those ids are still
 * recognized; every other model with text in and text out is `chat`. Without modalities the id decides (`classifyId`).
 */
export function classify(id: string, modalities?: ModalityHints): ModelKind {
  const output = modalities?.output ?? []
  if (output.length === 0)
    return classifyId(id)
  if (!output.includes('text'))
    return output.includes('image') ? 'image' : output.includes('audio') ? 'audio' : 'other'
  const input = modalities?.input ?? []
  if (input.length > 0 && !input.includes('text'))
    return input.includes('audio') ? 'audio' : 'other'
  if (/embed/i.test(id))
    return 'embedding'
  if (/moderation|rerank/i.test(id))
    return 'other'
  return 'chat'
}
