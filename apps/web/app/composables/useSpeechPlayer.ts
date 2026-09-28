// Read aloud (docs/UI.md 7.18, 11.3; ADR-029): one app-wide player, a module singleton shared by every ReadAloudButton
// and Settings -> Media's Test voice (id 'voice-test'). It reads the text of a reply (speech-text.ts) in sentence
// chunks, one POST /api/audio/speech per chunk, the next one fetched while the current one plays, through one reused
// HTMLAudioElement unlocked inside the click with a silent clip (Safari), with object URLs revoked after use, one
// AbortController per chunk request and playbackRate = the speechSpeed setting (the speed never reaches the provider).
// Starting another reading stops the first; a chat switch, hiding the page, starting a dictation (the composer calls
// stop()) and Esc outside inputs and overlays stop it; the natural end returns to idle. A failure shows the toast
// "Could not read this reply aloud" ("Could not play the test voice" for Test voice) with the server message.
// The stop triggers (the Esc shortcut, the page-hide listeners, the chat watcher) exist only while something plays.
import type { ApiClient, AudioSpeechBody } from '@harness-forge/shared'
import type { EffectScope, Ref } from 'vue'
import { getActivePinia } from 'pinia'
import { effectScope, onScopeDispose, readonly, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { useApi } from '~/composables/useApi'
import { focusInOverlay } from '~/composables/useComposerShortcuts'
import { useShortcuts } from '~/composables/useShortcuts'
import { useSettingsStore } from '~/stores/settings'
import { useUiStore } from '~/stores/ui'
import { toHarnessError } from '~/utils/errors'
import { readAloudChunks } from '~/utils/speech-text'

export type SpeechPlayerState = 'idle' | 'loading' | 'playing'

/** Overrides of the Settings -> Media choices for one read (Test voice passes the chosen model and voice). */
export interface SpeechPlayOptions {
  modelRef?: string
  voice?: string
}

export interface SpeechPlayer {
  state: Readonly<Ref<SpeechPlayerState>>
  /** The message being read ('voice-test' for Settings -> Media), or null. */
  activeId: Readonly<Ref<string | null>>
  /**
   * Stops whatever plays, then reads `markdown` in chunks (speech-text.ts). Call it inside the click: the audio element
   * is unlocked synchronously. Resolves when this reading ends (the natural end, stop() or a failure, which the player
   * reports with a toast); never rejects.
   */
  play: (id: string, markdown: string, opts?: SpeechPlayOptions) => Promise<void>
  stop: () => void
  /** Stops when `id` is active, else plays. */
  toggle: (id: string, markdown: string, opts?: SpeechPlayOptions) => Promise<void>
}

/** The id Settings -> Media's Test voice reads with (its failures say "Could not play the test voice"). */
export const VOICE_TEST_ID = 'voice-test'

/** Id of the Esc shortcut registered while something plays (docs/UI.md 12). */
export const READ_ALOUD_STOP_SHORTCUT = 'read-aloud-stop'

type UiStore = ReturnType<typeof useUiStore>

interface Run {
  readonly id: string
  readonly chunks: readonly string[]
  readonly options: SpeechPlayOptions
  readonly api: ApiClient
  readonly speed: () => number
  readonly scope: EffectScope
  /** Object URL of each chunk, fetched once (the next one while the current one plays). */
  readonly fetches: Array<Promise<string> | undefined>
  /** Chunks whose audio has arrived. */
  readonly ready: Set<number>
  readonly controllers: AbortController[]
  /** Object URLs not revoked yet. */
  readonly urls: Set<string>
  /** A chunk plays (not the silent unlock clip): the element's ended / error / pause events belong to it. */
  playing: boolean
  /** Settle the chunk that waits for its end. */
  onEnded: (() => void) | null
  onFailed: ((error: unknown) => void) | null
  /** Resolves the promise of play(). */
  readonly done: () => void
}

/** A media error of the audio element (a format the browser cannot decode, a broken file). */
class AudioPlaybackError extends Error {
  override name = 'AudioPlaybackError'
}

const state = ref<SpeechPlayerState>('idle')
const activeId = ref<string | null>(null)
let current: Run | null = null
let element: HTMLAudioElement | null = null
let silentUrl: string | null = null

function stoppedError(): DOMException {
  return new DOMException('The reading was stopped.', 'AbortError')
}

/** 50 ms of silence (8 kHz, 16-bit mono PCM WAV): played inside the click to unlock the element (Safari). */
function silentWav(): Blob {
  const samples = 400
  const view = new DataView(new ArrayBuffer(44 + samples * 2))
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++)
      view.setUint8(offset + index, text.charCodeAt(index))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 8000, true)
  view.setUint32(28, 16_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples * 2, true)
  return new Blob([view.buffer], { type: 'audio/wav' })
}

/** The one reused element; its listeners route events to the chunk that plays. */
function audioElement(): HTMLAudioElement {
  if (element)
    return element
  const audio = new Audio()
  audio.preload = 'auto'
  audio.addEventListener('ended', () => {
    const run = current
    if (!run?.playing)
      return
    run.playing = false
    run.onEnded?.()
  })
  audio.addEventListener('error', () => {
    const run = current
    if (!run?.playing)
      return
    run.playing = false
    run.onFailed?.(new AudioPlaybackError('The browser could not play the audio.'))
  })
  // Paused by the system (media keys, an interruption) rather than by its natural end: the reading is over.
  audio.addEventListener('pause', () => {
    if (current?.playing && !audio.ended)
      stop()
  })
  element = audio
  return audio
}

/** Starts the silent clip synchronously (inside the click), so later programmatic play() calls are allowed. */
function unlock(): HTMLAudioElement {
  const audio = audioElement()
  silentUrl ??= URL.createObjectURL(silentWav())
  audio.src = silentUrl
  audio.play().catch(() => {})
  return audio
}

function clampSpeed(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(2, Math.max(0.5, value)) : 1
}

function failureTitle(id: string): string {
  return id === VOICE_TEST_ID ? 'Could not play the test voice' : 'Could not read this reply aloud'
}

function failureMessage(error: unknown): string {
  if (error instanceof AudioPlaybackError)
    return error.message
  if (error instanceof Error && error.name === 'NotAllowedError')
    return 'The browser blocked audio playback.'
  if (error instanceof Error && error.name === 'NotSupportedError')
    return 'The browser could not play the audio.'
  return toHarnessError(error).message
}

/** Ends `run`: aborts its requests, revokes its URLs, silences the element, removes the stop triggers, then idle. */
function end(run: Run): void {
  if (current !== run)
    return
  current = null
  run.playing = false
  run.scope.stop()
  for (const controller of run.controllers)
    controller.abort()
  for (const url of run.urls)
    URL.revokeObjectURL(url)
  run.urls.clear()
  const waiting = run.onFailed
  run.onEnded = null
  run.onFailed = null
  waiting?.(stoppedError())
  if (element) {
    element.pause()
    element.removeAttribute('src')
    element.load()
  }
  state.value = 'idle'
  activeId.value = null
  run.done()
}

function stop(): void {
  if (current)
    end(current)
}

/** The stop triggers of a reading, inside its effect scope (removed when the reading ends). */
function installStopTriggers(ui: UiStore | null): void {
  useShortcuts().register({
    id: READ_ALOUD_STOP_SHORTCUT,
    keys: 'escape',
    description: 'Stop reading aloud',
    group: 'Chat',
    when: () => current !== null && !focusInOverlay(),
    handler: () => stop(),
  })
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden')
      stop()
  }
  const onPageHide = () => stop()
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', onPageHide)
  onScopeDispose(() => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', onPageHide)
  })
  if (ui)
    watch(() => ui.activeChatId, () => stop(), { flush: 'sync' })
}

async function fetchChunk(run: Run, index: number): Promise<string> {
  const controller = new AbortController()
  run.controllers.push(controller)
  const body: AudioSpeechBody = { text: run.chunks[index]! }
  if (run.options.modelRef)
    body.modelRef = run.options.modelRef
  if (run.options.voice)
    body.voice = run.options.voice
  const response = await run.api.audio.speech({ body, signal: controller.signal })
  const blob = await response.blob()
  if (run !== current)
    throw stoppedError()
  const url = URL.createObjectURL(blob)
  run.urls.add(url)
  run.ready.add(index)
  return url
}

/** The object URL of chunk `index`, fetched once. */
function chunkUrl(run: Run, index: number): Promise<string> {
  let fetch = run.fetches[index]
  if (!fetch) {
    fetch = fetchChunk(run, index)
    // Awaited (and reported) by readChunks when its turn comes; no unhandled rejection meanwhile.
    fetch.catch(() => {})
    run.fetches[index] = fetch
  }
  return fetch
}

/** Plays one chunk; resolves at its end, rejects on a media error or a refused play(). */
function playChunk(run: Run, audio: HTMLAudioElement, url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (run !== current) {
      reject(stoppedError())
      return
    }
    run.onEnded = resolve
    run.onFailed = reject
    audio.src = url
    // A new source resets the rate to defaultPlaybackRate: set both.
    const speed = run.speed()
    audio.defaultPlaybackRate = speed
    audio.playbackRate = speed
    run.playing = true
    audio.play().then(() => {
      if (run === current && run.playing)
        state.value = 'playing'
    }, (error: unknown) => {
      if (run === current) {
        run.playing = false
        reject(error)
      }
    })
  })
}

async function readChunks(run: Run, audio: HTMLAudioElement): Promise<void> {
  try {
    for (let index = 0; index < run.chunks.length; index++) {
      if (!run.ready.has(index))
        state.value = 'loading'
      const url = await chunkUrl(run, index)
      if (index + 1 < run.chunks.length)
        void chunkUrl(run, index + 1)
      await playChunk(run, audio, url)
      URL.revokeObjectURL(url)
      run.urls.delete(url)
    }
    end(run)
  }
  catch (error) {
    // After stop() (or another reading) the aborted requests and the settled chunk are expected: nothing to report.
    if (run !== current)
      return
    toast.error(failureTitle(run.id), { description: failureMessage(error) })
    end(run)
  }
}

function play(id: string, markdown: string, opts: SpeechPlayOptions = {}): Promise<void> {
  const api = useApi()
  // The stores of the running app (always there in the app; a bare unit test may have no Pinia).
  const pinia = getActivePinia()
  const settings = pinia ? useSettingsStore(pinia) : null
  const ui = pinia ? useUiStore(pinia) : null
  stop()
  const audio = unlock()
  const chunks = readAloudChunks(markdown)
  if (chunks.length === 0)
    return Promise.resolve()
  return new Promise<void>((resolve) => {
    const run: Run = {
      id,
      chunks,
      options: { ...opts },
      api,
      speed: () => clampSpeed(settings?.resolved.speechSpeed),
      scope: effectScope(true),
      fetches: [],
      ready: new Set(),
      controllers: [],
      urls: new Set(),
      playing: false,
      onEnded: null,
      onFailed: null,
      done: resolve,
    }
    current = run
    activeId.value = id
    state.value = 'loading'
    run.scope.run(() => installStopTriggers(ui))
    void readChunks(run, audio)
  })
}

function toggle(id: string, markdown: string, opts?: SpeechPlayOptions): Promise<void> {
  if (current?.id === id) {
    stop()
    return Promise.resolve()
  }
  return play(id, markdown, opts)
}

const player: SpeechPlayer = {
  state: readonly(state),
  activeId: readonly(activeId),
  play,
  stop,
  toggle,
}

/** The app-wide player (the same object on every call). */
export function useSpeechPlayer(): SpeechPlayer {
  return player
}

/** Test helper: stops, forgets the audio element and revokes the unlock clip's URL. */
export function resetSpeechPlayer(): void {
  stop()
  element = null
  if (silentUrl) {
    URL.revokeObjectURL(silentUrl)
    silentUrl = null
  }
}
