import type { AudioTranscription } from '@harness-forge/shared'
import type { Mock } from 'vitest'
import type { VoiceInputEnv, VoiceInputOptions } from './useVoiceInput'
import type { FakeMedia } from '~/utils/testing/fake-media'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, isReadonly } from 'vue'
import { FakeMediaRecorder, installFakeMedia, WEBM_EBML_HEADER } from '~/utils/testing/fake-media'
import { createMockApi } from '~/utils/testing/mock-api'
import { browserVoiceInputEnv, isVoiceInputSupported, sampleLevel, useVoiceInput } from './useVoiceInput'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let media: FakeMedia | null = null
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
})

afterEach(() => {
  media?.()
  media = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function transcription(text = 'Hello there.'): AudioTranscription {
  return { text, language: 'en', durationSec: 1.2, modelRef: 'mock:transcribe' }
}

type TranscribeMock = Mock<VoiceInputEnv['transcribe']>

interface Setup {
  transcribe?: TranscribeMock
  maxDurationMs?: number
  env?: Partial<VoiceInputEnv>
}

/** A voice input in its own effect scope, with spies for the callbacks and (unless given) the transcription. */
function setup(options: Setup = {}) {
  const onTranscript = vi.fn<VoiceInputOptions['onTranscript']>()
  const onError = vi.fn<NonNullable<VoiceInputOptions['onError']>>()
  const transcribe = options.transcribe ?? vi.fn<VoiceInputEnv['transcribe']>(async () => transcription())
  const scope = effectScope()
  const voice = scope.run(() => useVoiceInput({
    onTranscript,
    onError,
    maxDurationMs: options.maxDurationMs,
    env: { transcribe, ...options.env },
  }))!
  return { voice, onTranscript, onError, transcribe, scope }
}

/** Runs pending microtasks and zero-delay timers (fake timers). */
async function flush() {
  await vi.advanceTimersByTimeAsync(0)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function bytesOf(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()))
}

describe('useVoiceInput environment', () => {
  it('returns the documented shape, idle with no time and no level', () => {
    const voice = useVoiceInput({ onTranscript: vi.fn() })
    expect(Object.keys(voice).sort()).toEqual(['cancel', 'elapsedMs', 'level', 'secure', 'start', 'state', 'stop', 'supported', 'toggle'])
    expect(voice.state.value).toBe('idle')
    expect(voice.elapsedMs.value).toBe(0)
    expect(voice.level.value).toBe(0)
    expect([voice.state, voice.elapsedMs, voice.level].every(value => isReadonly(value))).toBe(true)
  })

  it('is unsupported and not secure in bare happy-dom (no MediaRecorder, no mediaDevices, no isSecureContext)', () => {
    const voice = useVoiceInput({ onTranscript: vi.fn() })
    expect(voice.supported).toBe(false)
    expect(voice.secure).toBe(false)
  })

  it('detects the fake microphone of installFakeMedia()', () => {
    media = installFakeMedia()
    const voice = useVoiceInput({ onTranscript: vi.fn(), onError: vi.fn(), maxDurationMs: 60_000 })
    expect(voice.supported).toBe(true)
    expect(voice.secure).toBe(true)
  })

  it('keeps the mic (disabled) on an insecure origin, where browsers hide navigator.mediaDevices', () => {
    media = installFakeMedia({ secure: false })
    expect(globalThis.navigator.mediaDevices).toBeUndefined()
    const voice = useVoiceInput({ onTranscript: vi.fn() })
    expect(voice.supported).toBe(true)
    expect(voice.secure).toBe(false)
  })

  it('takes an injected environment; a key given as undefined means "not available"', () => {
    const injected = useVoiceInput({
      onTranscript: vi.fn(),
      env: { isSecureContext: true, MediaRecorder: FakeMediaRecorder, mediaDevices: { getUserMedia: vi.fn() }, transcribe: vi.fn() },
    })
    expect(injected.supported).toBe(true)
    expect(injected.secure).toBe(true)

    media = installFakeMedia()
    expect(useVoiceInput({ onTranscript: vi.fn(), env: { MediaRecorder: undefined } }).supported).toBe(false)
    expect(useVoiceInput({ onTranscript: vi.fn(), env: { mediaDevices: undefined } }).supported).toBe(false)
    expect(useVoiceInput({ onTranscript: vi.fn(), env: { isSecureContext: false } }).secure).toBe(false)
  })

  it('can live in an effect scope that is disposed', () => {
    const scope = effectScope()
    const voice = scope.run(() => useVoiceInput({ onTranscript: vi.fn() }))!
    expect(() => scope.stop()).not.toThrow()
    expect(voice.state.value).toBe('idle')
  })
})

describe('useVoiceInput recording', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('records at 32 kbps with the preferred type, then transcribes the clip and releases the microphone', async () => {
    media = installFakeMedia()
    const { voice, onTranscript, onError, transcribe } = setup()
    const starting = voice.start()
    expect(voice.state.value).toBe('requesting')
    await starting
    expect(voice.state.value).toBe('recording')
    expect(media.getUserMedia).toHaveBeenCalledWith({ audio: true })
    const recorder = media.recorders[0]!
    expect(recorder.options).toEqual({ mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32_000 })
    expect(recorder.state).toBe('recording')

    await vi.advanceTimersByTimeAsync(1_250)
    expect(voice.elapsedMs.value).toBe(1_200)
    const stopping = voice.stop()
    expect(voice.state.value).toBe('transcribing')
    expect(voice.elapsedMs.value).toBe(1_250)
    await stopping

    expect(voice.state.value).toBe('idle')
    expect(transcribe).toHaveBeenCalledTimes(1)
    const [clip, signal] = transcribe.mock.calls[0]!
    expect(clip.type).toBe('audio/webm;codecs=opus')
    expect((await bytesOf(clip)).slice(0, WEBM_EBML_HEADER.length)).toEqual(Array.from(WEBM_EBML_HEADER))
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
    expect(onTranscript).toHaveBeenCalledWith('Hello there.')
    expect(onError).not.toHaveBeenCalled()
    expect(media.streams[0]!.stopped).toBe(true)
    expect(recorder.state).toBe('inactive')
  })

  it('discards a clip under 0.5 s without a request', async () => {
    media = installFakeMedia()
    const { voice, onTranscript, transcribe } = setup()
    await voice.start()
    await vi.advanceTimersByTimeAsync(400)
    const stopping = voice.stop()
    expect(voice.state.value).toBe('idle')
    await stopping
    expect(transcribe).not.toHaveBeenCalled()
    expect(onTranscript).not.toHaveBeenCalled()
    expect(media.streams[0]!.stopped).toBe(true)
  })

  it('reports an empty or blank transcript as \'\' (no speech detected)', async () => {
    media = installFakeMedia()
    const { voice, onTranscript } = setup({ transcribe: vi.fn(async () => transcription('   ')) })
    await voice.start()
    await vi.advanceTimersByTimeAsync(800)
    await voice.stop()
    expect(onTranscript).toHaveBeenCalledWith('')
  })

  it('reports a denied permission, a missing microphone and a busy one, and records nothing', async () => {
    for (const deny of [true, 'NotFoundError', 'NotReadableError'] as const) {
      media = installFakeMedia({ deny })
      const { voice, onError, transcribe } = setup()
      await voice.start()
      expect(voice.state.value).toBe('idle')
      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError.mock.calls[0]![0]).toMatchObject({ name: deny === true ? 'NotAllowedError' : deny })
      expect(media.recorders).toHaveLength(0)
      expect(transcribe).not.toHaveBeenCalled()
      media()
    }
    media = null
  })

  it('reports an insecure origin and a browser without MediaRecorder without asking for the microphone', async () => {
    media = installFakeMedia({ secure: false })
    const insecure = setup()
    await insecure.voice.start()
    expect(insecure.voice.state.value).toBe('idle')
    expect(insecure.onError.mock.calls[0]![0]).toMatchObject({ name: 'SecurityError' })
    media()

    media = installFakeMedia()
    const noRecorder = setup({ env: { MediaRecorder: undefined } })
    await noRecorder.voice.start()
    expect(noRecorder.voice.state.value).toBe('idle')
    expect(noRecorder.onError.mock.calls[0]![0]).toMatchObject({ name: 'NotSupportedError' })
    expect(media.getUserMedia).not.toHaveBeenCalled()
  })

  it('cancel while the permission prompt is open releases the microphone as soon as it is granted', async () => {
    media = installFakeMedia({ prompt: true })
    const { voice, onError } = setup()
    const starting = voice.start()
    expect(voice.state.value).toBe('requesting')
    voice.cancel()
    expect(voice.state.value).toBe('idle')
    media.grant()
    await starting
    expect(media.streams[0]!.stopped).toBe(true)
    expect(media.recorders).toHaveLength(0)
    expect(onError).not.toHaveBeenCalled()
    expect(voice.state.value).toBe('idle')
  })

  it('stop() while asking for the microphone cancels, and a late denial is not reported', async () => {
    media = installFakeMedia({ prompt: true })
    const { voice, onError } = setup()
    const starting = voice.start()
    await voice.stop()
    expect(voice.state.value).toBe('idle')
    media.deny()
    await starting
    expect(onError).not.toHaveBeenCalled()
  })

  it('cancel while recording drops the clip and stops the tracks', async () => {
    media = installFakeMedia()
    const { voice, onTranscript, transcribe } = setup()
    await voice.start()
    await vi.advanceTimersByTimeAsync(2_000)
    voice.cancel()
    expect(voice.state.value).toBe('idle')
    await flush()
    expect(media.recorders[0]!.state).toBe('inactive')
    expect(media.streams[0]!.stopped).toBe(true)
    expect(transcribe).not.toHaveBeenCalled()
    expect(onTranscript).not.toHaveBeenCalled()
  })

  it('cancel while transcribing aborts the request and ignores a late transcript', async () => {
    media = installFakeMedia()
    const pending = deferred<AudioTranscription>()
    const { voice, onTranscript, onError, transcribe } = setup({ transcribe: vi.fn(() => pending.promise) })
    await voice.start()
    await vi.advanceTimersByTimeAsync(1_000)
    const stopping = voice.stop()
    await flush()
    expect(voice.state.value).toBe('transcribing')
    expect(transcribe).toHaveBeenCalledTimes(1)
    const signal = transcribe.mock.calls[0]![1]
    voice.cancel()
    expect(voice.state.value).toBe('idle')
    expect(signal.aborted).toBe(true)
    pending.resolve(transcription('Too late.'))
    await stopping
    expect(onTranscript).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(voice.state.value).toBe('idle')
  })

  it('reports a failed transcription (413, provider errors) and returns to idle', async () => {
    media = installFakeMedia()
    const error = new HarnessError({ code: 'payload_too_large', message: 'Too large.' })
    const { voice, onTranscript, onError } = setup({ transcribe: vi.fn(async () => Promise.reject(error)) })
    await voice.start()
    await vi.advanceTimersByTimeAsync(1_000)
    await voice.stop()
    expect(voice.state.value).toBe('idle')
    expect(onError).toHaveBeenCalledWith(error)
    expect(onTranscript).not.toHaveBeenCalled()
    expect(media.streams[0]!.stopped).toBe(true)
  })

  it('returns to idle without an error when the request is aborted by something else than cancel()', async () => {
    media = installFakeMedia()
    const aborted = new DOMException('The operation was aborted.', 'AbortError')
    const { voice, onTranscript, onError } = setup({ transcribe: vi.fn(async () => Promise.reject(aborted)) })
    await voice.start()
    await vi.advanceTimersByTimeAsync(1_000)
    await voice.stop()
    expect(voice.state.value).toBe('idle')
    expect(onError).not.toHaveBeenCalled()
    expect(onTranscript).not.toHaveBeenCalled()
  })

  it('stops by itself at maxDurationMs and transcribes', async () => {
    media = installFakeMedia()
    const pending = deferred<AudioTranscription>()
    const { voice, onTranscript, transcribe } = setup({ maxDurationMs: 5_000, transcribe: vi.fn(() => pending.promise) })
    await voice.start()
    await vi.advanceTimersByTimeAsync(4_900)
    expect(voice.state.value).toBe('recording')
    await vi.advanceTimersByTimeAsync(100)
    expect(voice.state.value).toBe('transcribing')
    expect(voice.elapsedMs.value).toBe(5_000)
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(media.streams[0]!.stopped).toBe(true)
    pending.resolve(transcription())
    await flush()
    expect(onTranscript).toHaveBeenCalledWith('Hello there.')
    expect(voice.state.value).toBe('idle')
  })

  it('defaults the limit to LIMITS.transcriptionMaxSeconds (10 minutes)', async () => {
    media = installFakeMedia()
    const pending = deferred<AudioTranscription>()
    const { voice } = setup({ transcribe: vi.fn(() => pending.promise) })
    await voice.start()
    await vi.advanceTimersByTimeAsync(599_900)
    expect(voice.state.value).toBe('recording')
    await vi.advanceTimersByTimeAsync(100)
    expect(voice.state.value).toBe('transcribing')
    expect(voice.elapsedMs.value).toBe(600_000)
    pending.resolve(transcription())
    await flush()
    expect(voice.state.value).toBe('idle')
  })

  it('an ended track (a mobile interruption) stops the recording and transcribes it', async () => {
    media = installFakeMedia()
    const { voice, onTranscript, transcribe } = setup()
    await voice.start()
    await vi.advanceTimersByTimeAsync(1_500)
    media.streams[0]!.getTracks()[0]!.end()
    expect(voice.state.value).toBe('transcribing')
    await flush()
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(onTranscript).toHaveBeenCalledWith('Hello there.')
    expect(media.streams[0]!.stopped).toBe(true)
  })

  it('a recorder failure drops the clip, reports the error and stops the tracks', async () => {
    media = installFakeMedia()
    const { voice, onError, transcribe } = setup()
    await voice.start()
    await vi.advanceTimersByTimeAsync(1_000)
    media.recorders[0]!.fail()
    await flush()
    expect(voice.state.value).toBe('idle')
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![0]).toMatchObject({ name: 'UnknownError' })
    expect(transcribe).not.toHaveBeenCalled()
    expect(media.streams[0]!.stopped).toBe(true)
  })

  it('stops the tracks and reports when the recorder cannot start', async () => {
    media = installFakeMedia()
    class BrokenRecorder extends FakeMediaRecorder {
      override start(): void {
        throw new DOMException('There was an error starting the MediaRecorder.', 'NotSupportedError')
      }
    }
    const { voice, onError } = setup({ env: { MediaRecorder: BrokenRecorder } })
    await voice.start()
    expect(voice.state.value).toBe('idle')
    expect(onError.mock.calls[0]![0]).toMatchObject({ name: 'NotSupportedError' })
    expect(media.streams[0]!.stopped).toBe(true)
  })

  it('records the browser\'s supported type (Ogg, Safari MP4) or its default', async () => {
    const cases: Array<[types: string[], requested: string | undefined, clipType: string]> = [
      [['audio/ogg;codecs=opus'], 'audio/ogg;codecs=opus', 'audio/ogg;codecs=opus'],
      [['audio/mp4'], 'audio/mp4', 'audio/mp4'],
      [[], undefined, 'audio/webm'],
    ]
    for (const [mimeTypes, requested, clipType] of cases) {
      media = installFakeMedia({ mimeTypes })
      const { voice, transcribe } = setup()
      await voice.start()
      expect(media.recorders[0]!.options.mimeType).toBe(requested)
      expect(media.recorders[0]!.options.audioBitsPerSecond).toBe(32_000)
      await vi.advanceTimersByTimeAsync(700)
      await voice.stop()
      expect(transcribe.mock.calls[0]![0].type).toBe(clipType)
      media()
    }
    media = null
  })

  it('toggle(): idle starts, recording stops and transcribes, transcribing cancels, requesting is ignored', async () => {
    media = installFakeMedia()
    const pending = deferred<AudioTranscription>()
    const { voice, transcribe } = setup({ transcribe: vi.fn(() => pending.promise) })
    await voice.toggle()
    expect(voice.state.value).toBe('recording')
    await vi.advanceTimersByTimeAsync(900)
    const stopping = voice.toggle()
    await flush()
    expect(voice.state.value).toBe('transcribing')
    await voice.toggle()
    expect(voice.state.value).toBe('idle')
    expect(transcribe.mock.calls[0]![1].aborted).toBe(true)
    pending.resolve(transcription())
    await stopping
    media()

    media = installFakeMedia({ prompt: true })
    const prompted = setup()
    const starting = prompted.voice.toggle()
    await prompted.voice.toggle()
    expect(prompted.voice.state.value).toBe('requesting')
    media.grant()
    await starting
    expect(prompted.voice.state.value).toBe('recording')
    prompted.voice.cancel()
  })

  it('ignores start() while busy and stop() while idle', async () => {
    media = installFakeMedia()
    const { voice, transcribe } = setup()
    await voice.stop()
    expect(voice.state.value).toBe('idle')
    await voice.start()
    await voice.start()
    expect(media.getUserMedia).toHaveBeenCalledTimes(1)
    voice.cancel()
    voice.cancel()
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('a scope dispose cancels the recording and releases the microphone', async () => {
    media = installFakeMedia()
    const { voice, scope, transcribe } = setup()
    await voice.start()
    await vi.advanceTimersByTimeAsync(1_000)
    scope.stop()
    expect(voice.state.value).toBe('idle')
    await flush()
    expect(media.streams[0]!.stopped).toBe(true)
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('sends the clip to POST /api/audio/transcriptions as the multipart part `file` by default', async () => {
    media = installFakeMedia()
    api.audio.transcribe.mockResolvedValue(transcription('From the server.'))
    const onTranscript = vi.fn()
    const voice = useVoiceInput({ onTranscript })
    await voice.start()
    await vi.advanceTimersByTimeAsync(1_000)
    await voice.stop()
    expect(api.audio.transcribe).toHaveBeenCalledTimes(1)
    const input = api.audio.transcribe.mock.calls[0]![0] as { form: FormData, signal: AbortSignal }
    expect(Object.keys(input).sort()).toEqual(['form', 'signal'])
    expect(input.signal).toBeInstanceOf(AbortSignal)
    const file = input.form.get('file') as File
    expect(file.name).toBe('dictation.webm')
    expect(file.type).toBe('audio/webm;codecs=opus')
    expect([...input.form.keys()]).toEqual(['file'])
    expect(onTranscript).toHaveBeenCalledWith('From the server.')
  })

  it('follows the input level of a Web Audio analyser and closes it afterwards', async () => {
    const close = vi.fn(async () => {})
    const disconnect = vi.fn()
    class FakeAudioContext {
      resume = vi.fn(async () => {})
      close = close
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect }
      }

      createAnalyser() {
        return {
          fftSize: 0,
          getByteTimeDomainData: (samples: Uint8Array) => samples.fill(128 + 32),
        }
      }
    }
    vi.stubGlobal('AudioContext', FakeAudioContext)
    media = installFakeMedia()
    const { voice } = setup()
    await voice.start()
    await vi.advanceTimersByTimeAsync(300)
    expect(voice.level.value).toBeGreaterThan(0.5)
    expect(voice.level.value).toBeLessThanOrEqual(1)
    await voice.stop()
    expect(voice.level.value).toBe(0)
    expect(disconnect).toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })
})

describe('sampleLevel', () => {
  it('is 0 for silence and grows with the amplitude up to 1', () => {
    expect(sampleLevel(new Uint8Array(64).fill(128))).toBe(0)
    expect(sampleLevel([])).toBe(0)
    const quiet = sampleLevel(new Uint8Array(64).fill(132))
    const loud = sampleLevel(new Uint8Array(64).fill(160))
    expect(quiet).toBeGreaterThan(0)
    expect(loud).toBeGreaterThan(quiet)
    expect(sampleLevel(new Uint8Array(64).fill(255))).toBe(1)
  })
})

describe('isVoiceInputSupported / browserVoiceInputEnv', () => {
  it('needs MediaRecorder, and getUserMedia in a secure context', () => {
    const getUserMedia = vi.fn()
    expect(isVoiceInputSupported({ isSecureContext: true, MediaRecorder: FakeMediaRecorder, mediaDevices: { getUserMedia } })).toBe(true)
    expect(isVoiceInputSupported({ isSecureContext: true, MediaRecorder: FakeMediaRecorder })).toBe(false)
    expect(isVoiceInputSupported({ isSecureContext: false, MediaRecorder: FakeMediaRecorder })).toBe(true)
    expect(isVoiceInputSupported({ isSecureContext: true, mediaDevices: { getUserMedia } })).toBe(false)
    expect(isVoiceInputSupported({ isSecureContext: false })).toBe(false)
  })

  it('reads the browser globals', () => {
    expect(browserVoiceInputEnv()).toEqual({ isSecureContext: false, mediaDevices: undefined, MediaRecorder: undefined })
    media = installFakeMedia()
    const env = browserVoiceInputEnv()
    expect(env.isSecureContext).toBe(true)
    expect(env.MediaRecorder).toBe(FakeMediaRecorder)
    expect(env.mediaDevices?.getUserMedia).toBe(media.getUserMedia)
  })
})
