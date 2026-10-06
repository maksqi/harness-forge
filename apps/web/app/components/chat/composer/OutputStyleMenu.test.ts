import type { OutputStyleOption, OutputStyleScope } from './output-style'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, reactive, ref } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { projectId, styleEntry } from '~/utils/testing/fixtures'
import { bodyAll, byTestId } from './composer-test-utils'
import { automaticStyle, OUTPUT_STYLE_SCOPE, styleOptions } from './output-style'
import OutputStyleMenu from './OutputStyleMenu.vue'

const mock = vi.hoisted(() => ({ navigateTo: vi.fn() }))
vi.mock('./nuxt-imports', () => ({ navigateTo: (...args: unknown[]) => mock.navigateTo(...args) }))
// The shared test helpers import the stores, which import useApi ('#imports' does not resolve in Vitest).
vi.mock('~/composables/useApi', () => ({ useApi: () => ({}) }))

const options = styleOptions([
  styleEntry(),
  styleEntry({ name: 'pirate', label: 'Pirate', description: 'Talks like a pirate', source: 'plugin', pluginId: 'fun-pack', path: undefined }),
  styleEntry({ name: 'brief', label: 'Brief', description: 'Bullet points only', source: 'user', path: undefined }),
])

interface MenuState {
  open: boolean
  modelValue: string | null
  options: readonly OutputStyleOption[]
  automatic: OutputStyleOption | null
  returnFocusTo?: HTMLElement | null
}

/** Mounts the menu with v-model and v-model:open wired to a reactive state, and the composer's scope when given. */
function mountMenu(initial: Partial<MenuState> = {}, scope: OutputStyleScope | null = null) {
  const state = reactive<MenuState>({ open: false, modelValue: null, options, automatic: options[0]!, ...initial })
  const wrapper = mount(defineComponent({
    render: () => h(TooltipProvider, null, {
      default: () => h(OutputStyleMenu, {
        ...state,
        'onUpdate:modelValue': (value: string | null) => {
          state.modelValue = value
        },
        'onUpdate:open': (value: boolean) => {
          state.open = value
        },
      }),
    }),
  }), { attachTo: document.body, global: { provide: scope ? { [OUTPUT_STYLE_SCOPE as symbol]: ref(scope) } : {} } })
  const menu = () => wrapper.findComponent(OutputStyleMenu)
  const trigger = () => wrapper.get(byTestId(testIds.outputStyleTrigger))
  return { wrapper, state, menu, trigger }
}

function rows(): HTMLElement[] {
  return bodyAll(byTestId(testIds.outputStyleOption))
}

function row(value: string): HTMLElement {
  return bodyAll(byTestId(testIds.outputStyleOption, `[data-value="${value}"]`))[0]!
}

const websiteScope: OutputStyleScope = { projectId: projectId(1), projectName: 'website', projectStyle: 'terse', pluginNames: { pirate: 'Fun pack' } }

describe('outputStyleMenu', () => {
  beforeEach(() => {
    mock.navigateTo = vi.fn()
  })

  afterEach(() => {
    document.body.replaceChildren()
  })

  it('shows the automatic Default as the icon alone, named "(automatic)"', () => {
    const { wrapper, trigger } = mountMenu()
    expect(trigger().attributes()).toMatchObject({ 'data-value': 'default', 'data-source': 'automatic', 'aria-label': 'Output style: Default (automatic)' })
    expect(trigger().find('[data-slot="output-style-label"]').exists()).toBe(false)
    expect(trigger().find('[data-slot="output-style-dot"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows a style that is not Default with its label from sm and a dot below sm', () => {
    const { wrapper, trigger } = mountMenu({ modelValue: 'terse', automatic: null })
    expect(trigger().attributes()).toMatchObject({ 'data-value': 'terse', 'data-source': 'chat', 'aria-label': 'Output style: Terse' })
    const label = trigger().get('[data-slot="output-style-label"]')
    expect(label.text()).toBe('Terse')
    expect(label.classes()).toEqual(expect.arrayContaining(['hidden', 'sm:inline', 'max-w-[14ch]', 'truncate']))
    const dot = trigger().get('[data-slot="output-style-dot"]')
    expect(dot.attributes('aria-hidden')).toBe('true')
    expect(dot.classes()).toContain('sm:hidden')
    expect(trigger().classes()).toEqual(expect.arrayContaining(['h-8', 'pointer-coarse:h-10', 'pointer-coarse:min-w-10']))
    wrapper.unmount()
  })

  it('reads an automatic style that is not Default from the automatic option', () => {
    const { wrapper, trigger } = mountMenu({ automatic: options.find(option => option.name === 'learning')! })
    expect(trigger().attributes()).toMatchObject({ 'data-value': 'learning', 'data-source': 'automatic', 'aria-label': 'Output style: Learning (automatic)' })
    expect(trigger().find('[data-slot="output-style-dot"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('lists Automatic, the built-ins, then the personal, project and plugin styles with their sources', async () => {
    const { wrapper } = mountMenu({ open: true, automatic: automaticStyle('terse', 'default', options) }, websiteScope)
    await flushPromises()
    expect(rows().map(item => item.dataset.value)).toEqual(['', 'default', 'explanatory', 'learning', 'brief', 'terse', 'pirate'])
    expect(rows()[0]!.textContent).toContain('Automatic')
    expect(rows()[0]!.querySelector('[data-slot="output-style-automatic"]')?.textContent).toBe('Uses Terse, set for website')
    expect(rows()[0]!.getAttribute('data-state')).toBe('checked')
    const source = (value: string) => row(value).querySelector('[data-slot="output-style-source"]')?.textContent
    expect([source('default'), source('brief'), source('terse'), source('pirate')]).toEqual(['Built-in', 'Personal', 'Project', 'Fun pack'])
    expect(row('explanatory').textContent).toContain('Explains its choices and the code it touches.')
    const group = document.body.querySelector('[role="group"][aria-label="Output style"]')
    expect(group).not.toBeNull()
    wrapper.unmount()
  })

  it('reads "your default in Settings" without a project style, and without a scope', async () => {
    const { wrapper } = mountMenu({ open: true, automatic: options.find(option => option.name === 'explanatory')! })
    await flushPromises()
    expect(rows()[0]!.textContent).toContain('Uses Explanatory, your default in Settings')
    expect(row('pirate').querySelector('[data-slot="output-style-source"]')?.textContent).toBe('Plugin')
    wrapper.unmount()
  })

  it('emits the picked style and null for Automatic', async () => {
    const { wrapper, state, menu } = mountMenu({ open: true })
    await flushPromises()
    row('learning').click()
    await flushPromises()
    expect(menu().emitted('update:modelValue')).toEqual([['learning']])
    expect(state.modelValue).toBe('learning')

    state.open = true
    await flushPromises()
    expect(row('learning').getAttribute('data-state')).toBe('checked')
    row('').click()
    await flushPromises()
    expect(menu().emitted('update:modelValue')).toEqual([['learning'], [null]])
    wrapper.unmount()
  })

  it('keeps a chosen style that is no longer offered checked, "Not available"', async () => {
    const { wrapper, trigger } = mountMenu({ open: true, modelValue: 'gone', automatic: null })
    await flushPromises()
    expect(trigger().attributes()).toMatchObject({ 'data-value': 'gone', 'aria-label': 'Output style: gone' })
    const gone = row('gone')
    expect(rows().at(-1)).toBe(gone)
    expect(gone.getAttribute('data-state')).toBe('checked')
    expect(gone.querySelector('[data-slot="output-style-source"]')?.textContent).toBe('Not available')
    wrapper.unmount()
  })

  it('opens on the checked option from the keyboard and returns focus to returnFocusTo after a pick', async () => {
    const textarea = document.createElement('textarea')
    document.body.append(textarea)
    const { wrapper, state, trigger } = mountMenu({ modelValue: 'explanatory', returnFocusTo: textarea })
    await trigger().trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(state.open).toBe(true)
    expect(document.activeElement?.getAttribute('data-value')).toBe('explanatory')
    row('default').click()
    await flushPromises()
    expect(state.open).toBe(false)
    expect(state.modelValue).toBe('default')
    expect(document.activeElement).toBe(textarea)
    wrapper.unmount()
  })

  it('links "Manage output styles" to the Output styles tab of the chat\'s project', async () => {
    const { wrapper } = mountMenu({ open: true }, websiteScope)
    await flushPromises()
    const manage = bodyAll(byTestId(testIds.outputStyleManage))[0]!
    expect(manage.textContent).toContain('Manage output styles')
    manage.click()
    await flushPromises()
    expect(mock.navigateTo).toHaveBeenCalledWith(`/settings/customize?tab=output-styles&project=${projectId(1)}`)
    wrapper.unmount()

    const plain = mountMenu({ open: true })
    await flushPromises()
    bodyAll(byTestId(testIds.outputStyleManage))[0]!.click()
    await flushPromises()
    expect(mock.navigateTo).toHaveBeenLastCalledWith('/settings/customize?tab=output-styles')
    plain.wrapper.unmount()
  })
})
