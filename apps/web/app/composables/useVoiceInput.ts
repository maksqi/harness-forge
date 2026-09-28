// Dictation (docs/UI.md 7.17, 11.3; ADR-029): records the microphone with MediaRecorder and transcribes the clip
// through POST /api/audio/transcriptions (the multipart part `file`; the server uses the speech-to-text model and the
// language of Settings -> Media). Nothing is transcribed in the browser and nothing is stored.
// States idle -> requesting (the permission prompt) -> recording -> transcribing -> idle. Recorder types
// audio/webm;codecs=opus, audio/webm, audio/ogg;codecs=opus, audio/mp4, else the browser default, at 32 kbps
// (dictation.ts). The recording stops and is transcribed at maxDurationMs, when its audio track ends (a mobile
// interruption) or when the recorder stops by itself; clips under 0.5 s are discarded without a request; a recorder
// error drops the clip. The microphone tracks are always stopped in a finally. cancel() drops the recording or aborts
// the transcription (a late transcript is ignored); a scope dispose cancels. The input level (0-1) comes from a Web
// Audio analyser where one exists (it stays 0 elsewhere).
import type { AudioTranscription } from '@harness-forge/shared'
import type { Ref } from 'vue'
import { LIMITS } from '@harness-forge/shared'
import { getCurrentScope, onScopeDispose, readonly, ref } from 'vue'
import { MIN_DICTATION_MS, pickRecorderMimeType, RECORDER_BITS_PER_SECOND, recordingFileName } from '~/components/chat/composer/dictation'
import { useApi } from '~/composables/useApi'
import { isAbortError } from '~/utils/errors'

export type VoiceInputState = 'idle' | 'requesting' | 'recording' | 'transcribing'

/** The browser APIs dictation uses; tests inject fakes (utils/testing/fake-media.ts). Default: the browser. */
export interface VoiceInputEnv {
  isSecureContext: boolean
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>
  MediaRecorder?: typeof MediaRecorder
  /** Default: POST /api/audio/transcriptions with the clip as the multipart part `file`. */
  transcribe: (audio: Blob, signal: AbortSignal) => Promise<AudioTranscription>
}

export interface VoiceInputOptions {
  /** The transcript; '' = no speech detected (the composer shows the toast "No speech detected"). */
  onTranscript: (text: string) => void
  /** Permission denied, no microphone, busy microphone, 413, provider errors. */
  onError?: (error: unknown) => void
  /** Auto-stop (the clip is then transcribed); default LIMITS.transcriptionMaxSeconds x 1000 (10 min). */
  maxDurationMs?: number
  /** Replaces parts of the browser environment (a key given as undefined means "not available"). */
  env?: Partial<VoiceInputEnv>
}

export interface VoiceInput {
  state: Readonly<Ref<VoiceInputState>>
  /** The browser can record (false: the composer renders no mic button). */
  supported: boolean
  /** A secure context (false: the mic is disabled with "Voice input needs HTTPS or localhost"). */
  secure: boolean
  /** Recording time in ms (the RecordingIndicator timer); it stops while transcribing. */
  elapsedMs: Readonly<Ref<number>>
  /** 0-1 input level while recording (the MicButton ring). */
  level: Readonly<Ref<number>>
  start: () => Promise<void>
  /** Ends the recording and transcribes it (a clip under 0.5 s is discarded). */
  stop: () => Promise<void>
  /** Drops the recording or aborts the transcription. */
  cancel: () => void
  /** idle -> start, recording -> stop, transcribing -> cancel. */
  toggle: () => Promise<void>
}

/** The browser's media APIs (the default `transcribe` is added by useVoiceInput). */
export function browserVoiceInputEnv(): Omit<VoiceInputEnv, 'transcribe'> {
  return {
    isSecureContext: globalThis.isSecureContext === true,
    mediaDevices: globalThis.navigator?.mediaDevices,
    MediaRecorder: globalThis.MediaRecorder,
  }
}

/**
 * MediaRecorder and getUserMedia exist. Browsers leave `navigator.mediaDevices` out of insecure contexts, so there
 * MediaRecorder alone counts: the mic then shows as disabled with the HTTPS hint (`secure: false`) instead of
 * disappearing (docs/UI.md 7.17: "disabled on an insecure origin, hidden without MediaRecorder").
 */
export function isVoiceInputSupported(env: Omit<VoiceInputEnv, 'transcribe'>): boolean {
  if (typeof env.MediaRecorder !== 'function')
    return false
  return !env.isSecureContext || typeof env.mediaDevices?.getUserMedia === 'function'
}

/** How often the timer and the input level refresh while recording. */
const TICK_MS = 100
/** A recorder that never reports "stop" does not hold the microphone longer than this. */
const STOP_TIMEOUT_MS = 3000

/** The default transcription: `$api.audio.transcribe` with the clip as the multipart part `file`. */
function apiTranscribe(): VoiceInputEnv['transcribe'] {
  const api = useApi()
  return (audio, signal) => {
    const form = new FormData()
    // A File carries its name in every FormData implementation (some ignore the file name argument for a Blob).
    form.append('file', new File([audio], recordingFileName(audio.type), { type: audio.type }))
    return api.audio.transcribe({ form, signal })
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop()
    }
    catch {
      // Already stopped.
    }
  }
}

/** A recorder of `mimeType` at 32 kbps; the browser default when it refuses the type it claimed to support. */
function createRecorder(Recorder: typeof MediaRecorder, stream: MediaStream, mimeType: string | undefined): MediaRecorder {
  const options: MediaRecorderOptions = { audioBitsPerSecond: RECORDER_BITS_PER_SECOND }
  if (mimeType) {
    try {
      return new Recorder(stream, { ...options, mimeType })
    }
    catch {
      // Fall back to the browser's default type.
    }
  }
  return new Recorder(stream, options)
}

/** Resolves when `promise` does or after `ms`, whichever comes first. */
function settleWithin(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    void promise.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

// ---------- input level ----------

type AudioContextConstructor = new () => AudioContext

interface LevelMeter {
  /** The current level, 0-1. */
  read: () => number
  close: () => void
}

/** RMS of 8-bit time-domain samples (128 = silence), scaled so that normal speech fills most of 0-1. */
export function sampleLevel(samples: ArrayLike<number>): number {
  if (samples.length === 0)
    return 0
  let sum = 0
  for (let index = 0; index < samples.length; index++) {
    const value = ((samples[index] ?? 128) - 128) / 128
    sum += value * value
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 5)
}

/** Runs a browser call that may be missing or reject, and ignores its failure. */
function ignoreFailure(call: () => Promise<unknown> | undefined): void {
  try {
    void call()?.catch(() => {})
  }
  catch {
    // Not supported here.
  }
}

/** A Web Audio analyser on the microphone; null where Web Audio is missing or fails (the level then stays 0). */
function openLevelMeter(stream: MediaStream): LevelMeter | null {
  const scope = globalThis as typeof globalThis & { webkitAudioContext?: AudioContextConstructor }
  const Context: AudioContextConstructor | undefined = scope.AudioContext ?? scope.webkitAudioContext
  if (typeof Context !== 'function')
    return null
  let context: AudioContext | undefined
  try {
    const audio = new Context()
    context = audio
    const source = audio.createMediaStreamSource(stream)
    const analyser = audio.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    const samples = new Uint8Array(analyser.fftSize)
    // Created after the permission prompt, the context may start suspended.
    ignoreFailure(() => audio.resume())
    return {
      read: () => {
        try {
          analyser.getByteTimeDomainData(samples)
          return sampleLevel(samples)
        }
        catch {
          return 0
        }
      },
      close: () => {
        try {
          source.disconnect()
        }
        catch {
          // Already disconnected.
        }
        ignoreFailure(() => audio.close())
      },
    }
  }
  catch {
    ignoreFailure(() => context?.close())
    return null
  }
}

// ---------- the composable ----------

interface Recording {
  /** The attempt that started it (see `attempt`). */
  attempt: number
  stream: MediaStream
  recorder: MediaRecorder
  /** The type asked of the recorder (undefined = the browser default). */
  preferredType: string | undefined
  chunks: Blob[]
  startedAt: number
  /** Resolves on the recorder's "stop" event (after its last "dataavailable"). */
  stopped: Promise<void>
  /** finish() ran: later stop signals are ignored. */
  finishing: boolean
  /** Stops the timer and the auto-stop. */
  stopClock: () => void
  /** Stops the clock, the level meter, the track listeners and the microphone tracks (idempotent). */
  release: () => void
}

type FinishMode = 'transcribe' | 'discard' | 'error'

export function useVoiceInput(opts: VoiceInputOptions): VoiceInput {
  const env: Omit<VoiceInputEnv, 'transcribe'> = { ...browserVoiceInputEnv(), ...opts.env }
  const transcribe = opts.env?.transcribe ?? apiTranscribe()
  const maxDurationMs = opts.maxDurationMs ?? LIMITS.transcriptionMaxSeconds * 1000
  const supported = isVoiceInputSupported(env)
  const secure = env.isSecureContext === true

  const state = ref<VoiceInputState>('idle')
  const elapsedMs = ref(0)
  const level = ref(0)

  /** Bumped by every start() and cancel(): the async steps of an older attempt see a newer number and give up. */
  let attempt = 0
  let recording: Recording | null = null
  let transcription: AbortController | null = null

  function report(error: unknown): void {
    opts.onError?.(error)
  }

  function beginRecording(id: number, stream: MediaStream): Recording {
    const Recorder = env.MediaRecorder!
    const preferredType = pickRecorderMimeType(Recorder)
    const recorder = createRecorder(Recorder, stream, preferredType)
    let markStopped: () => void = () => {}
    const stopped = new Promise<void>((resolve) => {
      markStopped = resolve
    })
    const rec: Recording = {
      attempt: id,
      stream,
      recorder,
      preferredType,
      chunks: [],
      startedAt: Date.now(),
      stopped,
      finishing: false,
      stopClock: () => {},
      release: () => {},
    }

    const tracks = stream.getTracks()
    const onData = (event: Event) => {
      const data = (event as BlobEvent).data
      if (data && data.size > 0)
        rec.chunks.push(data)
    }
    const onStop = () => {
      markStopped()
      // Unless finish() stopped it, the recorder stopped by itself (its tracks ended): transcribe what it recorded.
      void finish(rec, 'transcribe')
    }
    const onError = (event: Event) => {
      void finish(rec, 'error', (event as ErrorEvent).error ?? new DOMException('The recording failed.', 'UnknownError'))
    }
    const onEnded = () => {
      void finish(rec, 'transcribe')
    }
    recorder.addEventListener('dataavailable', onData)
    recorder.addEventListener('stop', onStop)
    recorder.addEventListener('error', onError)
    for (const track of tracks)
      track.addEventListener('ended', onEnded)

    recorder.start()
    rec.startedAt = Date.now()
    const meter = openLevelMeter(stream)
    const tick = setInterval(() => {
      if (rec.finishing)
        return
      elapsedMs.value = Math.max(0, Date.now() - rec.startedAt)
      if (meter)
        level.value = Math.round((level.value * 0.5 + meter.read() * 0.5) * 100) / 100
    }, TICK_MS)
    const limit = setTimeout(() => void finish(rec, 'transcribe'), maxDurationMs)

    let released = false
    rec.stopClock = () => {
      clearInterval(tick)
      clearTimeout(limit)
    }
    rec.release = () => {
      if (released)
        return
      released = true
      rec.stopClock()
      meter?.close()
      for (const track of tracks)
        track.removeEventListener('ended', onEnded)
      stopTracks(stream)
    }
    return rec
  }

  /** Ends a recording: `transcribe` it (discarded under 0.5 s), `discard` it, or drop it after an `error`. */
  async function finish(rec: Recording, mode: FinishMode, error?: unknown): Promise<void> {
    if (rec.finishing)
      return
    rec.finishing = true
    rec.stopClock()
    const live = () => rec.attempt === attempt
    const duration = Math.max(0, Date.now() - rec.startedAt)
    const outcome: FinishMode = mode === 'transcribe' && duration < MIN_DICTATION_MS ? 'discard' : mode
    if (live()) {
      elapsedMs.value = Math.min(duration, maxDurationMs)
      level.value = 0
      if (outcome === 'transcribe') {
        state.value = 'transcribing'
      }
      else {
        state.value = 'idle'
        if (outcome === 'error')
          report(error)
      }
    }
    try {
      if (rec.recorder.state !== 'inactive')
        rec.recorder.stop()
    }
    catch {
      // Already stopped.
    }
    try {
      await settleWithin(rec.stopped, STOP_TIMEOUT_MS)
    }
    finally {
      rec.release()
      if (recording === rec)
        recording = null
    }
    if (outcome !== 'transcribe' || !live())
      return
    const type = rec.recorder.mimeType || rec.preferredType || rec.chunks[0]?.type || 'audio/webm'
    const clip = new Blob(rec.chunks, { type })
    if (clip.size === 0) {
      state.value = 'idle'
      return
    }
    await transcribeClip(rec.attempt, clip)
  }

  async function transcribeClip(id: number, clip: Blob): Promise<void> {
    const controller = new AbortController()
    transcription = controller
    try {
      const result = await transcribe(clip, controller.signal)
      if (id !== attempt || controller.signal.aborted)
        return
      state.value = 'idle'
      opts.onTranscript(String(result?.text ?? '').trim())
    }
    catch (error) {
      if (id !== attempt || controller.signal.aborted)
        return
      state.value = 'idle'
      // A request aborted by something else than cancel() (the page going away) is not an error to show.
      if (!isAbortError(error))
        report(error)
    }
    finally {
      if (transcription === controller)
        transcription = null
    }
  }

  async function start(): Promise<void> {
    if (state.value !== 'idle')
      return
    const id = ++attempt
    const mediaDevices = env.mediaDevices
    if (!supported || !secure || typeof mediaDevices?.getUserMedia !== 'function') {
      report(secure
        ? new DOMException('This browser can\'t record audio.', 'NotSupportedError')
        : new DOMException('Voice input needs HTTPS or localhost.', 'SecurityError'))
      return
    }
    state.value = 'requesting'
    elapsedMs.value = 0
    level.value = 0
    let stream: MediaStream
    try {
      stream = await mediaDevices.getUserMedia({ audio: true })
    }
    catch (error) {
      if (id === attempt) {
        state.value = 'idle'
        report(error)
      }
      return
    }
    if (id !== attempt) {
      // Canceled (or disposed) while the permission prompt was open: release the microphone at once.
      stopTracks(stream)
      return
    }
    try {
      recording = beginRecording(id, stream)
    }
    catch (error) {
      stopTracks(stream)
      state.value = 'idle'
      report(error)
      return
    }
    state.value = 'recording'
  }

  async function stop(): Promise<void> {
    if (state.value === 'requesting') {
      // Nothing recorded yet.
      cancel()
      return
    }
    const current = recording
    if (state.value !== 'recording' || !current)
      return
    await finish(current, 'transcribe')
  }

  function cancel(): void {
    if (state.value === 'idle' && !recording && !transcription)
      return
    attempt += 1
    state.value = 'idle'
    level.value = 0
    if (recording)
      void finish(recording, 'discard')
    transcription?.abort()
    transcription = null
  }

  async function toggle(): Promise<void> {
    if (state.value === 'idle')
      return start()
    if (state.value === 'recording')
      return stop()
    if (state.value === 'transcribing')
      cancel()
  }

  if (getCurrentScope())
    onScopeDispose(cancel)

  return {
    state: readonly(state),
    supported,
    secure,
    elapsedMs: readonly(elapsedMs),
    level: readonly(level),
    start,
    stop,
    cancel,
    toggle,
  }
}
