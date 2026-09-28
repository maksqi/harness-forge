// Test helper (not app code; never imported by components): fake browser media APIs for the voice features
// (docs/UI.md 7.17, 7.18; docs/phases/phase-6-v1-2.md "Rules for every Phase 6 agent"). happy-dom has no
// MediaRecorder, no navigator.mediaDevices, no isSecureContext and an HTMLMediaElement whose play() plays nothing.
// - installFakeMedia({ deny?, mimeTypes?, secure?, prompt? }) installs navigator.mediaDevices.getUserMedia,
//   MediaRecorder (FakeMediaRecorder) and isSecureContext, and returns the uninstall function, which also carries
//   handles to the fakes (getUserMedia, streams, recorders, grant, deny).
// - FakeMediaRecorder "records" a blob that starts like a real file of its type (an EBML-prefixed WebM for audio/webm)
//   and emits it through dataavailable on stop(), requestData() and every `timeslice`, like a browser.
// - FakeMediaStream / FakeMediaStreamTrack: the microphone; stop() releases a track, end() simulates the source going
//   away (a mobile interruption), which also stops a recorder of the stream.
// - FakeAudio (+ installFakeAudio()): an HTMLAudioElement stand-in whose play() resolves and whose end of playback
//   (end()) and errors (fail()) are fired by the test.
// Event handler properties (`onstop`, `onended`, ...) behave like the browser's: registered as a listener when first
// set, so each event reaches a handler exactly once.
import type { Mock } from 'vitest'
import { vi } from 'vitest'

/** The recorder types Chrome supports: the default `isTypeSupported()` list of `installFakeMedia()`. */
export const FAKE_RECORDER_MIME_TYPES: readonly string[] = ['audio/webm;codecs=opus', 'audio/webm']

/** EBML header of a WebM file (EBML version 1, DocType "webm"): the first bytes of every fake WebM recording. */
export const WEBM_EBML_HEADER: Uint8Array<ArrayBuffer> = Uint8Array.from([
  ...[0x1A, 0x45, 0xDF, 0xA3], // EBML element id
  0x9F, // size: 31 bytes
  ...[0x42, 0x86, 0x81, 0x01], // EBMLVersion 1
  ...[0x42, 0xF7, 0x81, 0x01], // EBMLReadVersion 1
  ...[0x42, 0xF2, 0x81, 0x04], // EBMLMaxIDLength 4
  ...[0x42, 0xF3, 0x81, 0x08], // EBMLMaxSizeLength 8
  ...[0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6D], // DocType "webm"
  ...[0x42, 0x87, 0x81, 0x04], // DocTypeVersion 4
  ...[0x42, 0x85, 0x81, 0x02], // DocTypeReadVersion 2
])

/** Start of a WebM Segment of unknown size (what a recorder streams after the EBML header). */
const WEBM_SEGMENT_START = [0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]

/** Bytes of media data in every emitted chunk. */
const CHUNK_PAYLOAD_BYTES = 256

function ascii(text: string): number[] {
  return Array.from(text, char => char.charCodeAt(0))
}

/** Lowercase, without spaces: `audio/webm; codecs=opus` -> `audio/webm;codecs=opus`. */
function normalizeMimeType(type: string): string {
  return type.replace(/\s+/g, '').toLowerCase()
}

/** The container signature a recording of `mimeType` starts with (WebM unless the type says Ogg or MP4). */
function containerHeader(mimeType: string): number[] {
  const base = normalizeMimeType(mimeType).split(';')[0] ?? ''
  if (base === 'audio/ogg' || base === 'video/ogg')
    return [...ascii('OggS'), 0x00, 0x02, ...Array.from<number>({ length: 22 }).fill(0)]
  if (base === 'audio/mp4' || base === 'video/mp4' || base === 'audio/x-m4a')
    return [0x00, 0x00, 0x00, 0x18, ...ascii('ftypM4A '), 0x00, 0x00, 0x00, 0x00, ...ascii('M4A isom')]
  return [...WEBM_EBML_HEADER, ...WEBM_SEGMENT_START]
}

/** Deterministic filler standing in for encoded audio. */
function payload(length: number): number[] {
  return Array.from({ length }, (_, index) => (index * 31 + 7) & 0xFF)
}

/**
 * The bytes of a fake recording of `mimeType`: the container signature (an EBML header with DocType "webm" for
 * audio/webm, `OggS` for Ogg, an `ftyp` box for MP4), then `payloadBytes` of filler. Real enough for the server's
 * magic-byte check of `POST /audio/transcriptions`.
 */
export function fakeRecordingBytes(mimeType = 'audio/webm', payloadBytes = CHUNK_PAYLOAD_BYTES): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([...containerHeader(mimeType), ...payload(payloadBytes)])
}

// ---------- event handler properties ----------

type HandlerHost = EventTarget & Record<symbol, unknown>

/**
 * Defines `on<type>` accessors on a prototype. Like in a browser, a handler becomes an event listener the first time it
 * is set, so dispatchEvent() calls it exactly once, after the listeners added before it.
 */
function defineEventHandlers(prototype: EventTarget, types: readonly string[]): void {
  for (const type of types) {
    const handlerKey = Symbol(`on${type}`)
    const listenerKey = Symbol(`on${type} listener`)
    Object.defineProperty(prototype, `on${type}`, {
      configurable: true,
      enumerable: true,
      get(this: HandlerHost) {
        return this[handlerKey] ?? null
      },
      set(this: HandlerHost, value: unknown) {
        this[handlerKey] = typeof value === 'function' ? value : null
        if (this[listenerKey])
          return
        const listener = (event: Event) => {
          const handler = this[handlerKey]
          if (typeof handler === 'function')
            handler.call(this, event)
        }
        this[listenerKey] = listener
        this.addEventListener(type, listener)
      },
    })
  }
}

let fakeIdSeq = 0

function nextFakeId(prefix: string): string {
  fakeIdSeq += 1
  return `${prefix}-${fakeIdSeq}`
}

// ---------- getUserMedia errors ----------

/** DOMException names getUserMedia rejects with (the composer maps them to its toasts). */
export type FakeMediaErrorName = 'NotAllowedError' | 'NotFoundError' | 'NotReadableError' | 'AbortError' | 'SecurityError'

const MEDIA_ERROR_MESSAGES: Record<FakeMediaErrorName, string> = {
  NotAllowedError: 'Permission denied',
  NotFoundError: 'Requested device not found',
  NotReadableError: 'Could not start audio source',
  AbortError: 'The request was aborted',
  SecurityError: 'The request is not allowed in this context',
}

/**
 * A getUserMedia failure as a browser reports it: NotAllowedError (permission denied), NotFoundError (no microphone),
 * NotReadableError (the microphone is in use by another app), ...
 */
export function mediaError(name: FakeMediaErrorName = 'NotAllowedError'): DOMException {
  return new DOMException(MEDIA_ERROR_MESSAGES[name], name)
}

// ---------- stream and tracks ----------

const trackWatchers = new WeakMap<FakeMediaStreamTrack, Set<() => void>>()

function watchTrack(track: FakeMediaStreamTrack, watcher: () => void): () => void {
  let watchers = trackWatchers.get(track)
  if (!watchers) {
    watchers = new Set()
    trackWatchers.set(track, watchers)
  }
  watchers.add(watcher)
  return () => watchers.delete(watcher)
}

/**
 * A track of the fake microphone. `stop()` releases it (readyState "ended", no "ended" event, as in browsers; `stopped`
 * records it); `end()` simulates the source going away (an unplugged device, a mobile interruption) and fires "ended".
 * Either way a FakeMediaRecorder recording a stream whose tracks all ended stops (dataavailable, then stop).
 */
export class FakeMediaStreamTrack extends EventTarget implements MediaStreamTrack {
  declare onended: ((this: MediaStreamTrack, ev: Event) => any) | null
  declare onmute: ((this: MediaStreamTrack, ev: Event) => any) | null
  declare onunmute: ((this: MediaStreamTrack, ev: Event) => any) | null

  readonly id = nextFakeId('fake-track')
  readonly kind: 'audio' | 'video'
  readonly label: string
  contentHint = ''
  enabled = true
  muted = false
  readyState: MediaStreamTrackState = 'live'
  /** stop() was called: the app released the microphone. */
  stopped = false
  #constraints: MediaTrackConstraints = {}

  constructor(kind: 'audio' | 'video' = 'audio', label = 'Fake microphone') {
    super()
    this.kind = kind
    this.label = label
  }

  stop(): void {
    this.stopped = true
    this.#markEnded()
  }

  /** Test control: the source ended; fires "ended" once. */
  end(): void {
    if (this.readyState === 'ended')
      return
    this.#markEnded()
    this.dispatchEvent(new Event('ended'))
  }

  clone(): FakeMediaStreamTrack {
    const copy = new FakeMediaStreamTrack(this.kind, this.label)
    copy.enabled = this.enabled
    return copy
  }

  getSettings(): MediaTrackSettings {
    return {
      deviceId: 'fake-microphone',
      groupId: 'fake-group',
      channelCount: 1,
      sampleRate: 48_000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }
  }

  getConstraints(): MediaTrackConstraints {
    return { ...this.#constraints }
  }

  getCapabilities(): MediaTrackCapabilities {
    return { deviceId: 'fake-microphone', groupId: 'fake-group' }
  }

  applyConstraints(constraints: MediaTrackConstraints = {}): Promise<void> {
    this.#constraints = { ...constraints }
    return Promise.resolve()
  }

  #markEnded(): void {
    if (this.readyState === 'ended')
      return
    this.readyState = 'ended'
    for (const watcher of [...(trackWatchers.get(this) ?? [])])
      watcher()
  }
}
defineEventHandlers(FakeMediaStreamTrack.prototype, ['ended', 'mute', 'unmute'])

/** The fake microphone stream: one live audio track by default. */
export class FakeMediaStream extends EventTarget implements MediaStream {
  declare onaddtrack: ((this: MediaStream, ev: MediaStreamTrackEvent) => any) | null
  declare onremovetrack: ((this: MediaStream, ev: MediaStreamTrackEvent) => any) | null

  readonly id = nextFakeId('fake-stream')
  #tracks: FakeMediaStreamTrack[]

  constructor(tracks: readonly FakeMediaStreamTrack[] = [new FakeMediaStreamTrack()]) {
    super()
    this.#tracks = [...tracks]
  }

  get active(): boolean {
    return this.#tracks.some(track => track.readyState === 'live')
  }

  /** Every track was stopped by the app: the microphone is released. */
  get stopped(): boolean {
    return this.#tracks.length > 0 && this.#tracks.every(track => track.stopped)
  }

  getTracks(): FakeMediaStreamTrack[] {
    return [...this.#tracks]
  }

  getAudioTracks(): FakeMediaStreamTrack[] {
    return this.#tracks.filter(track => track.kind === 'audio')
  }

  getVideoTracks(): FakeMediaStreamTrack[] {
    return this.#tracks.filter(track => track.kind === 'video')
  }

  getTrackById(trackId: string): FakeMediaStreamTrack | null {
    return this.#tracks.find(track => track.id === trackId) ?? null
  }

  addTrack(track: FakeMediaStreamTrack): void {
    if (!this.#tracks.includes(track))
      this.#tracks.push(track)
  }

  removeTrack(track: FakeMediaStreamTrack): void {
    this.#tracks = this.#tracks.filter(item => item !== track)
  }

  clone(): FakeMediaStream {
    return new FakeMediaStream(this.#tracks.map(track => track.clone()))
  }
}
defineEventHandlers(FakeMediaStream.prototype, ['addtrack', 'removetrack'])

// ---------- MediaRecorder ----------

/** The `dataavailable` event of FakeMediaRecorder (happy-dom's BlobEvent carries no data). */
export class FakeBlobEvent extends Event implements BlobEvent {
  readonly data: Blob
  readonly timecode: number

  constructor(type: string, init: BlobEventInit) {
    super(type, init)
    this.data = init.data
    this.timecode = init.timecode ?? 0
  }
}

function invalidState(method: string, state: RecordingState): DOMException {
  return new DOMException(`Failed to execute '${method}' on 'MediaRecorder': The MediaRecorder's state is '${state}'.`, 'InvalidStateError')
}

/**
 * A MediaRecorder that "records" fake audio. `isTypeSupported()` answers from `supportedTypes` (set by
 * `installFakeMedia({ mimeTypes })`); the constructor throws NotSupportedError for another explicit `mimeType`; without
 * one the recorder uses the first supported type. Events follow the browser order in microtasks: start; on stop()
 * dataavailable (the last chunk) then stop; requestData() and every `timeslice` emit a chunk. The first chunk starts
 * with the container header (`fakeRecordingBytes`), so `chunks` joined form one file (`blob`).
 */
export class FakeMediaRecorder extends EventTarget implements MediaRecorder {
  /** Types `isTypeSupported()` accepts. */
  static supportedTypes: readonly string[] = FAKE_RECORDER_MIME_TYPES
  /** Every recorder created since the last `installFakeMedia()`, in order. */
  static readonly instances: FakeMediaRecorder[] = []

  static isTypeSupported(type: string): boolean {
    const wanted = normalizeMimeType(type)
    return FakeMediaRecorder.supportedTypes.some(item => normalizeMimeType(item) === wanted)
  }

  declare ondataavailable: ((this: MediaRecorder, ev: BlobEvent) => any) | null
  declare onerror: ((this: MediaRecorder, ev: ErrorEvent) => any) | null
  declare onpause: ((this: MediaRecorder, ev: Event) => any) | null
  declare onresume: ((this: MediaRecorder, ev: Event) => any) | null
  declare onstart: ((this: MediaRecorder, ev: Event) => any) | null
  declare onstop: ((this: MediaRecorder, ev: Event) => any) | null

  readonly stream: MediaStream
  readonly mimeType: string
  readonly audioBitsPerSecond: number
  readonly videoBitsPerSecond: number
  /** A copy of the constructor options (assert the requested type and bit rate). */
  readonly options: MediaRecorderOptions
  /** Every chunk emitted by dataavailable, in order. */
  readonly chunks: Blob[] = []
  /** The `timeslice` of the last start(). */
  timeslice: number | undefined
  #state: RecordingState = 'inactive'
  #headerSent = false
  #startedAt = 0
  #timer: ReturnType<typeof setInterval> | undefined
  #unwatch: (() => void) | undefined

  constructor(stream: MediaStream, options: MediaRecorderOptions = {}) {
    super()
    if (!stream)
      throw new TypeError('Failed to construct \'MediaRecorder\': parameter 1 is not of type \'MediaStream\'.')
    const requested = options.mimeType ?? ''
    if (requested && !FakeMediaRecorder.isTypeSupported(requested))
      throw new DOMException(`Failed to construct 'MediaRecorder': Unsupported mimeType: ${requested}`, 'NotSupportedError')
    this.stream = stream
    this.options = { ...options }
    this.mimeType = requested || FakeMediaRecorder.supportedTypes[0] || 'audio/webm'
    this.audioBitsPerSecond = options.audioBitsPerSecond ?? options.bitsPerSecond ?? 128_000
    this.videoBitsPerSecond = options.videoBitsPerSecond ?? 0
    FakeMediaRecorder.instances.push(this)
  }

  get state(): RecordingState {
    return this.#state
  }

  /** The recording so far: every emitted chunk joined, typed `mimeType`. */
  get blob(): Blob {
    return new Blob(this.chunks, { type: this.mimeType })
  }

  start(timeslice?: number): void {
    if (this.#state !== 'inactive')
      throw invalidState('start', this.#state)
    if (this.stream.active === false)
      throw new DOMException('Failed to execute \'start\' on \'MediaRecorder\': There was an error starting the MediaRecorder.', 'NotSupportedError')
    this.#state = 'recording'
    this.timeslice = timeslice
    this.#startedAt = Date.now()
    this.#watchTracks()
    this.#startTimer()
    queueMicrotask(() => this.dispatchEvent(new Event('start')))
  }

  stop(): void {
    if (this.#state === 'inactive')
      return
    this.#finish()
  }

  pause(): void {
    if (this.#state === 'inactive')
      throw invalidState('pause', this.#state)
    if (this.#state === 'paused')
      return
    this.#state = 'paused'
    this.#stopTimer()
    queueMicrotask(() => this.dispatchEvent(new Event('pause')))
  }

  resume(): void {
    if (this.#state === 'inactive')
      throw invalidState('resume', this.#state)
    if (this.#state === 'recording')
      return
    this.#state = 'recording'
    this.#startTimer()
    queueMicrotask(() => this.dispatchEvent(new Event('resume')))
  }

  requestData(): void {
    if (this.#state === 'inactive')
      throw invalidState('requestData', this.#state)
    queueMicrotask(() => this.#emit())
  }

  /**
   * Test control: a recording failure. Fires "error" (an ErrorEvent carrying `error`), then stops like a browser
   * (dataavailable, stop). Ignored while inactive.
   */
  fail(error: DOMException = new DOMException('The recording failed.', 'UnknownError')): void {
    if (this.#state === 'inactive')
      return
    queueMicrotask(() => this.dispatchEvent(new ErrorEvent('error', { error, message: error.message })))
    this.#finish()
  }

  /** Test cleanup: stops the timeslice timer and the track watchers without firing events. */
  dispose(): void {
    this.#stopTimer()
    this.#unwatch?.()
    this.#unwatch = undefined
  }

  #finish(): void {
    this.#state = 'inactive'
    this.dispose()
    queueMicrotask(() => {
      this.#emit()
      this.dispatchEvent(new Event('stop'))
    })
  }

  #emit(): void {
    const bytes = this.#headerSent ? Uint8Array.from(payload(CHUNK_PAYLOAD_BYTES)) : fakeRecordingBytes(this.mimeType)
    this.#headerSent = true
    const data = new Blob([bytes], { type: this.mimeType })
    this.chunks.push(data)
    this.dispatchEvent(new FakeBlobEvent('dataavailable', { data, timecode: Date.now() - this.#startedAt }))
  }

  #startTimer(): void {
    if (this.timeslice !== undefined && this.timeslice > 0)
      this.#timer = setInterval(() => this.#emit(), this.timeslice)
  }

  #stopTimer(): void {
    if (this.#timer === undefined)
      return
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  /** A browser stops recording once every track of the stream ended (stopped or interrupted); FakeMediaStreamTracks only. */
  #watchTracks(): void {
    const all = typeof this.stream.getTracks === 'function' ? this.stream.getTracks() : []
    const tracks = all.filter(track => track instanceof FakeMediaStreamTrack)
    if (tracks.length === 0)
      return
    const check = () => {
      if (this.#state !== 'inactive' && tracks.every(track => track.readyState === 'ended'))
        this.#finish()
    }
    const unwatchers = tracks.map(track => watchTrack(track, check))
    this.#unwatch = () => unwatchers.forEach(unwatch => unwatch())
  }
}
defineEventHandlers(FakeMediaRecorder.prototype, ['dataavailable', 'error', 'pause', 'resume', 'start', 'stop'])

// ---------- installing the fakes ----------

/** The objects a global is installed on: globalThis and, when it differs, window. */
function globalHosts(): object[] {
  const hosts = new Set<object>([globalThis])
  if (typeof window !== 'undefined')
    hosts.add(window)
  return [...hosts]
}

/** Defines `key` as an own property with `value` (undefined = "not available"); returns the restore function. */
function replaceProperty(target: object, key: string, value: unknown): () => void {
  const previous = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, { configurable: true, enumerable: true, writable: true, value })
  return () => {
    if (previous)
      Object.defineProperty(target, key, previous)
    else
      Reflect.deleteProperty(target, key)
  }
}

export interface FakeMediaOptions {
  /**
   * getUserMedia rejects: `true` = NotAllowedError (permission denied), or another DOMException name (NotFoundError:
   * no microphone; NotReadableError: the microphone is in use). Default: granted.
   */
  deny?: boolean | FakeMediaErrorName
  /** Types `MediaRecorder.isTypeSupported()` accepts; default Chrome's `FAKE_RECORDER_MIME_TYPES`. */
  mimeTypes?: readonly string[]
  /**
   * `isSecureContext`; default true. `false` also leaves `navigator.mediaDevices` undefined, as browsers do outside
   * secure contexts (MediaRecorder stays).
   */
  secure?: boolean
  /** The permission prompt stays open: getUserMedia waits for `media.grant()` or `media.deny()`. */
  prompt?: boolean
}

export interface FakeMedia {
  /** Uninstalls the fakes (idempotent): restores MediaRecorder, navigator.mediaDevices and isSecureContext. */
  (): void
  /** The same as calling the handle. */
  uninstall: () => void
  /** navigator.mediaDevices.getUserMedia (a vi.fn; not installed with `secure: false`). */
  getUserMedia: Mock<(constraints?: MediaStreamConstraints) => Promise<MediaStream>>
  /** Every stream getUserMedia handed out, in order. */
  streams: FakeMediaStream[]
  /** Every FakeMediaRecorder created since the install, in order (`FakeMediaRecorder.instances`). */
  recorders: FakeMediaRecorder[]
  /** `prompt: true`: grants the waiting getUserMedia calls (each gets its own stream). */
  grant: () => void
  /** `prompt: true`: rejects the waiting getUserMedia calls; default NotAllowedError. */
  deny: (name?: FakeMediaErrorName) => void
}

/**
 * Installs the fake microphone on the happy-dom globals: `navigator.mediaDevices` ({ getUserMedia, enumerateDevices }),
 * `MediaRecorder` (FakeMediaRecorder with the given `mimeTypes`) and `isSecureContext`. getUserMedia requires an
 * `audio` constraint (video: NotFoundError). Returns the uninstall function with handles to the fakes. Waiting
 * `prompt` requests stay pending after the uninstall.
 */
export function installFakeMedia(options: FakeMediaOptions = {}): FakeMedia {
  const secure = options.secure ?? true
  const streams: FakeMediaStream[] = []
  const waiting: Array<{ resolve: (stream: MediaStream) => void, reject: (error: unknown) => void }> = []

  function openStream(): FakeMediaStream {
    const stream = new FakeMediaStream()
    streams.push(stream)
    return stream
  }

  const getUserMedia = vi.fn((constraints?: MediaStreamConstraints): Promise<MediaStream> => {
    if (!constraints?.audio && !constraints?.video)
      return Promise.reject(new TypeError('Failed to execute \'getUserMedia\' on \'MediaDevices\': At least one of audio and video must be requested'))
    if (constraints.video)
      return Promise.reject(mediaError('NotFoundError'))
    if (options.prompt)
      return new Promise<MediaStream>((resolve, reject) => waiting.push({ resolve, reject }))
    if (options.deny)
      return Promise.reject(mediaError(options.deny === true ? 'NotAllowedError' : options.deny))
    return Promise.resolve(openStream())
  })

  const mediaDevices = secure
    ? {
        getUserMedia,
        enumerateDevices: () => Promise.resolve([
          { deviceId: 'fake-microphone', groupId: 'fake-group', kind: 'audioinput', label: 'Fake microphone', toJSON: () => ({}) },
        ]),
      }
    : undefined

  FakeMediaRecorder.supportedTypes = options.mimeTypes ?? FAKE_RECORDER_MIME_TYPES
  FakeMediaRecorder.instances.length = 0
  const restorers = [
    ...globalHosts().flatMap(host => [
      replaceProperty(host, 'MediaRecorder', FakeMediaRecorder),
      replaceProperty(host, 'isSecureContext', secure),
    ]),
    replaceProperty(globalThis.navigator, 'mediaDevices', mediaDevices),
  ]

  let installed = true
  function uninstall(): void {
    if (!installed)
      return
    installed = false
    waiting.length = 0
    for (const recorder of FakeMediaRecorder.instances)
      recorder.dispose()
    FakeMediaRecorder.supportedTypes = FAKE_RECORDER_MIME_TYPES
    for (const restore of restorers.reverse())
      restore()
  }

  return Object.assign(uninstall, {
    uninstall,
    getUserMedia,
    streams,
    recorders: FakeMediaRecorder.instances,
    grant: () => {
      for (const request of waiting.splice(0))
        request.resolve(openStream())
    },
    deny: (name: FakeMediaErrorName = 'NotAllowedError') => {
      for (const request of waiting.splice(0))
        request.reject(mediaError(name))
    },
  })
}

// ---------- audio playback ----------

/** `HTMLMediaElement.error` of a FakeAudio (code 4 = MEDIA_ERR_SRC_NOT_SUPPORTED). */
export interface FakeMediaErrorInfo {
  readonly code: number
  readonly message: string
}

/**
 * An HTMLAudioElement stand-in for the read-aloud player: `new Audio(src?)` compatible (see `installFakeAudio()`),
 * every instance listed in `FakeAudio.instances`. play() resolves at once and fires "play" and "playing" (it rejects
 * with NotSupportedError without a src, or with `playError`); setting `src` (or load()) resets the element; the test
 * ends playback with `end()` ("pause" then "ended", as a browser fires them) or fails it with `fail()` ("error").
 */
export class FakeAudio extends EventTarget {
  /** Every FakeAudio created since the last `installFakeAudio()` / `reset()`, in order. */
  static readonly instances: FakeAudio[] = []
  /** When set, every play() rejects with it (e.g. a NotAllowedError DOMException: autoplay blocked). */
  static playError: unknown = null

  /** The newest FakeAudio. */
  static get last(): FakeAudio | undefined {
    return FakeAudio.instances.at(-1)
  }

  /** Forgets every instance and the static `playError`. */
  static reset(): void {
    FakeAudio.instances.length = 0
    FakeAudio.playError = null
  }

  declare onended: ((this: FakeAudio, ev: Event) => any) | null
  declare onerror: ((this: FakeAudio, ev: Event) => any) | null
  declare onplay: ((this: FakeAudio, ev: Event) => any) | null
  declare onplaying: ((this: FakeAudio, ev: Event) => any) | null
  declare onpause: ((this: FakeAudio, ev: Event) => any) | null
  declare oncanplay: ((this: FakeAudio, ev: Event) => any) | null
  declare oncanplaythrough: ((this: FakeAudio, ev: Event) => any) | null
  declare onloadedmetadata: ((this: FakeAudio, ev: Event) => any) | null
  declare ontimeupdate: ((this: FakeAudio, ev: Event) => any) | null

  /** Every `src` assigned, in order ('' when the attribute was removed). */
  readonly sources: string[] = []
  currentTime = 0
  duration = Number.NaN
  playbackRate = 1
  defaultPlaybackRate = 1
  volume = 1
  muted = false
  loop = false
  autoplay = false
  preload: '' | 'none' | 'metadata' | 'auto' = 'auto'
  crossOrigin: string | null = null
  paused = true
  ended = false
  error: FakeMediaErrorInfo | null = null
  /** play() calls so far (resolved or rejected). */
  playCalls = 0
  /** When set, the next play() of this element rejects with it. */
  playError: unknown = null
  #src = ''

  constructor(src?: string) {
    super()
    FakeAudio.instances.push(this)
    if (src !== undefined)
      this.src = src
  }

  get src(): string {
    return this.#src
  }

  /** A new source resets the element: paused, not ended, at 0, no error (no events, like the load algorithm). */
  set src(value: string) {
    this.#src = String(value)
    this.sources.push(this.#src)
    this.#reset()
  }

  play(): Promise<void> {
    this.playCalls += 1
    const error = this.playError ?? FakeAudio.playError
    this.playError = null
    if (error)
      return Promise.reject(error)
    if (!this.#src)
      return Promise.reject(new DOMException('The element has no supported sources.', 'NotSupportedError'))
    if (this.ended) {
      this.ended = false
      this.currentTime = 0
    }
    if (this.paused) {
      this.paused = false
      this.dispatchEvent(new Event('play'))
      this.dispatchEvent(new Event('playing'))
    }
    return Promise.resolve()
  }

  pause(): void {
    if (this.paused)
      return
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  }

  load(): void {
    this.#reset()
  }

  canPlayType(type: string): CanPlayTypeResult {
    return type.startsWith('audio/') ? 'maybe' : ''
  }

  getAttribute(name: string): string | null {
    return name === 'src' && this.#src ? this.#src : null
  }

  setAttribute(name: string, value: string): void {
    if (name === 'src')
      this.src = value
  }

  removeAttribute(name: string): void {
    if (name === 'src')
      this.src = ''
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null
  }

  /** Test control: playback reached the end: currentTime = duration (when known), "pause" (if playing), "ended". */
  end(): void {
    if (Number.isFinite(this.duration))
      this.currentTime = this.duration
    this.ended = true
    if (!this.paused) {
      this.paused = true
      this.dispatchEvent(new Event('pause'))
    }
    this.dispatchEvent(new Event('ended'))
  }

  /** Test control: a media error (default code 4, MEDIA_ERR_SRC_NOT_SUPPORTED); fires "error". */
  fail(code = 4, message = 'The media could not be loaded.'): void {
    this.error = { code, message }
    this.dispatchEvent(new Event('error'))
  }

  /** This fake typed as the element it stands in for (for injected factories). */
  asElement(): HTMLAudioElement {
    return this as unknown as HTMLAudioElement
  }

  #reset(): void {
    this.paused = true
    this.ended = false
    this.currentTime = 0
    this.error = null
  }
}
defineEventHandlers(FakeAudio.prototype, ['ended', 'error', 'play', 'playing', 'pause', 'canplay', 'canplaythrough', 'loadedmetadata', 'timeupdate'])

/**
 * Replaces the global `Audio` constructor with FakeAudio (so `new Audio()` creates fakes) and clears FakeAudio's
 * registry; returns the uninstall function (idempotent).
 */
export function installFakeAudio(): () => void {
  FakeAudio.reset()
  const restorers = globalHosts().map(host => replaceProperty(host, 'Audio', FakeAudio))
  let installed = true
  return () => {
    if (!installed)
      return
    installed = false
    for (const restore of restorers.reverse())
      restore()
    FakeAudio.reset()
  }
}
