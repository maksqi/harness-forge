// The media models of the mock provider (C11-T3, PROVIDERS.md 8), driven through the real AI SDK calls
// (`generateImage`, `transcribe`, `generateSpeech`) as the image and audio services will call them.
import type { ImageModelV4CallOptions } from '@ai-sdk/provider'
import { APICallError } from '@ai-sdk/provider'
import { IMAGE_ASPECT_RATIOS } from '@harness-forge/shared'
import { generateImage, generateSpeech, transcribe } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultProviderError } from '../../providers/errors.ts'
import { firstPixel, readPng, readWav } from './media.test-util.ts'
import {
  createMockImageModel,
  createMockSpeechModel,
  createMockTranscriptionModel,
  createMockWav,
  MOCK_IMAGE_EDGE,
  MOCK_IMAGE_FAILURE,
  MOCK_IMAGE_TIMING,
  MOCK_SPEECH_AUDIO,
  MOCK_TRANSCRIPT,
  mockAspectRatioOption,
  mockImageColor,
  mockImageParams,
  mockImageSize,
  mockRevisedPrompt,
  mockSpeechDurationMs,
} from './media.ts'

afterEach(() => {
  vi.useRealTimers()
})

function callOptions(overrides: Partial<ImageModelV4CallOptions> = {}): ImageModelV4CallOptions {
  return { prompt: 'a red fox', n: 1, size: undefined, aspectRatio: undefined, seed: undefined, files: undefined, mask: undefined, providerOptions: {}, ...overrides }
}

async function settle(promise: Promise<unknown>): Promise<'pending' | 'resolved' | 'rejected'> {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending'
  promise.then(() => (state = 'resolved'), () => (state = 'rejected'))
  await Promise.resolve()
  await Promise.resolve()
  return state
}

describe('mock image sizes', () => {
  it('maps every aspect ratio to an exact pixel ratio within 320 px, Auto to a square', () => {
    expect(mockImageSize()).toEqual({ width: MOCK_IMAGE_EDGE, height: MOCK_IMAGE_EDGE })
    expect(mockImageSize({ aspectRatio: '16:9' })).toEqual({ width: 320, height: 180 })
    expect(mockImageSize({ aspectRatio: '9:16' })).toEqual({ width: 180, height: 320 })
    expect(mockImageSize({ aspectRatio: '3:2' })).toEqual({ width: 318, height: 212 })
    for (const ratio of IMAGE_ASPECT_RATIOS) {
      const [w, h] = ratio.split(':').map(Number) as [number, number]
      const { width, height } = mockImageSize({ aspectRatio: ratio })
      expect(width * h, ratio).toBe(height * w)
      expect(Math.max(width, height), ratio).toBeLessThanOrEqual(MOCK_IMAGE_EDGE)
    }
  })

  it('uses an explicit size (scaled down to 1024 px) and ignores malformed values', () => {
    expect(mockImageSize({ size: '64x32', aspectRatio: '1:1' })).toEqual({ width: 64, height: 32 })
    expect(mockImageSize({ size: '1024x1536' })).toEqual({ width: 683, height: 1024 })
    expect(mockImageSize({ size: '0x10', aspectRatio: 'wide' })).toEqual({ width: 320, height: 320 })
  })
})

describe('mock:image', () => {
  it('generates n solid-color PNGs at the aspect ratio with usage and a revised prompt', async () => {
    const result = await generateImage({ model: createMockImageModel('image'), prompt: 'a red fox at dawn', n: 2, aspectRatio: '16:9' })
    expect(result.images).toHaveLength(2)
    const [first, second] = result.images.map(image => readPng(image.uint8Array))
    expect(first).toMatchObject({ width: 320, height: 180, crcOk: true })
    expect(second).toMatchObject({ width: 320, height: 180 })
    expect(result.images.every(image => image.mediaType === 'image/png')).toBe(true)
    // Colors come from a hash of prompt + index: two images of one request differ.
    expect(firstPixel(first!)).toEqual(mockImageColor('a red fox at dawn', 0))
    expect(firstPixel(second!)).toEqual(mockImageColor('a red fox at dawn', 1))
    expect(firstPixel(first!)).not.toEqual(firstPixel(second!))
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 200, totalTokens: 205 })
    expect(result.providerMetadata.mock?.images).toEqual([{ revisedPrompt: 'Mock: a red fox at dawn' }, { revisedPrompt: 'Mock: a red fox at dawn' }])
    expect(result.images[0]?.providerMetadata).toEqual({ mock: { revisedPrompt: 'Mock: a red fox at dawn' } })
  })

  it('makes up to 4 images in one call, square without an aspect ratio, deterministically', async () => {
    const model = createMockImageModel('image')
    const spy = vi.spyOn(model, 'doGenerate')
    const result = await generateImage({ model, prompt: 'lighthouse', n: 4 })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(result.images.map(image => readPng(image.uint8Array).width)).toEqual([320, 320, 320, 320])
    expect(result.images.map(image => readPng(image.uint8Array).height)).toEqual([320, 320, 320, 320])
    const again = await generateImage({ model: createMockImageModel('image'), prompt: 'lighthouse', n: 4 })
    expect(again.images.map(image => image.base64)).toEqual(result.images.map(image => image.base64))
  })

  it('an edit (input images) changes the colors; the aspect ratio of providerOptions.mock is used too', async () => {
    const model = createMockImageModel('image')
    const plain = await model.doGenerate(callOptions())
    const input = plain.images[0] as Uint8Array
    const edit = await model.doGenerate(callOptions({ files: [{ type: 'file', mediaType: 'image/png', data: input }] }))
    expect(firstPixel(readPng(edit.images[0] as Uint8Array))).not.toEqual(firstPixel(readPng(input)))
    expect(firstPixel(readPng(edit.images[0] as Uint8Array))).toEqual(mockImageColor('a red fox', 0, [{ type: 'file', mediaType: 'image/png', data: input }]))
    const viaOptions = await model.doGenerate(callOptions({ providerOptions: { mock: { aspectRatio: '4:3' } } }))
    expect(readPng(viaOptions.images[0] as Uint8Array)).toMatchObject({ width: 320, height: 240 })
    const explicit = await model.doGenerate(callOptions({ size: '64x48' }))
    expect(readPng(explicit.images[0] as Uint8Array)).toMatchObject({ width: 64, height: 48 })
  })

  it('waits 300 ms, and 5 s when the prompt contains "slow"', async () => {
    vi.useFakeTimers()
    const model = createMockImageModel('image')
    const quick = model.doGenerate(callOptions())
    await vi.advanceTimersByTimeAsync(MOCK_IMAGE_TIMING.delayMs - 1)
    expect(await settle(Promise.resolve(quick))).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(await settle(Promise.resolve(quick))).toBe('resolved')

    const slow = model.doGenerate(callOptions({ prompt: 'a SLOW sunset' }))
    await vi.advanceTimersByTimeAsync(MOCK_IMAGE_TIMING.slowDelayMs - 1)
    expect(await settle(Promise.resolve(slow))).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(await settle(Promise.resolve(slow))).toBe('resolved')
    expect(MOCK_IMAGE_TIMING).toEqual({ delayMs: 300, slowDelayMs: 5000 })
  })

  it('honors the abort signal while it waits', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const pending = generateImage({ model: createMockImageModel('image'), prompt: 'slow painting', abortSignal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - started).toBeLessThan(1000)
    const aborted = new AbortController()
    aborted.abort()
    await expect(createMockImageModel('image').doGenerate(callOptions({ abortSignal: aborted.signal }))).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects a prompt containing "fail" with a 400 APICallError (not retried, mapped to provider_error)', async () => {
    const model = createMockImageModel('image')
    const spy = vi.spyOn(model, 'doGenerate')
    const error = await generateImage({ model, prompt: 'please FAIL now', maxRetries: 2 }).then(() => null, (caught: unknown) => caught)
    expect(spy).toHaveBeenCalledTimes(1)
    const cause = APICallError.isInstance(error) ? error : (error as { lastError?: unknown }).lastError
    expect(APICallError.isInstance(cause)).toBe(true)
    expect(cause).toMatchObject({ statusCode: 400, message: MOCK_IMAGE_FAILURE, isRetryable: false })
    const mapped = defaultProviderError(cause, { providerId: 'mock', providerName: 'Mock (dev only)', redactText: text => text, now: 0 })
    expect(mapped).toMatchObject({ code: 'provider_error', status: 400, providerId: 'mock' })
  })

  it('rejects other model ids with a 404', async () => {
    await expect(createMockImageModel('echo').doGenerate(callOptions())).rejects.toMatchObject({ statusCode: 404 })
  })

  it('cuts the revised prompt to the prompt limit', () => {
    expect(mockRevisedPrompt('x')).toBe('Mock: x')
    expect(Array.from(mockRevisedPrompt('y'.repeat(40_000)))).toHaveLength(32_000)
  })
})

describe('imageParams of the mock provider', () => {
  it('passes the aspect ratio through (call option and providerOptions.mock), nothing for Auto', () => {
    expect(mockImageParams({ n: 2, inputs: 0 })).toBeUndefined()
    const params = mockImageParams({ n: 1, aspectRatio: '9:16', inputs: 1 })
    expect(params).toEqual({ aspectRatio: '9:16', providerOptions: { mock: { aspectRatio: '9:16' } } })
    expect(mockAspectRatioOption(params?.providerOptions)).toBe('9:16')
    expect(mockAspectRatioOption({ mock: { aspectRatio: 3 } })).toBeUndefined()
    expect(mockAspectRatioOption(undefined)).toBeUndefined()
  })
})

describe('mock:transcribe', () => {
  it('returns the mock transcript for any recording, without language or duration', async () => {
    const result = await transcribe({ model: createMockTranscriptionModel('transcribe'), audio: createMockWav('hello there') })
    expect(result).toMatchObject({ text: MOCK_TRANSCRIPT, segments: [], language: undefined, durationInSeconds: undefined })
    expect(MOCK_TRANSCRIPT).toBe('This is a mock transcription.')
    const webm = Uint8Array.from([0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81, 0x01])
    expect((await transcribe({ model: createMockTranscriptionModel('transcribe'), audio: webm })).text).toBe(MOCK_TRANSCRIPT)
  })

  it('rejects an aborted call and other model ids', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(transcribe({ model: createMockTranscriptionModel('transcribe'), audio: createMockWav(), abortSignal: controller.signal })).rejects.toThrow()
    await expect(createMockTranscriptionModel('speech').doGenerate({ audio: createMockWav(), mediaType: 'audio/wav' })).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('mock:speech', () => {
  it('returns a silent 8 kHz mono 16-bit WAV detected as audio/wav', async () => {
    const result = await generateSpeech({ model: createMockSpeechModel('speech'), text: 'Hello world', voice: 'mock-voice-b' })
    expect(result.audio.mediaType).toBe('audio/wav')
    expect(result.audio.format).toBe('wav')
    const wav = readWav(result.audio.uint8Array)
    expect(wav).toMatchObject({ riff: 'RIFF', wave: 'WAVE', format: 1, channels: 1, sampleRate: 8000, byteRate: 16_000, blockAlign: 2, bitsPerSample: 16, silent: true })
    expect(wav.durationMs).toBe(1000)
    expect(result.audio.uint8Array.byteLength).toBe(44 + wav.dataBytes)
  })

  it('lasts 400 ms per word, at least 1 s and at most 6 s', () => {
    expect(MOCK_SPEECH_AUDIO).toEqual({ sampleRate: 8000, msPerWord: 400, minMs: 1000, maxMs: 6000 })
    const words = (n: number): string => Array.from({ length: n }, (_, index) => `w${index}`).join(' ')
    for (const [n, ms] of [[0, 1000], [1, 1000], [2, 1000], [3, 1200], [5, 2000], [15, 6000], [40, 6000]] as const) {
      expect(mockSpeechDurationMs(words(n)), `${n} words`).toBe(ms)
      expect(readWav(createMockWav(words(n))).durationMs, `${n} words`).toBe(ms)
    }
    expect(readWav(createMockWav()).durationMs).toBe(1000)
  })

  it('rejects an aborted call and other model ids', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(generateSpeech({ model: createMockSpeechModel('speech'), text: 'hi', abortSignal: controller.signal })).rejects.toThrow()
    await expect(createMockSpeechModel('transcribe').doGenerate({ text: 'hi' })).rejects.toMatchObject({ statusCode: 404 })
  })
})
