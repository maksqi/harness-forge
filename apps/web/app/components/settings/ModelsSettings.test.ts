import type { CatalogModel, Settings } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { DEFAULT_SETTINGS } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { catalogModel, providerSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import ModelsSettings from './ModelsSettings.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

const NuxtLink = defineComponent({
  props: { to: { type: String, required: true } },
  setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()),
})

const anthropic = providerSummary({ modelsFetchedAt: Date.now() - 3_600_000 })
const openrouter = providerSummary({ id: 'openrouter', name: 'OpenRouter' })
const unconfigured = providerSummary({ id: 'openai', name: 'OpenAI (ChatGPT)', status: 'not_configured' })

const sonnet = catalogModel({ id: 'claude-sonnet-5', name: 'Claude Sonnet 5', cost: { input: 3, output: 15 } })
const haiku = catalogModel({ id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', hidden: true })
const custom = catalogModel({ id: 'claude-next', name: 'claude-next', custom: true, source: 'custom' })
const routed = Array.from({ length: 70 }, (_, index) => catalogModel({ providerId: 'openrouter', id: `vendor/model-${index}`, name: `Model ${index}` }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi
let models: CatalogModel[]

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  stubLocalStorage()
  toasts.error.mockReset()
  toasts.success.mockReset()
  models = [sonnet, haiku, custom, ...routed]
  let settings: Settings = { ...DEFAULT_SETTINGS }
  api.providers.list.mockResolvedValue({ items: [anthropic, unconfigured, openrouter] })
  api.models.list.mockImplementation(async () => ({ items: models }))
  api.settings.get.mockImplementation(async () => settings)
  api.settings.update.mockImplementation(async ({ body }: { body: Partial<Settings> }) => {
    settings = { ...settings, ...body }
    return settings
  })
  api.models.updatePrefs.mockImplementation(async ({ body }: { body: { providerId: string, modelId: string, favorite?: boolean, hidden?: boolean } }) => {
    const model = models.find(item => item.providerId === body.providerId && item.id === body.modelId)!
    return { ...model, ...(body.favorite !== undefined ? { favorite: body.favorite } : {}), ...(typeof body.hidden === 'boolean' ? { hidden: body.hidden } : {}) }
  })
})

afterEach(() => {
  disposePinia(pinia)
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

async function mountModels() {
  const Host = defineComponent({ setup: () => () => h(TooltipProvider, null, { default: () => h(ModelsSettings) }) })
  const wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia], stubs: { NuxtLink } } })
  await flushPromises()
  return wrapper
}

function section(id: string) {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testIds.modelsSection}"][data-provider-id="${id}"]`)
}

function row(ref: string) {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testIds.modelRow}"][data-model-ref="${ref}"]`)
}

describe('modelsSettings', () => {
  it('shows one section per connected provider and collapses large ones', async () => {
    await mountModels()
    expect(section('anthropic')).not.toBeNull()
    expect(section('openai')).toBeNull()
    expect(section('anthropic')!.dataset.state).toBe('open')
    expect(section('openrouter')!.dataset.state).toBe('closed')
    expect(section('openrouter')!.textContent).toContain('70 models')

    expect(row('anthropic:claude-sonnet-5')!.textContent).toContain('$3 / $15')
    expect(row('anthropic:claude-haiku-4-5')!.dataset.hidden).toBe('true')
    expect(row('anthropic:claude-next')!.textContent).toContain('Custom')
  })

  it('stars and hides models', async () => {
    await mountModels()
    row('anthropic:claude-sonnet-5')!.querySelector<HTMLButtonElement>(`[data-testid="${testIds.modelFavorite}"]`)!.click()
    await flushPromises()
    expect(api.models.updatePrefs).toHaveBeenCalledWith({ body: { providerId: 'anthropic', modelId: 'claude-sonnet-5', favorite: true } })
    expect(row('anthropic:claude-sonnet-5')!.querySelector(`[data-testid="${testIds.modelFavorite}"]`)!.getAttribute('aria-pressed')).toBe('true')

    const visible = row('anthropic:claude-haiku-4-5')!.querySelector<HTMLButtonElement>(`[data-testid="${testIds.modelVisible}"]`)!
    expect(visible.getAttribute('aria-checked')).toBe('false')
    visible.click()
    await flushPromises()
    expect(api.models.updatePrefs).toHaveBeenCalledWith({ body: { providerId: 'anthropic', modelId: 'claude-haiku-4-5', hidden: false } })
  })

  it('filters models and opens matching sections', async () => {
    const wrapper = await mountModels()
    await wrapper.get(`[data-testid="${testIds.modelsFilter}"]`).setValue('model-42')
    await flushPromises()
    expect(section('anthropic')).toBeNull()
    expect(section('openrouter')!.dataset.state).toBe('open')
    expect(section('openrouter')!.textContent).toContain('1 of 70 models')
    expect(row('openrouter:vendor/model-42')).not.toBeNull()

    await wrapper.get(`[data-testid="${testIds.modelsFilter}"]`).setValue('nothing-like-this')
    await flushPromises()
    expect(wrapper.text()).toContain('No models match "nothing-like-this".')
  })

  it('refreshes a provider listing', async () => {
    api.models.refresh.mockResolvedValue({ items: [sonnet] })
    await mountModels()
    section('anthropic')!.querySelector<HTMLButtonElement>(`[data-testid="${testIds.modelsRefresh}"]`)!.click()
    await flushPromises()
    expect(api.models.refresh).toHaveBeenCalledWith({ params: { id: 'anthropic' } })
  })

  it('adds a custom model to the provider of the section', async () => {
    api.models.addCustom.mockImplementation(async ({ body }: { body: { providerId: string, modelId: string, name?: string } }) =>
      catalogModel({ providerId: body.providerId, id: body.modelId, name: body.name ?? body.modelId, custom: true, source: 'custom' }))
    await mountModels()
    section('anthropic')!.querySelector<HTMLButtonElement>(`[data-testid="${testIds.customModelAdd}"]`)!.click()
    await flushPromises()

    const dialog = document.body.querySelector(`[data-testid="${testIds.customModelDialog}"]`)!
    expect(dialog.textContent).toContain('Anthropic (Claude)')
    document.body.querySelector<HTMLButtonElement>(`[data-testid="${testIds.customModelSave}"]`)!.click()
    await flushPromises()
    expect(dialog.textContent).toContain('Enter the model id the provider expects.')
    expect(api.models.addCustom).not.toHaveBeenCalled()

    const id = document.body.querySelector<HTMLInputElement>(`[data-testid="${testIds.customModelId}"]`)!
    id.value = 'claude-sonnet-5-preview'
    id.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    document.body.querySelector<HTMLButtonElement>(`[data-testid="${testIds.customModelSave}"]`)!.click()
    await flushPromises()

    expect(api.models.addCustom).toHaveBeenCalledWith({
      body: {
        providerId: 'anthropic',
        modelId: 'claude-sonnet-5-preview',
        capabilities: { tools: true, vision: false, reasoning: false, pdf: false },
      },
    })
    expect(toasts.success).toHaveBeenCalledWith('Added claude-sonnet-5-preview')
    expect(document.body.querySelector(`[data-testid="${testIds.customModelDialog}"]`)).toBeNull()
    expect(row('anthropic:claude-sonnet-5-preview')).not.toBeNull()
  })

  it('sets the default model from the picker', async () => {
    await mountModels()
    const trigger = document.body.querySelector<HTMLButtonElement>(`[data-testid="${testIds.modelsDefaultPicker}"]`)!
    expect(trigger.textContent).toContain('Automatic (last used model)')
    trigger.click()
    await flushPromises()

    const option = document.body.querySelector<HTMLElement>('[data-slot="command-item"][data-model-ref="anthropic:claude-sonnet-5"]')
    expect(option).not.toBeNull()
    // Hidden models never appear in the picker.
    expect(document.body.querySelector('[data-slot="command-item"][data-model-ref="anthropic:claude-haiku-4-5"]')).toBeNull()
    option!.click()
    await flushPromises()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { defaultModelRef: 'anthropic:claude-sonnet-5' } })
    expect(trigger.dataset.value).toBe('anthropic:claude-sonnet-5')
  })

  it('points to the providers page when nothing is connected', async () => {
    api.providers.list.mockResolvedValue({ items: [unconfigured] })
    const wrapper = await mountModels()
    expect(wrapper.text()).toContain('No connected providers')
    expect(wrapper.get('a[href="/settings/providers"]').text()).toBe('Connect a provider')
  })
})
