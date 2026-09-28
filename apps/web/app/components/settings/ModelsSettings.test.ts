import type { CatalogModel, Settings } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
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
let mounted: VueWrapper[] = []

/** Tests that open a select of 70+ models: slow on a busy machine, so they get more than the default 5 s. */
const HEAVY_TEST_TIMEOUT = 20_000

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

afterEach(async () => {
  // Unmount before clearing <body>: a popover closing late must not unmount into removed nodes.
  for (const wrapper of mounted)
    wrapper.unmount()
  mounted = []
  await flushPromises()
  disposePinia(pinia)
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

async function mountModels() {
  const Host = defineComponent({ setup: () => () => h(TooltipProvider, null, { default: () => h(ModelsSettings) }) })
  const wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia], stubs: { NuxtLink } } })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}

function section(id: string) {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testIds.modelsSection}"][data-provider-id="${id}"]`)
}

function row(ref: string) {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testIds.modelRow}"][data-model-ref="${ref}"]`)
}

/** Options of the open default / title model select. */
function selectOptions() {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.modelSelectOption}"]`)]
}

function selectOption(ref: string) {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testIds.modelSelectOption}"][data-model-ref="${ref}"]`)
}

function rowMenu(ref: string) {
  return row(ref)!.querySelector<HTMLButtonElement>(`[data-testid="${testIds.modelRowMenu}"]`)!
}

function press(target: Element, key: string) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

async function settle(rounds = 3) {
  for (let round = 0; round < rounds; round++) {
    await flushPromises()
    await nextTick()
  }
}

/** Opens a reka-ui dropdown menu the way a keyboard user does and returns the labels of its items. */
async function openMenu(trigger: HTMLElement) {
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await flushPromises()
  await nextTick()
  return [...document.body.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim())
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
        kind: 'chat',
        capabilities: { tools: true, vision: false, reasoning: false, pdf: false, imageOutput: false },
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

    const option = selectOption('anthropic:claude-sonnet-5')
    expect(option).not.toBeNull()
    expect(option!.dataset.slot).toBe('command-item')
    // Hidden models never appear in the picker.
    expect(selectOption('anthropic:claude-haiku-4-5')).toBeNull()
    option!.click()
    await flushPromises()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { defaultModelRef: 'anthropic:claude-sonnet-5' } })
    expect(trigger.dataset.value).toBe('anthropic:claude-sonnet-5')
  }, HEAVY_TEST_TIMEOUT)

  it('lists the title model choices as options with their model refs, Automatic first with an empty ref', async () => {
    await mountModels()
    const trigger = document.body.querySelector<HTMLButtonElement>(`[data-testid="${testIds.modelsTitlePicker}"]`)!
    trigger.click()
    await flushPromises()

    const [automatic, ...choices] = selectOptions()
    expect(automatic!.dataset.modelRef).toBe('')
    expect(automatic!.textContent).toContain('Automatic (small model of the chat\'s provider)')
    expect(automatic!.dataset.checked).toBe('true')
    // Every visible model of the connected providers, each with its ref; the hidden one is left out.
    expect(choices).toHaveLength(2 + routed.length)
    expect(choices.slice(0, 2).map(option => option.dataset.modelRef)).toEqual(['anthropic:claude-sonnet-5', 'anthropic:claude-next'])
    expect(choices.map(option => option.dataset.modelRef)).toContain('openrouter:vendor/model-69')
    expect(choices.map(option => option.dataset.modelRef)).not.toContain('anthropic:claude-haiku-4-5')

    selectOption('anthropic:claude-next')!.click()
    await flushPromises()
    expect(api.settings.update).toHaveBeenLastCalledWith({ body: { titleModelRef: 'anthropic:claude-next' } })
    expect(trigger.dataset.value).toBe('anthropic:claude-next')

    trigger.click()
    await flushPromises()
    expect(selectOption('anthropic:claude-next')!.dataset.checked).toBe('true')
    selectOption('')!.click()
    await flushPromises()
    expect(api.settings.update).toHaveBeenLastCalledWith({ body: { titleModelRef: null } })
    expect(trigger.dataset.value).toBe('')
  }, HEAVY_TEST_TIMEOUT)

  it('opens a row menu from its ⋯ trigger: Rename for every model, Remove only for custom models', async () => {
    api.models.removeCustom.mockImplementation(async () => {
      models = models.filter(model => model !== custom)
    })
    await mountModels()
    expect(rowMenu('anthropic:claude-sonnet-5').getAttribute('aria-label')).toBe('Actions for Claude Sonnet 5')
    expect(rowMenu('anthropic:claude-next').getAttribute('aria-label')).toBe('Actions for claude-next')

    expect(await openMenu(rowMenu('anthropic:claude-next'))).toEqual(['Rename', 'Remove'])
    document.body.querySelector<HTMLElement>(`[data-testid="${testIds.modelRemove}"]`)!.click()
    await flushPromises()
    expect(api.models.removeCustom).toHaveBeenCalledWith({ query: { providerId: 'anthropic', modelId: 'claude-next' } })
    expect(toasts.success).toHaveBeenCalledWith('Removed claude-next')
    expect(row('anthropic:claude-next')).toBeNull()

    expect(await openMenu(rowMenu('anthropic:claude-sonnet-5'))).toEqual(['Rename'])
    expect(document.body.querySelector(`[data-testid="${testIds.modelRemove}"]`)).toBeNull()
  })

  it('lists chat models only in the default and title selects', async () => {
    const image = catalogModel({ id: 'claude-image', name: 'Claude Image', kind: 'image' })
    const voice = catalogModel({ id: 'claude-voice', name: 'Claude Voice', kind: 'speech' })
    const transcribe = catalogModel({ id: 'claude-ears', name: 'Claude Ears', kind: 'transcription', hidden: true })
    models = [sonnet, image, voice, transcribe]
    await mountModels()
    for (const picker of [testIds.modelsDefaultPicker, testIds.modelsTitlePicker]) {
      const trigger = document.body.querySelector<HTMLButtonElement>(`[data-testid="${picker}"]`)!
      expect(trigger.dataset.kind).toBe('chat')
      trigger.click()
      await flushPromises()
      // Image, speech-to-text and text-to-speech models are chosen in Settings -> Media, even when visible.
      expect(selectOptions().map(option => option.dataset.modelRef)).toEqual(['', 'anthropic:claude-sonnet-5'])
      trigger.click()
      await settle()
    }
  })

  it('shows the kind of non-chat models instead of their capabilities', async () => {
    models = [
      sonnet,
      catalogModel({ id: 'claude-image', name: 'Claude Image', kind: 'image', hidden: true }),
      catalogModel({ id: 'claude-ears', name: 'Claude Ears', kind: 'transcription', hidden: true }),
      catalogModel({ id: 'claude-voice', name: 'Claude Voice', kind: 'speech', hidden: true }),
      catalogModel({ id: 'claude-embed', name: 'Claude Embed', kind: 'embedding', hidden: true }),
    ]
    await mountModels()
    const kindOf = (ref: string) => row(ref)!.querySelector<HTMLElement>('[data-slot="model-kind"]')
    expect(kindOf('anthropic:claude-image')!.textContent!.trim()).toBe('Image')
    expect(kindOf('anthropic:claude-ears')!.textContent!.trim()).toBe('Speech to text')
    expect(kindOf('anthropic:claude-voice')!.textContent!.trim()).toBe('Text to speech')
    expect(kindOf('anthropic:claude-voice')!.dataset.kind).toBe('speech')
    expect(kindOf('anthropic:claude-embed')!.textContent!.trim()).toBe('Embedding')
    expect(row('anthropic:claude-image')!.querySelector('[data-slot="model-caps"]')).toBeNull()
    // Chat models keep their capability icons.
    expect(kindOf('anthropic:claude-sonnet-5')).toBeNull()
    expect(row('anthropic:claude-sonnet-5')!.querySelector('[data-slot="model-caps"]')).not.toBeNull()
  })

  it('adds a custom text-to-speech model: the Kind select, no context window or capabilities, the kind badge', async () => {
    api.models.addCustom.mockImplementation(async ({ body }: { body: { providerId: string, modelId: string, name?: string, kind?: CatalogModel['kind'] } }) => {
      const added = catalogModel({
        providerId: body.providerId,
        id: body.modelId,
        name: body.name ?? body.modelId,
        kind: body.kind ?? 'chat',
        hidden: (body.kind ?? 'chat') !== 'chat',
        custom: true,
        source: 'custom',
        contextWindow: null,
        capabilities: { tools: false, vision: false, pdf: false, reasoning: false, structuredOutput: false, imageOutput: false },
      })
      models = [...models, added]
      return added
    })
    models = [sonnet]
    await mountModels()
    section('anthropic')!.querySelector<HTMLButtonElement>(`[data-testid="${testIds.customModelAdd}"]`)!.click()
    await flushPromises()

    const dialog = document.body.querySelector<HTMLElement>(`[data-testid="${testIds.customModelDialog}"]`)!
    const kind = dialog.querySelector<HTMLElement>('[data-slot="select-trigger"]')!
    const capabilities = dialog.querySelector<HTMLElement>('fieldset')!
    const contextWindow = [...dialog.querySelectorAll('label')].find(label => label.textContent?.trim() === 'Context window')!.parentElement!
    expect(kind.dataset.value).toBe('chat')
    expect(kind.textContent).toContain('Chat')
    expect(capabilities.style.display).toBe('')
    expect(contextWindow.style.display).toBe('')
    expect(dialog.textContent).toContain('It appears in the model picker right away.')

    press(kind, 'Enter')
    await settle()
    const items = [...document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')]
    expect(items.map(item => item.textContent?.trim())).toEqual(['Chat', 'Image', 'Speech to text', 'Text to speech'])
    press(items.find(item => item.dataset.value === 'speech')!, 'Enter')
    await settle(5)

    expect(kind.dataset.value).toBe('speech')
    expect(kind.textContent).toContain('Text to speech')
    expect(capabilities.style.display).toBe('none')
    expect(contextWindow.style.display).toBe('none')
    expect(dialog.textContent).toContain('Choose it in Settings → Media.')

    const id = dialog.querySelector<HTMLInputElement>(`[data-testid="${testIds.customModelId}"]`)!
    id.value = 'claude-voice-preview'
    id.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    document.body.querySelector<HTMLButtonElement>(`[data-testid="${testIds.customModelSave}"]`)!.click()
    await flushPromises()

    expect(api.models.addCustom).toHaveBeenCalledWith({
      body: { providerId: 'anthropic', modelId: 'claude-voice-preview', kind: 'speech' },
    })
    expect(document.body.querySelector(`[data-testid="${testIds.customModelDialog}"]`)).toBeNull()
    const added = row('anthropic:claude-voice-preview')!
    expect(added.textContent).toContain('Custom')
    expect(added.querySelector('[data-slot="model-kind"]')!.textContent!.trim()).toBe('Text to speech')
  })

  it('does not let a hidden context window block a custom model of another kind', async () => {
    api.models.addCustom.mockImplementation(async ({ body }: { body: { providerId: string, modelId: string, kind?: CatalogModel['kind'] } }) =>
      catalogModel({ providerId: body.providerId, id: body.modelId, kind: body.kind ?? 'chat', custom: true, source: 'custom' }))
    models = [sonnet]
    await mountModels()
    section('anthropic')!.querySelector<HTMLButtonElement>(`[data-testid="${testIds.customModelAdd}"]`)!.click()
    await flushPromises()
    const dialog = document.body.querySelector<HTMLElement>(`[data-testid="${testIds.customModelDialog}"]`)!
    const inputs = [...dialog.querySelectorAll<HTMLInputElement>('input')]
    const id = dialog.querySelector<HTMLInputElement>(`[data-testid="${testIds.customModelId}"]`)!
    const contextWindow = inputs.find(input => input.placeholder === 'Tokens')!
    id.value = 'gpt-image-2'
    id.dispatchEvent(new Event('input', { bubbles: true }))
    contextWindow.value = 'lots'
    contextWindow.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    document.body.querySelector<HTMLButtonElement>(`[data-testid="${testIds.customModelSave}"]`)!.click()
    await flushPromises()
    expect(dialog.textContent).toContain('Enter a number of tokens, e.g. 128000 or 128K.')
    expect(api.models.addCustom).not.toHaveBeenCalled()

    const kind = dialog.querySelector<HTMLElement>('[data-slot="select-trigger"]')!
    press(kind, 'Enter')
    await settle()
    press(document.body.querySelector<HTMLElement>('[data-slot="select-item"][data-value="image"]')!, 'Enter')
    await settle(5)
    expect(dialog.textContent).toContain('Image models appear in the model picker when the provider can generate images.')
    document.body.querySelector<HTMLButtonElement>(`[data-testid="${testIds.customModelSave}"]`)!.click()
    await flushPromises()
    expect(api.models.addCustom).toHaveBeenCalledWith({ body: { providerId: 'anthropic', modelId: 'gpt-image-2', kind: 'image' } })
  })

  it('points to the providers page when nothing is connected', async () => {
    api.providers.list.mockResolvedValue({ items: [unconfigured] })
    const wrapper = await mountModels()
    expect(wrapper.text()).toContain('No connected providers')
    expect(wrapper.get('a[href="/settings/providers"]').text()).toBe('Connect a provider')
  })
})
