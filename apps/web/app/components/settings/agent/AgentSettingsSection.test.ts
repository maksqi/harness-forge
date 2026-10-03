// Settings -> General -> Agent (docs/UI.md 9.11): Automatic compaction, the compaction and sub-agent model selects
// ("Same model as the chat" = null, the warning of a sub-agent model without tools) and Sub-agent max steps (1-200 with
// the rules of Max steps). Every field saves through settings.update and rolls back with a toast on failure.
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
import { SAME_MODEL_LABEL, subagentModelWarning } from './agent-settings'
import AgentSettingsSection from './AgentSettingsSection.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

const NO_CAPS = { tools: false, vision: false, pdf: false, reasoning: false, structuredOutput: false, imageOutput: false }
const anthropic = providerSummary()
const sonnet = catalogModel({ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' })
const haiku = catalogModel({ id: 'claude-haiku-5', name: 'Claude Haiku 5' })
const noTools = catalogModel({ id: 'tiny-chat', name: 'Tiny Chat', capabilities: NO_CAPS })

let pinia: ReturnType<typeof createPinia>
let api: MockApi
let wrapper: VueWrapper | null = null
let saved: Settings

function preloadCatalog() {
  useProvidersStore().items = [anthropic]
  useProvidersStore().loaded = true
  useModelsStore().items = [sonnet, haiku, noTools]
  useModelsStore().loaded = true
}

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

async function mountAgent() {
  const Host = defineComponent({ setup: () => () => h(TooltipProvider, null, { default: () => h(AgentSettingsSection) }) })
  wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
  await flushPromises()
  return wrapper
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.body.querySelector<T>(`[data-testid="${id}"]`)
  expect(element, id).not.toBeNull()
  return element!
}

function option(modelRef: string): HTMLElement {
  const element = document.body.querySelector<HTMLElement>(`[data-testid="${testIds.modelSelectOption}"][data-model-ref="${modelRef}"]`)
  expect(element, modelRef).not.toBeNull()
  return element!
}

/** Opens the model select `id` and picks `modelRef` ('' = "Same model as the chat"). */
async function pick(id: string, modelRef: string) {
  byTestId(id).click()
  await flushPromises()
  option(modelRef).click()
  await flushPromises()
}

function warning(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-slot="subagent-model-warning"]')
}

describe('agentSettingsSection', () => {
  it('renders the Agent section with its four fields and the defaults', async () => {
    preloadCatalog()
    const host = await mountAgent()
    const section = host.get('[data-slot="settings-section"]')
    expect(section.get('h2').text()).toBe('Agent')
    expect(section.text()).toContain('Long chats and sub-agents.')
    expect(section.text()).toContain('Automatic compaction')
    expect(section.text()).toContain('Summarize older messages when a chat nears the model\'s context window. When off, older messages are left out instead.')
    expect(section.text()).toContain('Compaction model')
    expect(section.text()).toContain('Sub-agent model')
    expect(section.text()).toContain('Sub-agent max steps')
    expect(section.text()).toContain('How many tool calls one sub-agent may chain (1–200).')

    expect(byTestId(testIds.settingsAutoCompact).getAttribute('aria-checked')).toBe('true')
    for (const [id, label] of [[testIds.settingsCompactionModel, 'Compaction model'], [testIds.settingsSubagentModel, 'Sub-agent model']] as const) {
      const trigger = byTestId(id)
      expect(trigger.dataset.value).toBe('')
      expect(trigger.textContent).toContain(SAME_MODEL_LABEL)
      expect(trigger.getAttribute('aria-label')).toBe(`${label}, Same model as the chat`)
      // The visible label points at the trigger.
      expect(section.find(`label[for="${trigger.id}"]`).text()).toBe(label)
    }
    const steps = byTestId<HTMLInputElement>(testIds.settingsSubagentMaxSteps)
    expect(steps.value).toBe('30')
    expect(steps.getAttribute('inputmode')).toBe('numeric')
    expect(warning()).toBeNull()
  })

  it('saves Automatic compaction at once and rolls it back with a toast when saving fails', async () => {
    preloadCatalog()
    await mountAgent()
    const toggle = byTestId(testIds.settingsAutoCompact)
    toggle.click()
    await flushPromises()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { autoCompact: false } })
    expect(useSettingsStore().resolved.autoCompact).toBe(false)
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    api.settings.update.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    toggle.click()
    await flushPromises()
    expect(api.settings.update).toHaveBeenLastCalledWith({ body: { autoCompact: true } })
    expect(toasts.error).toHaveBeenCalledWith('Something went wrong', { description: 'Disk full.' })
    expect(useSettingsStore().resolved.autoCompact).toBe(false)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('saves the compaction model as compactModelRef, and "Same model as the chat" as null', async () => {
    preloadCatalog()
    await mountAgent()
    await pick(testIds.settingsCompactionModel, haiku.ref)
    expect(api.settings.update).toHaveBeenCalledWith({ body: { compactModelRef: 'anthropic:claude-haiku-5' } })
    expect(useSettingsStore().resolved.compactModelRef).toBe('anthropic:claude-haiku-5')
    expect(byTestId(testIds.settingsCompactionModel).dataset.value).toBe('anthropic:claude-haiku-5')
    // The sub-agent model is a separate setting.
    expect(useSettingsStore().resolved.subagentModelRef).toBeNull()

    await pick(testIds.settingsCompactionModel, '')
    expect(api.settings.update).toHaveBeenLastCalledWith({ body: { compactModelRef: null } })
    expect(byTestId(testIds.settingsCompactionModel).dataset.value).toBe('')
    expect(toasts.error).not.toHaveBeenCalled()
  })

  it('lists the chat models after "Same model as the chat"', async () => {
    preloadCatalog()
    await mountAgent()
    byTestId(testIds.settingsSubagentModel).click()
    await flushPromises()
    const refs = [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.modelSelectOption}"]`)].map(item => item.dataset.modelRef)
    expect(refs).toEqual(['', sonnet.ref, haiku.ref, noTools.ref])
    expect(option('').textContent).toContain(SAME_MODEL_LABEL)
    expect(option('').dataset.checked).toBe('true')
  })

  it('saves the sub-agent model and rolls a failed choice back with a toast', async () => {
    preloadCatalog()
    await mountAgent()
    await pick(testIds.settingsSubagentModel, haiku.ref)
    expect(api.settings.update).toHaveBeenCalledWith({ body: { subagentModelRef: 'anthropic:claude-haiku-5' } })
    expect(byTestId(testIds.settingsSubagentModel).dataset.value).toBe('anthropic:claude-haiku-5')

    api.settings.update.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    await pick(testIds.settingsSubagentModel, sonnet.ref)
    expect(api.settings.update).toHaveBeenLastCalledWith({ body: { subagentModelRef: 'anthropic:claude-sonnet-5' } })
    expect(toasts.error).toHaveBeenCalledWith('Something went wrong', { description: 'Disk full.' })
    expect(useSettingsStore().resolved.subagentModelRef).toBe('anthropic:claude-haiku-5')
    expect(byTestId(testIds.settingsSubagentModel).dataset.value).toBe('anthropic:claude-haiku-5')
  })

  it('warns when the sub-agent model can\'t call tools', async () => {
    preloadCatalog()
    await mountAgent()
    await pick(testIds.settingsSubagentModel, noTools.ref)
    expect(api.settings.update).toHaveBeenCalledWith({ body: { subagentModelRef: 'anthropic:tiny-chat' } })
    const note = warning()!
    expect(note.textContent?.trim()).toBe('Tiny Chat can\'t call tools, so sub-agents can\'t use it.')
    expect(byTestId(testIds.settingsSubagentModel).getAttribute('aria-describedby')).toBe(note.id)

    // The compaction model needs no tools.
    await pick(testIds.settingsCompactionModel, noTools.ref)
    expect(document.body.querySelectorAll('[data-slot="subagent-model-warning"]')).toHaveLength(1)

    await pick(testIds.settingsSubagentModel, sonnet.ref)
    expect(warning()).toBeNull()
    expect(byTestId(testIds.settingsSubagentModel).hasAttribute('aria-describedby')).toBe(false)

    await pick(testIds.settingsSubagentModel, '')
    expect(warning()).toBeNull()
  })

  it('shows no warning for a sub-agent model the catalog does not know', async () => {
    preloadCatalog()
    useSettingsStore().settings = { ...saved, subagentModelRef: 'gone:old-model' }
    await mountAgent()
    expect(byTestId(testIds.settingsSubagentModel).dataset.value).toBe('gone:old-model')
    expect(warning()).toBeNull()
  })

  it('loads the model catalog when nothing loaded it yet', async () => {
    useSettingsStore().settings = { ...saved, subagentModelRef: noTools.ref }
    api.providers.list.mockResolvedValue({ items: [anthropic] })
    api.models.list.mockResolvedValue({ items: [sonnet, noTools] })
    await mountAgent()
    expect(api.providers.list).toHaveBeenCalledTimes(1)
    expect(api.models.list).toHaveBeenCalledWith({ query: { includeHidden: true } })
    expect(warning()?.textContent).toContain('Tiny Chat can\'t call tools')
  })

  it('validates Sub-agent max steps (1 to 200) and saves a valid value', async () => {
    preloadCatalog()
    await mountAgent()
    const input = wrapper!.get(`[data-testid="${testIds.settingsSubagentMaxSteps}"]`)

    for (const value of ['0', '201', 'ten', '2.5', '']) {
      await input.trigger('focus')
      await input.setValue(value)
      await input.trigger('blur')
      await flushPromises()
      expect(wrapper!.text()).toContain('Enter a whole number from 1 to 200.')
      expect(input.attributes('aria-invalid')).toBe('true')
    }
    expect(api.settings.update).not.toHaveBeenCalled()
    expect(useSettingsStore().resolved.subagentMaxSteps).toBe(30)

    // Esc restores the saved value and clears the error.
    await input.trigger('focus')
    await input.trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect((input.element as HTMLInputElement).value).toBe('30')
    expect(input.attributes('aria-invalid')).toBeUndefined()

    // An unchanged value saves nothing.
    await input.trigger('focus')
    await input.setValue(' 30 ')
    await input.trigger('blur')
    await flushPromises()
    expect(api.settings.update).not.toHaveBeenCalled()

    await input.trigger('focus')
    await input.setValue(' 50 ')
    await input.trigger('keydown', { key: 'Enter' })
    await input.trigger('blur')
    await flushPromises()
    expect(api.settings.update).toHaveBeenCalledTimes(1)
    expect(api.settings.update).toHaveBeenCalledWith({ body: { subagentMaxSteps: 50 } })
    expect(useSettingsStore().resolved.subagentMaxSteps).toBe(50)
    expect((input.element as HTMLInputElement).value).toBe('50')
    expect(wrapper!.text()).not.toContain('Enter a whole number from 1 to 200.')
  })

  it('restores Sub-agent max steps with a toast when saving fails', async () => {
    preloadCatalog()
    api.settings.update.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    await mountAgent()
    const input = wrapper!.get(`[data-testid="${testIds.settingsSubagentMaxSteps}"]`)
    await input.trigger('focus')
    await input.setValue('200')
    await input.trigger('blur')
    await flushPromises()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { subagentMaxSteps: 200 } })
    expect(toasts.error).toHaveBeenCalledWith('Something went wrong', { description: 'Disk full.' })
    expect(useSettingsStore().resolved.subagentMaxSteps).toBe(30)
    expect((input.element as HTMLInputElement).value).toBe('30')
  })

  it('shows a saved value that arrives later unless the user is editing', async () => {
    preloadCatalog()
    await mountAgent()
    const input = wrapper!.get(`[data-testid="${testIds.settingsSubagentMaxSteps}"]`)
    useSettingsStore().settings = { ...saved, subagentMaxSteps: 12 }
    await flushPromises()
    expect((input.element as HTMLInputElement).value).toBe('12')

    await input.trigger('focus')
    await input.setValue('7')
    useSettingsStore().settings = { ...saved, subagentMaxSteps: 15 }
    await flushPromises()
    expect((input.element as HTMLInputElement).value).toBe('7')
  })
})

describe('agent settings rules', () => {
  it('warns only for a known model without tool calls', () => {
    expect(subagentModelWarning(undefined)).toBeNull()
    expect(subagentModelWarning(sonnet)).toBeNull()
    expect(subagentModelWarning(noTools)).toBe('Tiny Chat can\'t call tools, so sub-agents can\'t use it.')
    expect(SAME_MODEL_LABEL).toBe('Same model as the chat')
  })
})
