// Voice DTOs (API.md section 4.19, ADR-029): dictation (`POST /audio/transcriptions`) and read-aloud
// (`POST /audio/speech`). Audio and text pass through the server; nothing is stored or logged.
import { z } from 'zod'
import { modelRefSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'

/** Language of a dictation: `auto` (detect; nothing is sent to the provider) or an ISO 639 code (`en`, `de`, `yue`). */
export const transcriptionLanguageSchema = z.union([
  z.literal('auto'),
  z.string().regex(/^[a-z]{2,3}$/, 'Expected "auto" or an ISO 639 code of 2-3 lowercase letters.'),
])
export type TranscriptionLanguage = z.infer<typeof transcriptionLanguageSchema>

/**
 * A provider voice name (`alloy`, `Kore`, `en-US-Neural2-A`): trimmed, 1..64 characters of letters, digits, `_`,
 * space, `.`, `:` and `-`.
 */
export const speechVoiceSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\w .:-]+$/, 'Voices use letters, digits, spaces and "_", ".", ":", "-".')
export type SpeechVoice = z.infer<typeof speechVoiceSchema>

/**
 * Multipart fields of `POST /audio/transcriptions` next to the recording in the part `file` (not part of this schema;
 * the route rejects unknown and repeated fields). Omitted fields fall back to the settings `transcriptionModelRef` /
 * `transcriptionLanguage`.
 */
export const audioTranscribeFormSchema = z.strictObject({
  /** A `transcription` model; default: the `transcriptionModelRef` setting (neither set -> `400`). */
  modelRef: modelRefSchema.optional(),
  language: transcriptionLanguageSchema.optional(),
})
export type AudioTranscribeForm = z.infer<typeof audioTranscribeFormSchema>

/** Response of `POST /audio/transcriptions`; no speech detected = `text: ''`. */
export const audioTranscriptionSchema = z.object({
  text: z.string(),
  /** The language the provider detected or used, when it reports one. */
  language: z.string().nullable(),
  /** Duration of the recording in seconds, when the provider reports it. */
  durationSec: z.number().min(0).nullable(),
  /** The model used. */
  modelRef: modelRefSchema,
})
export type AudioTranscription = z.infer<typeof audioTranscriptionSchema>

/**
 * Body of `POST /audio/speech` (the response is the audio bytes). Omitted fields fall back to the settings
 * `speechModelRef` / `speechVoice`.
 */
export const audioSpeechBodySchema = z.strictObject({
  /** 1..4096 characters, trimmed (the web reads a reply in chunks). */
  text: z.string().trim().min(1).max(LIMITS.speechTextMaxChars),
  /** A `speech` model; default: the `speechModelRef` setting (neither set -> `400`). */
  modelRef: modelRefSchema.optional(),
  /** Default: the `speechVoice` setting, else the provider default. */
  voice: speechVoiceSchema.optional(),
})
export type AudioSpeechBody = z.infer<typeof audioSpeechBodySchema>
