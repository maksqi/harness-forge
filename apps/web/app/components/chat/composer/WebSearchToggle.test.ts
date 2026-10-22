// WebSearchToggle (Phase 14, ADR-062, ADR-063; docs/UI.md 7.35, 10.10, 12, 14): the C54 contract (props, emits, the exposed
// activate, the root test id with `data-state` / `data-mode`, `aria-pressed`, `aria-disabled`) and W14.8's behavior: the
// tooltip with the Alt+W hint, the unavailable popover per resolver reason with "Set up web search", "Turn off web search"
// for a pressed toggle that cannot search, the focus after the popover closes, the icon-only layout below `sm` and the
// re-read of the search API configuration when the popover opens.
import type { WebSearchResolution, WebSearchUnavailableReason } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { DEFAULT_SETTINGS } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, reactive } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import { createMockApi } from '~/utils/testing/mock-api'
import { bodyAll, byTestId, NuxtLinkStub } from './composer-test-utils'
import { WEB_SEARCH_REASON_TEXT } from './web-search'
import WebSearchToggle from './WebSearchToggle.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

const native: WebSearchResolution = { kind: 'native', exclusive: false }

interface Props {
  modelValue: boolean
  availability: WebSearchResolution
  via: string | null
  disabled?: boolean
  returnFocusTo?: HTMLElement | null
}

let pinia: ReturnType<typeof createPinia>
let api: MockApi

function mountToggle(initial: Props) {
  const props = reactive<Props>({ ...initial })
  const wrapper = mount(defineComponent({
    render: () => h(TooltipProvider, null, {
      default: () => h(WebSearchToggle, {
        ...props,
        'onUpdate:modelValue': (value: boolean) => {
          props.modelValue = value
        },
      }),
    }),
  }), { attachTo: document.body, global: { plugins: [pinia], stubs: { NuxtLink: NuxtLinkStub } } })
  const component = () => wrapper.getComponent(WebSearchToggle)
  const root = () => wrapper.get(byTestId(testIds.composerWebSearch))
  const popover = () => bodyAll(byTestId(testIds.webSearchUnavailable))
  return { wrapper, props, component, root, popover }
}

function unavailable(reason: WebSearchUnavailableReason): WebSearchResolution {
  return { kind: 'unavailable', reason }
}

describe('webSearchToggle', () => {
  beforeEach(() => {
    api = createMockApi()
    mock.api = api
    pinia = createPinia()
    setActivePinia(pinia)
    useSettingsStore().settings = { ...DEFAULT_SETTINGS }
  })

  afterEach(() => {
    disposePinia(pinia)
    document.body.replaceChildren()
  })

  it('is a pressed toggle named "Web search" that emits the flipped value', async () => {
    const { wrapper, component, root } = mountToggle({ modelValue: false, availability: native, via: 'Anthropic' })
    expect(root().attributes('aria-label')).toBe('Web search')
    expect(root().attributes('aria-pressed')).toBe('false')
    expect(root().attributes('data-state')).toBe('off')
    expect(root().attributes('data-mode')).toBe('native')
    expect(root().attributes('aria-disabled')).toBeUndefined()
    expect(root().attributes('aria-haspopup')).toBeUndefined()
    await root().trigger('click')
    expect(component().emitted('update:modelValue')).toEqual([[true]])
    expect(root().attributes()).toMatchObject({ 'aria-pressed': 'true', 'data-state': 'on' })
    // The 6px dot of the icon-only toggle (below `sm`) while on.
    expect(root().find('[data-slot="web-search-dot"]').exists()).toBe(true)
    ;(component().vm as unknown as { activate: () => void }).activate()
    await flushPromises()
    expect(component().emitted('update:modelValue')).toEqual([[true], [false]])
    expect(root().find('[data-slot="web-search-dot"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('is icon-only below sm and keeps a 40 px target on coarse pointers', () => {
    const { wrapper, root } = mountToggle({ modelValue: true, availability: { kind: 'builtin' }, via: 'Brave Search' })
    const classes = root().classes()
    expect(classes).toEqual(expect.arrayContaining(['shrink-0', 'h-8', 'pointer-coarse:h-10', 'pointer-coarse:min-w-10']))
    const label = root().findAll('span').find(span => span.text() === 'Search')!
    expect(label.classes()).toEqual(['hidden', 'sm:inline'])
    expect(root().get('[data-slot="web-search-dot"]').classes()).toContain('sm:hidden')
    // The tooltip trigger's wrapper never shrinks in the toolbar either.
    expect(root().element.parentElement?.classList.contains('shrink-0')).toBe(true)
    wrapper.unmount()
  })

  it('names who searches in the tooltip, with the Alt+W hint only while Alt shortcuts are on', async () => {
    const tooltip = () => document.body.querySelector('[data-slot="tooltip-content"]')
    /** Focus on the tooltip trigger (the toggle's wrapper) opens the tooltip. */
    async function hover(element: HTMLElement) {
      const trigger = element.parentElement!
      element.focus()
      trigger.dispatchEvent(new FocusEvent('focus'))
      await flushPromises()
    }

    const on = mountToggle({ modelValue: true, availability: { kind: 'builtin' }, via: 'Brave Search' })
    expect(on.root().attributes('aria-keyshortcuts')).toBe('Alt+W')
    await hover(on.root().element as HTMLElement)
    await vi.waitFor(() => expect(tooltip()?.textContent).toContain('Web search on · Brave Search'))
    expect(tooltip()!.querySelector('[data-slot="kbd-combo"]')).not.toBeNull()
    on.wrapper.unmount()
    document.body.replaceChildren()

    useSettingsStore().settings = { ...DEFAULT_SETTINGS, altShortcuts: false }
    const off = mountToggle({ modelValue: false, availability: native, via: 'Anthropic' })
    expect(off.root().attributes('aria-keyshortcuts')).toBeUndefined()
    await hover(off.root().element as HTMLElement)
    await vi.waitFor(() => expect(tooltip()?.textContent).toContain('Web search off'))
    expect(tooltip()!.querySelector('[data-slot="kbd-combo"]')).toBeNull()
    off.wrapper.unmount()
  })

  it.each([
    ['no-backend'],
    ['tools-unsupported'],
    ['tool-mode-off'],
    ['tools-conflict'],
  ] as const)('unavailable (%s): aria-disabled but focusable, described by the reason; a click opens the popover', async (reason) => {
    const { wrapper, component, root, popover } = mountToggle({ modelValue: false, availability: unavailable(reason), via: null })
    expect(root().attributes()).toMatchObject({ 'data-state': 'unavailable', 'aria-disabled': 'true', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' })
    expect(root().attributes('data-mode')).toBeUndefined()
    expect(root().attributes('disabled')).toBeUndefined()
    const describedBy = root().attributes('aria-describedby')!
    expect(document.getElementById(describedBy)?.textContent).toBe(WEB_SEARCH_REASON_TEXT[reason])

    await root().trigger('click')
    await flushPromises()
    expect(component().emitted('update:modelValue')).toBeUndefined()
    expect(popover()).toHaveLength(1)
    expect(popover()[0]!.getAttribute('data-reason')).toBe(reason)
    expect(popover()[0]!.textContent).toContain('Web search')
    expect(popover()[0]!.textContent).toContain(WEB_SEARCH_REASON_TEXT[reason])
    const setup = bodyAll(byTestId(testIds.webSearchSetup))[0]!
    expect(setup.getAttribute('href')).toBe('/settings/search')
    expect(setup.textContent).toContain('Set up web search')
    // An unpressed toggle has nothing to turn off.
    expect(popover()[0]!.querySelector('[data-slot="web-search-turn-off"]')).toBeNull()
    expect(root().attributes('aria-expanded')).toBe('true')

    // The setup link closes the popover (it navigates away).
    setup.click()
    await flushPromises()
    expect(popover()).toHaveLength(0)
    wrapper.unmount()
  })

  it('re-reads the search API configuration when the popover opens', async () => {
    const { wrapper, root } = mountToggle({ modelValue: false, availability: unavailable('no-backend'), via: null })
    expect(api.plugins.getSettings).not.toHaveBeenCalled()
    await root().trigger('click')
    await flushPromises()
    expect(api.plugins.getSettings).toHaveBeenCalledWith({ params: { id: 'core-search' } })
    wrapper.unmount()
  })

  it('a pressed toggle that cannot search stays pressed and its popover can turn it off', async () => {
    const { wrapper, component, root, popover } = mountToggle({ modelValue: true, availability: unavailable('tool-mode-off'), via: null })
    expect(root().attributes()).toMatchObject({ 'data-state': 'unavailable', 'aria-pressed': 'true', 'aria-disabled': 'true' })
    await root().trigger('click')
    await flushPromises()
    const turnOff = popover()[0]!.querySelector<HTMLButtonElement>('[data-slot="web-search-turn-off"]')!
    expect(turnOff.textContent?.trim()).toBe('Turn off web search')
    turnOff.click()
    await flushPromises()
    expect(component().emitted('update:modelValue')).toEqual([[false]])
    expect(popover()).toHaveLength(0)
    expect(root().attributes('aria-pressed')).toBe('false')
    wrapper.unmount()
  })

  it('closing the popover gives the focus back to the toggle, or to returnFocusTo after Alt+W', async () => {
    const { wrapper, component, root, popover, props } = mountToggle({ modelValue: false, availability: unavailable('no-backend'), via: null })
    const textarea = document.createElement('textarea')
    document.body.append(textarea)
    props.returnFocusTo = textarea
    await flushPromises()
    await root().trigger('click')
    await flushPromises()
    expect(popover()).toHaveLength(1)
    await root().trigger('click')
    await flushPromises()
    expect(popover()).toHaveLength(0)
    expect(document.activeElement).toBe(root().element)

    textarea.focus()
    ;(component().vm as unknown as { activate: () => void }).activate()
    await flushPromises()
    expect(popover()).toHaveLength(1)
    ;(component().vm as unknown as { activate: () => void }).activate()
    await flushPromises()
    expect(popover()).toHaveLength(0)
    expect(document.activeElement).toBe(textarea)
    wrapper.unmount()
  })

  it('the popover goes away once search becomes available', async () => {
    const { wrapper, props, root, popover } = mountToggle({ modelValue: false, availability: unavailable('no-backend'), via: null })
    await root().trigger('click')
    await flushPromises()
    expect(popover()).toHaveLength(1)
    props.availability = { kind: 'builtin' }
    props.via = 'Tavily'
    await flushPromises()
    expect(popover()).toHaveLength(0)
    expect(root().attributes()).toMatchObject({ 'data-state': 'off', 'data-mode': 'builtin' })
    expect(root().attributes('aria-describedby')).toBeUndefined()
    wrapper.unmount()
  })

  it('does nothing while the composer is disabled', async () => {
    const enabled = mountToggle({ modelValue: false, availability: native, via: 'OpenAI', disabled: true })
    expect(enabled.root().attributes('aria-disabled')).toBe('true')
    await enabled.root().trigger('click')
    ;(enabled.component().vm as unknown as { activate: () => void }).activate()
    await flushPromises()
    expect(enabled.component().emitted('update:modelValue')).toBeUndefined()
    enabled.wrapper.unmount()

    const blocked = mountToggle({ modelValue: false, availability: unavailable('no-backend'), via: null, disabled: true })
    await blocked.root().trigger('click')
    await flushPromises()
    expect(blocked.popover()).toHaveLength(0)
    blocked.wrapper.unmount()
  })
})
