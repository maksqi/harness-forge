import type { SpeechModelV4CallOptions, TranscriptionModelV4CallOptions } from '@ai-sdk/provider'
import type { ProviderDefinition, TranscriptionHints } from '@harness-forge/plugin-sdk'
import type { SettingsUpdate } from '@harness-forge/shared'
import type { LogRecord } from '../../logger.ts'
import type { FakeMediaResolverOptions } from '../../providers/testing.ts'
import type { ProviderService, ResolvedModelBase } from '../../providers/types.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { AppDeps } from '../../types.ts'
import type { AudioServiceOptions } from './index.ts'
// Audio service (ADR-029, ARCHITECTURE.md 6.12 / 10.8 / 12) against the fake media resolvers (instant `ai/test` models
// on the real catalog and registry): recording checks, model / language / voice resolution, the exact AI SDK call
// options, `NoTranscriptGeneratedError`, speech types, timeouts, client aborts, error mapping + provider outcome, usage
// rows, and log lines that never carry a transcript or speech text.
import { APICallError } from '@ai-sdk/provider'
import { HarnessError, harnessErrorEnvelopeSchema, LIMITS } from '@harness-forge/shared'
import { generateSpeech, transcribe } from 'ai'
import { MockSpeechModelV4, MockTranscriptionModelV4 } from 'ai/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readWav } from '../../builtin-plugins/mock/media.test-util.ts'
import { createMockWav, MOCK_TRANSCRIPT } from '../../builtin-plugins/mock/media.ts'
import { usage } from '../../db/schema.ts'
import { createProviderServiceWith, unknownProviderMessage } from '../../providers/index.ts'
import { withFakeMediaResolvers } from '../../providers/testing.ts'
import { SAMPLE_WEBM_BYTES } from '../../testing/api-samples.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import {
  CANCELED_MESSAGE,
  createAudioServiceWith,
  echoesText,
  EMPTY_RECORDING_MESSAGE,
  NO_SPEECH_MODEL_MESSAGE,
  NO_TRANSCRIPTION_MODEL_MESSAGE,
  RECORDING_TOO_LARGE_MESSAGE,
  speechMediaType,
} from './index.ts'

// Pass-through spies: the service's exact `transcribe()` / `generateSpeech()` options are asserted.
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, transcribe: vi.fn(actual.transcribe), generateSpeech: vi.fn(actual.generateSpeech) }
})

const SPEECH_TEXT = 'Please read this sentence aloud for me.'
const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...new Uint8Array(120)])

const apps: TestApp[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
  vi.mocked(transcribe).mockClear()
  vi.mocked(generateSpeech).mockClear()
})

interface AudioAppOptions extends FakeMediaResolverOptions {
  /** Merged into the provider definition of every resolved audio model (e.g. `transcriptionOptions`). */
  definition?: Partial<ProviderDefinition>
  /** Replaces `providers.mapError`. */
  mapError?: ProviderService['mapError']
  service?: AudioServiceOptions
  settings?: SettingsUpdate
}

function patchedProviders(deps: AppDeps, options: AudioAppOptions): ProviderService {
  const base = withFakeMediaResolvers(createProviderServiceWith(deps, {}), deps, options)
  const patch = <T extends ResolvedModelBase>(resolved: T): T => options.definition === undefined
    ? resolved
    : { ...resolved, provider: { ...resolved.provider, definition: { ...resolved.provider.definition, ...options.definition } } }
  return {
    ...base,
    resolveTranscriptionModel: async (ref, resolveOptions) => patch(await base.resolveTranscriptionModel(ref, resolveOptions)),
    resolveSpeechModel: async (ref, resolveOptions) => patch(await base.resolveSpeechModel(ref, resolveOptions)),
    ...(options.mapError === undefined ? {} : { mapError: options.mapError }),
  }
}

async function audioApp(options: AudioAppOptions = {}): Promise<TestApp> {
  const t = await createTestApp({
    env: { HF_MOCK_PROVIDER: '1' },
    factories: {
      providers: deps => patchedProviders(deps, options),
      audio: deps => createAudioServiceWith(deps, options.service ?? {}),
    },
  })
  apps.push(t)
  if (options.settings !== undefined)
    await t.deps.settings.update(options.settings)
  return t
}

/** Rejects with the abort reason once the call's signal aborts (a provider that never answers). */
function untilAborted(options: { abortSignal?: AbortSignal }): Promise<never> {
  return new Promise((_resolve, reject) => {
    const signal = options.abortSignal
    if (signal === undefined)
      return
    if (signal.aborted)
      reject(signal.reason)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

interface TranscriptAnswer {
  text?: string
  language?: string
  durationInSeconds?: number
}

function transcriptionModel(answer: TranscriptAnswer = {}, before?: (options: TranscriptionModelV4CallOptions) => Promise<unknown>) {
  const calls: TranscriptionModelV4CallOptions[] = []
  const model = new MockTranscriptionModelV4({
    provider: 'mock',
    modelId: 'transcribe',
    doGenerate: async (options) => {
      calls.push(options)
      await before?.(options)
      return {
        text: answer.text ?? MOCK_TRANSCRIPT,
        segments: [],
        language: answer.language,
        durationInSeconds: answer.durationInSeconds,
        warnings: [],
        response: { timestamp: new Date(0), modelId: 'transcribe' },
      }
    },
  })
  return { model, calls }
}

interface SpeechAnswer {
  audio?: Uint8Array
  headers?: Record<string, string>
}

function speechModel(answer: SpeechAnswer = {}, before?: (options: SpeechModelV4CallOptions) => Promise<unknown>) {
  const calls: SpeechModelV4CallOptions[] = []
  const model = new MockSpeechModelV4({
    provider: 'mock',
    modelId: 'speech',
    doGenerate: async (options) => {
      calls.push(options)
      await before?.(options)
      return { audio: answer.audio ?? createMockWav(options.text), warnings: [], response: { timestamp: new Date(0), modelId: 'speech', headers: answer.headers } }
    },
  })
  return { model, calls }
}

function recording(content: Uint8Array = SAMPLE_WEBM_BYTES, type = 'audio/webm;codecs=opus'): File {
  return new File([new Uint8Array(content)], 'dictation.webm', { type })
}

function signal(): AbortSignal {
  return new AbortController().signal
}

async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  }
  catch (error) {
    if (error instanceof HarnessError)
      return error
    throw error
  }
  throw new Error('expected a rejection')
}

function audioLines(t: TestApp, purpose: 'transcription' | 'speech'): LogRecord[] {
  return t.logs.records.filter(record => record.msg === `audio ${purpose}`)
}

function lastTranscribeOptions(): Parameters<typeof transcribe>[0] {
  const call = vi.mocked(transcribe).mock.calls.at(-1)
  if (call === undefined)
    throw new Error('transcribe() was not called')
  return call[0]
}

function lastSpeechOptions(): Parameters<typeof generateSpeech>[0] {
  const call = vi.mocked(generateSpeech).mock.calls.at(-1)
  if (call === undefined)
    throw new Error('generateSpeech() was not called')
  return call[0]
}

describe('audioService.transcribe', () => {
  it('transcribes with the settings model: the recording bytes, one retry, the call signal and no options for auto', async () => {
    const model = transcriptionModel()
    const t = await audioApp({ transcriptionModels: { 'mock:transcribe': model.model }, settings: { transcriptionModelRef: 'mock:transcribe' } })
    expect(await t.deps.audio.transcribe({ file: recording(), form: {}, signal: signal() })).toEqual({
      text: MOCK_TRANSCRIPT,
      language: null,
      durationSec: null,
      modelRef: 'mock:transcribe',
    })
    expect(model.calls).toHaveLength(1)
    expect(model.calls[0]!.audio).toEqual(SAMPLE_WEBM_BYTES)
    // The AI SDK sniffs the media type from the bytes.
    expect(model.calls[0]).toMatchObject({ mediaType: 'audio/webm', providerOptions: {} })
    const options = lastTranscribeOptions()
    expect(Object.keys(options).sort()).toEqual(['abortSignal', 'audio', 'maxRetries', 'model'])
    expect(options.maxRetries).toBe(1)
    expect(options.abortSignal).toBe(model.calls[0]!.abortSignal)
  })

  it('uses the form model and language over the settings; a code goes through transcriptionOptions, auto sends nothing', async () => {
    const model = transcriptionModel()
    const hook = vi.fn((hints: TranscriptionHints) => (hints.language === undefined ? undefined : { mock: { language: hints.language } }))
    const t = await audioApp({
      transcriptionModels: { 'mock:transcribe': model.model },
      definition: { transcriptionOptions: hook },
      settings: { transcriptionModelRef: 'mock:missing', transcriptionLanguage: 'de' },
    })
    await t.deps.audio.transcribe({ file: recording(), form: { modelRef: 'mock:transcribe' }, signal: signal() })
    expect(hook).toHaveBeenLastCalledWith({ language: 'de' })
    expect(model.calls[0]!.providerOptions).toEqual({ mock: { language: 'de' } })
    expect(lastTranscribeOptions().providerOptions).toEqual({ mock: { language: 'de' } })

    await t.deps.audio.transcribe({ file: recording(), form: { modelRef: 'mock:transcribe', language: 'yue' }, signal: signal() })
    expect(hook).toHaveBeenLastCalledWith({ language: 'yue' })
    expect(model.calls[1]!.providerOptions).toEqual({ mock: { language: 'yue' } })

    await t.deps.audio.transcribe({ file: recording(), form: { modelRef: 'mock:transcribe', language: 'auto' }, signal: signal() })
    expect(hook).toHaveBeenCalledTimes(2)
    expect(model.calls[2]!.providerOptions).toEqual({})
    // The settings model is only the fallback: without a form model it is used (and is not in the catalog).
    expect((await rejection(t.deps.audio.transcribe({ file: recording(), form: {}, signal: signal() }))).code).toBe('model_not_found')
  })

  it('sends no provider options when transcriptionOptions throws or returns something else', async () => {
    for (const transcriptionOptions of [
      () => {
        throw new Error('hook bug')
      },
      () => ({ mock: 'de' }) as never,
      () => [{ mock: {} }] as never,
    ]) {
      const model = transcriptionModel()
      const t = await audioApp({ transcriptionModels: { 'mock:transcribe': model.model }, definition: { transcriptionOptions } })
      const result = await t.deps.audio.transcribe({ file: recording(), form: { modelRef: 'mock:transcribe', language: 'de' }, signal: signal() })
      expect(result.text).toBe(MOCK_TRANSCRIPT)
      expect(model.calls[0]!.providerOptions).toEqual({})
      expect(t.logs.records.some(record => record.level === 'warn' && record.msg.startsWith('provider transcriptionOptions()'))).toBe(true)
    }
  })

  it('refuses a missing model, and passes the resolver errors through without calling a provider', async () => {
    const model = transcriptionModel()
    const t = await audioApp({ transcriptionModels: { 'mock:transcribe': model.model } })
    const none = await rejection(t.deps.audio.transcribe({ file: recording(), form: {}, signal: signal() }))
    expect(none.toJSON().error).toMatchObject({
      code: 'validation_error',
      message: NO_TRANSCRIPTION_MODEL_MESSAGE,
      details: { issues: [{ path: ['modelRef'], message: NO_TRANSCRIPTION_MODEL_MESSAGE }] },
    })
    expect((await rejection(t.deps.audio.transcribe({ file: recording(), form: { modelRef: 'mock:speech' }, signal: signal() }))).code).toBe('validation_error')
    expect((await rejection(t.deps.audio.transcribe({ file: recording(), form: { modelRef: 'mock:nope' }, signal: signal() }))).toJSON().error)
      .toMatchObject({ code: 'model_not_found', action: 'refresh-models' })
    // Phase 7: an unknown provider is provider_not_configured (400, action configure-provider).
    expect((await rejection(t.deps.audio.transcribe({ file: recording(), form: { modelRef: 'acme:whisper' }, signal: signal() }))).toJSON().error)
      .toMatchObject({ code: 'provider_not_configured', action: 'configure-provider', providerId: 'acme', message: unknownProviderMessage('acme') })
    expect(model.calls).toEqual([])
    expect(audioLines(t, 'transcription')).toEqual([])
    expect(await t.db.select().from(usage)).toEqual([])
  })

  it('checks the size before the type: under 64 bytes is empty, over the limit is 413', async () => {
    const model = transcriptionModel()
    const t = await audioApp({ transcriptionModels: { 'mock:transcribe': model.model }, settings: { transcriptionModelRef: 'mock:transcribe' } })
    const empty = await rejection(t.deps.audio.transcribe({ file: recording(SAMPLE_WEBM_BYTES.subarray(0, 63)), form: {}, signal: signal() }))
    expect(empty.toJSON().error).toMatchObject({ code: 'validation_error', message: EMPTY_RECORDING_MESSAGE, details: { issues: [{ path: ['file'] }] } })
    const large = await rejection(t.deps.audio.transcribe({ file: new File([new Uint8Array(LIMITS.audioUploadBytes + 1)], 'long.webm', { type: 'audio/webm' }), form: {}, signal: signal() }))
    expect(large.httpStatus).toBe(413)
    expect(large.toJSON().error).toEqual({ code: 'payload_too_large', message: RECORDING_TOO_LARGE_MESSAGE, details: { limitBytes: LIMITS.audioUploadBytes } })
    expect(RECORDING_TOO_LARGE_MESSAGE).toBe('Recordings are limited to 25 MB.')
    expect(model.calls).toEqual([])
  })

  it('refuses a type that is not accepted or does not match the bytes; octet-stream lets the bytes decide', async () => {
    const model = transcriptionModel()
    const t = await audioApp({ transcriptionModels: { 'mock:transcribe': model.model }, settings: { transcriptionModelRef: 'mock:transcribe' } })
    const png = await rejection(t.deps.audio.transcribe({ file: recording(PNG, 'audio/webm'), form: {}, signal: signal() }))
    expect(png.toJSON().error).toMatchObject({ code: 'validation_error', message: 'The recording does not match its type (audio/webm).' })
    const image = await rejection(t.deps.audio.transcribe({ file: recording(PNG, 'image/png'), form: {}, signal: signal() }))
    expect(image.message).toBe('The type image/png is not accepted: send a WebM, Ogg, MP4, MP3, WAV or FLAC recording.')
    expect(model.calls).toEqual([])

    const wav = createMockWav('hello there')
    expect((await t.deps.audio.transcribe({ file: recording(wav, 'application/octet-stream'), form: {}, signal: signal() })).text).toBe(MOCK_TRANSCRIPT)
    expect(model.calls[0]).toMatchObject({ mediaType: 'audio/wav' })
  })

  it('answers text \'\' when no speech is detected (NoTranscriptGeneratedError) and trims the transcript', async () => {
    const silent = transcriptionModel({ text: '' })
    const t = await audioApp({ transcriptionModels: { 'mock:transcribe': silent.model }, settings: { transcriptionModelRef: 'mock:transcribe' } })
    expect(await t.deps.audio.transcribe({ file: recording(), form: {}, signal: signal() })).toEqual({ text: '', language: null, durationSec: null, modelRef: 'mock:transcribe' })
    expect(audioLines(t, 'transcription').map(record => record.outcome)).toEqual(['empty'])
    expect(await t.db.select({ purpose: usage.purpose }).from(usage)).toEqual([{ purpose: 'transcription' }])

    const spaced = transcriptionModel({ text: '  Hallo Welt.  ', language: 'de', durationInSeconds: 2.5 })
    const other = await audioApp({ transcriptionModels: { 'mock:transcribe': spaced.model }, settings: { transcriptionModelRef: 'mock:transcribe' } })
    expect(await other.deps.audio.transcribe({ file: recording(), form: {}, signal: signal() })).toEqual({ text: 'Hallo Welt.', language: 'de', durationSec: 2.5, modelRef: 'mock:transcribe' })
    expect(audioLines(other, 'transcription')[0]).toMatchObject({ outcome: 'ok', durationSec: 2.5 })
  })

  it('reports an impossible duration as null', async () => {
    const odd = transcriptionModel({ durationInSeconds: -1 })
    const t = await audioApp({ transcriptionModels: { 'mock:transcribe': odd.model }, settings: { transcriptionModelRef: 'mock:transcribe' } })
    expect((await t.deps.audio.transcribe({ file: recording(), form: {}, signal: signal() })).durationSec).toBeNull()
  })

  it('maps provider errors, records the outcome, writes no usage row; a later success clears the provider error', async () => {
    let fail = true
    const model = transcriptionModel({}, async () => {
      if (fail)
        throw new APICallError({ message: 'Incorrect API key provided', url: 'https://api.example.com/v1/audio/transcriptions', requestBodyValues: {}, statusCode: 401, isRetryable: false })
    })
    const t = await audioApp({ transcriptionModels: { 'mock:transcribe': model.model }, settings: { transcriptionModelRef: 'mock:transcribe' } })
    const error = await rejection(t.deps.audio.transcribe({ file: recording(), form: {}, signal: signal() }))
    expect(error.toJSON().error).toMatchObject({ code: 'auth_invalid', providerId: 'mock', status: 401, action: 'configure-provider' })
    // The original error (it carries the request) is not attached.
    expect(error.cause).toBeUndefined()
    expect(model.calls).toHaveLength(1)
    expect((await t.deps.providers.get('mock')).lastError).toMatchObject({ code: 'auth_invalid' })
    expect(await t.db.select().from(usage)).toEqual([])
    expect(audioLines(t, 'transcription')).toEqual([expect.objectContaining({ level: 'info', outcome: 'failed', code: 'auth_invalid' })])

    fail = false
    await t.deps.audio.transcribe({ file: recording(), form: {}, signal: signal() })
    expect((await t.deps.providers.get('mock')).lastError).toBeNull()
  })

  it('times out after the limit with provider_unreachable and aborts the provider call', async () => {
    const hanging = transcriptionModel({}, untilAborted)
    const t = await audioApp({
      transcriptionModels: { 'mock:transcribe': hanging.model },
      settings: { transcriptionModelRef: 'mock:transcribe' },
      service: { transcriptionTimeoutMs: 50 },
    })
    const error = await rejection(t.deps.audio.transcribe({ file: recording(), form: {}, signal: signal() }))
    expect(error.toJSON().error).toMatchObject({ code: 'provider_unreachable', providerId: 'mock', action: 'retry' })
    const callSignal = hanging.calls[0]!.abortSignal!
    expect(callSignal.aborted).toBe(true)
    expect((callSignal.reason as DOMException).name).toBe('TimeoutError')
    expect((await t.deps.providers.get('mock')).lastError).toMatchObject({ code: 'provider_unreachable' })
  })

  it('aborts the provider call when the request signal aborts: canceled, nothing recorded', async () => {
    const hanging = transcriptionModel({}, untilAborted)
    const t = await audioApp({ transcriptionModels: { 'mock:transcribe': hanging.model }, settings: { transcriptionModelRef: 'mock:transcribe' } })
    const controller = new AbortController()
    const pending = t.deps.audio.transcribe({ file: recording(), form: {}, signal: controller.signal })
    await vi.waitFor(() => expect(hanging.calls).toHaveLength(1))
    // @hono/node-server aborts with a string reason when the client disconnects.
    controller.abort('Client connection prematurely closed.')
    const error = await rejection(pending)
    expect(error.toJSON().error).toMatchObject({ code: 'validation_error', message: CANCELED_MESSAGE })
    expect(hanging.calls[0]!.abortSignal!.aborted).toBe(true)
    expect(await t.db.select().from(usage)).toEqual([])
    expect((await t.deps.providers.get('mock')).lastError).toBeNull()
    expect(audioLines(t, 'transcription')).toEqual([expect.objectContaining({ outcome: 'canceled' })])
    // Already aborted: refused before anything is read.
    const aborted = new AbortController()
    aborted.abort()
    expect((await rejection(t.deps.audio.transcribe({ file: recording(), form: {}, signal: aborted.signal }))).message).toBe(CANCELED_MESSAGE)
    expect(hanging.calls).toHaveLength(1)
  })
})

describe('audioService.speak', () => {
  it('speaks with the settings model and voice; only the text, the voice and the call options reach generateSpeech', async () => {
    const model = speechModel()
    const t = await audioApp({ speechModels: { 'mock:speech': model.model }, settings: { speechModelRef: 'mock:speech', speechVoice: 'mock-voice-a' } })
    const speech = await t.deps.audio.speak({ text: `  ${SPEECH_TEXT} `, signal: signal() })
    expect(speech).toMatchObject({ mediaType: 'audio/wav', modelRef: 'mock:speech' })
    expect(readWav(speech.audio)).toMatchObject({ riff: 'RIFF', wave: 'WAVE', silent: true })
    const [call] = model.calls
    expect(call).toMatchObject({ text: SPEECH_TEXT, voice: 'mock-voice-a', providerOptions: {} })
    for (const key of ['outputFormat', 'instructions', 'speed', 'language'] as const)
      expect(call![key], key).toBeUndefined()
    const options = lastSpeechOptions()
    expect(Object.keys(options).sort()).toEqual(['abortSignal', 'maxRetries', 'model', 'text', 'voice'])
    expect(options.maxRetries).toBe(1)
    expect(options.abortSignal).toBe(call!.abortSignal)
  })

  it('uses the body model and voice over the settings; no voice anywhere = the provider default', async () => {
    const model = speechModel()
    const t = await audioApp({ speechModels: { 'mock:speech': model.model }, settings: { speechModelRef: 'mock:missing', speechVoice: 'mock-voice-a' } })
    await t.deps.audio.speak({ text: 'Hello world', modelRef: 'mock:speech', voice: 'mock-voice-b', signal: signal() })
    expect(model.calls[0]!.voice).toBe('mock-voice-b')
    await t.deps.settings.update({ speechVoice: null })
    await t.deps.audio.speak({ text: 'Hello world', modelRef: 'mock:speech', signal: signal() })
    expect(model.calls[1]!.voice).toBeUndefined()
    expect(lastSpeechOptions()).not.toHaveProperty('voice')
    expect((await rejection(t.deps.audio.speak({ text: 'Hello world', signal: signal() }))).code).toBe('model_not_found')
  })

  it('refuses a missing model, a model of another kind and text outside 1..4096 characters', async () => {
    const model = speechModel()
    const t = await audioApp({ speechModels: { 'mock:speech': model.model } })
    expect((await rejection(t.deps.audio.speak({ text: 'Hello world', signal: signal() }))).toJSON().error).toMatchObject({
      code: 'validation_error',
      message: NO_SPEECH_MODEL_MESSAGE,
      details: { issues: [{ path: ['modelRef'] }] },
    })
    expect((await rejection(t.deps.audio.speak({ text: 'Hello world', modelRef: 'mock:transcribe', signal: signal() }))).code).toBe('validation_error')
    for (const text of ['   ', 'x'.repeat(LIMITS.speechTextMaxChars + 1)])
      expect((await rejection(t.deps.audio.speak({ text, modelRef: 'mock:speech', signal: signal() }))).code).toBe('validation_error')
    expect(model.calls).toEqual([])
    expect(audioLines(t, 'speech')).toEqual([])
  })

  it('normalizes the audio type and refuses one browsers cannot play', async () => {
    const unknownBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
    const cases: Array<[SpeechAnswer, string]> = [
      // Unrecognized bytes without a type: the AI SDK falls back to `audio/mp3`.
      [{ audio: unknownBytes }, 'audio/mpeg'],
      [{ audio: new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0xFF, 0xFB, 0x90, 0x64]) }, 'audio/mpeg'],
      [{ audio: unknownBytes, headers: { 'content-type': 'audio/x-wav' } }, 'audio/wav'],
      [{ audio: new Uint8Array([0x4F, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) }, 'audio/ogg'],
    ]
    for (const [answer, expected] of cases) {
      const t = await audioApp({ speechModels: { 'mock:speech': speechModel(answer).model }, settings: { speechModelRef: 'mock:speech' } })
      const speech = await t.deps.audio.speak({ text: 'Hello world', signal: signal() })
      expect(speech.mediaType, expected).toBe(expected)
      expect(speech.audio).toEqual(answer.audio)
    }

    const t = await audioApp({ speechModels: { 'mock:speech': speechModel({ audio: unknownBytes, headers: { 'content-type': 'audio/L16;rate=24000' } }).model }, settings: { speechModelRef: 'mock:speech' } })
    const error = await rejection(t.deps.audio.speak({ text: 'Hello world', signal: signal() }))
    expect(error.toJSON().error).toEqual({
      code: 'provider_error',
      message: 'Mock (dev only) returned audio in a format that cannot be played (audio/l16).',
      providerId: 'mock',
      action: 'retry',
    })
    expect(await t.db.select().from(usage)).toEqual([])
    expect(audioLines(t, 'speech')).toEqual([expect.objectContaining({ outcome: 'failed', code: 'provider_error', type: 'audio/l16' })])
  })

  it('answers provider_error when the model returns no audio (NoSpeechGeneratedError)', async () => {
    const t = await audioApp({ speechModels: { 'mock:speech': speechModel({ audio: new Uint8Array(0) }).model }, settings: { speechModelRef: 'mock:speech' } })
    expect((await rejection(t.deps.audio.speak({ text: 'Hello world', signal: signal() }))).toJSON().error).toEqual({
      code: 'provider_error',
      message: 'Mock (dev only) returned no audio.',
      providerId: 'mock',
      action: 'retry',
    })
  })

  it('replaces a provider error message that echoes the speech text', async () => {
    const failing = speechModel({}, async () => {
      throw new APICallError({ message: `Rejected: ${SPEECH_TEXT}`, url: 'https://api.example.com/v1/audio/speech', requestBodyValues: { input: SPEECH_TEXT }, statusCode: 400, isRetryable: false })
    })
    const echoing = await audioApp({
      speechModels: { 'mock:speech': failing.model },
      settings: { speechModelRef: 'mock:speech' },
      mapError: providerId => new HarnessError({ code: 'provider_error', message: `The provider said: ${SPEECH_TEXT}`, providerId, status: 400, details: { upstream: SPEECH_TEXT } }),
    })
    const error = await rejection(echoing.deps.audio.speak({ text: SPEECH_TEXT, signal: signal() }))
    expect(error.toJSON().error).toEqual({ code: 'provider_error', message: 'Mock (dev only) returned an error.', providerId: 'mock', status: 400 })

    // The default mapping writes its own message (the vendor excerpt goes to details.upstream, never logged).
    const plain = await audioApp({ speechModels: { 'mock:speech': failing.model }, settings: { speechModelRef: 'mock:speech' } })
    const mapped = await rejection(plain.deps.audio.speak({ text: 'Hello world', signal: signal() }))
    expect(mapped.toJSON().error).toMatchObject({ code: 'provider_error', message: 'Mock (dev only) returned an error (HTTP 400).', status: 400 })
    for (const app of [echoing, plain])
      expect(app.logs.text()).not.toContain(SPEECH_TEXT)
  })

  it('times out with provider_unreachable and cancels when the request signal aborts', async () => {
    const hanging = speechModel({}, untilAborted)
    const t = await audioApp({ speechModels: { 'mock:speech': hanging.model }, settings: { speechModelRef: 'mock:speech' }, service: { speechTimeoutMs: 50 } })
    expect((await rejection(t.deps.audio.speak({ text: 'Hello world', signal: signal() }))).code).toBe('provider_unreachable')
    expect((hanging.calls[0]!.abortSignal!.reason as DOMException).name).toBe('TimeoutError')

    const other = await audioApp({ speechModels: { 'mock:speech': hanging.model }, settings: { speechModelRef: 'mock:speech' } })
    const controller = new AbortController()
    const pending = other.deps.audio.speak({ text: 'Hello world', signal: controller.signal })
    await vi.waitFor(() => expect(hanging.calls).toHaveLength(2))
    controller.abort()
    expect((await rejection(pending)).message).toBe(CANCELED_MESSAGE)
    expect(hanging.calls[1]!.abortSignal!.aborted).toBe(true)
    expect((await other.deps.providers.get('mock')).lastError).toBeNull()
    expect(audioLines(other, 'speech')).toEqual([expect.objectContaining({ outcome: 'canceled' })])
  })
})

describe('usage rows and logs', () => {
  it('writes one usage row per answered call and logs sizes, types and timings only', async () => {
    const t = await audioApp({
      transcriptionModels: { 'mock:transcribe': transcriptionModel({ durationInSeconds: 1.5 }).model },
      speechModels: { 'mock:speech': speechModel().model },
      settings: { transcriptionModelRef: 'mock:transcribe', speechModelRef: 'mock:speech' },
    })
    await t.deps.audio.transcribe({ file: recording(), form: {}, signal: signal() })
    const speech = await t.deps.audio.speak({ text: SPEECH_TEXT, signal: signal() })

    const rows = await t.db.select().from(usage)
    expect(rows.map(({ id: _id, createdAt, ...row }) => ({ ...row, createdAt: typeof createdAt }))).toEqual([
      { chatId: null, messageId: null, purpose: 'transcription', providerId: 'mock', modelId: 'transcribe', input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, createdAt: 'number' },
      { chatId: null, messageId: null, purpose: 'speech', providerId: 'mock', modelId: 'speech', input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, createdAt: 'number' },
    ])

    const [transcription] = audioLines(t, 'transcription')
    expect(transcription).toEqual({
      time: expect.any(String),
      level: 'info',
      msg: 'audio transcription',
      providerId: 'mock',
      modelId: 'transcribe',
      bytes: SAMPLE_WEBM_BYTES.byteLength,
      type: 'audio/webm',
      durationSec: 1.5,
      ms: expect.any(Number),
      outcome: 'ok',
    })
    const [spoken] = audioLines(t, 'speech')
    expect(spoken).toEqual({
      time: expect.any(String),
      level: 'info',
      msg: 'audio speech',
      providerId: 'mock',
      modelId: 'speech',
      chars: SPEECH_TEXT.length,
      type: 'audio/wav',
      bytes: speech.audio.byteLength,
      ms: expect.any(Number),
      outcome: 'ok',
    })
    const logs = t.logs.text()
    expect(logs).not.toContain(MOCK_TRANSCRIPT)
    expect(logs).not.toContain(SPEECH_TEXT)
  })
})

describe('unknown provider on the audio routes (Phase 7, ADR-028 consequence)', () => {
  const expected = {
    code: 'provider_not_configured',
    action: 'configure-provider',
    providerId: 'nope',
    message: 'The provider "nope" is not available. Pick another model or install the provider.',
  }

  function transcribeInit(modelRef: string): RequestInit {
    const form = new FormData()
    form.append('file', recording())
    form.append('modelRef', modelRef)
    return { method: 'POST', body: form }
  }

  function speechInit(modelRef: string): RequestInit {
    return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: SPEECH_TEXT, modelRef }) }
  }

  it.each([
    ['the real resolvers', async () => createTestApp({ env: { HF_MOCK_PROVIDER: '1' } })],
    ['the fake media resolvers', async () => audioApp()],
  ])('answers 400 provider_not_configured for POST /audio/transcriptions and /audio/speech with %s', async (_label, create) => {
    const t = await create()
    if (!apps.includes(t))
      apps.push(t)
    for (const [path, init] of [['/api/audio/transcriptions', transcribeInit('nope:x')], ['/api/audio/speech', speechInit('nope:x')]] as const) {
      const response = await t.request(path, init)
      expect(response.status, path).toBe(400)
      expect(harnessErrorEnvelopeSchema.parse(await response.json()).error, path).toMatchObject(expected)
    }
    // The settings models fail the same way (a provider removed after it was chosen).
    await t.deps.settings.update({ transcriptionModelRef: 'nope:listen', speechModelRef: 'nope:say' })
    const form = new FormData()
    form.append('file', recording())
    for (const [path, init] of [
      ['/api/audio/transcriptions', { method: 'POST', body: form }],
      ['/api/audio/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: SPEECH_TEXT }) }],
    ] as const) {
      const response = await t.request(path, init)
      expect(response.status, path).toBe(400)
      expect(harnessErrorEnvelopeSchema.parse(await response.json()).error, path).toMatchObject(expected)
    }
    expect(vi.mocked(transcribe)).not.toHaveBeenCalled()
    expect(vi.mocked(generateSpeech)).not.toHaveBeenCalled()
    expect(await t.db.select().from(usage)).toEqual([])
  })
})

describe('helpers', () => {
  it('speechMediaType: aliases normalized, parameters stripped, other types refused', () => {
    expect(speechMediaType('audio/mp3')).toBe('audio/mpeg')
    expect(speechMediaType('audio/mpeg')).toBe('audio/mpeg')
    expect(speechMediaType('AUDIO/WAV; rate=24000')).toBe('audio/wav')
    expect(speechMediaType('audio/wave')).toBe('audio/wav')
    expect(speechMediaType('audio/x-flac')).toBe('audio/flac')
    expect(speechMediaType('audio/x-m4a')).toBe('audio/mp4')
    for (const type of ['audio/ogg', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/flac'])
      expect(speechMediaType(type)).toBe(type)
    for (const type of ['audio/pcm', 'audio/l16', 'text/html', 'application/octet-stream', '', undefined])
      expect(speechMediaType(type)).toBeNull()
  })

  it('echoesText: the whole text or a 24-character run of it', () => {
    expect(echoesText(`Invalid input: ${SPEECH_TEXT}`, SPEECH_TEXT)).toBe(true)
    expect(echoesText('Invalid input: "read this sentence aloud f..."', SPEECH_TEXT)).toBe(true)
    expect(echoesText('Mock (dev only) returned an error (HTTP 400).', SPEECH_TEXT)).toBe(false)
    expect(echoesText('The text "Hello" is invalid.', 'Hello')).toBe(true)
    expect(echoesText('Anything', 'Hi')).toBe(false)
    expect(echoesText('', SPEECH_TEXT)).toBe(false)
  })
})
