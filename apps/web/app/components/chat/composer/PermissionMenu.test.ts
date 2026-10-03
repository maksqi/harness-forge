import type { ToolMode } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h, nextTick } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import { settings } from '~/utils/testing/fixtures'
import { bodyAll, byTestId } from './composer-test-utils'
import PermissionMenu from './PermissionMenu.vue'

// The shared test helpers import the stores, which import useApi ('#imports' does not resolve in Vitest).
vi.mock('~/composables/useApi', () => ({ useApi: () => ({}) }))

function mountMenu(modelValue: ToolMode, modes?: readonly ToolMode[]) {
  const wrapper = mount({
    render: () => h(TooltipProvider, null, { default: () => h(PermissionMenu, { modelValue, ...(modes ? { modes } : {}) }) }),
  }, { attachTo: document.body })
  return { wrapper, menu: () => wrapper.findComponent(PermissionMenu) }
}

async function openMenu(wrapper: ReturnType<typeof mountMenu>['wrapper']) {
  await wrapper.get(byTestId(testIds.permissionMenuTrigger)).trigger('keydown', { key: 'Enter' })
  await nextTick()
  return bodyAll(byTestId(testIds.permissionOption))
}

describe('permissionMenu', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

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

  it('offers every mode by default, in menu order, with descriptions, and emits the pick', async () => {
    const { wrapper, menu } = mountMenu('ask')
    const options = await openMenu(wrapper)
    expect(options.map(option => option.dataset.value)).toEqual(['ask', 'edits', 'plan', 'auto', 'off'])
    expect(options[0]!.textContent).toContain('Ask before tools that can change things')
    expect(options[1]!.textContent).toContain('Accept edits')
    expect(options[1]!.textContent).toContain('Edit project files without asking; ask before shell commands')
    expect(options[2]!.textContent).toContain('Explore and plan; change nothing until you approve the plan')
    expect(options[3]!.textContent).toContain('Run tools without asking, except ones marked always-ask')
    expect(options[4]!.textContent).toContain('Don\'t use tools')
    options[4]!.click()
    await flushPromises()
    expect(menu().emitted('update:modelValue')).toEqual([['off']])
    wrapper.unmount()
  })

  it('offers only the given modes, in menu order whatever the order of `modes`', async () => {
    const { wrapper, menu } = mountMenu('ask', ['off', 'auto', 'ask'])
    const options = await openMenu(wrapper)
    expect(options.map(option => option.dataset.value)).toEqual(['ask', 'auto', 'off'])
    options[1]!.click()
    await flushPromises()
    expect(menu().emitted('update:modelValue')).toEqual([['auto']])
    wrapper.unmount()

    const project = mountMenu('ask', ['ask', 'edits', 'auto', 'off'])
    const projectOptions = await openMenu(project.wrapper)
    expect(projectOptions.map(option => option.dataset.value)).toEqual(['ask', 'edits', 'auto', 'off'])
    projectOptions[1]!.click()
    await flushPromises()
    expect(project.menu().emitted('update:modelValue')).toEqual([['edits']])
    project.wrapper.unmount()
  })

  it('shows Accept edits on the trigger and keeps the current mode in the list', async () => {
    const { wrapper } = mountMenu('edits', ['ask', 'auto', 'off'])
    const trigger = wrapper.get(byTestId(testIds.permissionMenuTrigger))
    expect(trigger.attributes('data-value')).toBe('edits')
    expect(trigger.attributes('aria-label')).toBe('Permission mode: Accept edits')
    expect(trigger.text()).toContain('Accept edits')
    expect(trigger.classes()).not.toContain('text-primary')
    const options = await openMenu(wrapper)
    expect(options.map(option => option.dataset.value)).toEqual(['ask', 'edits', 'auto', 'off'])
    expect(options[1]!.getAttribute('aria-checked')).toBe('true')
    wrapper.unmount()
  })

  it('shows Plan in the info tone, on the trigger and in the menu', async () => {
    const { wrapper } = mountMenu('plan', ['ask', 'edits', 'plan', 'auto', 'off'])
    const trigger = wrapper.get(byTestId(testIds.permissionMenuTrigger))
    expect(trigger.attributes()).toMatchObject({ 'data-value': 'plan', 'aria-label': 'Permission mode: Plan' })
    expect(trigger.text()).toContain('Plan')
    expect(trigger.classes()).toContain('text-info')
    expect(trigger.classes()).not.toContain('text-primary')
    const options = await openMenu(wrapper)
    const plan = options.find(option => option.dataset.value === 'plan')!
    expect(plan.getAttribute('aria-checked')).toBe('true')
    const icons = (option: HTMLElement) => [...option.querySelectorAll('svg')].map(icon => icon.getAttribute('class') ?? '')
    expect(icons(plan).some(name => name.includes('lucide-clipboard-list') && name.includes('text-info'))).toBe(true)
    expect(plan.querySelector('span.text-info')?.textContent).toBe('Plan')
    expect(plan.textContent).toContain('Explore and plan; change nothing until you approve the plan')
    const ask = options.find(option => option.dataset.value === 'ask')!
    expect(icons(ask).some(name => name.includes('lucide-hand') && name.includes('text-muted-foreground'))).toBe(true)
    wrapper.unmount()
  })

  it('lists Alt+P and Shift+Tab in aria-keyshortcuts while each is on', async () => {
    const store = useSettingsStore()
    const { wrapper } = mountMenu('ask')
    const trigger = () => wrapper.get(byTestId(testIds.permissionMenuTrigger))
    expect(trigger().attributes('aria-keyshortcuts')).toBe('Alt+P Shift+Tab')
    store.settings = settings({ shiftTabModes: false })
    await nextTick()
    expect(trigger().attributes('aria-keyshortcuts')).toBe('Alt+P')
    store.settings = settings({ shiftTabModes: true, altShortcuts: false })
    await nextTick()
    expect(trigger().attributes('aria-keyshortcuts')).toBe('Shift+Tab')
    store.settings = settings({ shiftTabModes: false, altShortcuts: false })
    await nextTick()
    expect(trigger().attributes('aria-keyshortcuts')).toBeUndefined()
    wrapper.unmount()
  })
})
