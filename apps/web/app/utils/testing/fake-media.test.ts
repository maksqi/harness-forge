import type { FakeMedia } from './fake-media'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FAKE_RECORDER_MIME_TYPES,
  FakeAudio,
  FakeBlobEvent,
  FakeMediaRecorder,
  FakeMediaStream,
  fakeRecordingBytes,
  installFakeAudio,
  installFakeMedia,
  mediaError,
  WEBM_EBML_HEADER,
} from './fake-media'

const EBML_MAGIC = [0x1A, 0x45, 0xDF, 0xA3]

let media: FakeMedia | null = null
let uninstallAudio: (() => void) | null = null

afterEach(() => {
  media?.()
  media = null
  uninstallAudio?.()
  uninstallAudio = null
  vi.useRealTimers()
})

/** Lets queued microtasks (the recorder's events) run; works with fake timers too. */
async function microtasks(): Promise<void> {
  for (let round = 0; round < 5; round++)
    await Promise.resolve()
}

async function bytesOf(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()))
}

function thrown(run: () => unknown): unknown {
  try {
    run()
  }
  catch (error) {
    return error
  }
  return undefined
}

async function microphone(): Promise<MediaStream> {
  return globalThis.navigator.mediaDevices.getUserMedia({ audio: true })
}

describe('installFakeMedia', () => {
  it('installs MediaRecorder, navigator.mediaDevices and isSecureContext, and restores happy-dom on uninstall', () => {
    expect('MediaRecorder' in globalThis).toBe(false)
    expect('mediaDevices' in globalThis.navigator).toBe(false)
    expect('isSecureContext' in globalThis).toBe(false)

    const handle = installFakeMedia()
    expect(globalThis.MediaRecorder).toBe(FakeMediaRecorder)
    expect(handle.recorders).toBe(FakeMediaRecorder.instances)
    expect(globalThis.navigator.mediaDevices.getUserMedia).toBe(handle.getUserMedia)
    expect(globalThis.isSecureContext).toBe(true)

    handle()
    handle.uninstall()
    expect('MediaRecorder' in globalThis).toBe(false)
    expect('mediaDevices' in globalThis.navigator).toBe(false)
    expect('isSecureContext' in globalThis).toBe(false)
  })

  it('grants a live audio stream that the app releases with stop() (no "ended" event)', async () => {
    media = installFakeMedia()
    const stream = await microphone()
    expect(stream).toBeInstanceOf(FakeMediaStream)
    expect(media.getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(media.streams).toEqual([stream])
    const [track] = stream.getAudioTracks()
    expect(track).toMatchObject({ kind: 'audio', readyState: 'live', enabled: true, label: 'Fake microphone' })
    expect(stream.active).toBe(true)

    const ended = vi.fn()
    track!.addEventListener('ended', ended)
    for (const item of stream.getTracks())
      item.stop()
    expect(track!.readyState).toBe('ended')
    expect(ended).not.toHaveBeenCalled()
    expect(stream.active).toBe(false)
    expect(media.streams[0]!.stopped).toBe(true)
    expect(await globalThis.navigator.mediaDevices.enumerateDevices()).toMatchObject([{ kind: 'audioinput' }])
  })

  it('rejects like a browser: permission denied, no microphone, busy microphone, bad constraints', async () => {
    media = installFakeMedia({ deny: true })
    await expect(microphone()).rejects.toMatchObject({ name: 'NotAllowedError' })
    media()
    for (const name of ['NotFoundError', 'NotReadableError'] as const) {
      media = installFakeMedia({ deny: name })
      await expect(microphone()).rejects.toMatchObject({ name, message: mediaError(name).message })
      media()
    }
    media = installFakeMedia()
    await expect(globalThis.navigator.mediaDevices.getUserMedia({})).rejects.toBeInstanceOf(TypeError)
    await expect(globalThis.navigator.mediaDevices.getUserMedia({ audio: true, video: true })).rejects.toMatchObject({ name: 'NotFoundError' })
    expect(media.streams).toEqual([])
    expect(mediaError()).toBeInstanceOf(DOMException)
  })

  it('keeps the permission prompt open until grant() or deny()', async () => {
    media = installFakeMedia({ prompt: true })
    const granted = microphone()
    const outcome = vi.fn()
    granted.then(outcome, outcome)
    await microtasks()
    expect(outcome).not.toHaveBeenCalled()
    media.grant()
    await expect(granted).resolves.toBeInstanceOf(FakeMediaStream)

    const denied = microphone()
    media.deny('NotReadableError')
    await expect(denied).rejects.toMatchObject({ name: 'NotReadableError' })
    expect(media.streams).toHaveLength(1)
  })

  it('leaves navigator.mediaDevices out of an insecure context, as browsers do (MediaRecorder stays)', () => {
    media = installFakeMedia({ secure: false })
    expect(globalThis.isSecureContext).toBe(false)
    expect(globalThis.navigator.mediaDevices).toBeUndefined()
    expect(globalThis.MediaRecorder).toBe(FakeMediaRecorder)
  })
})

describe('fakeMediaRecorder', () => {
  it('answers isTypeSupported() from mimeTypes and refuses another explicit type', async () => {
    media = installFakeMedia()
    expect(FAKE_RECORDER_MIME_TYPES).toEqual(['audio/webm;codecs=opus', 'audio/webm'])
    expect(MediaRecorder.isTypeSupported('audio/webm;codecs=opus')).toBe(true)
    expect(MediaRecorder.isTypeSupported('audio/webm; codecs=opus')).toBe(true)
    expect(MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')).toBe(false)
    const stream = await microphone()
    expect(() => new MediaRecorder(stream, { mimeType: 'audio/mp4' })).toThrow(/Unsupported mimeType: audio\/mp4/)
    expect(new MediaRecorder(stream).mimeType).toBe('audio/webm;codecs=opus')
    media()

    media = installFakeMedia({ mimeTypes: ['audio/mp4'] })
    expect(MediaRecorder.isTypeSupported('audio/webm')).toBe(false)
    expect(new MediaRecorder(await microphone()).mimeType).toBe('audio/mp4')
  })

  it('records: start, then on stop dataavailable with an EBML-prefixed WebM blob and stop, each handler once', async () => {
    media = installFakeMedia()
    const recorder = new MediaRecorder(await microphone(), { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32_000 })
    expect(media.recorders).toEqual([recorder])
    expect(recorder).toMatchObject({ state: 'inactive', mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32_000 })
    expect(media.recorders[0]!.options).toEqual({ mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32_000 })

    const events: string[] = []
    const blobs: Blob[] = []
    recorder.addEventListener('start', () => events.push('start'))
    recorder.ondataavailable = (event) => {
      expect(event).toBeInstanceOf(FakeBlobEvent)
      events.push('dataavailable')
      blobs.push(event.data)
    }
    recorder.onstop = () => events.push('stop')
    recorder.addEventListener('stop', () => events.push('stop listener'))

    recorder.start()
    expect(recorder.state).toBe('recording')
    await microtasks()
    expect(events).toEqual(['start'])
    recorder.stop()
    expect(recorder.state).toBe('inactive')
    await microtasks()
    expect(events).toEqual(['start', 'dataavailable', 'stop', 'stop listener'])

    expect(blobs).toHaveLength(1)
    expect(blobs[0]!.type).toBe('audio/webm;codecs=opus')
    const bytes = await bytesOf(blobs[0]!)
    expect(bytes.slice(0, WEBM_EBML_HEADER.length)).toEqual([...WEBM_EBML_HEADER])
    expect(new TextDecoder().decode(Uint8Array.from(bytes.slice(0, WEBM_EBML_HEADER.length)))).toContain('webm')
    expect(bytes.length).toBeGreaterThan(64)

    recorder.stop()
    await microtasks()
    expect(events).toHaveLength(4)
  })

  it('emits a chunk every timeslice; only the first one carries the container header', async () => {
    vi.useFakeTimers()
    media = installFakeMedia()
    const recorder = new MediaRecorder(await microphone())
    const chunks: Blob[] = []
    recorder.ondataavailable = event => chunks.push(event.data)
    recorder.start(1000)
    vi.advanceTimersByTime(3000)
    expect(chunks).toHaveLength(3)
    recorder.stop()
    await microtasks()
    expect(chunks).toHaveLength(4)
    expect((await bytesOf(chunks[0]!)).slice(0, 4)).toEqual(EBML_MAGIC)
    expect((await bytesOf(chunks[1]!)).slice(0, 4)).not.toEqual(EBML_MAGIC)

    const fake = media.recorders[0]!
    expect(fake.timeslice).toBe(1000)
    expect(fake.chunks).toEqual(chunks)
    expect(fake.blob.size).toBe(chunks.reduce((sum, chunk) => sum + chunk.size, 0))
    expect((await bytesOf(fake.blob)).slice(0, 4)).toEqual(EBML_MAGIC)
    vi.advanceTimersByTime(5000)
    expect(chunks).toHaveLength(4)
  })

  it('supports pause, resume and requestData and throws InvalidStateError where a browser does', async () => {
    media = installFakeMedia()
    const recorder = new MediaRecorder(await microphone())
    expect(thrown(() => recorder.pause())).toMatchObject({ name: 'InvalidStateError' })
    expect(thrown(() => recorder.resume())).toMatchObject({ name: 'InvalidStateError' })
    expect(thrown(() => recorder.requestData())).toMatchObject({ name: 'InvalidStateError' })

    const events: string[] = []
    for (const type of ['start', 'pause', 'resume', 'dataavailable', 'stop'])
      recorder.addEventListener(type, () => events.push(type))
    recorder.start()
    expect(thrown(() => recorder.start())).toMatchObject({ name: 'InvalidStateError' })
    recorder.pause()
    expect(recorder.state).toBe('paused')
    recorder.resume()
    expect(recorder.state).toBe('recording')
    recorder.requestData()
    await microtasks()
    recorder.stop()
    await microtasks()
    expect(events).toEqual(['start', 'pause', 'resume', 'dataavailable', 'dataavailable', 'stop'])
  })

  it('stops when the microphone goes away (end()) or is released by the app (stop())', async () => {
    media = installFakeMedia()
    const recorder = new MediaRecorder(await microphone())
    const events: string[] = []
    recorder.addEventListener('dataavailable', () => events.push('dataavailable'))
    recorder.addEventListener('stop', () => events.push('stop'))
    const track = media.streams[0]!.getTracks()[0]!
    const ended = vi.fn()
    track.onended = ended
    recorder.start()
    track.end()
    track.end()
    expect(ended).toHaveBeenCalledTimes(1)
    expect(recorder.state).toBe('inactive')
    await microtasks()
    expect(events).toEqual(['dataavailable', 'stop'])
    expect(media.streams[0]!.stopped).toBe(false)

    const released = new MediaRecorder(await microphone())
    const stops = vi.fn()
    released.onstop = stops
    released.start()
    for (const item of media.streams[1]!.getTracks())
      item.stop()
    await microtasks()
    expect(stops).toHaveBeenCalledTimes(1)
    expect(released.state).toBe('inactive')
    expect(media.streams[1]!.stopped).toBe(true)
    expect(thrown(() => released.start())).toMatchObject({ name: 'NotSupportedError' })
  })

  it('fail() fires an error event carrying the DOMException, then dataavailable and stop', async () => {
    media = installFakeMedia()
    const recorder = new MediaRecorder(await microphone())
    const events: string[] = []
    recorder.onerror = (event) => {
      expect(event.error).toMatchObject({ name: 'UnknownError', message: 'Device lost' })
      events.push('error')
    }
    recorder.addEventListener('dataavailable', () => events.push('dataavailable'))
    recorder.addEventListener('stop', () => events.push('stop'))
    recorder.start()
    media.recorders[0]!.fail(new DOMException('Device lost', 'UnknownError'))
    expect(recorder.state).toBe('inactive')
    await microtasks()
    expect(events).toEqual(['error', 'dataavailable', 'stop'])
  })

  it('records a MediaStream-like object a test injects', async () => {
    const recorder = new FakeMediaRecorder({ id: 'custom-stream' } as unknown as MediaStream, { mimeType: 'audio/webm' })
    const stops = vi.fn()
    recorder.onstop = stops
    recorder.start()
    recorder.stop()
    await microtasks()
    expect(stops).toHaveBeenCalledTimes(1)
    expect(recorder.chunks).toHaveLength(1)
    expect(recorder.blob.type).toBe('audio/webm')
  })

  it('calls only the latest on* handler and none after it is set to null', async () => {
    media = installFakeMedia()
    const recorder = new MediaRecorder(await microphone())
    const first = vi.fn()
    const second = vi.fn()
    recorder.onstart = first
    recorder.onstart = second
    recorder.start()
    await microtasks()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    recorder.onstop = second
    recorder.onstop = null
    expect(recorder.onstop).toBeNull()
    recorder.stop()
    await microtasks()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('fakeRecordingBytes', () => {
  it('starts with the container signature of the type, then the payload', () => {
    expect([...fakeRecordingBytes('audio/webm').slice(0, 4)]).toEqual(EBML_MAGIC)
    expect(new TextDecoder().decode(fakeRecordingBytes('audio/ogg;codecs=opus').slice(0, 4))).toBe('OggS')
    expect(new TextDecoder().decode(fakeRecordingBytes('audio/mp4').slice(4, 8))).toBe('ftyp')
    expect(fakeRecordingBytes('audio/webm', 10)).toHaveLength(WEBM_EBML_HEADER.length + 12 + 10)
    // The EBML header size is a one-byte vint (marker bit 0x80): it covers the 31 bytes after the id and the size.
    expect(WEBM_EBML_HEADER[4]! & 0x7F).toBe(WEBM_EBML_HEADER.length - 5)
  })
})

describe('fakeAudio', () => {
  it('stands in for new Audio(): play() resolves with play and playing; end() fires pause, then ended', async () => {
    uninstallAudio = installFakeAudio()
    const audio = new Audio()
    expect(audio).toBeInstanceOf(FakeAudio)
    expect(FakeAudio.last).toBe(audio)
    const events: string[] = []
    for (const type of ['play', 'playing', 'pause', 'ended'])
      audio.addEventListener(type, () => events.push(type))
    const onended = vi.fn()
    audio.onended = onended
    audio.src = 'blob:chunk-1'
    audio.playbackRate = 1.5
    await expect(audio.play()).resolves.toBeUndefined()
    expect(audio.paused).toBe(false)

    const fake = FakeAudio.last!
    fake.duration = 2.4
    fake.end()
    expect(events).toEqual(['play', 'playing', 'pause', 'ended'])
    expect(onended).toHaveBeenCalledTimes(1)
    expect(audio).toMatchObject({ ended: true, paused: true, currentTime: 2.4, playbackRate: 1.5 })
  })

  it('rejects play() without a source or with a play error; pause() fires once', async () => {
    const audio = new FakeAudio()
    await expect(audio.play()).rejects.toMatchObject({ name: 'NotSupportedError' })
    audio.src = 'blob:chunk-1'
    audio.playError = new DOMException('Autoplay is blocked.', 'NotAllowedError')
    await expect(audio.play()).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(audio.play()).resolves.toBeUndefined()
    FakeAudio.playError = new DOMException('Autoplay is blocked.', 'NotAllowedError')
    await expect(audio.play()).rejects.toMatchObject({ name: 'NotAllowedError' })
    FakeAudio.reset()
    const pauses = vi.fn()
    audio.onpause = pauses
    audio.pause()
    audio.pause()
    expect(pauses).toHaveBeenCalledTimes(1)
    expect(audio.playCalls).toBe(4)
  })

  it('records every source; a new source resets the element; fail() fires error', async () => {
    const audio = new FakeAudio('data:audio/wav;base64,UklGRg==')
    audio.src = 'blob:chunk-1'
    await audio.play()
    audio.currentTime = 3
    audio.removeAttribute('src')
    expect(audio.sources).toEqual(['data:audio/wav;base64,UklGRg==', 'blob:chunk-1', ''])
    expect(audio).toMatchObject({ paused: true, ended: false, currentTime: 0, src: '' })
    expect(audio.hasAttribute('src')).toBe(false)
    audio.setAttribute('src', 'blob:chunk-2')
    expect(audio.getAttribute('src')).toBe('blob:chunk-2')

    const errors = vi.fn()
    audio.addEventListener('error', errors)
    audio.fail()
    expect(errors).toHaveBeenCalledTimes(1)
    expect(audio.error).toEqual({ code: 4, message: 'The media could not be loaded.' })
    audio.load()
    expect(audio.error).toBeNull()
    expect(audio.canPlayType('audio/wav')).toBe('maybe')
    expect(audio.asElement()).toBe(audio)
  })

  it('installFakeAudio() replaces Audio and restores it', () => {
    const original = globalThis.Audio
    const uninstall = installFakeAudio()
    expect(globalThis.Audio).toBe(FakeAudio)
    const audio = new Audio('blob:chunk-1')
    expect(FakeAudio.instances).toEqual([audio])
    uninstall()
    uninstall()
    expect(globalThis.Audio).toBe(original)
    expect(FakeAudio.instances).toEqual([])
  })
})
