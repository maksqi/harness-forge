// Fakes of the Phase 6 media services (C11-T5), so the image pipeline (W6.1), the image host (W6.4) and the audio
// routes (W6.5) can test against the frozen interfaces while the real services land in parallel:
//
//   const t = await createTestApp({ factories: { images: createFakeImageService } })
//   const t = await createTestApp({ overrides: { audio: createFakeAudioService({ text: '' }) } })
//
// Both follow the documented contract where callers can see it (the model fallback to the settings, input limits,
// abort, the usage row of an image generation) and answer deterministically: images are the solid-color PNGs of the
// mock provider (`builtin-plugins/mock/media.ts`), speech is its silent WAV. Never imported by production code.
import type { AudioTranscribeForm, AudioTranscription } from '@harness-forge/shared'
import type { AudioService, AudioSpeakInput, AudioTranscribeInput, SpeechAudio } from '../services/audio/types.ts'
import type { ImageGenerationInput, ImageGenerationResult, ImageService, StoredImage } from '../services/images/types.ts'
import type { AppDeps } from '../types.ts'
import { HarnessError, LIMITS, parseModelRef, validationError } from '@harness-forge/shared'
import { abortableDelay, abortError } from '../builtin-plugins/mock/common.ts'
import { createMockWav, MOCK_TRANSCRIPT, mockImagePng, mockImageSize, mockImageUsage, mockRevisedPrompt } from '../builtin-plugins/mock/media.ts'

/** The message of a missing image model (the `generate_image` error text of ADR-028). */
export const NO_IMAGE_MODEL_MESSAGE = 'Choose an image model in Settings → Media.'

function invalid(path: string, message: string): HarnessError {
  return validationError([{ path: [path], message, code: 'custom' }], message)
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw abortError(signal)
}

// ---------- images ----------

export interface FakeImageServiceOptions {
  /** Wait before the images exist (aborts with the input's signal); default 0. */
  delayMs?: number
  /** Called for every valid call after the wait: a returned value is thrown (e.g. a mapped provider error). */
  failWith?: (input: ImageGenerationInput) => unknown
  /** Images of every call reported in `dropped` instead of stored; default 0. */
  dropped?: number
  /** `costUsd` of every call; default null. */
  costUsd?: number | null
  /** Write the usage row (`purpose: 'image'`) like the real service; default true. */
  recordUsage?: boolean
}

export interface FakeImageService extends ImageService {
  /** Every input received, in call order (invalid ones included). */
  readonly calls: ImageGenerationInput[]
}

/**
 * An `ImageService` without a provider call: the model is `resolved.modelRef ?? modelRef ?? settings.imageModelRef`
 * (none -> `validation_error` "Choose an image model in Settings → Media."); the prompt (1..32000 characters), `n`
 * (1..4) and the input files (at most 4, each must exist) are checked; after `delayMs` it stores `n - dropped` PNGs of
 * the mock provider (`image-<i>.png`, sized by the aspect ratio, colored by prompt + index + inputs) through
 * `files.upload` (the P6-0b `saveGenerated` is a stub), writes the usage row and answers the usage of `mock:image`, the
 * revised prompt `Mock: <prompt>` and `costUsd` from the options. An aborted signal rejects with its reason. Use as a
 * factory: `factories: { images: createFakeImageService }` or `images: deps => createFakeImageService(deps, options)`.
 */
export function createFakeImageService(deps: AppDeps, options: FakeImageServiceOptions = {}): FakeImageService {
  const calls: ImageGenerationInput[] = []

  async function modelRefOf(input: ImageGenerationInput): Promise<string> {
    const ref = input.resolved?.modelRef ?? input.modelRef ?? (await deps.settings.get()).imageModelRef
    if (ref === null || ref === undefined)
      throw invalid('modelRef', NO_IMAGE_MODEL_MESSAGE)
    return ref
  }

  async function generate(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    calls.push(input)
    throwIfAborted(input.signal)
    const modelRef = await modelRefOf(input)
    const prompt = input.prompt.trim()
    if (prompt === '' || Array.from(prompt).length > LIMITS.imagePromptMaxChars)
      throw invalid('prompt', `The image prompt must have 1-${LIMITS.imagePromptMaxChars} characters.`)
    if (!Number.isInteger(input.n) || input.n < 1 || input.n > LIMITS.imagesPerTurnMax)
      throw invalid('n', `Generate 1-${LIMITS.imagesPerTurnMax} images.`)
    const inputFileIds = input.inputFileIds ?? []
    if (inputFileIds.length > LIMITS.imageInputsMax)
      throw invalid('inputFileIds', `At most ${LIMITS.imageInputsMax} input images.`)
    for (const id of inputFileIds) {
      if (await deps.files.get(id) === null)
        throw new HarnessError({ code: 'not_found', message: `File ${id} not found.` })
    }
    await abortableDelay(options.delayMs ?? 0, input.signal)
    const failure = options.failWith?.(input)
    if (failure !== undefined)
      throw failure
    throwIfAborted(input.signal)

    const dropped = Math.min(input.n, Math.max(0, options.dropped ?? 0))
    const size = mockImageSize({ aspectRatio: input.aspectRatio })
    const inputs = inputFileIds.map(id => ({ type: 'url' as const, url: id }))
    const images: StoredImage[] = []
    for (let index = 0; index < input.n - dropped; index++) {
      const png = mockImagePng(prompt, index, size, inputs)
      const ref = await deps.files.upload(new File([new Uint8Array(png)], `image-${index + 1}.png`, { type: 'image/png' }))
      const file = await deps.files.get(ref.id)
      if (file === null)
        throw new Error(`fake images: the stored image ${ref.id} is missing.`)
      images.push({ file, url: ref.url })
    }
    const usage = mockImageUsage(prompt, input.n)
    const costUsd = options.costUsd ?? null
    if (options.recordUsage ?? true) {
      const { providerId, modelId } = parseModelRef(modelRef)
      await deps.chats.addUsage({
        chatId: input.chatId,
        messageId: input.messageId,
        purpose: 'image',
        providerId,
        modelId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd,
      })
    }
    return { modelRef, images, usage, costUsd, revisedPrompt: mockRevisedPrompt(prompt), dropped }
  }

  return { calls, generate }
}

// ---------- audio ----------

export interface FakeAudioServiceOptions {
  /** Stands in for `settings.transcriptionModelRef`; default `mock:transcribe`, null = none set. */
  transcriptionModelRef?: string | null
  /** Stands in for `settings.speechModelRef`; default `mock:speech`, null = none set. */
  speechModelRef?: string | null
  /** The transcript; default `This is a mock transcription.` (`''` = no speech detected). */
  text?: string
  /** Wait before answering (aborts with the input's signal); default 0. */
  delayMs?: number
  /** Called for every valid call after the wait: a returned value is thrown (e.g. a mapped provider error). */
  failWith?: (member: 'transcribe' | 'speak') => unknown
}

/** A call of `createFakeAudioService` (sizes and fields only for recordings). */
export type FakeAudioCall
  = | { member: 'transcribe', type: string, bytes: number, form: AudioTranscribeForm }
    | { member: 'speak', text: string, modelRef?: string, voice?: string }

export interface FakeAudioService extends AudioService {
  readonly calls: FakeAudioCall[]
}

/**
 * An `AudioService` without a provider call, for route tests. `transcribe`: model `form.modelRef ??
 * transcriptionModelRef` (none -> `validation_error`), more than `LIMITS.audioUploadBytes` -> `payload_too_large`,
 * fewer than 64 bytes -> `validation_error` "The recording is empty.", then `{ text, language: null, durationSec: null,
 * modelRef }` (no type sniffing: that is the real service's `sniff.ts`). `speak`: model `modelRef ?? speechModelRef`
 * (none -> `validation_error`), then the silent WAV of the mock provider as `audio/wav`. Aborted signals reject with
 * their reason.
 */
export function createFakeAudioService(options: FakeAudioServiceOptions = {}): FakeAudioService {
  const calls: FakeAudioCall[] = []
  const transcriptionDefault = options.transcriptionModelRef === undefined ? 'mock:transcribe' : options.transcriptionModelRef
  const speechDefault = options.speechModelRef === undefined ? 'mock:speech' : options.speechModelRef

  async function finish(member: 'transcribe' | 'speak', signal: AbortSignal): Promise<void> {
    await abortableDelay(options.delayMs ?? 0, signal)
    const failure = options.failWith?.(member)
    if (failure !== undefined)
      throw failure
    throwIfAborted(signal)
  }

  return {
    calls,
    transcribe: async (input: AudioTranscribeInput): Promise<AudioTranscription> => {
      calls.push({ member: 'transcribe', type: input.file.type, bytes: input.file.size, form: { ...input.form } })
      throwIfAborted(input.signal)
      const modelRef = input.form.modelRef ?? transcriptionDefault
      if (modelRef === null)
        throw invalid('modelRef', 'Choose a speech-to-text model in Settings → Media.')
      if (input.file.size > LIMITS.audioUploadBytes) {
        throw new HarnessError({
          code: 'payload_too_large',
          message: `Recordings are limited to ${LIMITS.audioUploadBytes / 1024 / 1024} MB.`,
          details: { limitBytes: LIMITS.audioUploadBytes },
        })
      }
      if (input.file.size < 64)
        throw invalid('file', 'The recording is empty.')
      await finish('transcribe', input.signal)
      return { text: options.text ?? MOCK_TRANSCRIPT, language: null, durationSec: null, modelRef }
    },
    speak: async (input: AudioSpeakInput): Promise<SpeechAudio> => {
      calls.push({ member: 'speak', text: input.text, modelRef: input.modelRef, voice: input.voice })
      throwIfAborted(input.signal)
      const modelRef = input.modelRef ?? speechDefault
      if (modelRef === null)
        throw invalid('modelRef', 'Choose a read-aloud model in Settings → Media.')
      await finish('speak', input.signal)
      return { audio: createMockWav(input.text), mediaType: 'audio/wav', modelRef }
    },
  }
}
