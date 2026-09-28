import { DEFAULT_SETTINGS } from '@harness-forge/shared'
import { mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import { createMockApi } from '~/utils/testing/mock-api'
import ReadAloudButton from './ReadAloudButton.vue'

vi.mock('~/composables/useApi', () => ({ useApi: () => createMockApi() }))

const MESSAGE_ID = 'msg_assistant0000001'

let pinia: ReturnType<typeof createPinia>

function mountButton() {
  return mount(ReadAloudButton, {
    props: { messageId: MESSAGE_ID, markdown: 'The **answer** is 42.' },
    attachTo: document.body,
    global: { plugins: [pinia] },
  })
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
})

describe('readAloudButton', () => {
  it('renders nothing while no speech model is set', () => {
    useSettingsStore().settings = { ...DEFAULT_SETTINGS, speechModelRef: null }
    const wrapper = mountButton()
    expect(wrapper.find(`[data-testid="${testIds.messageReadAloud}"]`).exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders its root, idle, once a speech model is set', async () => {
    const settings = useSettingsStore()
    settings.settings = { ...DEFAULT_SETTINGS, speechModelRef: null }
    const wrapper = mountButton()
    settings.settings = { ...DEFAULT_SETTINGS, speechModelRef: 'mock:speech' }
    await wrapper.vm.$nextTick()
    const root = wrapper.get(`[data-testid="${testIds.messageReadAloud}"]`)
    expect(root.element).toBe(wrapper.element)
    expect(root.attributes()).toMatchObject({ 'data-state': 'idle', 'aria-label': 'Read aloud', 'aria-pressed': 'false' })
    expect(wrapper.props()).toEqual({ messageId: MESSAGE_ID, markdown: 'The **answer** is 42.' })
    wrapper.unmount()
  })
})
