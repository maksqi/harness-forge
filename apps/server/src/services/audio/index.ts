// Dictation and read-aloud (ADR-029, ARCHITECTURE.md 6.12 / 10.8 / 12, API.md 5.21). Owner: W6.5. Implements
// `AudioService` (./types.ts) behind `createAudioService(deps)`; the recording type checks live in `./sniff.ts`.
//
// - `transcribe`: the recording must have 64 bytes .. `LIMITS.audioUploadBytes` and an accepted type that matches its
//   magic bytes; model = `form.modelRef ?? settings.transcriptionModelRef`, language = `form.language ??
//   settings.transcriptionLanguage` (`auto` sends nothing, a code goes through the provider's `transcriptionOptions`
//   hook); then `transcribe()` within 120 s with one retry. `NoTranscriptGeneratedError` (no speech) is `text: ''`.
// - `speak`: model = `modelRef ?? settings.speechModelRef`, voice = `voice ?? settings.speechVoice` (null = the provider
//   default); `generateSpeech()` gets the text and the voice only (never `outputFormat`, `speed`, `instructions` or
//   `language`) within 60 s with one retry; the reported audio type is normalized (`audio/mp3` -> `audio/mpeg`) and must
//   be one of `SPEECH_AUDIO_MIME_TYPES`, else `provider_error`.
// Both: the request signal aborts the provider call; a client that went away gets `validation_error` "The request was
// canceled." (only the logs see it; never recorded as a provider failure). Provider errors go through
// `providers.mapError` and `providers.recordOutcome`. A call that answers writes one usage row (no chat, 0 tokens, no
// cost) and records the provider as working. Privacy (ARCHITECTURE.md 10.8): nothing is stored; the one info line per
// call carries the provider, the model, the byte or character count, the type, the duration, the milliseconds and the
// outcome, never the recording, the transcript, the speech text or an error object (AI SDK errors carry the request).
import type { ProviderOptions } from '@harness-forge/plugin-sdk'
import type { AudioTranscription } from '@harness-forge/shared'
import type { ProviderCallOutcome, ResolvedModelBase } from '../../providers/types.ts'
import type { AppDeps } from '../../types.ts'
import type { AudioService, AudioSpeakInput, AudioTranscribeInput, SpeechAudio, SpeechAudioMimeType } from './types.ts'
import { performance } from 'node:perf_hooks'
import { HarnessError, LIMITS, validationError } from '@harness-forge/shared'
import { generateSpeech, NoSpeechGeneratedError, NoTranscriptGeneratedError, transcribe } from 'ai'
import { withTimeout } from '../../providers/runtime.ts'
import { checkAudioType, mediaTypeOf } from './sniff.ts'
import { SPEECH_AUDIO_MIME_TYPES } from './types.ts'

/** Time limit of one `transcribe()` call, retry included (ADR-029). */
export const TRANSCRIPTION_TIMEOUT_MS = 120_000
/** Time limit of one `generateSpeech()` call, retry included (ADR-029). */
export const SPEECH_TIMEOUT_MS = 60_000
/** Retries of a failed provider call (the AI SDK default is 2). */
export const AUDIO_MAX_RETRIES = 1
/** A smaller upload is no recording (a container header at most). */
export const RECORDING_MIN_BYTES = 64

export const EMPTY_RECORDING_MESSAGE = 'The recording is empty.'
export const RECORDING_TOO_LARGE_MESSAGE = `Recordings are limited to ${LIMITS.audioUploadBytes / 1024 / 1024} MB.`
export const NO_TRANSCRIPTION_MODEL_MESSAGE = 'Choose a speech-to-text model in Settings → Media.'
export const NO_SPEECH_MODEL_MESSAGE = 'Choose a read-aloud model in Settings → Media.'
export const CANCELED_MESSAGE = 'The request was canceled.'

/** Codes of an upstream failure: recorded as the provider's call outcome (drives its status). */
const PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set([
  'auth_invalid',
  'rate_limited',
  'model_not_found',
  'context_overflow',
  'provider_unreachable',
  'provider_error',
])

/** Other names of the speech response types (the AI SDK falls back to `audio/mp3` when it cannot tell). */
const SPEECH_TYPE_ALIASES: Readonly<Record<string, SpeechAudioMimeType>> = {
  'audio/mp3': 'audio/mpeg',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/x-flac': 'audio/flac',
  'audio/x-m4a': 'audio/mp4',
}
const SPEECH_TYPES: ReadonlySet<string> = new Set(SPEECH_AUDIO_MIME_TYPES)

/** Longest `language` passed through from a provider. */
const LANGUAGE_MAX_CHARS = 64
/** Speech text runs compared with a provider error message (see `echoesText`). */
const ECHO_WINDOW_CHARS = 24

export interface AudioServiceOptions {
  /** `transcribe()` time limit; default `TRANSCRIPTION_TIMEOUT_MS`. */
  transcriptionTimeoutMs?: number
  /** `generateSpeech()` time limit; default `SPEECH_TIMEOUT_MS`. */
  speechTimeoutMs?: number
}

type AudioPurpose = 'transcription' | 'speech'
type CallOutcome = 'ok' | 'empty' | 'canceled' | 'failed'

/** What the info line of a provider call carries (sizes and types only). */
interface CallLog {
  purpose: AudioPurpose
  resolved: ResolvedModelBase
  started: number
  fields: Record<string, number | string | undefined>
}

function invalid(path: string, message: string): HarnessError {
  return validationError([{ path: [path], message, code: 'custom' }], message)
}

/**
 * The error of a call whose client went away (its request signal aborted): nobody reads the answer, so it is a
 * `validation_error` for the logs (debug level), not a provider failure.
 */
export function canceledError(): HarnessError {
  return validationError([{ path: [], message: CANCELED_MESSAGE, code: 'aborted' }], CANCELED_MESSAGE)
}

function recordingTooLarge(): HarnessError {
  return new HarnessError({ code: 'payload_too_large', message: RECORDING_TOO_LARGE_MESSAGE, details: { limitBytes: LIMITS.audioUploadBytes } })
}

/** The `Content-Type` of speech audio: the reported type normalized, or null when it is not one browsers play. */
export function speechMediaType(reported: string | undefined): SpeechAudioMimeType | null {
  const type = mediaTypeOf(reported)
  const canonical = SPEECH_TYPE_ALIASES[type] ?? type
  return SPEECH_TYPES.has(canonical) ? (canonical as SpeechAudioMimeType) : null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isProviderOptions(value: unknown): value is ProviderOptions {
  return isPlainObject(value) && Object.values(value).every(isPlainObject)
}

/**
 * True when `message` repeats the speech text, or any run of 24 of its characters (the whole text when shorter; texts
 * under 4 characters are not checked): a provider error that echoes its input would put the text into the error log,
 * so such a message is replaced (a false positive only costs a generic message). Slides over the message, which is
 * short, rather than over the text.
 */
export function echoesText(message: string, text: string): boolean {
  const source = text.trim()
  if (source.length < 4)
    return false
  const window = Math.min(ECHO_WINDOW_CHARS, source.length)
  for (let start = 0; start + window <= message.length; start++) {
    if (source.includes(message.slice(start, start + window)))
      return true
  }
  return false
}

function upstreamOf(error: HarnessError): string {
  const details = error.details
  if (isPlainObject(details) && typeof details.upstream === 'string')
    return details.upstream
  return ''
}

/** A detected language as reported (trimmed, capped), or null. */
function languageOf(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  const language = value.trim().slice(0, LANGUAGE_MAX_CHARS)
  return language === '' ? null : language
}

function durationOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function createAudioService(deps: AppDeps): AudioService {
  return createAudioServiceWith(deps, {})
}

export function createAudioServiceWith(deps: AppDeps, options: AudioServiceOptions = {}): AudioService {
  const transcriptionTimeoutMs = options.transcriptionTimeoutMs ?? TRANSCRIPTION_TIMEOUT_MS
  const speechTimeoutMs = options.speechTimeoutMs ?? SPEECH_TIMEOUT_MS

  async function record(providerId: string, outcome: ProviderCallOutcome): Promise<void> {
    try {
      await deps.providers.recordOutcome(providerId, outcome)
    }
    catch (error) {
      deps.logger.warn('cannot record the provider outcome', { providerId, err: error })
    }
  }

  async function addUsage(purpose: AudioPurpose, resolved: ResolvedModelBase): Promise<void> {
    try {
      await deps.chats.addUsage({
        chatId: null,
        messageId: null,
        purpose,
        providerId: resolved.providerId,
        modelId: resolved.modelId,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: null,
      })
    }
    catch (error) {
      deps.logger.warn('cannot write the usage row', { providerId: resolved.providerId, purpose, err: error })
    }
  }

  function logCall(call: CallLog, outcome: CallOutcome, extra: Record<string, number | string | undefined> = {}): void {
    deps.logger.info(`audio ${call.purpose}`, {
      providerId: call.resolved.providerId,
      modelId: call.resolved.modelId,
      ...call.fields,
      ...extra,
      ms: Math.round(performance.now() - call.started),
      outcome,
    })
  }

  /** Runs a resolver; a client that went away meanwhile gets `canceledError()`, resolver errors pass unchanged. */
  async function resolving<T>(signal: AbortSignal, resolve: () => Promise<T>): Promise<T> {
    try {
      return await resolve()
    }
    catch (error) {
      if (signal.aborted)
        throw canceledError()
      throw error
    }
  }

  /** The provider options of a language code (`transcriptionOptions`); a throwing hook or an invalid value sends none. */
  function transcriptionOptions(resolved: ResolvedModelBase, language: string): ProviderOptions | undefined {
    const definition = resolved.provider.definition
    const hook = definition.transcriptionOptions
    if (hook === undefined)
      return undefined
    let value: unknown
    try {
      value = hook.call(definition, { language })
    }
    catch (error) {
      deps.logger.warn('provider transcriptionOptions() failed; the language hint is not sent', { providerId: resolved.providerId, err: error })
      return undefined
    }
    if (value === undefined || value === null)
      return undefined
    if (!isProviderOptions(value)) {
      deps.logger.warn('provider transcriptionOptions() returned invalid provider options; the language hint is not sent', { providerId: resolved.providerId })
      return undefined
    }
    return value
  }

  /**
   * The mapped error of a failed call, without the original error attached (it may carry the request): the SDK's "no
   * speech" error, else `providers.mapError`. With `text`, a message that echoes it becomes a generic one.
   */
  function mapCallError(resolved: ResolvedModelBase, error: unknown, text?: string): HarnessError {
    const providerName = resolved.provider.definition.name
    const generic = { code: 'provider_error', message: `${providerName} returned an error.`, providerId: resolved.providerId, action: 'retry' } as const
    if (NoSpeechGeneratedError.isInstance(error))
      return new HarnessError({ ...generic, message: `${providerName} returned no audio.` })
    let mapped: HarnessError
    try {
      mapped = deps.providers.mapError(resolved.providerId, error)
    }
    catch {
      return new HarnessError(generic)
    }
    const init = mapped.toJSON().error
    if (text !== undefined && (echoesText(init.message, text) || echoesText(upstreamOf(mapped), text))) {
      const { details: _details, ...rest } = init
      return new HarnessError({ ...rest, message: generic.message })
    }
    return new HarnessError(init)
  }

  /** The error a failed call answers with: canceled, or the mapped provider error (its outcome recorded). */
  async function failure(call: CallLog, error: unknown, signal: AbortSignal, text?: string): Promise<HarnessError> {
    if (signal.aborted) {
      logCall(call, 'canceled')
      return canceledError()
    }
    const mapped = mapCallError(call.resolved, error, text)
    if (PROVIDER_ERROR_CODES.has(mapped.code))
      await record(call.resolved.providerId, { ok: false, error: mapped.toJSON().error })
    logCall(call, 'failed', { code: mapped.code })
    return mapped
  }

  async function transcribeRecording(input: AudioTranscribeInput): Promise<AudioTranscription> {
    const started = performance.now()
    const { file, form, signal } = input
    if (signal.aborted)
      throw canceledError()
    if (file.size > LIMITS.audioUploadBytes)
      throw recordingTooLarge()
    if (file.size < RECORDING_MIN_BYTES)
      throw invalid('file', EMPTY_RECORDING_MESSAGE)
    const bytes = new Uint8Array(await file.arrayBuffer())
    const checked = checkAudioType(file.type, bytes)
    if (!checked.ok)
      throw invalid('file', checked.reason)

    const settings = await deps.settings.get()
    const modelRef = form.modelRef ?? settings.transcriptionModelRef
    if (modelRef === null)
      throw invalid('modelRef', NO_TRANSCRIPTION_MODEL_MESSAGE)
    const language = form.language ?? settings.transcriptionLanguage
    const resolved = await resolving(signal, () => deps.providers.resolveTranscriptionModel(modelRef, { signal }))
    const providerOptions = language === 'auto' ? undefined : transcriptionOptions(resolved, language)
    const call: CallLog = { purpose: 'transcription', resolved, started, fields: { bytes: bytes.byteLength, type: checked.type } }

    let text = ''
    let detected: string | null = null
    let durationSec: number | null = null
    try {
      const result = await withTimeout(transcriptionTimeoutMs, abortSignal => transcribe({
        model: resolved.model,
        audio: bytes,
        ...(providerOptions === undefined ? {} : { providerOptions }),
        maxRetries: AUDIO_MAX_RETRIES,
        abortSignal,
      }), signal)
      text = result.text.trim()
      detected = languageOf(result.language)
      durationSec = durationOf(result.durationInSeconds)
    }
    catch (error) {
      // No speech in the recording: an answer, not a failure.
      if (signal.aborted || !NoTranscriptGeneratedError.isInstance(error))
        throw await failure(call, error, signal)
    }
    await record(resolved.providerId, { ok: true })
    await addUsage('transcription', resolved)
    logCall(call, text === '' ? 'empty' : 'ok', { durationSec: durationSec ?? undefined })
    return { text, language: detected, durationSec, modelRef: resolved.modelRef }
  }

  async function speak(input: AudioSpeakInput): Promise<SpeechAudio> {
    const started = performance.now()
    const { signal } = input
    if (signal.aborted)
      throw canceledError()
    const text = input.text.trim()
    if (text.length === 0 || text.length > LIMITS.speechTextMaxChars)
      throw invalid('text', `The text to read aloud must have 1-${LIMITS.speechTextMaxChars} characters.`)

    const settings = await deps.settings.get()
    const modelRef = input.modelRef ?? settings.speechModelRef
    if (modelRef === null)
      throw invalid('modelRef', NO_SPEECH_MODEL_MESSAGE)
    const voice = input.voice ?? settings.speechVoice ?? undefined
    const resolved = await resolving(signal, () => deps.providers.resolveSpeechModel(modelRef, { signal }))
    const call: CallLog = { purpose: 'speech', resolved, started, fields: { chars: text.length } }

    let audio: Uint8Array
    let reported: string
    try {
      const result = await withTimeout(speechTimeoutMs, abortSignal => generateSpeech({
        model: resolved.model,
        text,
        ...(voice === undefined ? {} : { voice }),
        maxRetries: AUDIO_MAX_RETRIES,
        abortSignal,
      }), signal)
      audio = result.audio.uint8Array
      reported = result.audio.mediaType
    }
    catch (error) {
      throw await failure(call, error, signal, text)
    }
    const mediaType = speechMediaType(reported)
    if (mediaType === null) {
      const type = mediaTypeOf(reported) || 'unknown'
      const error = new HarnessError({
        code: 'provider_error',
        message: `${resolved.provider.definition.name} returned audio in a format that cannot be played (${type}).`,
        providerId: resolved.providerId,
        action: 'retry',
      })
      await record(resolved.providerId, { ok: false, error: error.toJSON().error })
      logCall(call, 'failed', { code: error.code, type, bytes: audio.byteLength })
      throw error
    }
    await record(resolved.providerId, { ok: true })
    await addUsage('speech', resolved)
    logCall(call, 'ok', { type: mediaType, bytes: audio.byteLength })
    return { audio, mediaType, modelRef: resolved.modelRef }
  }

  return { transcribe: transcribeRecording, speak }
}
