// The app-wide read-aloud player (docs/UI.md 7.18, 11.3): chunked requests, one reused audio element unlocked inside
// the click, prefetching, playback speed, object URL hygiene, every stop trigger and the failure toasts.
import type { MockApi } from '~/utils/testing/mock-api'
import { DEFAULT_SETTINGS, HarnessError, LIMITS } from '@harness-forge/shared'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isReadonly } from 'vue'
import { useSettingsStore } from '~/stores/settings'
import { useUiStore } from '~/stores/ui'
import { FakeAudio, installFakeAudio } from '~/utils/testing/fake-media'
import { createMockApi } from '~/utils/testing/mock-api'
import { useShortcuts } from './useShortcuts'
import { READ_ALOUD_STOP_SHORTCUT, resetSpeechPlayer, useSpeechPlayer, VOICE_TEST_ID } from './useSpeechPlayer'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

const toasts = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: toasts }))

interface SpeechCall {
  body: { text: string, modelRef?: string, voice?: string }
  signal: AbortSignal
  /** Answers with the audio bytes (a WAV blob). */
  respond: () => void
  fail: (error: unknown) => void
}

let api: MockApi
let calls: SpeechCall[]
let created: string[]
let revoked: string[]
let uninstallAudio: () => void

/** Every POST /audio/speech waits for the test; an aborted request rejects like fetch does. */
function controlSpeech() {
  api.audio.speech.mockImplementation(({ body, signal }: { body: SpeechCall['body'], signal: AbortSignal }) =>
    new Promise<Response>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
      calls.push({
        body,
        signal,
        respond: () => resolve(new Response(new Blob(['RIFF....WAVE'], { type: 'audio/wav' }))),
        fail: reject,
      })
    }))
}

async function settle() {
  for (let round = 0; round < 4; round++)
    await flushPromises()
}

function audio(): FakeAudio {
  return FakeAudio.last!
}

/** A reply that makes two chunks: a first sentence under 300 characters, then a second one. */
const FIRST = `The first sentence ${'a'.repeat(200)}.`
const SECOND = `The second sentence ${'b'.repeat(200)}.`
const TWO_CHUNKS = `${FIRST} ${SECOND}`

function setSettings(patch: Partial<typeof DEFAULT_SETTINGS> = {}) {
  useSettingsStore().settings = { ...DEFAULT_SETTINGS, speechModelRef: 'mock:speech', ...patch }
}

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  calls = []
  created = []
  revoked = []
  setActivePinia(createPinia())
  setSettings()
  uninstallAudio = installFakeAudio()
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:test/${created.length + 1}`
    created.push(url)
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    revoked.push(url)
  })
  toasts.error.mockReset()
  controlSpeech()
})

afterEach(() => {
  resetSpeechPlayer()
  uninstallAudio()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('useSpeechPlayer: the singleton', () => {
  it('returns one app-wide player: the same object and refs on every call', () => {
    const first = useSpeechPlayer()
    const second = useSpeechPlayer()
    expect(second).toBe(first)
    expect(second.state).toBe(first.state)
    expect(second.activeId).toBe(first.activeId)
  })

  it('starts idle with nothing active, behind read-only refs, with play, stop and toggle', () => {
    const player = useSpeechPlayer()
    expect(Object.keys(player).sort()).toEqual(['activeId', 'play', 'state', 'stop', 'toggle'])
    expect(player.state.value).toBe('idle')
    expect(player.activeId.value).toBeNull()
    expect(isReadonly(player.state)).toBe(true)
    expect(isReadonly(player.activeId)).toBe(true)
  })
})

describe('useSpeechPlayer: reading', () => {
  it('unlocks the element inside the click, reads chunk by chunk at the speech speed, prefetches, then ends idle', async () => {
    setSettings({ speechSpeed: 1.5 })
    const player = useSpeechPlayer()
    const done = player.play('msg_1', TWO_CHUNKS)

    // Synchronously, still inside the click: the silent clip plays on the one element.
    expect(FakeAudio.instances).toHaveLength(1)
    expect(audio().playCalls).toBe(1)
    expect(audio().sources).toEqual(['blob:test/1'])
    expect(player.state.value).toBe('loading')
    expect(player.activeId.value).toBe('msg_1')

    await settle()
    expect(calls.map(call => call.body)).toEqual([{ text: FIRST }])
    calls[0]!.respond()
    await settle()
    expect(audio().src).toBe('blob:test/2')
    expect(audio().playbackRate).toBe(1.5)
    expect(audio().defaultPlaybackRate).toBe(1.5)
    expect(player.state.value).toBe('playing')
    // The next chunk is fetched while the first one plays.
    expect(calls.map(call => call.body)).toEqual([{ text: FIRST }, { text: SECOND }])

    // The first chunk ends before the second arrived: loading until it does; the used URL is revoked.
    audio().end()
    await settle()
    expect(player.state.value).toBe('loading')
    expect(revoked).toContain('blob:test/2')
    calls[1]!.respond()
    await settle()
    expect(audio().src).toBe('blob:test/3')
    expect(player.state.value).toBe('playing')

    audio().end()
    await settle()
    expect(player.state.value).toBe('idle')
    expect(player.activeId.value).toBeNull()
    expect(revoked).toContain('blob:test/3')
    await expect(done).resolves.toBeUndefined()
    expect(calls).toHaveLength(2)
    expect(toasts.error).not.toHaveBeenCalled()
  })

  it('plays a prefetched chunk right away and splits a long reply at the chunk limits', async () => {
    const sentence = `${'word '.repeat(19)}end.`
    const reply = `${sentence} `.repeat(40).trim()
    const player = useSpeechPlayer()
    void player.play('msg_1', reply)
    await settle()
    calls[0]!.respond()
    await settle()
    calls[1]!.respond()
    await settle()
    audio().end()
    await settle()
    // The second chunk was already there: no loading gap.
    expect(player.state.value).toBe('playing')
    expect(audio().src).toBe('blob:test/3')
    const texts = calls.map(call => call.body.text)
    expect(texts[0]!.length).toBeLessThanOrEqual(LIMITS.speechFirstChunkChars)
    expect(texts[1]!.length).toBeLessThanOrEqual(LIMITS.speechChunkChars)
    expect(texts[1]!.length).toBeGreaterThan(LIMITS.speechFirstChunkChars)
  })

  it('ignores the end of the silent unlock clip', async () => {
    const player = useSpeechPlayer()
    void player.play('msg_1', 'Hello there.')
    audio().end()
    await settle()
    expect(player.state.value).toBe('loading')
    calls[0]!.respond()
    await settle()
    expect(player.state.value).toBe('playing')
  })

  it('sends the model and voice of Test voice, and only the text for replies', async () => {
    const player = useSpeechPlayer()
    void player.play(VOICE_TEST_ID, 'This is how replies sound when they are read aloud.', { modelRef: 'openai:gpt-4o-mini-tts', voice: 'alloy' })
    await settle()
    expect(calls[0]!.body).toEqual({ text: 'This is how replies sound when they are read aloud.', modelRef: 'openai:gpt-4o-mini-tts', voice: 'alloy' })
    void player.play('msg_1', '**Hi** [there](https://example.com)')
    await settle()
    expect(calls[1]!.body).toEqual({ text: 'Hi there.' })
  })

  it('reads nothing for a reply without words', async () => {
    const player = useSpeechPlayer()
    await expect(player.play('msg_1', '<br>\n---')).resolves.toBeUndefined()
    expect(player.state.value).toBe('idle')
    expect(player.activeId.value).toBeNull()
    expect(api.audio.speech).not.toHaveBeenCalled()
  })

  it('reuses one element for every reading', async () => {
    const player = useSpeechPlayer()
    void player.play('msg_1', 'One.')
    void player.play('msg_2', 'Two.')
    void player.play('msg_3', 'Three.')
    await settle()
    expect(FakeAudio.instances).toHaveLength(1)
    expect(created.filter(url => url === 'blob:test/1')).toHaveLength(1)
  })
})

describe('useSpeechPlayer: stopping', () => {
  it('stop() while loading aborts the request, and a late answer plays nothing', async () => {
    const player = useSpeechPlayer()
    const done = player.play('msg_1', 'Hello there.')
    await settle()
    player.stop()
    expect(calls[0]!.signal.aborted).toBe(true)
    expect(player.state.value).toBe('idle')
    expect(player.activeId.value).toBeNull()
    await expect(done).resolves.toBeUndefined()
    await settle()
    expect(audio().src).toBe('')
    expect(toasts.error).not.toHaveBeenCalled()
  })

  it('drops an answer that arrives after stop() although the request ignored the abort', async () => {
    let answer: (response: Response) => void = () => {}
    api.audio.speech.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      answer = resolve
    }))
    const player = useSpeechPlayer()
    void player.play('msg_1', 'Hello there.')
    await settle()
    player.stop()
    answer(new Response(new Blob(['RIFF'], { type: 'audio/wav' })))
    await settle()
    expect(created).toEqual(['blob:test/1'])
    expect(audio().src).toBe('')
    expect(player.state.value).toBe('idle')
    expect(toasts.error).not.toHaveBeenCalled()
  })

  it('stop() while playing pauses, drops the source, revokes the URLs and aborts the prefetch', async () => {
    const player = useSpeechPlayer()
    void player.play('msg_1', TWO_CHUNKS)
    await settle()
    calls[0]!.respond()
    await settle()
    expect(player.state.value).toBe('playing')
    player.stop()
    expect(audio().paused).toBe(true)
    expect(audio().src).toBe('')
    expect(calls[1]!.signal.aborted).toBe(true)
    expect(revoked).toContain('blob:test/2')
    expect(player.state.value).toBe('idle')
    await settle()
    expect(toasts.error).not.toHaveBeenCalled()
  })

  it('a second reply stops the first', async () => {
    const player = useSpeechPlayer()
    const first = player.play('msg_1', 'First reply.')
    await settle()
    calls[0]!.respond()
    await settle()
    expect(player.activeId.value).toBe('msg_1')

    const second = player.play('msg_2', 'Second reply.')
    await expect(first).resolves.toBeUndefined()
    expect(player.activeId.value).toBe('msg_2')
    expect(player.state.value).toBe('loading')
    await settle()
    expect(calls[1]!.body.text).toBe('Second reply.')
    calls[1]!.respond()
    await settle()
    expect(player.state.value).toBe('playing')
    audio().end()
    await settle()
    expect(player.state.value).toBe('idle')
    await expect(second).resolves.toBeUndefined()
    expect(toasts.error).not.toHaveBeenCalled()
  })

  it('toggle() stops the active reply and plays any other', async () => {
    const player = useSpeechPlayer()
    void player.toggle('msg_1', 'Hi.')
    expect(player.activeId.value).toBe('msg_1')
    await expect(player.toggle('msg_1', 'Hi.')).resolves.toBeUndefined()
    expect(player.state.value).toBe('idle')
    void player.toggle('msg_1', 'Hi.')
    void player.toggle('msg_2', 'Bye.')
    expect(player.activeId.value).toBe('msg_2')
  })

  it('stops on a chat switch', async () => {
    const ui = useUiStore()
    ui.setActiveChat('0199a8f0-0000-7000-8000-00000000000a')
    const player = useSpeechPlayer()
    void player.play('msg_1', 'Hello.')
    ui.setActiveChat('0199a8f0-0000-7000-8000-00000000000b')
    expect(player.state.value).toBe('idle')
    // Only a change stops: a new reading in the same chat goes on.
    void player.play('msg_1', 'Hello.')
    await settle()
    expect(player.state.value).toBe('loading')
    ui.setActiveChat(null)
    expect(player.state.value).toBe('idle')
  })

  it('stops when the page is hidden or left', async () => {
    const player = useSpeechPlayer()
    void player.play('msg_1', 'Hello.')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try {
      document.dispatchEvent(new Event('visibilitychange'))
    }
    finally {
      delete (document as { visibilityState?: unknown }).visibilityState
    }
    expect(player.state.value).toBe('idle')

    void player.play('msg_1', 'Hello.')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(player.state.value).toBe('loading')
    window.dispatchEvent(new Event('pagehide'))
    expect(player.state.value).toBe('idle')
  })

  it('stops on Esc outside inputs and overlays; the shortcut exists only while something plays', async () => {
    const shortcuts = useShortcuts()
    const registered = () => shortcuts.list().some(def => def.id === READ_ALOUD_STOP_SHORTCUT)
    const press = (target: HTMLElement) => {
      const listener = (event: KeyboardEvent) => shortcuts.handleKeydown(event)
      target.addEventListener('keydown', listener)
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      target.removeEventListener('keydown', listener)
    }
    const player = useSpeechPlayer()
    expect(registered()).toBe(false)
    void player.play('msg_1', 'Hello.')
    expect(registered()).toBe(true)

    const textarea = document.createElement('textarea')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const dialogButton = document.createElement('button')
    dialog.append(dialogButton)
    const button = document.createElement('button')
    document.body.append(textarea, dialog, button)

    press(textarea)
    expect(player.state.value).toBe('loading')
    dialogButton.focus()
    press(dialogButton)
    expect(player.state.value).toBe('loading')
    button.focus()
    press(button)
    expect(player.state.value).toBe('idle')
    expect(registered()).toBe(false)
  })

  it('a pause from the system (media keys) ends the reading', async () => {
    const player = useSpeechPlayer()
    void player.play('msg_1', 'Hello there.')
    await settle()
    calls[0]!.respond()
    await settle()
    audio().pause()
    expect(player.state.value).toBe('idle')
    expect(toasts.error).not.toHaveBeenCalled()
  })
})

describe('useSpeechPlayer: failures', () => {
  it('shows the server message and returns to idle', async () => {
    api.audio.speech.mockRejectedValue(new HarnessError({ code: 'provider_not_configured', message: 'No API key for OpenAI.' }))
    const player = useSpeechPlayer()
    const done = player.play('msg_1', 'Hello.')
    await settle()
    expect(toasts.error).toHaveBeenCalledWith('Could not read this reply aloud', { description: 'No API key for OpenAI.' })
    expect(player.state.value).toBe('idle')
    expect(player.activeId.value).toBeNull()
    await expect(done).resolves.toBeUndefined()
  })

  it('names Test voice in its toast', async () => {
    api.audio.speech.mockRejectedValue(new HarnessError({ code: 'validation_error', message: 'Choose a speech model.' }))
    const player = useSpeechPlayer()
    await player.play(VOICE_TEST_ID, 'This is how replies sound.')
    expect(toasts.error).toHaveBeenCalledWith('Could not play the test voice', { description: 'Choose a speech model.' })
  })

  it('reports a later chunk that fails, after the first one played', async () => {
    const player = useSpeechPlayer()
    void player.play('msg_1', TWO_CHUNKS)
    await settle()
    calls[0]!.respond()
    await settle()
    calls[1]!.fail(new HarnessError({ code: 'rate_limited', message: 'Slow down.' }))
    await settle()
    // Still playing the first chunk: the failure shows when its turn comes.
    expect(player.state.value).toBe('playing')
    audio().end()
    await settle()
    expect(toasts.error).toHaveBeenCalledWith('Could not read this reply aloud', { description: 'Slow down.' })
    expect(player.state.value).toBe('idle')
    expect(revoked).toEqual(expect.arrayContaining(['blob:test/2']))
  })

  it('reports audio the browser cannot play', async () => {
    const player = useSpeechPlayer()
    void player.play('msg_1', 'Hello there.')
    await settle()
    calls[0]!.respond()
    await settle()
    audio().fail()
    await settle()
    expect(toasts.error).toHaveBeenCalledWith('Could not read this reply aloud', { description: 'The browser could not play the audio.' })
    expect(player.state.value).toBe('idle')
  })

  it('reports playback the browser refused', async () => {
    const player = useSpeechPlayer()
    void player.play('msg_1', 'Hello there.')
    audio().playError = new DOMException('play() is not allowed.', 'NotAllowedError')
    await settle()
    calls[0]!.respond()
    await settle()
    expect(toasts.error).toHaveBeenCalledWith('Could not read this reply aloud', { description: 'The browser blocked audio playback.' })
    expect(player.state.value).toBe('idle')
  })
})
