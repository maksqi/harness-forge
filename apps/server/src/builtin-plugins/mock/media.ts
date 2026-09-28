// Media models of the dev-only `mock` provider (PROVIDERS.md 8, plugin API 1.1.0, ADR-028 / ADR-029): `mock:image`
// (`ImageModelV4`), `mock:transcribe` (`TranscriptionModelV4`) and `mock:speech` (`SpeechModelV4`), built on the
// `ai/test` mocks like the language models. Every answer is deterministic; delays end as soon as the call's
// `abortSignal` aborts. The image helpers (size, color) are shared with `mock:image-chat` (./models.ts).
import type { ImageModelV4, ImageModelV4File, SharedV4ProviderOptions, SpeechModelV4, TranscriptionModelV4 } from '@ai-sdk/provider'
import type { ImageParamsRequest, ImageParamsResult } from '@harness-forge/plugin-sdk'
import type { Rgb } from './png.ts'
import { createHash } from 'node:crypto'
import { APICallError } from '@ai-sdk/provider'
import { LIMITS } from '@harness-forge/shared'
import { MockImageModelV4, MockSpeechModelV4, MockTranscriptionModelV4 } from 'ai/test'
import { abortableDelay, abortError, countWords, MOCK_PROVIDER_ID, unknownModelError } from './common.ts'
import { encodeSolidPng } from './png.ts'

/** Model ids of the media models (`kind` `image`, `transcription`, `speech`). */
export const MOCK_IMAGE_MODEL_ID = 'image'
export const MOCK_TRANSCRIPTION_MODEL_ID = 'transcribe'
export const MOCK_SPEECH_MODEL_ID = 'speech'

/** `ModelInfo.voices` of `mock:speech` (suggestions of Settings → Media; any other voice is accepted too). */
export const MOCK_SPEECH_VOICES = ['mock-voice-a', 'mock-voice-b'] as const

/** The text `mock:transcribe` returns for any recording. */
export const MOCK_TRANSCRIPT = 'This is a mock transcription.'

/** `mock:image` timing: the wait before the images exist (a prompt containing "slow" waits longer). */
export const MOCK_IMAGE_TIMING = {
  delayMs: 300,
  slowDelayMs: 5000,
} as const

/** The long edge of a mock image in pixels (the aspect ratio sets the short edge; "Auto" is square). */
export const MOCK_IMAGE_EDGE = 320

/** Largest edge of an explicit `size` (larger sizes are scaled down, keeping the ratio). */
export const MOCK_IMAGE_MAX_EDGE = 1024

/** Output tokens reported per generated image. */
export const MOCK_IMAGE_TOKENS_PER_IMAGE = 100

/** The failure of a `mock:image` prompt containing "fail". */
export const MOCK_IMAGE_FAILURE = 'Mock image generation failure'
export const MOCK_IMAGE_ERROR_URL = 'mock://image'

/** `mock:speech` output: silent 16-bit mono PCM, 400 ms per word, from 1 s to 6 s. */
export const MOCK_SPEECH_AUDIO = {
  sampleRate: 8000,
  msPerWord: 400,
  minMs: 1000,
  maxMs: 6000,
} as const

// ---------- images ----------

/** Pixel size of a mock image. */
export interface MockImageSize {
  width: number
  height: number
}

/** Token usage of a `mock:image` call (every field reported). */
export interface MockImageUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

const SIZE_PATTERN = /^(\d{1,5})x(\d{1,5})$/
const RATIO_PATTERN = /^(\d{1,3}):(\d{1,3})$/

/** The two positive integers of `value` matched by `pattern`, or null. */
function positivePair(value: string | undefined, pattern: RegExp): [number, number] | null {
  const match = value?.match(pattern)
  if (!match)
    return null
  const first = Number(match[1])
  const second = Number(match[2])
  return first > 0 && second > 0 ? [first, second] : null
}

/**
 * The pixel size of a mock image: an explicit `size` (`WxH`, scaled down to `MOCK_IMAGE_MAX_EDGE` keeping its ratio),
 * else the aspect ratio `W:H` (`W*k` x `H*k` with the largest `k` that keeps both edges within `MOCK_IMAGE_EDGE`, so the
 * ratio is exact: 16:9 -> 320x180, 3:2 -> 318x212), else a square (`MOCK_IMAGE_EDGE` x `MOCK_IMAGE_EDGE`).
 */
export function mockImageSize(options: { size?: string, aspectRatio?: string } = {}): MockImageSize {
  const size = positivePair(options.size, SIZE_PATTERN)
  if (size !== null) {
    const [width, height] = size
    const scale = Math.min(1, MOCK_IMAGE_MAX_EDGE / Math.max(width, height))
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
  }
  const ratio = positivePair(options.aspectRatio, RATIO_PATTERN)
  if (ratio !== null) {
    const [width, height] = ratio
    const unit = Math.max(1, Math.floor(MOCK_IMAGE_EDGE / Math.max(width, height)))
    return { width: width * unit, height: height * unit }
  }
  return { width: MOCK_IMAGE_EDGE, height: MOCK_IMAGE_EDGE }
}

/**
 * The color of image `index` of a request: the first three bytes of a sha256 over the prompt, the index and the input
 * images (bytes, base64 text or URL), so every image of a request and every edit differs.
 */
export function mockImageColor(prompt: string, index: number, inputs: readonly ImageModelV4File[] = []): Rgb {
  const hash = createHash('sha256').update(prompt).update('\u0000').update(String(index))
  for (const input of inputs) {
    hash.update('\u0000')
    if (input.type === 'url')
      hash.update(input.url)
    else
      hash.update(input.data)
  }
  const digest = hash.digest()
  return [digest[0]!, digest[1]!, digest[2]!]
}

/** A mock image: a solid-color PNG (see `mockImageSize` and `mockImageColor`). */
export function mockImagePng(prompt: string, index: number, size: MockImageSize, inputs: readonly ImageModelV4File[] = []): Uint8Array {
  return encodeSolidPng(size.width, size.height, mockImageColor(prompt, index, inputs))
}

/** Usage of a `mock:image` call: the prompt's words in, `MOCK_IMAGE_TOKENS_PER_IMAGE` per image out. */
export function mockImageUsage(prompt: string, n: number): MockImageUsage {
  const inputTokens = countWords(prompt)
  const outputTokens = MOCK_IMAGE_TOKENS_PER_IMAGE * n
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}

/** The `revisedPrompt` of `mock:image`: `Mock: <prompt>`, cut to `LIMITS.imagePromptMaxChars` characters. */
export function mockRevisedPrompt(prompt: string): string {
  return Array.from(`Mock: ${prompt}`).slice(0, LIMITS.imagePromptMaxChars).join('')
}

/** The aspect ratio passed through `providerOptions.mock` (`imageParams`), if any. */
export function mockAspectRatioOption(providerOptions: SharedV4ProviderOptions | undefined): string | undefined {
  const value = providerOptions?.[MOCK_PROVIDER_ID]?.aspectRatio
  return typeof value === 'string' ? value : undefined
}

/**
 * `imageParams` of the mock provider: passes the aspect ratio through, as `aspectRatio` (image models: the pixel size
 * follows it) and as `providerOptions.mock.aspectRatio` (image-output chat models, which only get provider options);
 * nothing for "Auto".
 */
export function mockImageParams(request: ImageParamsRequest): ImageParamsResult | undefined {
  if (request.aspectRatio === undefined)
    return undefined
  return { aspectRatio: request.aspectRatio, providerOptions: { [MOCK_PROVIDER_ID]: { aspectRatio: request.aspectRatio } } }
}

/** The 400 `APICallError` (not retryable) of a `mock:image` prompt containing "fail". */
export function mockImageError(): APICallError {
  return new APICallError({
    message: MOCK_IMAGE_FAILURE,
    url: MOCK_IMAGE_ERROR_URL,
    requestBodyValues: {},
    statusCode: 400,
    responseHeaders: {},
    responseBody: JSON.stringify({ error: { type: 'invalid_request_error', message: MOCK_IMAGE_FAILURE } }),
    isRetryable: false,
  })
}

/**
 * `mock:image` (`createImageModel` of the mock provider): waits `MOCK_IMAGE_TIMING.delayMs` (`slowDelayMs` when the
 * prompt contains "slow"), honoring the abort signal; a prompt containing "fail" then rejects with `mockImageError()`;
 * otherwise `n` solid-color PNGs (one call makes up to `LIMITS.imagesPerTurnMax` images), the usage of
 * `mockImageUsage` and `providerMetadata.mock.images[i].revisedPrompt` (the key OpenAI uses too). Other model ids reject
 * with a 404.
 */
export function createMockImageModel(modelId: string): ImageModelV4 {
  return new MockImageModelV4({
    provider: MOCK_PROVIDER_ID,
    modelId,
    maxImagesPerCall: LIMITS.imagesPerTurnMax,
    doGenerate: async (options) => {
      if (modelId !== MOCK_IMAGE_MODEL_ID)
        throw unknownModelError(modelId)
      const prompt = options.prompt ?? ''
      const text = prompt.toLowerCase()
      await abortableDelay(text.includes('slow') ? MOCK_IMAGE_TIMING.slowDelayMs : MOCK_IMAGE_TIMING.delayMs, options.abortSignal)
      if (text.includes('fail'))
        throw mockImageError()
      const size = mockImageSize({ size: options.size, aspectRatio: options.aspectRatio ?? mockAspectRatioOption(options.providerOptions) })
      const inputs = options.files ?? []
      const images = Array.from({ length: options.n }, (_, index) => mockImagePng(prompt, index, size, inputs))
      const revisedPrompt = mockRevisedPrompt(prompt)
      return {
        images,
        warnings: [],
        providerMetadata: { [MOCK_PROVIDER_ID]: { images: images.map(() => ({ revisedPrompt })) } },
        response: { timestamp: new Date(0), modelId, headers: undefined },
        usage: mockImageUsage(prompt, options.n),
      }
    },
  })
}

// ---------- transcription ----------

/**
 * `mock:transcribe` (`createTranscriptionModel` of the mock provider): `MOCK_TRANSCRIPT` for any recording, no segments,
 * language or duration; rejects with the abort reason when the call is aborted. Other model ids reject with a 404.
 */
export function createMockTranscriptionModel(modelId: string): TranscriptionModelV4 {
  return new MockTranscriptionModelV4({
    provider: MOCK_PROVIDER_ID,
    modelId,
    doGenerate: async (options) => {
      if (modelId !== MOCK_TRANSCRIPTION_MODEL_ID)
        throw unknownModelError(modelId)
      if (options.abortSignal?.aborted)
        throw abortError(options.abortSignal)
      return {
        text: MOCK_TRANSCRIPT,
        segments: [],
        language: undefined,
        durationInSeconds: undefined,
        warnings: [],
        response: { timestamp: new Date(0), modelId },
      }
    },
  })
}

// ---------- speech ----------

/** Duration of the speech of `text`: `MOCK_SPEECH_AUDIO.msPerWord` per word, clamped to `minMs`..`maxMs`. */
export function mockSpeechDurationMs(text: string): number {
  const { msPerWord, minMs, maxMs } = MOCK_SPEECH_AUDIO
  return Math.min(maxMs, Math.max(minMs, countWords(text) * msPerWord))
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index++)
    target[offset + index] = text.charCodeAt(index)
}

/**
 * A silent WAV file (RIFF / WAVE, PCM, 16-bit, mono, `MOCK_SPEECH_AUDIO.sampleRate` Hz): the 44-byte canonical header,
 * then `mockSpeechDurationMs(text)` of zero samples. `generateSpeech` reports it as `audio/wav` (magic bytes).
 */
export function createMockWav(text = ''): Uint8Array {
  const { sampleRate } = MOCK_SPEECH_AUDIO
  const bytesPerSample = 2
  const samples = Math.round((sampleRate * mockSpeechDurationMs(text)) / 1000)
  const dataBytes = samples * bytesPerSample
  const out = new Uint8Array(44 + dataBytes)
  const view = new DataView(out.buffer)
  writeAscii(out, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(out, 8, 'WAVE')
  writeAscii(out, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true) // byte rate
  view.setUint16(32, bytesPerSample, true) // block align
  view.setUint16(34, 8 * bytesPerSample, true) // bits per sample
  writeAscii(out, 36, 'data')
  view.setUint32(40, dataBytes, true)
  return out
}

/**
 * `mock:speech` (`createSpeechModel` of the mock provider): `createMockWav(text)` for any voice; rejects with the abort
 * reason when the call is aborted. Other model ids reject with a 404.
 */
export function createMockSpeechModel(modelId: string): SpeechModelV4 {
  return new MockSpeechModelV4({
    provider: MOCK_PROVIDER_ID,
    modelId,
    doGenerate: async (options) => {
      if (modelId !== MOCK_SPEECH_MODEL_ID)
        throw unknownModelError(modelId)
      if (options.abortSignal?.aborted)
        throw abortError(options.abortSignal)
      return { audio: createMockWav(options.text), warnings: [], response: { timestamp: new Date(0), modelId } }
    },
  })
}
