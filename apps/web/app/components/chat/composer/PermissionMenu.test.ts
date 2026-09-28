import type { ToolMode } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { h, nextTick } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { bodyAll, byTestId } from './composer-test-utils'
import PermissionMenu from './PermissionMenu.vue'

// The shared test helpers import the stores, which import useApi ('#imports' does not resolve in Vitest).
vi.mock('~/composables/useApi', () => ({ useApi: () => ({}) }))

function mountMenu(modelValue: ToolMode) {
  const wrapper = mount({
    render: () => h(TooltipProvider, null, { default: () => h(PermissionMenu, { modelValue }) }),
  }, { attachTo: document.body })
  return { wrapper, menu: () => wrapper.findComponent(PermissionMenu) }
}

describe('permissionMenu', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('shows the mode on the trigger; Auto in ember', () => {
    const ask = mountMenu('ask')
    const askTrigger = ask.wrapper.get(byTestId(testIds.permissionMenuTrigger))
    expect(askTrigger.attributes('data-value')).toBe('ask')
    expect(askTrigger.attributes('aria-label')).toBe('Permission mode: Ask')
    expect(askTrigger.classes()).not.toContain('text-primary')
    ask.wrapper.unmount()

    const auto = mountMenu('auto')
    const autoTrigger = auto.wrapper.get(byTestId(testIds.permissionMenuTrigger))
    expect(autoTrigger.text()).toContain('Auto')
    expect(autoTrigger.classes()).toContain('text-primary')
    auto.wrapper.unmount()
  })

  it('offers Ask, Auto and Off with descriptions and emits the pick', async () => {
    const { wrapper, menu } = mountMenu('ask')
    await wrapper.get(byTestId(testIds.permissionMenuTrigger)).trigger('keydown', { key: 'Enter' })
    await nextTick()
    const options = bodyAll(byTestId(testIds.permissionOption))
    expect(options.map(option => option.dataset.value)).toEqual(['ask', 'auto', 'off'])
    expect(options[0]!.textContent).toContain('Ask before tools that can change things')
    expect(options[1]!.textContent).toContain('Run tools without asking, except ones marked always-ask')
    expect(options[2]!.textContent).toContain('Don\'t use tools')
    options[2]!.click()
    await flushPromises()
    expect(menu().emitted('update:modelValue')).toEqual([['off']])
    wrapper.unmount()
  })
})
