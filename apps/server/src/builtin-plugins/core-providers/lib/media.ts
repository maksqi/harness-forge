// Image and voice helpers shared by the builtin providers (PROVIDERS.md section 13, ADR-028 / ADR-029): the seeds of
// media models (explicit kinds, so the catalog lists them even next to a live listing) and the transcription language.
import type { ModelInfo, TranscriptionHints } from '@harness-forge/plugin-sdk'

/** A dedicated image model (`generateImage`); `vision`: input images are accepted (an edit of the previous image). */
export function imageSeed(id: string, name: string): ModelInfo {
  return { id, name, kind: 'image', capabilities: { vision: true } }
}

/** A speech-to-text model (dictation). */
export function transcriptionSeed(id: string, name: string): ModelInfo {
  return { id, name, kind: 'transcription' }
}

/** A text-to-speech model (read-aloud) with the voices to suggest, when any are known. */
export function speechSeed(id: string, name: string, voices: readonly string[] = []): ModelInfo {
  return voices.length > 0 ? { id, name, kind: 'speech', voices: [...voices] } : { id, name, kind: 'speech' }
}

/**
 * The spoken language of transcription hints as a lowercase ISO 639 code; `undefined` when absent, blank or `auto`, so
 * that no language option is sent and the provider detects the language.
 */
export function transcriptionLanguage(hints: TranscriptionHints | undefined): string | undefined {
  const language = hints?.language?.trim().toLowerCase()
  return language && language !== 'auto' ? language : undefined
}
