// Read aloud button (docs/UI.md 7.18, 10.4): hidden without a speech model, the idle / loading / playing states of
// its own message on the one app-wide player, the toggle and the labels.
import type { MockApi } from '~/utils/testing/mock-api'
import { DEFAULT_SETTINGS } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h, nextTick } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { resetSpeechPlayer, useSpeechPlayer } from '~/composables/useSpeechPlayer'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import { FakeAudio, installFakeAudio } from '~/utils/testing/fake-media'
import { createMockApi } from '~/utils/testing/mock-api'
import ReadAloudButton from './ReadAloudButton.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))
vi.mock('vue-sonner', () => ({ toast: { error: vi.fn() } }))

const MESSAGE_ID = 'msg_assistant0000001'
const OTHER_ID = 'msg_assistant0000002'

let pinia: ReturnType<typeof createPinia>
let api: MockApi
let answers: Array<() => void>
let uninstallAudio: () => void

function mountButton(props: Record<string, unknown> = {}) {
  return mount({
    render: () => h(TooltipProvider, null, {
      default: () => h(ReadAloudButton, { messageId: MESSAGE_ID, markdown: 'The **answer** is 42.', ...props }),
    }),
  }, { attachTo: document.body, global: { plugins: [pinia] } })
}

function button(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`[data-testid="${testIds.messageReadAloud}"]`)
}

async function settle() {
  for (let round = 0; round < 4; round++)
    await flushPromises()
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  api = createMockApi()
  mock.api = api
  answers = []
  api.audio.speech.mockImplementation(() => new Promise<Response>((resolve) => {
    answers.push(() => resolve(new Response(new Blob(['RIFF'], { type: 'audio/wav' }))))
  }))
  uninstallAudio = installFakeAudio()
  let next = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test/${++next}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

afterEach(() => {
  resetSpeechPlayer()
  uninstallAudio()
  vi.restoreAllMocks()
  disposePinia(pinia)
  document.body.replaceChildren()
})

describe('readAloudButton', () => {
  it('renders nothing while no speech model is set', () => {
    useSettingsStore().settings = { ...DEFAULT_SETTINGS, speechModelRef: null }
    const wrapper = mountButton()
    expect(button()).toBeNull()
    wrapper.unmount()
  })

  it('renders its root, idle, once a speech model is set, and forwards attributes to the button', async () => {
    const settings = useSettingsStore()
    settings.settings = { ...DEFAULT_SETTINGS, speechModelRef: null }
    const wrapper = mountButton({ class: 'extra-class' })
    settings.settings = { ...DEFAULT_SETTINGS, speechModelRef: 'mock:speech' }
    await nextTick()
    const root = button()!
    expect(root.tagName).toBe('BUTTON')
    expect(root.dataset.state).toBe('idle')
    expect(root.getAttribute('aria-label')).toBe('Read aloud')
    expect(root.getAttribute('aria-pressed')).toBe('false')
    expect(root.classList.contains('extra-class')).toBe(true)
    wrapper.unmount()
  })

  it('reads its reply on click: loading, playing, then a click stops it', async () => {
    useSettingsStore().settings = { ...DEFAULT_SETTINGS, speechModelRef: 'mock:speech' }
    const wrapper = mountButton()
    button()!.click()
    await nextTick()
    // The audio element was unlocked inside the click.
    expect(FakeAudio.last?.playCalls).toBe(1)
    expect(button()!.dataset.state).toBe('loading')
    expect(button()!.getAttribute('aria-pressed')).toBe('true')
    expect(button()!.getAttribute('aria-busy')).toBe('true')
    expect(button()!.getAttribute('aria-label')).toBe('Stop reading')
    expect(button()!.querySelector('.animate-spin')).not.toBeNull()

    await settle()
    expect(api.audio.speech).toHaveBeenCalledWith(expect.objectContaining({ body: { text: 'The answer is 42.' } }))
    answers[0]!()
    await settle()
    expect(button()!.dataset.state).toBe('playing')
    expect(button()!.getAttribute('aria-busy')).toBeNull()
    expect(button()!.getAttribute('aria-label')).toBe('Stop reading')
    expect(button()!.querySelector('.animate-spin')).toBeNull()

    button()!.click()
    await nextTick()
    expect(button()!.dataset.state).toBe('idle')
    expect(button()!.getAttribute('aria-pressed')).toBe('false')
    expect(button()!.getAttribute('aria-label')).toBe('Read aloud')
    expect(useSpeechPlayer().state.value).toBe('idle')
    wrapper.unmount()
  })

  it('stays idle while another reply is read, and takes over on click', async () => {
    useSettingsStore().settings = { ...DEFAULT_SETTINGS, speechModelRef: 'mock:speech' }
    const wrapper = mountButton()
    const player = useSpeechPlayer()
    void player.play(OTHER_ID, 'Another reply.')
    await nextTick()
    expect(button()!.dataset.state).toBe('idle')
    button()!.click()
    await nextTick()
    expect(player.activeId.value).toBe(MESSAGE_ID)
    expect(button()!.dataset.state).toBe('loading')
    wrapper.unmount()
  })
})
