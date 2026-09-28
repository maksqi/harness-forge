import type { Settings } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { Ref } from 'vue'
import type { SpeechPlayerState } from '~/composables/useSpeechPlayer'
import type { MockApi } from '~/utils/testing/mock-api'
import { DEFAULT_SETTINGS, HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useModelsStore } from '~/stores/models'
import { useProvidersStore } from '~/stores/providers'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import { catalogModel, providerSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import { TEST_VOICE_TEXT } from './voice-settings'
import VoiceSettings from './VoiceSettings.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

// The app-wide read-aloud player (W6.8) replaced by a controllable fake with the frozen signature
// (VoiceSettings.player.test.ts runs the real player on a fake audio element).
const speech = vi.hoisted(() => ({
  state: null as unknown as Ref<SpeechPlayerState>,
  activeId: null as unknown as Ref<string | null>,
  play: vi.fn(),
  stop: vi.fn(),
  toggle: vi.fn(),
}))
vi.mock('~/composables/useSpeechPlayer', async () => {
  const { ref } = await import('vue')
  speech.state = ref<SpeechPlayerState>('idle')
  speech.activeId = ref<string | null>(null)
  return {
    VOICE_TEST_ID: 'voice-test',
    useSpeechPlayer: () => ({
      state: speech.state,
      activeId: speech.activeId,
      play: speech.play,
      stop: speech.stop,
      toggle: speech.toggle,
    }),
  }
})

const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'sage']

const openai = providerSummary({ id: 'openai', name: 'OpenAI (ChatGPT)' })
const groq = providerSummary({ id: 'groq', name: 'Groq' })
const transcribe = catalogModel({ providerId: 'openai', id: 'gpt-4o-mini-transcribe', name: 'GPT-4o mini Transcribe', kind: 'transcription', hidden: true })
const whisper = catalogModel({ providerId: 'groq', id: 'whisper-large-v3-turbo', name: 'Whisper large v3 turbo', kind: 'transcription', hidden: true })
const tts = catalogModel({ providerId: 'openai', id: 'gpt-4o-mini-tts', name: 'GPT-4o mini TTS', kind: 'speech', hidden: true, voices: VOICES })
const tts1 = catalogModel({ providerId: 'openai', id: 'tts-1', name: 'TTS 1', kind: 'speech', hidden: true })
const chat = catalogModel({ providerId: 'openai', id: 'gpt-5', name: 'GPT-5' })

let pinia: ReturnType<typeof createPinia>
let api: MockApi
let wrapper: VueWrapper | null = null
let saved: Settings

function seedSettings(patch: Partial<Settings> = {}) {
  saved = { ...DEFAULT_SETTINGS, ...patch }
  useSettingsStore().settings = { ...saved }
  useSettingsStore().loaded = true
}

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  stubLocalStorage()
  vi.stubGlobal('isSecureContext', true)
  toasts.error.mockReset()
  speech.state.value = 'idle'
  speech.activeId.value = null
  speech.play.mockReset()
  speech.stop.mockReset()
  speech.toggle.mockReset()
  speech.toggle.mockResolvedValue(undefined)
  api.settings.update.mockImplementation(async ({ body }: { body: Partial<Settings> }) => {
    saved = { ...saved, ...body }
    return saved
  })
  useProvidersStore().items = [groq, openai]
  useProvidersStore().loaded = true
  useModelsStore().items = [chat, transcribe, whisper, tts, tts1]
  useModelsStore().loaded = true
  seedSettings()
})

afterEach(async () => {
  wrapper?.unmount()
  wrapper = null
  await flushPromises()
  disposePinia(pinia)
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

async function mountVoice() {
  const Host = defineComponent({ setup: () => () => h(TooltipProvider, null, { default: () => h(VoiceSettings) }) })
  wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
  await flushPromises()
  return wrapper
}

async function settle(rounds = 3) {
  for (let round = 0; round < rounds; round++) {
    await flushPromises()
    await nextTick()
  }
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.body.querySelector<T>(`[data-testid="${id}"]`)!
}

function press(target: Element, key: string) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

/** Picks `modelRef` ('' = Off) in a SettingsModelSelect. */
async function chooseModel(testId: string, modelRef: string) {
  byTestId(testId).click()
  await flushPromises()
  const option = document.body.querySelector<HTMLElement>(`[data-testid="${testIds.modelSelectOption}"][data-model-ref="${modelRef}"]`)
  expect(option, `option ${modelRef}`).not.toBeNull()
  option!.click()
  await flushPromises()
}

/** Opens a reka Select with the keyboard and picks the item with `value`. */
async function chooseItem(testId: string, value: string) {
  press(byTestId(testId), 'Enter')
  await settle()
  const item = document.body.querySelector<HTMLElement>(`[data-slot="select-item"][data-value="${value}"]`)
  expect(item, `item ${value}`).not.toBeNull()
  press(item!, 'Enter')
  await settle(5)
}

function voiceInput(): HTMLInputElement {
  return byTestId<HTMLInputElement>(testIds.settingsSpeechVoice)
}

async function type(input: HTMLInputElement, text: string) {
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}

function suggestions(): string[] {
  return [...document.body.querySelectorAll<HTMLElement>('[data-slot="voice-suggestions"] [role="option"]')].map(option => option.dataset.value ?? '')
}

describe('voiceSettings', () => {
  it('renders the Voice section with the privacy notice and every control off', async () => {
    const host = await mountVoice()
    const root = host.get(`[data-testid="${testIds.voiceSettings}"]`)
    expect(root.element.tagName).toBe('SECTION')
    expect(root.get('h2').text()).toBe('Voice')
    expect(root.text()).toContain('Audio and text go to the provider you choose; harness-forge doesn\'t store them.')
    for (const label of ['Speech to text', 'Language', 'Read aloud', 'Voice', 'Speed'])
      expect(root.findAll('label').map(item => item.text())).toContain(label)

    expect(byTestId(testIds.settingsTranscriptionModel).dataset.value).toBe('')
    expect(byTestId(testIds.settingsTranscriptionModel).textContent).toContain('Off')
    expect(byTestId(testIds.settingsSpeechModel).dataset.value).toBe('')
    expect(byTestId(testIds.settingsSpeechModel).textContent).toContain('Off')

    const language = byTestId(testIds.settingsTranscriptionLanguage)
    expect(language.dataset.value).toBe('auto')
    expect(language.textContent).toContain('Detect automatically')
    expect(language.hasAttribute('disabled')).toBe(true)

    expect(voiceInput().placeholder).toBe('Provider default')
    expect(voiceInput().value).toBe('')
    expect(voiceInput().disabled).toBe(true)

    const speed = byTestId(testIds.settingsSpeechSpeed)
    expect(speed.dataset.value).toBe('1')
    expect(speed.textContent).toContain('1×')
    expect(speed.hasAttribute('disabled')).toBe(true)

    const test = byTestId<HTMLButtonElement>(testIds.settingsSpeechTest)
    expect(test.textContent?.trim()).toBe('Test voice')
    expect(test.dataset.state).toBe('idle')
    expect(test.disabled).toBe(true)
    expect(document.body.querySelector('[data-slot="voice-insecure-note"]')).toBeNull()

    // Every visible label names its control.
    const labelFor = (text: string) => root.findAll('label').find(item => item.text() === text)!.attributes('for')
    expect(labelFor('Speech to text')).toBe(byTestId(testIds.settingsTranscriptionModel).id)
    expect(labelFor('Language')).toBe(language.id)
    expect(labelFor('Read aloud')).toBe(byTestId(testIds.settingsSpeechModel).id)
    expect(labelFor('Voice')).toBe(voiceInput().id)
    expect(labelFor('Speed')).toBe(speed.id)
  })

  it('saves the speech-to-text model, listing hidden transcription models, and enables the language', async () => {
    await mountVoice()
    byTestId(testIds.settingsTranscriptionModel).click()
    await flushPromises()
    const refs = [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.modelSelectOption}"]`)].map(option => option.dataset.modelRef)
    expect(refs).toEqual(['', 'groq:whisper-large-v3-turbo', 'openai:gpt-4o-mini-transcribe'])
    document.body.querySelector<HTMLElement>(`[data-testid="${testIds.modelSelectOption}"][data-model-ref="groq:whisper-large-v3-turbo"]`)!.click()
    await flushPromises()

    expect(api.settings.update).toHaveBeenCalledWith({ body: { transcriptionModelRef: 'groq:whisper-large-v3-turbo' } })
    expect(byTestId(testIds.settingsTranscriptionModel).dataset.value).toBe('groq:whisper-large-v3-turbo')
    expect(byTestId(testIds.settingsTranscriptionLanguage).hasAttribute('disabled')).toBe(false)

    await chooseModel(testIds.settingsTranscriptionModel, '')
    expect(api.settings.update).toHaveBeenLastCalledWith({ body: { transcriptionModelRef: null } })
    expect(byTestId(testIds.settingsTranscriptionLanguage).hasAttribute('disabled')).toBe(true)
  })

  it('saves the dictation language', async () => {
    seedSettings({ transcriptionModelRef: 'groq:whisper-large-v3-turbo' })
    await mountVoice()
    press(byTestId(testIds.settingsTranscriptionLanguage), 'Enter')
    await settle()
    const items = [...document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')]
    expect(items).toHaveLength(23)
    expect(items[0]!.textContent?.trim()).toBe('Detect automatically')
    expect(items.find(item => item.dataset.value === 'de')!.textContent).toContain('German')
    press(items.find(item => item.dataset.value === 'de')!, 'Enter')
    await settle(5)

    expect(api.settings.update).toHaveBeenCalledWith({ body: { transcriptionLanguage: 'de' } })
    const language = byTestId(testIds.settingsTranscriptionLanguage)
    expect(language.dataset.value).toBe('de')
    expect(language.textContent).toContain('German')

    await chooseItem(testIds.settingsTranscriptionLanguage, 'auto')
    expect(api.settings.update).toHaveBeenLastCalledWith({ body: { transcriptionLanguage: 'auto' } })
  })

  it('shows a language set through the API by its code', async () => {
    seedSettings({ transcriptionModelRef: 'groq:whisper-large-v3-turbo', transcriptionLanguage: 'yue' })
    await mountVoice()
    const language = byTestId(testIds.settingsTranscriptionLanguage)
    expect(language.dataset.value).toBe('yue')
    expect(language.textContent).toContain('yue')
  })

  it('saves the read-aloud model and clears the voice with it', async () => {
    seedSettings({ speechModelRef: 'openai:tts-1', speechVoice: 'nova' })
    await mountVoice()
    expect(voiceInput().value).toBe('nova')
    expect(voiceInput().disabled).toBe(false)

    await chooseModel(testIds.settingsSpeechModel, 'openai:gpt-4o-mini-tts')
    expect(api.settings.update).toHaveBeenCalledWith({ body: { speechModelRef: 'openai:gpt-4o-mini-tts', speechVoice: null } })
    expect(byTestId(testIds.settingsSpeechModel).dataset.value).toBe('openai:gpt-4o-mini-tts')
    expect(useSettingsStore().resolved.speechVoice).toBeNull()
    expect(voiceInput().value).toBe('')

    await chooseModel(testIds.settingsSpeechModel, '')
    expect(api.settings.update).toHaveBeenLastCalledWith({ body: { speechModelRef: null, speechVoice: null } })
    expect(voiceInput().disabled).toBe(true)
    expect(byTestId(testIds.settingsSpeechSpeed).hasAttribute('disabled')).toBe(true)
    expect(byTestId<HTMLButtonElement>(testIds.settingsSpeechTest).disabled).toBe(true)
  })

  it('saves a typed voice on blur and on Enter, and an empty field as the provider default', async () => {
    seedSettings({ speechModelRef: 'openai:tts-1' })
    await mountVoice()
    const input = voiceInput()

    input.focus()
    await type(input, '  nova ')
    input.blur()
    await flushPromises()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { speechVoice: 'nova' } })
    expect(input.value).toBe('nova')

    input.focus()
    await type(input, 'onyx')
    press(input, 'Enter')
    await flushPromises()
    expect(api.settings.update).toHaveBeenLastCalledWith({ body: { speechVoice: 'onyx' } })
    expect(document.activeElement).not.toBe(input)

    input.focus()
    await type(input, '')
    input.blur()
    await flushPromises()
    expect(api.settings.update).toHaveBeenLastCalledWith({ body: { speechVoice: null } })

    // Unchanged: no request.
    const calls = api.settings.update.mock.calls.length
    input.focus()
    input.blur()
    await flushPromises()
    expect(api.settings.update).toHaveBeenCalledTimes(calls)
  })

  it('refuses an invalid voice inline and restores the saved one on Escape', async () => {
    seedSettings({ speechModelRef: 'openai:tts-1', speechVoice: 'nova' })
    const host = await mountVoice()
    const input = voiceInput()

    input.focus()
    await type(input, 'nova!')
    input.blur()
    await flushPromises()
    expect(host.text()).toContain('Voices use letters, digits, spaces and "_", ".", ":", "-".')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(api.settings.update).not.toHaveBeenCalled()

    input.focus()
    await type(input, 'shimmer')
    press(input, 'Escape')
    await flushPromises()
    expect(input.value).toBe('nova')
    expect(input.hasAttribute('aria-invalid')).toBe(false)
    expect(host.text()).not.toContain('Voices use letters')
    expect(api.settings.update).not.toHaveBeenCalled()
  })

  it('suggests the voices of the read-aloud model, filtered by the typed text', async () => {
    seedSettings({ speechModelRef: 'openai:gpt-4o-mini-tts' })
    await mountVoice()
    const input = voiceInput()
    expect(input.getAttribute('role')).toBe('combobox')
    expect(input.getAttribute('aria-expanded')).toBe('false')

    input.focus()
    await settle()
    expect(suggestions()).toEqual(VOICES)
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(input.getAttribute('aria-controls')).toBe(document.body.querySelector('[data-slot="voice-suggestions"]')!.id)
    // Focus stays in the input while the suggestions show.
    expect(document.activeElement).toBe(input)

    await type(input, 'al')
    await settle()
    expect(suggestions()).toEqual(['alloy', 'ballad', 'coral'])

    await type(input, 'onyx')
    await settle()
    expect(suggestions()).toEqual([])
    expect(input.getAttribute('aria-expanded')).toBe('false')
  })

  it('picks a suggestion with the arrow keys and Enter', async () => {
    seedSettings({ speechModelRef: 'openai:gpt-4o-mini-tts' })
    await mountVoice()
    const input = voiceInput()
    input.focus()
    await settle()

    press(input, 'ArrowDown')
    press(input, 'ArrowDown')
    await settle()
    const active = input.getAttribute('aria-activedescendant')
    expect(active).toBeTruthy()
    const highlighted = document.getElementById(active!)!
    expect(highlighted.dataset.value).toBe('ash')
    expect(highlighted.getAttribute('aria-selected')).toBe('true')

    press(input, 'ArrowUp')
    press(input, 'ArrowUp')
    await settle()
    expect(document.getElementById(input.getAttribute('aria-activedescendant')!)!.dataset.value).toBe('sage')

    press(input, 'Enter')
    await settle()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { speechVoice: 'sage' } })
    expect(input.value).toBe('sage')
    expect(suggestions()).toEqual([])
  })

  it('saves a clicked suggestion and closes the list with Escape before restoring', async () => {
    seedSettings({ speechModelRef: 'openai:gpt-4o-mini-tts', speechVoice: 'alloy' })
    await mountVoice()
    const input = voiceInput()
    input.focus()
    await settle()
    const option = document.body.querySelector<HTMLElement>('[data-slot="voice-suggestions"] [data-value="coral"]')!
    option.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    option.click()
    await settle()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { speechVoice: 'coral' } })
    expect(input.value).toBe('coral')
    expect(suggestions()).toEqual([])

    await type(input, 'b')
    await settle()
    expect(suggestions()).toEqual(['ballad'])
    press(input, 'Escape')
    await settle()
    // The first Escape only closes the suggestions; the typed text stays.
    expect(suggestions()).toEqual([])
    expect(input.value).toBe('b')
    press(input, 'Escape')
    await settle()
    expect(input.value).toBe('coral')
  })

  it('offers no suggestions for a model without known voices', async () => {
    seedSettings({ speechModelRef: 'openai:tts-1' })
    await mountVoice()
    const input = voiceInput()
    expect(input.hasAttribute('role')).toBe(false)
    input.focus()
    await settle()
    expect(document.body.querySelector('[data-slot="voice-suggestions"]')).toBeNull()
  })

  it('saves the playback speed', async () => {
    seedSettings({ speechModelRef: 'openai:tts-1' })
    await mountVoice()
    press(byTestId(testIds.settingsSpeechSpeed), 'Enter')
    await settle()
    const items = [...document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')]
    expect(items.map(item => item.textContent?.trim())).toEqual(['0.75×', '1×', '1.25×', '1.5×', '1.75×', '2×'])
    press(items.find(item => item.dataset.value === '1.5')!, 'Enter')
    await settle(5)
    expect(api.settings.update).toHaveBeenCalledWith({ body: { speechSpeed: 1.5 } })
    expect(byTestId(testIds.settingsSpeechSpeed).dataset.value).toBe('1.5')
    expect(byTestId(testIds.settingsSpeechSpeed).textContent).toContain('1.5×')
  })

  it('tests the voice through the app-wide player with the chosen model and voice', async () => {
    seedSettings({ speechModelRef: 'openai:gpt-4o-mini-tts', speechVoice: 'ash' })
    await mountVoice()
    const test = byTestId<HTMLButtonElement>(testIds.settingsSpeechTest)
    expect(test.disabled).toBe(false)
    test.click()
    await flushPromises()
    expect(speech.toggle).toHaveBeenCalledWith('voice-test', TEST_VOICE_TEXT, { modelRef: 'openai:gpt-4o-mini-tts', voice: 'ash' })

    speech.activeId.value = 'voice-test'
    speech.state.value = 'loading'
    await flushPromises()
    expect(test.dataset.state).toBe('loading')
    expect(test.getAttribute('aria-busy')).toBe('true')

    speech.state.value = 'playing'
    await flushPromises()
    expect(test.dataset.state).toBe('playing')
    expect(test.textContent?.trim()).toBe('Stop')
    expect(test.getAttribute('aria-pressed')).toBe('true')

    // Another reply being read leaves Test voice idle.
    speech.activeId.value = 'msg_0000000000000001'
    await flushPromises()
    expect(test.dataset.state).toBe('idle')
    expect(test.textContent?.trim()).toBe('Test voice')
    expect(test.getAttribute('aria-pressed')).toBe('false')
  })

  it('leaves the voice out when it is the provider default', async () => {
    seedSettings({ speechModelRef: 'openai:tts-1' })
    await mountVoice()
    byTestId<HTMLButtonElement>(testIds.settingsSpeechTest).click()
    await flushPromises()
    expect(speech.toggle).toHaveBeenCalledWith('voice-test', TEST_VOICE_TEXT, { modelRef: 'openai:tts-1' })
  })

  it('stops the test voice when read aloud is turned off or the page is left', async () => {
    seedSettings({ speechModelRef: 'openai:tts-1' })
    const host = await mountVoice()
    speech.activeId.value = 'voice-test'
    speech.state.value = 'playing'
    await chooseModel(testIds.settingsSpeechModel, '')
    expect(speech.stop).toHaveBeenCalledTimes(1)

    host.unmount()
    wrapper = null
    expect(speech.stop).toHaveBeenCalledTimes(2)
  })

  it('does not stop another reply when the page is left', async () => {
    seedSettings({ speechModelRef: 'openai:tts-1' })
    const host = await mountVoice()
    speech.activeId.value = 'msg_0000000000000001'
    speech.state.value = 'playing'
    host.unmount()
    wrapper = null
    expect(speech.stop).not.toHaveBeenCalled()
  })

  it('warns on an insecure origin that the microphone needs HTTPS or localhost', async () => {
    vi.stubGlobal('isSecureContext', false)
    await mountVoice()
    const note = document.body.querySelector<HTMLElement>('[data-slot="voice-insecure-note"]')!
    expect(note.textContent?.trim()).toBe('Voice input needs HTTPS or localhost')
    expect(byTestId(testIds.settingsTranscriptionModel).getAttribute('aria-describedby')).toBe(note.id)
    // The setting still saves.
    await chooseModel(testIds.settingsTranscriptionModel, 'openai:gpt-4o-mini-transcribe')
    expect(api.settings.update).toHaveBeenCalledWith({ body: { transcriptionModelRef: 'openai:gpt-4o-mini-transcribe' } })
  })

  it('toasts a failed save and shows the saved value again', async () => {
    seedSettings({ speechModelRef: 'openai:tts-1' })
    api.settings.update.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    await mountVoice()
    const input = voiceInput()
    input.focus()
    await type(input, 'nova')
    input.blur()
    await flushPromises()
    expect(toasts.error).toHaveBeenCalledWith('Something went wrong', { description: 'Disk full.' })
    expect(useSettingsStore().resolved.speechVoice).toBeNull()
    expect(input.value).toBe('')
  })
})
