import type { Mock } from 'vitest'
import type { MockApi } from '~/utils/testing/mock-api'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h, nextTick, reactive } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useModelsStore } from '~/stores/models'
import { testIds } from '~/utils/testids'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import { anthropic, bodyAll, byTestId, haiku, llama, NuxtLinkStub, ollama, openai, seedStores, sonnet } from './composer-test-utils'
import ModelPicker from './ModelPicker.vue'

const mock = vi.hoisted(() => ({ api: null as unknown, navigateTo: null as unknown as Mock<(...args: unknown[]) => unknown> }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))
vi.mock('./nuxt-imports', () => ({ navigateTo: (...args: unknown[]) => mock.navigateTo(...args) }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

interface PickerProps {
  modelValue: string | null
  open: boolean
  variant?: 'composer' | 'field'
  allowNone?: boolean
}

function mountPicker(initial: PickerProps) {
  const state = reactive({ ...initial })
  const wrapper = mount({
    render: () => h(TooltipProvider, null, {
      default: () => h(ModelPicker, {
        ...state,
        'onUpdate:modelValue': (value: string | null) => {
          state.modelValue = value
        },
        'onUpdate:open': (value: boolean) => {
          state.open = value
        },
      }),
    }),
  }, { attachTo: document.body, global: { plugins: [pinia], stubs: { NuxtLink: NuxtLinkStub } } })
  return { wrapper, state, picker: () => wrapper.findComponent(ModelPicker) }
}

function groups() {
  return bodyAll(byTestId(testIds.modelPickerGroup)).map(group => ({
    value: group.dataset.value,
    refs: Array.from(group.querySelectorAll<HTMLElement>(byTestId(testIds.modelPickerItem))).map(item => item.dataset.modelRef),
  }))
}

async function search(text: string) {
  const input = document.body.querySelector<HTMLInputElement>(byTestId(testIds.modelPickerSearch))!
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  await nextTick()
}

describe('modelPicker', () => {
  beforeEach(() => {
    api = createMockApi()
    mock.api = api
    mock.navigateTo = vi.fn()
    stubLocalStorage()
    pinia = createPinia()
    setActivePinia(pinia)
    seedStores()
  })

  afterEach(() => {
    disposePinia(pinia)
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  })

  it('shows the selected model in the trigger with its provider icon', () => {
    const { wrapper } = mountPicker({ modelValue: sonnet.ref, open: false })
    const trigger = wrapper.get(byTestId(testIds.modelPickerTrigger))
    expect(trigger.attributes('data-model-ref')).toBe(sonnet.ref)
    expect(trigger.text()).toContain('Claude Sonnet 5')
    expect(trigger.attributes('aria-label')).toBe('Model: Claude Sonnet 5')
    expect(trigger.find('[data-slot="provider-icon"]').exists()).toBe(true)
    expect(trigger.attributes('data-available')).toBeUndefined()
    wrapper.unmount()
  })

  it('warns in the trigger when the model\'s provider is gone', () => {
    const { wrapper } = mountPicker({ modelValue: 'removed:model-x', open: false })
    const trigger = wrapper.get(byTestId(testIds.modelPickerTrigger))
    expect(trigger.attributes('data-available')).toBe('false')
    expect(trigger.attributes('aria-label')).toBe('Model: model-x (unavailable)')
    wrapper.unmount()
  })

  it('groups favorites, recent and connected providers; hidden models never show', async () => {
    useModelsStore().touchRecent(llama.ref)
    const { wrapper } = mountPicker({ modelValue: sonnet.ref, open: true })
    await flushPromises()
    expect(bodyAll(byTestId(testIds.modelPicker))).toHaveLength(1)
    expect(groups()).toEqual([
      { value: 'favorites', refs: [haiku.ref] },
      { value: 'recent', refs: [llama.ref] },
      { value: 'anthropic', refs: [sonnet.ref, haiku.ref] },
      { value: 'ollama', refs: [llama.ref] },
      { value: 'not-connected', refs: [] },
    ])
    expect(document.body.textContent).not.toContain('Claude Embed')
    // Provider group headers carry the provider icon.
    const anthropicGroup = bodyAll(byTestId(testIds.modelPickerGroup, '[data-value="anthropic"]'))[0]!
    expect(anthropicGroup.querySelector('[data-slot="provider-icon"]')?.getAttribute('aria-label')).toBe(anthropic.name)
    // The current model is checked; items read their capabilities and context size.
    const current = bodyAll(byTestId(testIds.modelPickerItem, `[data-model-ref="${sonnet.ref}"]`))
    expect(current.every(item => item.dataset.checked === 'true')).toBe(true)
    expect(current[0]!.getAttribute('aria-label')).toBe('Claude Sonnet 5, Anthropic (Claude), vision, tools, reasoning, 200K context')
    wrapper.unmount()
  })

  it('searches by name, id and provider and shows provider groups only', async () => {
    const { wrapper } = mountPicker({ modelValue: null, open: true })
    await flushPromises()
    await search('haiku')
    expect(groups()).toEqual([{ value: 'anthropic', refs: [haiku.ref] }])
    await search('ollama')
    expect(groups()).toEqual([{ value: 'ollama', refs: [llama.ref] }])
    await search('openai')
    expect(groups()).toEqual([{ value: 'not-connected', refs: [] }])
    await search('nothing-matches')
    expect(groups()).toEqual([])
    expect(document.body.textContent).toContain('No models found')
    wrapper.unmount()
  })

  it('picks a model: emits it, records it as recent and closes', async () => {
    const { wrapper, state, picker } = mountPicker({ modelValue: sonnet.ref, open: true })
    await flushPromises()
    bodyAll(byTestId(testIds.modelPickerItem, `[data-model-ref="${llama.ref}"]`)).at(-1)!.click()
    await flushPromises()
    expect(picker().emitted('update:modelValue')).toEqual([[llama.ref]])
    expect(state.modelValue).toBe(llama.ref)
    expect(state.open).toBe(false)
    expect(useModelsStore().recentRefs[0]).toBe(llama.ref)
    wrapper.unmount()
  })

  it('picks with the keyboard from the search field', async () => {
    const { wrapper, picker } = mountPicker({ modelValue: null, open: true })
    await flushPromises()
    await search('llama')
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>(byTestId(testIds.modelPickerSearch))!
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(picker().emitted('update:modelValue')).toEqual([[llama.ref]])
    wrapper.unmount()
  })

  it('toggles a favorite with the star without picking the model', async () => {
    api.models.updatePrefs.mockResolvedValue({ ...sonnet, favorite: true })
    const { wrapper, picker } = mountPicker({ modelValue: null, open: true })
    await flushPromises()
    const star = bodyAll(byTestId(testIds.modelPickerFavorite, `[data-model-ref="${sonnet.ref}"]`))[0]!
    expect(star.getAttribute('aria-label')).toBe('Favorite')
    expect(star.getAttribute('aria-pressed')).toBe('false')
    star.click()
    await flushPromises()
    expect(api.models.updatePrefs).toHaveBeenCalledWith({ body: { providerId: 'anthropic', modelId: 'claude-sonnet-5', favorite: true } })
    expect(picker().emitted('update:modelValue')).toBeUndefined()
    expect(groups()[0]).toEqual({ value: 'favorites', refs: [sonnet.ref, haiku.ref] })
    wrapper.unmount()
  })

  it('links unconnected providers to their key dialog and has footer links', async () => {
    const { wrapper, state } = mountPicker({ modelValue: null, open: true })
    await flushPromises()
    const connect = document.body.querySelector<HTMLElement>(`[data-provider-id="${openai.id}"]`)!
    expect(connect.textContent).toContain('Connect')
    connect.click()
    await flushPromises()
    expect(mock.navigateTo).toHaveBeenCalledWith('/settings/providers?configure=openai')
    expect(state.open).toBe(false)

    state.open = true
    await flushPromises()
    expect(document.body.querySelector(byTestId(testIds.modelPickerManage))?.getAttribute('href')).toBe('/settings/models')
    expect(document.body.querySelector(byTestId(testIds.modelPickerConnect))?.getAttribute('href')).toBe('/settings/providers')
    wrapper.unmount()
  })

  it('field variant: a None item that emits null, and no recent tracking', async () => {
    const { wrapper, state, picker } = mountPicker({ modelValue: sonnet.ref, open: true, variant: 'field', allowNone: true })
    await flushPromises()
    const trigger = wrapper.get(byTestId(testIds.modelPickerTrigger))
    expect(trigger.classes()).toContain('w-full')
    const none = bodyAll(byTestId(testIds.modelPickerItem, '[data-model-ref=""]'))[0]!
    expect(none.textContent).toContain('None')
    none.click()
    await flushPromises()
    expect(picker().emitted('update:modelValue')).toEqual([[null]])
    expect(wrapper.get(byTestId(testIds.modelPickerTrigger)).text()).toContain('None')

    state.open = true
    await flushPromises()
    bodyAll(byTestId(testIds.modelPickerItem, `[data-model-ref="${llama.ref}"]`))[0]!.click()
    await flushPromises()
    expect(picker().emitted('update:modelValue')).toEqual([[null], [llama.ref]])
    expect(useModelsStore().recentRefs).toEqual([])
    wrapper.unmount()
  })

  it('loads providers and models when they are not loaded yet', async () => {
    const pristine = createPinia()
    setActivePinia(pristine)
    api.providers.list.mockResolvedValue({ items: [anthropic, ollama] })
    api.models.list.mockResolvedValue({ items: [sonnet, llama] })
    pinia = pristine
    const { wrapper } = mountPicker({ modelValue: sonnet.ref, open: false })
    await flushPromises()
    expect(api.providers.list).toHaveBeenCalledTimes(1)
    expect(api.models.list).toHaveBeenCalledWith({ query: { includeHidden: true } })
    expect(wrapper.get(byTestId(testIds.modelPickerTrigger)).text()).toContain('Claude Sonnet 5')
    wrapper.unmount()
  })
})
