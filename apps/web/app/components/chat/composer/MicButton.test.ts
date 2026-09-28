import type { VoiceInputState } from '~/composables/useVoiceInput'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import MicButton from './MicButton.vue'

interface Props {
  state: VoiceInputState
  configured: boolean
  secure: boolean
  level?: number
  disabled?: boolean
}

function mountMic(props: Props) {
  return mount(MicButton, { props, attachTo: document.body })
}

function mic(wrapper: ReturnType<typeof mountMic>) {
  return wrapper.get(`[data-testid="${testIds.composerMic}"]`)
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('micButton', () => {
  it('renders its root with the voice input state, the label and the Alt+V hint', () => {
    const cases: Array<[VoiceInputState, string]> = [
      ['idle', 'Dictate'],
      ['requesting', 'Dictate'],
      ['recording', 'Stop and transcribe'],
      ['transcribing', 'Cancel transcription'],
    ]
    for (const [state, label] of cases) {
      const wrapper = mountMic({ state, configured: true, secure: true })
      const root = mic(wrapper)
      expect(root.element).toBe(wrapper.element)
      expect(root.attributes()).toMatchObject({
        'data-state': state,
        'aria-label': label,
        'aria-keyshortcuts': 'Alt+V',
        'aria-pressed': state === 'recording' ? 'true' : 'false',
      })
      wrapper.unmount()
    }
  })

  it('shows setup without a speech-to-text model and insecure (aria-disabled) on an insecure origin', () => {
    const setup = mountMic({ state: 'idle', configured: false, secure: true })
    expect(mic(setup).attributes('data-state')).toBe('setup')
    expect(mic(setup).attributes('aria-disabled')).toBeUndefined()
    setup.unmount()
    const insecure = mountMic({ state: 'idle', configured: false, secure: false })
    expect(mic(insecure).attributes('data-state')).toBe('insecure')
    expect(mic(insecure).attributes('aria-disabled')).toBe('true')
    insecure.unmount()
  })

  it('emits toggle when idle, recording or transcribing, never while requesting, in setup, insecure or disabled', async () => {
    const emitting: Props[] = [
      { state: 'idle', configured: true, secure: true },
      { state: 'recording', configured: true, secure: true, level: 0.6 },
      { state: 'transcribing', configured: true, secure: true },
    ]
    for (const props of emitting) {
      const wrapper = mountMic(props)
      await mic(wrapper).trigger('click')
      expect(wrapper.emitted('toggle')).toEqual([[]])
      wrapper.unmount()
    }
    const silent: Props[] = [
      { state: 'requesting', configured: true, secure: true },
      { state: 'idle', configured: false, secure: true },
      { state: 'idle', configured: true, secure: false },
      { state: 'idle', configured: true, secure: true, disabled: true },
    ]
    for (const props of silent) {
      const wrapper = mountMic(props)
      await mic(wrapper).trigger('click')
      expect(wrapper.emitted('toggle')).toBeUndefined()
      wrapper.unmount()
    }
  })

  it('defaults level to 0 and disabled to false', () => {
    const wrapper = mountMic({ state: 'idle', configured: true, secure: true })
    expect(wrapper.props()).toMatchObject({ level: 0, disabled: false })
    wrapper.unmount()
  })
})
