// Frozen interface of voice (ADR-029, ARCHITECTURE.md 6.12 / 10.8, API.md 4.19 / 5.21): dictation (`transcribe`) and
// read-aloud (`speak`). Implementation: `createAudioService(deps)` in `services/audio/index.ts` with the magic-byte
// sniffer in `services/audio/sniff.ts` (W6.5; a stub that answers `not_implemented` until then). Consumer: the routes
// `audio.transcribe` (`POST /audio/transcriptions`) and `audio.speech` (`POST /audio/speech`) in `http/routes/audio.ts`.
// Audio and text only pass through: nothing is stored, and no recording, transcript or speech text is ever logged.
import type { AudioSpeechBody, AudioTranscribeForm, AudioTranscription } from '@harness-forge/shared'

/**
 * Recording types accepted by `POST /audio/transcriptions` (API.md 5.21): each canonical type with the aliases that
 * map to it. Parameters such as `;codecs=opus` are stripped and the type lowercased before the lookup;
 * `application/octet-stream` lets the magic bytes decide. Chat uploads keep `UPLOAD_MIME_PATTERNS` (no audio).
 */
export const AUDIO_UPLOAD_TYPES = {
  'audio/webm': ['video/webm'],
  'audio/ogg': [],
  'audio/mp4': ['audio/x-m4a', 'video/mp4'],
  'audio/mpeg': ['audio/mp3'],
  'audio/wav': ['audio/x-wav', 'audio/wave'],
  'audio/flac': ['audio/x-flac'],
} as const satisfies Readonly<Record<string, readonly string[]>>

/** A canonical recording type (a key of `AUDIO_UPLOAD_TYPES`). */
export type AudioUploadType = keyof typeof AUDIO_UPLOAD_TYPES

/**
 * `Content-Type` values of a speech response (`SpeechAudio.mediaType`): the audio types browsers play. The type
 * `generateSpeech` reports is normalized first (the AI SDK fallback `audio/mp3` becomes `audio/mpeg`); any other type
 * is refused with `provider_error`.
 */
export const SPEECH_AUDIO_MIME_TYPES = [
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
  'audio/flac',
] as const

/** A speech response type (one of `SPEECH_AUDIO_MIME_TYPES`). */
export type SpeechAudioMimeType = (typeof SPEECH_AUDIO_MIME_TYPES)[number]

/** Input of `AudioService.transcribe`: the recording of one dictation. */
export interface AudioTranscribeInput {
  /**
   * The multipart part `file` (a `File` from the parsed form, or any `Blob`): its declared `type` must be an accepted
   * recording type (`AUDIO_UPLOAD_TYPES`, or `application/octet-stream`) that matches the magic bytes (`sniff.ts`);
   * fewer than 64 bytes -> `validation_error` "The recording is empty."; more than `LIMITS.audioUploadBytes` ->
   * `payload_too_large` (`details.limitBytes`).
   */
  file: Blob
  /**
   * The other multipart fields, parsed by the route: `modelRef ?? settings.transcriptionModelRef` (neither ->
   * `validation_error`), `language ?? settings.transcriptionLanguage` (`auto` sends nothing, a code goes through the
   * provider's `transcriptionOptions`).
   */
  form: AudioTranscribeForm
  /** The request signal: a client that disconnects aborts the provider call (with the 120 s timeout). */
  signal: AbortSignal
}

/** Input of `AudioService.speak`: one chunk of a reply read aloud (`AudioSpeechBody`, validated by the route). */
export interface AudioSpeakInput extends AudioSpeechBody {
  /** The request signal: a client that disconnects aborts the provider call (with the 60 s timeout). */
  signal: AbortSignal
}

/** Result of `AudioService.speak`: the bytes of the response body. */
export interface SpeechAudio {
  /** The audio exactly as the provider returned it (`Content-Length` = its length). */
  audio: Uint8Array
  /** The response `Content-Type`: one of `SPEECH_AUDIO_MIME_TYPES`. */
  mediaType: SpeechAudioMimeType
  /** The speech model used (`providerId:modelId`). */
  modelRef: string
}

/**
 * Dictation and read-aloud through the user's own models (ADR-029). Both members resolve the model
 * (`providers.resolveTranscriptionModel` / `resolveSpeechModel`: a wrong kind or a provider without the factory ->
 * `validation_error`, a failing factory -> `plugin_error`), map provider errors with `providers.mapError`, record the
 * outcome (`providers.recordOutcome`), write one usage row per call (`purpose` `transcription` / `speech`, `chatId`
 * null, 0 tokens, `costUsd` null) and log only the provider, the model, the byte or character count, the type, the
 * duration and the milliseconds.
 */
export interface AudioService {
  /**
   * `transcribe({ model, audio, providerOptions, maxRetries: 1, abortSignal })` within 120 s. `NoTranscriptGeneratedError`
   * (no speech) -> `text: ''`. Returns `{ text, language, durationSec, modelRef }` (`null` when the provider does not
   * report the language or the duration).
   */
  readonly transcribe: (input: AudioTranscribeInput) => Promise<AudioTranscription>
  /**
   * `generateSpeech({ model, text, voice, maxRetries: 1, abortSignal })` within 60 s, the model `modelRef ??
   * settings.speechModelRef` (neither -> `validation_error`) and the voice `voice ?? settings.speechVoice` (null = the
   * provider default). `outputFormat`, `speed`, `instructions` and `language` are never passed (the browser applies
   * `speechSpeed` as `playbackRate`).
   */
  readonly speak: (input: AudioSpeakInput) => Promise<SpeechAudio>
}
