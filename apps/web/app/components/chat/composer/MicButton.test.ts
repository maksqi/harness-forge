import type { VoiceInputState } from '~/composables/useVoiceInput'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { bodyAll, byTestId, NuxtLinkStub } from './composer-test-utils'
import MicButton from './MicButton.vue'

vi.mock('~/composables/useApi', () => ({ useApi: () => ({}) }))

interface Props {
  state: VoiceInputState
  configured: boolean
  secure: boolean
  level?: number
  disabled?: boolean
}

function mountMic(initial: Props) {
  const props = reactive<Props>({ ...initial })
  const wrapper = mount(defineComponent({
    render: () => h(TooltipProvider, null, { default: () => h(MicButton, { ...props }) }),
  }), { attachTo: document.body, global: { stubs: { NuxtLink: NuxtLinkStub } } })
  const component = () => wrapper.findComponent(MicButton)
  return { wrapper, props, component }
}

function mic(wrapper: ReturnType<typeof mountMic>['wrapper']) {
  return wrapper.get(byTestId(testIds.composerMic))
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('micButton', () => {
  it('renders the voice input state, the label, aria-pressed and the Alt+V hint', () => {
    const cases: Array<[VoiceInputState, string]> = [
      ['idle', 'Dictate'],
      ['requesting', 'Dictate'],
      ['recording', 'Stop and transcribe'],
      ['transcribing', 'Cancel transcription'],
    ]
    for (const [state, label] of cases) {
      const { wrapper } = mountMic({ state, configured: true, secure: true })
      const root = mic(wrapper)
      expect(root.element.tagName).toBe('BUTTON')
      expect(root.attributes()).toMatchObject({
        'data-state': state,
        'aria-label': label,
        'aria-keyshortcuts': 'Alt+V',
        'aria-pressed': state === 'recording' ? 'true' : 'false',
      })
      expect(root.attributes('aria-disabled')).toBeUndefined()
      wrapper.unmount()
    }
  })

  it('shows a spinner while asking and transcribing, "Transcribing…" from sm, and a level ring while recording', async () => {
    const { wrapper, props } = mountMic({ state: 'requesting', configured: true, secure: true })
    expect(mic(wrapper).find('.animate-spin').exists()).toBe(true)
    props.state = 'transcribing'
    await nextTick()
    expect(mic(wrapper).find('.animate-spin').exists()).toBe(true)
    expect(mic(wrapper).text()).toContain('Transcribing…')
    props.state = 'recording'
    props.level = 0.5
    await nextTick()
    const ring = mic(wrapper).get('[data-slot="mic-level"]')
    expect(ring.attributes('style')).toContain('--mic-level-scale: 1.225')
    expect(ring.classes()).toContain('motion-reduce:scale-100')
    expect(mic(wrapper).classes()).toContain('bg-destructive/10')
    props.level = 7
    await nextTick()
    expect(mic(wrapper).get('[data-slot="mic-level"]').attributes('style')).toContain('--mic-level-scale: 1.45')
    props.state = 'idle'
    await nextTick()
    expect(mic(wrapper).find('[data-slot="mic-level"]').exists()).toBe(false)
    expect(mic(wrapper).text()).not.toContain('Transcribing')
    wrapper.unmount()
  })

  it('shows setup without a speech-to-text model and insecure (aria-disabled) on an insecure origin', () => {
    const setup = mountMic({ state: 'idle', configured: false, secure: true })
    expect(mic(setup.wrapper).attributes()).toMatchObject({ 'data-state': 'setup', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' })
    expect(mic(setup.wrapper).attributes('aria-disabled')).toBeUndefined()
    setup.wrapper.unmount()
    const insecure = mountMic({ state: 'recording', configured: false, secure: false })
    expect(mic(insecure.wrapper).attributes('data-state')).toBe('insecure')
    expect(mic(insecure.wrapper).attributes('aria-disabled')).toBe('true')
    expect(mic(insecure.wrapper).attributes('aria-pressed')).toBe('false')
    insecure.wrapper.unmount()
  })

  it('emits toggle when idle, recording or transcribing, never while requesting, in setup, insecure or disabled', async () => {
    const emitting: Props[] = [
      { state: 'idle', configured: true, secure: true },
      { state: 'recording', configured: true, secure: true, level: 0.6 },
      { state: 'transcribing', configured: true, secure: true },
    ]
    for (const props of emitting) {
      const { wrapper, component } = mountMic(props)
      await mic(wrapper).trigger('click')
      expect(component().emitted('toggle')).toEqual([[]])
      wrapper.unmount()
    }
    const silent: Props[] = [
      { state: 'requesting', configured: true, secure: true },
      { state: 'idle', configured: false, secure: true },
      { state: 'idle', configured: true, secure: false },
      { state: 'idle', configured: true, secure: true, disabled: true },
    ]
    for (const props of silent) {
      const { wrapper, component } = mountMic(props)
      await mic(wrapper).trigger('click')
      expect(component().emitted('toggle')).toBeUndefined()
      wrapper.unmount()
    }
  })

  it('opens the setup popover with the settings link; a second click closes it', async () => {
    const { wrapper } = mountMic({ state: 'idle', configured: false, secure: true })
    await mic(wrapper).trigger('click')
    await flushPromises()
    const popover = bodyAll(byTestId(testIds.composerMicSetup))
    expect(popover).toHaveLength(1)
    expect(popover[0]!.textContent).toContain('Choose a speech-to-text model to dictate messages.')
    const link = bodyAll(byTestId(testIds.composerMicSetupLink))[0]!
    expect(link.getAttribute('href')).toBe('/settings/media')
    expect(link.textContent?.trim()).toBe('Open settings')
    expect(mic(wrapper).attributes('aria-expanded')).toBe('true')

    await mic(wrapper).trigger('click')
    await flushPromises()
    expect(bodyAll(byTestId(testIds.composerMicSetup))).toHaveLength(0)
    wrapper.unmount()
  })

  it('closes the setup popover when the link is followed or a model gets configured', async () => {
    const { wrapper, props } = mountMic({ state: 'idle', configured: false, secure: true })
    await mic(wrapper).trigger('click')
    await flushPromises()
    bodyAll(byTestId(testIds.composerMicSetupLink))[0]!.click()
    await flushPromises()
    expect(bodyAll(byTestId(testIds.composerMicSetup))).toHaveLength(0)

    await mic(wrapper).trigger('click')
    await flushPromises()
    expect(bodyAll(byTestId(testIds.composerMicSetup))).toHaveLength(1)
    props.configured = true
    await flushPromises()
    expect(bodyAll(byTestId(testIds.composerMicSetup))).toHaveLength(0)
    expect(mic(wrapper).attributes('data-state')).toBe('idle')
    wrapper.unmount()
  })

  it('exposes activate(), which does what a click does (Alt+V)', async () => {
    const { wrapper, component, props } = mountMic({ state: 'idle', configured: true, secure: true })
    const exposed = component().vm as unknown as { activate: () => void }
    exposed.activate()
    expect(component().emitted('toggle')).toEqual([[]])
    props.configured = false
    await nextTick()
    exposed.activate()
    await flushPromises()
    expect(bodyAll(byTestId(testIds.composerMicSetup))).toHaveLength(1)
    expect(component().emitted('toggle')).toEqual([[]])
    wrapper.unmount()
  })

  it('defaults level to 0 and disabled to false', () => {
    const { wrapper, component } = mountMic({ state: 'idle', configured: true, secure: true })
    expect(component().props()).toMatchObject({ level: 0, disabled: false })
    wrapper.unmount()
  })
})
