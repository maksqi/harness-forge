import type { FakeMedia } from '~/utils/testing/fake-media'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, isReadonly } from 'vue'
import { FakeMediaRecorder, installFakeMedia } from '~/utils/testing/fake-media'
import { browserVoiceInputEnv, isVoiceInputSupported, useVoiceInput } from './useVoiceInput'

let media: FakeMedia | null = null

afterEach(() => {
  media?.()
  media = null
})

describe('useVoiceInput', () => {
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
