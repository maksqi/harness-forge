// Dictation (docs/UI.md 7.17, 11.3; ADR-029): records the microphone with MediaRecorder and transcribes the clip
// through POST /api/audio/transcriptions (the speech-to-text model of Settings -> Media). States idle -> requesting
// (the permission prompt) -> recording -> transcribing -> idle. Recorder types audio/webm;codecs=opus, audio/webm,
// audio/ogg;codecs=opus, audio/mp4, else the browser default, at 32 kbps; auto-stop at maxDurationMs; clips under
// 0.5 s are discarded without a request; the microphone tracks are always stopped in a finally; an ended track (a
// mobile interruption) stops and transcribes; a scope dispose cancels.
// Stub (C12, P6-0b): implemented by W6.9 in P6-A; the signature of useVoiceInput is frozen. This stub detects the
// environment (`supported`, `secure`) and stays idle: start / stop / cancel / toggle do nothing yet.
import type { AudioTranscription } from '@harness-forge/shared'
import type { Ref } from 'vue'
import { getCurrentScope, onScopeDispose, readonly, ref } from 'vue'

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
  /** Recording time in ms (the RecordingIndicator timer). */
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

/** The browser's media APIs (the default `transcribe` is added by the implementation). */
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

export function useVoiceInput(opts: VoiceInputOptions): VoiceInput {
  const env: Omit<VoiceInputEnv, 'transcribe'> = { ...browserVoiceInputEnv(), ...opts.env }
  const state = ref<VoiceInputState>('idle')
  const elapsedMs = ref(0)
  const level = ref(0)

  function cancel(): void {
    // Stub: nothing records yet.
  }

  if (getCurrentScope())
    onScopeDispose(cancel)

  return {
    state: readonly(state),
    supported: isVoiceInputSupported(env),
    secure: env.isSecureContext === true,
    elapsedMs: readonly(elapsedMs),
    level: readonly(level),
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    cancel,
    toggle: () => Promise.resolve(),
  }
}
