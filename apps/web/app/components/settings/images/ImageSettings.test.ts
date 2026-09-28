import type { Settings } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { MockApi } from '~/utils/testing/mock-api'
import { DEFAULT_SETTINGS, HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useModelsStore } from '~/stores/models'
import { useProvidersStore } from '~/stores/providers'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import { catalogModel, providerSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import ImageSettings from './ImageSettings.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

const openai = providerSummary({ id: 'openai', name: 'OpenAI (ChatGPT)' })
const gptImage = catalogModel({ providerId: 'openai', id: 'gpt-image-1', name: 'GPT Image 1', kind: 'image' })
const dalle = catalogModel({ providerId: 'openai', id: 'dall-e-2', name: 'DALL-E 2', kind: 'image', hidden: true })
const chat = catalogModel({ providerId: 'openai', id: 'gpt-5', name: 'GPT-5' })

let pinia: ReturnType<typeof createPinia>
let api: MockApi
let wrapper: VueWrapper | null = null
let saved: Settings

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  stubLocalStorage()
  toasts.error.mockReset()
  saved = { ...DEFAULT_SETTINGS }
  api.settings.update.mockImplementation(async ({ body }: { body: Partial<Settings> }) => {
    saved = { ...saved, ...body }
    return saved
  })
  useProvidersStore().items = [openai]
  useProvidersStore().loaded = true
  useModelsStore().items = [chat, gptImage, dalle]
  useModelsStore().loaded = true
  useSettingsStore().settings = { ...saved }
  useSettingsStore().loaded = true
})

afterEach(async () => {
  wrapper?.unmount()
  wrapper = null
  await flushPromises()
  disposePinia(pinia)
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

async function mountImages() {
  const Host = defineComponent({ setup: () => () => h(TooltipProvider, null, { default: () => h(ImageSettings) }) })
  wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
  await flushPromises()
  return wrapper
}

function trigger(): HTMLButtonElement {
  return document.body.querySelector<HTMLButtonElement>(`[data-testid="${testIds.settingsImageModel}"]`)!
}

function option(modelRef: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testIds.modelSelectOption}"][data-model-ref="${modelRef}"]`)
}

function optionRefs(): string[] {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.modelSelectOption}"]`)].map(item => item.dataset.modelRef ?? '')
}

describe('imageSettings', () => {
  it('renders the Images section with the image model field', async () => {
    const host = await mountImages()
    const root = host.get(`[data-testid="${testIds.imageSettings}"]`)
    expect(root.element.tagName).toBe('SECTION')
    expect(root.get('h2').text()).toBe('Images')
    expect(root.text()).toContain('Generate pictures with your own providers.')
    expect(root.text()).toContain('Image model')
    expect(root.text()).toContain('The generate_image tool uses this model. To generate images directly, pick an image model in the composer.')
    expect(trigger().dataset.value).toBe('')
    expect(trigger().textContent).toContain('None (the generate_image tool is off)')
    expect(trigger().getAttribute('aria-label')).toBe('Image model, None (the generate_image tool is off)')
    // The visible label points at the trigger.
    const label = root.find('label')
    expect(label.attributes('for')).toBe(trigger().id)
  })

  it('lists the visible image models of connected providers after "None"', async () => {
    await mountImages()
    trigger().click()
    await flushPromises()
    expect(optionRefs()).toEqual(['', 'openai:gpt-image-1'])
    expect(option('')!.textContent).toContain('None (the generate_image tool is off)')
    expect(option('')!.dataset.checked).toBe('true')
  })

  it('saves the chosen image model, then None', async () => {
    await mountImages()
    trigger().click()
    await flushPromises()
    option('openai:gpt-image-1')!.click()
    await flushPromises()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { imageModelRef: 'openai:gpt-image-1' } })
    expect(useSettingsStore().resolved.imageModelRef).toBe('openai:gpt-image-1')
    expect(trigger().dataset.value).toBe('openai:gpt-image-1')

    trigger().click()
    await flushPromises()
    option('')!.click()
    await flushPromises()
    expect(api.settings.update).toHaveBeenLastCalledWith({ body: { imageModelRef: null } })
    expect(trigger().dataset.value).toBe('')
    expect(toasts.error).not.toHaveBeenCalled()
  })

  it('toasts a failed save and shows the previous choice again', async () => {
    api.settings.update.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    await mountImages()
    trigger().click()
    await flushPromises()
    option('openai:gpt-image-1')!.click()
    await flushPromises()
    expect(toasts.error).toHaveBeenCalledWith('Something went wrong', { description: 'Disk full.' })
    expect(useSettingsStore().resolved.imageModelRef).toBeNull()
    expect(trigger().dataset.value).toBe('')
  })

  it('says so when no connected provider has an image model', async () => {
    useModelsStore().items = [chat, dalle]
    await mountImages()
    trigger().click()
    await flushPromises()
    expect(optionRefs()).toEqual([''])
    expect(document.body.querySelector('[data-slot="model-select-empty"]')!.textContent!.trim())
      .toBe('No image models from your connected providers.')
  })
})
