import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h, nextTick, reactive } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import ThemeToggle from './ThemeToggle.vue'

const colorMode = vi.hoisted(() => ({ state: null as null | { preference: string, value: string } }))

vi.mock('./nuxt-imports', () => ({
  useColorMode: () => colorMode.state,
}))

function mountToggle(collapsed = false) {
  return mount({
    render: () => h(TooltipProvider, null, { default: () => h(ThemeToggle, { collapsed }) }),
  }, { attachTo: document.body })
}

describe('themeToggle', () => {
  beforeEach(() => {
    colorMode.state = reactive({ preference: 'dark', value: 'dark' })
  })

  afterEach(() => {
    document.body.replaceChildren()
  })

  it('shows the three choices with the current preference on', () => {
    const wrapper = mountToggle()
    const group = wrapper.get(`[data-testid="${testIds.themeToggle}"]`)
    expect(group.attributes('aria-label')).toBe('Theme')
    expect(wrapper.get(`[data-testid="${testIds.themeDark}"]`).attributes('data-state')).toBe('on')
    expect(wrapper.get(`[data-testid="${testIds.themeLight}"]`).attributes('data-state')).toBe('off')
    expect(wrapper.get(`[data-testid="${testIds.themeSystem}"]`).attributes('aria-label')).toBe('System')
    wrapper.unmount()
  })

  it('sets useColorMode().preference when a choice is clicked', async () => {
    const wrapper = mountToggle()
    await wrapper.get(`[data-testid="${testIds.themeLight}"]`).trigger('click')
    expect(colorMode.state!.preference).toBe('light')
    await nextTick()
    expect(wrapper.get(`[data-testid="${testIds.themeLight}"]`).attributes('data-state')).toBe('on')

    await wrapper.get(`[data-testid="${testIds.themeSystem}"]`).trigger('click')
    expect(colorMode.state!.preference).toBe('system')
    wrapper.unmount()
  })

  it('keeps the active choice when it is clicked again', async () => {
    const wrapper = mountToggle()
    await wrapper.get(`[data-testid="${testIds.themeDark}"]`).trigger('click')
    await nextTick()
    expect(colorMode.state!.preference).toBe('dark')
    expect(wrapper.get(`[data-testid="${testIds.themeDark}"]`).attributes('data-state')).toBe('on')
    wrapper.unmount()
  })

  it('treats an unknown stored preference as dark', () => {
    colorMode.state = reactive({ preference: 'sepia', value: 'sepia' })
    const wrapper = mountToggle()
    expect(wrapper.get(`[data-testid="${testIds.themeDark}"]`).attributes('data-state')).toBe('on')
    wrapper.unmount()
  })

  it('collapsed: one labelled button that opens a menu of choices', async () => {
    colorMode.state = reactive({ preference: 'light', value: 'light' })
    const wrapper = mountToggle(true)
    const trigger = wrapper.get(`[data-testid="${testIds.themeToggle}"]`)
    expect(trigger.element.tagName).toBe('BUTTON')
    expect(trigger.attributes('aria-label')).toBe('Theme: Light')
    // A 40px target on touch devices, like the other icon-rail buttons (UI.md 14.5).
    expect(trigger.classes()).toEqual(expect.arrayContaining(['size-8', 'pointer-coarse:size-10']))
    expect(wrapper.find(`[data-testid="${testIds.themeDark}"]`).exists()).toBe(false)

    await trigger.trigger('keydown', { key: 'Enter' })
    await nextTick()
    const system = document.body.querySelector<HTMLElement>(`[data-testid="${testIds.themeSystem}"]`)
    expect(system).not.toBeNull()
    expect(document.body.querySelector(`[data-testid="${testIds.themeLight}"]`)?.getAttribute('data-state')).toBe('on')
    system!.click()
    await nextTick()
    expect(colorMode.state!.preference).toBe('system')
    wrapper.unmount()
  })
})
