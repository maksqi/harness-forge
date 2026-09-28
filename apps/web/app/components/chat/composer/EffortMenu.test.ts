import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { createMockApi } from '~/utils/testing/mock-api'
import { bodyAll, byTestId, haiku, seedStores, sonnet } from './composer-test-utils'
import EffortMenu from './EffortMenu.vue'

vi.mock('~/composables/useApi', () => ({ useApi: () => createMockApi() }))

let pinia: ReturnType<typeof createPinia>

function mountMenu(props: { modelValue: 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max', modelRef: string | null, open?: boolean }) {
  const wrapper = mount({
    render: () => h(TooltipProvider, null, { default: () => h(EffortMenu, props) }),
  }, { attachTo: document.body, global: { plugins: [pinia] } })
  return { wrapper, menu: () => wrapper.findComponent(EffortMenu) }
}

describe('effortMenu', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    seedStores()
  })

  afterEach(() => {
    disposePinia(pinia)
    document.body.replaceChildren()
  })

  it('is hidden for models without effort control', () => {
    const { wrapper } = mountMenu({ modelValue: 'high', modelRef: haiku.ref })
    expect(wrapper.find(byTestId(testIds.effortMenuTrigger)).exists()).toBe(false)
    wrapper.unmount()
  })

  it('is hidden without a model', () => {
    const { wrapper } = mountMenu({ modelValue: 'auto', modelRef: null })
    expect(wrapper.find(byTestId(testIds.effortMenuTrigger)).exists()).toBe(false)
    wrapper.unmount()
  })

  it('offers Auto and the model\'s efforts in order and emits the pick', async () => {
    const { wrapper, menu } = mountMenu({ modelValue: 'auto', modelRef: sonnet.ref, open: true })
    await flushPromises()
    const trigger = wrapper.get(byTestId(testIds.effortMenuTrigger))
    expect(trigger.attributes('aria-label')).toBe('Reasoning effort: Auto')
    const options = bodyAll(byTestId(testIds.effortOption))
    expect(options.map(option => option.dataset.value)).toEqual(['auto', 'low', 'medium', 'high'])
    expect(options[0]!.textContent).toContain('Provider default')
    expect(options[0]!.getAttribute('data-state')).toBe('checked')
    options[3]!.click()
    await flushPromises()
    expect(menu().emitted('update:modelValue')).toEqual([['high']])
    wrapper.unmount()
  })

  it('shows an effort the model does not offer as Auto', () => {
    const { wrapper } = mountMenu({ modelValue: 'max', modelRef: sonnet.ref })
    const trigger = wrapper.get(byTestId(testIds.effortMenuTrigger))
    expect(trigger.attributes('data-value')).toBe('auto')
    expect(trigger.text()).toContain('Auto')
    wrapper.unmount()
  })
})
