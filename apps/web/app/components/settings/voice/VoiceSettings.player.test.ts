// Test voice with the real app-wide player (W6.8's useSpeechPlayer) on a fake audio element: the request carries the
// chosen model and voice, the speed becomes the playback rate, the button follows the player, and a failure shows the
// player's single toast "Could not play the test voice".
import type { Settings } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { MockApi } from '~/utils/testing/mock-api'
import { DEFAULT_SETTINGS, HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { resetSpeechPlayer, useSpeechPlayer, VOICE_TEST_ID } from '~/composables/useSpeechPlayer'
import { useModelsStore } from '~/stores/models'
import { useProvidersStore } from '~/stores/providers'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import { FakeAudio, installFakeAudio } from '~/utils/testing/fake-media'
import { catalogModel, providerSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import { TEST_VOICE_TEXT } from './voice-settings'
import VoiceSettings from './VoiceSettings.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

interface SpeechCall {
  body: { text: string, modelRef?: string, voice?: string }
  signal: AbortSignal
  respond: () => void
  fail: (error: unknown) => void
}

const openai = providerSummary({ id: 'openai', name: 'OpenAI (ChatGPT)' })
const tts = catalogModel({ providerId: 'openai', id: 'gpt-4o-mini-tts', name: 'GPT-4o mini TTS', kind: 'speech', hidden: true, voices: ['alloy', 'ash'] })

let pinia: ReturnType<typeof createPinia>
let api: MockApi
let calls: SpeechCall[]
let uninstallAudio: () => void
let wrapper: VueWrapper | null = null

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  calls = []
  pinia = createPinia()
  setActivePinia(pinia)
  stubLocalStorage()
  vi.stubGlobal('isSecureContext', true)
  uninstallAudio = installFakeAudio()
  let objectUrls = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test/${++objectUrls}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  toasts.error.mockReset()
  // Every POST /audio/speech waits for the test; an aborted request rejects like fetch does.
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
  useProvidersStore().items = [openai]
  useProvidersStore().loaded = true
  useModelsStore().items = [tts]
  useModelsStore().loaded = true
  const settings: Settings = { ...DEFAULT_SETTINGS, speechModelRef: 'openai:gpt-4o-mini-tts', speechVoice: 'ash', speechSpeed: 1.5 }
  useSettingsStore().settings = settings
  useSettingsStore().loaded = true
})

afterEach(async () => {
  wrapper?.unmount()
  wrapper = null
  resetSpeechPlayer()
  uninstallAudio()
  await flushPromises()
  disposePinia(pinia)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

async function settle() {
  for (let round = 0; round < 4; round++)
    await flushPromises()
}

async function mountVoice() {
  const Host = defineComponent({ setup: () => () => h(TooltipProvider, null, { default: () => h(VoiceSettings) }) })
  wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
  await flushPromises()
}

function testButton(): HTMLButtonElement {
  return document.body.querySelector<HTMLButtonElement>(`[data-testid="${testIds.settingsSpeechTest}"]`)!
}

describe('voiceSettings: Test voice with the app-wide player', () => {
  it('reads the test sentence with the chosen model, voice and speed, and stops on a second click', async () => {
    await mountVoice()
    testButton().click()
    await settle()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body).toEqual({ text: TEST_VOICE_TEXT, modelRef: 'openai:gpt-4o-mini-tts', voice: 'ash' })
    expect(useSpeechPlayer().activeId.value).toBe(VOICE_TEST_ID)
    expect(testButton().dataset.state).toBe('loading')

    calls[0]!.respond()
    await settle()
    expect(testButton().dataset.state).toBe('playing')
    expect(testButton().textContent?.trim()).toBe('Stop')
    expect(FakeAudio.last!.playbackRate).toBe(1.5)

    testButton().click()
    await settle()
    expect(useSpeechPlayer().state.value).toBe('idle')
    expect(testButton().dataset.state).toBe('idle')
    expect(testButton().textContent?.trim()).toBe('Test voice')
    expect(toasts.error).not.toHaveBeenCalled()
  })

  it('returns to idle at the natural end', async () => {
    await mountVoice()
    testButton().click()
    await settle()
    calls[0]!.respond()
    await settle()
    FakeAudio.last!.end()
    await settle()
    expect(testButton().dataset.state).toBe('idle')
  })

  it('shows the player\'s one toast when the provider refuses the voice', async () => {
    await mountVoice()
    testButton().click()
    await settle()
    calls[0]!.fail(new HarnessError({ code: 'provider_error', message: 'Voice "ash" is not available.' }))
    await settle()
    expect(toasts.error).toHaveBeenCalledTimes(1)
    expect(toasts.error).toHaveBeenCalledWith('Could not play the test voice', { description: 'Voice "ash" is not available.' })
    expect(testButton().dataset.state).toBe('idle')
  })

  it('stops the test sentence when the page is left', async () => {
    await mountVoice()
    testButton().click()
    await settle()
    const request = calls[0]!
    wrapper!.unmount()
    wrapper = null
    await settle()
    expect(useSpeechPlayer().state.value).toBe('idle')
    expect(request.signal.aborted).toBe(true)
    expect(toasts.error).not.toHaveBeenCalled()
  })
})
