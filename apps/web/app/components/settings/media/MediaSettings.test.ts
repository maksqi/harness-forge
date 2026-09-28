import type { Settings } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { ComputedRef } from 'vue'
import type { MockApi } from '~/utils/testing/mock-api'
import { DEFAULT_SETTINGS, HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import MediaPage from '~/pages/settings/media.vue'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import { catalogModel, providerSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import ImageSettings from '../images/ImageSettings.vue'
import VoiceSettings from '../voice/VoiceSettings.vue'
import MediaSettings from './MediaSettings.vue'

const mocks = vi.hoisted(() => ({ useHead: vi.fn(), api: null as unknown }))
// SettingsPage sets the tab title through the settings nuxt-imports module ('#imports' does not resolve in Vitest).
vi.mock('~/components/settings/nuxt-imports', () => ({ useHead: mocks.useHead }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))

const openai = providerSummary({ id: 'openai', name: 'OpenAI (ChatGPT)' })
const models = [
  catalogModel({ providerId: 'openai', id: 'gpt-5', name: 'GPT-5' }),
  catalogModel({ providerId: 'openai', id: 'gpt-image-1', name: 'GPT Image 1', kind: 'image' }),
  catalogModel({ providerId: 'openai', id: 'gpt-4o-mini-transcribe', name: 'GPT-4o mini Transcribe', kind: 'transcription', hidden: true }),
  catalogModel({ providerId: 'openai', id: 'gpt-4o-mini-tts', name: 'GPT-4o mini TTS', kind: 'speech', hidden: true, voices: ['alloy'] }),
]
const saved: Settings = {
  ...DEFAULT_SETTINGS,
  imageModelRef: 'openai:gpt-image-1',
  transcriptionModelRef: 'openai:gpt-4o-mini-transcribe',
  transcriptionLanguage: 'fr',
  speechModelRef: 'openai:gpt-4o-mini-tts',
  speechVoice: 'alloy',
  speechSpeed: 1.25,
}

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper | null = null

beforeEach(() => {
  mocks.useHead.mockReset()
  api = createMockApi()
  mocks.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  stubLocalStorage()
  vi.stubGlobal('isSecureContext', true)
  api.providers.list.mockResolvedValue({ items: [openai] })
  api.models.list.mockResolvedValue({ items: models })
  api.settings.get.mockResolvedValue(saved)
})

afterEach(async () => {
  wrapper?.unmount()
  wrapper = null
  await flushPromises()
  disposePinia(pinia)
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

async function mountWithProviders(component: typeof MediaSettings | typeof MediaPage) {
  const Host = defineComponent({ setup: () => () => h(TooltipProvider, null, { default: () => h(component) }) })
  wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
  await flushPromises()
  return wrapper
}

function byTestId(id: string): HTMLElement {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
}

describe('mediaSettings', () => {
  it('renders its root test id with the Images section, then the Voice section', async () => {
    const host = await mountWithProviders(MediaSettings)
    const root = host.get(`[data-testid="${testIds.mediaSettings}"]`)
    const sections = root.findAll('[data-slot="settings-section"]').map(section => section.attributes('data-testid'))
    expect(sections).toEqual([testIds.imageSettings, testIds.voiceSettings])
    expect(host.findComponent(ImageSettings).exists()).toBe(true)
    expect(host.findComponent(VoiceSettings).exists()).toBe(true)
  })

  it('loads the providers, the whole catalog and the settings, and shows the saved choices', async () => {
    await mountWithProviders(MediaSettings)
    expect(api.providers.list).toHaveBeenCalled()
    expect(api.models.list).toHaveBeenCalledWith({ query: { includeHidden: true } })
    expect(api.settings.get).toHaveBeenCalled()
    expect(byTestId(testIds.settingsImageModel).dataset.value).toBe('openai:gpt-image-1')
    expect(byTestId(testIds.settingsTranscriptionModel).dataset.value).toBe('openai:gpt-4o-mini-transcribe')
    expect(byTestId(testIds.settingsTranscriptionLanguage).dataset.value).toBe('fr')
    expect(byTestId(testIds.settingsSpeechModel).dataset.value).toBe('openai:gpt-4o-mini-tts')
    expect((byTestId(testIds.settingsSpeechVoice) as HTMLInputElement).value).toBe('alloy')
    expect(byTestId(testIds.settingsSpeechSpeed).dataset.value).toBe('1.25')
    expect(byTestId(testIds.settingsSpeechTest).hasAttribute('disabled')).toBe(false)
  })

  it('does not fetch the settings again when they are loaded', async () => {
    useSettingsStore().settings = { ...saved }
    useSettingsStore().loaded = true
    await mountWithProviders(MediaSettings)
    expect(api.settings.get).not.toHaveBeenCalled()
    expect(api.models.list).toHaveBeenCalled()
  })

  it('says so when loading fails, and retries', async () => {
    api.models.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'The database is locked.' }))
    const host = await mountWithProviders(MediaSettings)
    const alert = host.get('[data-slot="settings-load-error"]')
    expect(alert.text()).toContain('Could not load the media settings')
    expect(alert.text()).toContain('The database is locked.')
    // The sections still render under the alert.
    expect(host.find(`[data-testid="${testIds.imageSettings}"]`).exists()).toBe(true)

    await alert.get('button').trigger('click')
    await flushPromises()
    expect(host.find('[data-slot="settings-load-error"]').exists()).toBe(false)
    expect(api.models.list).toHaveBeenCalledTimes(2)
  })
})

describe('settings media page', () => {
  it('renders MediaSettings in the settings page frame titled "Images and voice"', async () => {
    const host = await mountWithProviders(MediaPage)
    const header = host.get(`[data-testid="${testIds.pageHeader}"]`)
    expect(header.get('h1').text()).toBe('Images and voice')
    expect(header.text()).toContain('Models for generated images, dictation and reading replies aloud.')
    expect(host.find(`[data-testid="${testIds.mediaSettings}"]`).exists()).toBe(true)
    expect(host.find(`[data-testid="${testIds.imageSettings}"]`).exists()).toBe(true)
    expect(host.find(`[data-testid="${testIds.voiceSettings}"]`).exists()).toBe(true)
    const head = mocks.useHead.mock.calls[0]?.[0] as { title: ComputedRef<string> } | undefined
    expect(head?.title.value).toBe('Images and voice · harness-forge')
  })
})
