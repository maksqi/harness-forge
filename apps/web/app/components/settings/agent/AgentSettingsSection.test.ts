// Settings -> General -> Agent (docs/UI.md 9.11): Automatic compaction, the compaction and sub-agent model selects
// ("Same model as the chat" = null, the warning of a sub-agent model without tools), Sub-agent max steps (1-200 with
// the rules of Max steps) and (Phase 10) Save approved plans and Plan folder. Every field saves through settings.update
// and rolls back with a toast on failure; the plan folder shows a server 400 inline.
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
import {
  PLAN_DIRECTORY_FOLDER_ERROR,
  PLAN_DIRECTORY_LENGTH_ERROR,
  PLAN_DIRECTORY_PLACEHOLDER,
  planDirectoryError,
  SAME_MODEL_LABEL,
  subagentModelWarning,
} from './agent-settings'
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
  it('renders the Agent section with its fields and the defaults', async () => {
    preloadCatalog()
    const host = await mountAgent()
    const section = host.get('[data-slot="settings-section"]')
    expect(section.get('h2').text()).toBe('Agent')
    expect(section.text()).toContain('Long chats, sub-agents and plans.')
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

describe('agentSettingsSection: plan files (Phase 10)', () => {
  function planFiles(): HTMLElement {
    return byTestId(testIds.settingsPlanFiles)
  }

  function planDirectory() {
    return wrapper!.get<HTMLInputElement>(`[data-testid="${testIds.settingsPlanDirectory}"]`)
  }

  function fieldError(): string | null {
    const input = planDirectory().element
    return input.closest('[data-slot="field"]')!.querySelector('[data-slot="field-error"]')?.textContent?.trim() ?? null
  }

  async function commit(value: string, key: 'Enter' | null = null) {
    const input = planDirectory()
    await input.trigger('focus')
    await input.setValue(value)
    if (key)
      await input.trigger('keydown', { key })
    await input.trigger('blur')
    await flushPromises()
  }

  async function mountWithPlanFiles(on: boolean) {
    preloadCatalog()
    saved = { ...saved, planFiles: on }
    useSettingsStore().settings = { ...saved }
    await mountAgent()
  }

  it('renders Save approved plans (off) and Plan folder (disabled, mono, the default folder) after Sub-agent max steps', async () => {
    preloadCatalog()
    const host = await mountAgent()
    const text = host.text()
    expect(text).toContain('Save approved plans')
    expect(text).toContain('When you approve a plan in a project chat, it\'s saved as a Markdown file in the project.')
    expect(text).toContain('Plan folder')
    expect(text).toContain('A folder inside the project. Files are named by date and plan title.')
    expect(text.indexOf('Sub-agent max steps')).toBeLessThan(text.indexOf('Save approved plans'))
    expect(text.indexOf('Save approved plans')).toBeLessThan(text.indexOf('Plan folder'))

    const toggle = planFiles()
    expect(toggle.getAttribute('role')).toBe('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.dataset.state).toBe('unchecked')
    expect(host.find(`label[for="${toggle.id}"]`).text()).toBe('Save approved plans')

    const input = planDirectory()
    expect(input.element.value).toBe('.harness/plans')
    expect(input.attributes('placeholder')).toBe('.harness/plans')
    expect(PLAN_DIRECTORY_PLACEHOLDER).toBe('.harness/plans')
    expect(input.element.disabled).toBe(true)
    expect(input.classes()).toContain('font-mono')
    expect(host.find(`label[for="${input.element.id}"]`).text()).toBe('Plan folder')
    // The help text describes the input.
    const help = document.getElementById(input.attributes('aria-describedby')!)
    expect(help?.textContent?.trim()).toBe('A folder inside the project. Files are named by date and plan title.')
  })

  it('saves Save approved plans at once, enables Plan folder, and rolls a failed save back with a toast', async () => {
    preloadCatalog()
    await mountAgent()
    planFiles().click()
    await flushPromises()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { planFiles: true } })
    expect(useSettingsStore().resolved.planFiles).toBe(true)
    expect(planFiles().getAttribute('aria-checked')).toBe('true')
    expect(planDirectory().element.disabled).toBe(false)

    api.settings.update.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    planFiles().click()
    await flushPromises()
    expect(api.settings.update).toHaveBeenLastCalledWith({ body: { planFiles: false } })
    expect(toasts.error).toHaveBeenCalledWith('Something went wrong', { description: 'Disk full.' })
    expect(useSettingsStore().resolved.planFiles).toBe(true)
    expect(planDirectory().element.disabled).toBe(false)
  })

  it('checks the plan folder like the server and keeps the saved value', async () => {
    await mountWithPlanFiles(true)
    const cases: Array<[string, string]> = [
      ['', PLAN_DIRECTORY_FOLDER_ERROR],
      ['   ', PLAN_DIRECTORY_FOLDER_ERROR],
      ['/srv/plans', PLAN_DIRECTORY_FOLDER_ERROR],
      ['\\plans', PLAN_DIRECTORY_FOLDER_ERROR],
      ['C:/plans', PLAN_DIRECTORY_FOLDER_ERROR],
      ['../plans', PLAN_DIRECTORY_FOLDER_ERROR],
      ['docs/../../plans', PLAN_DIRECTORY_FOLDER_ERROR],
      ['./plans', PLAN_DIRECTORY_FOLDER_ERROR],
      ['docs//plans', PLAN_DIRECTORY_FOLDER_ERROR],
      ['.git/plans', PLAN_DIRECTORY_FOLDER_ERROR],
      ['docs/.GIT', PLAN_DIRECTORY_FOLDER_ERROR],
      ['a'.repeat(201), PLAN_DIRECTORY_LENGTH_ERROR],
    ]
    for (const [value, error] of cases) {
      await commit(value)
      expect(fieldError(), value).toBe(error)
      expect(planDirectory().attributes('aria-invalid')).toBe('true')
      expect(planDirectory().element.value).toBe(value)
    }
    expect(api.settings.update).not.toHaveBeenCalled()
    expect(useSettingsStore().resolved.planDirectory).toBe('.harness/plans')
    expect(fieldError()).toBe('Use at most 200 characters.')
    // The error is announced with the help text.
    const describedBy = planDirectory().attributes('aria-describedby')!.split(' ')
    expect(describedBy).toHaveLength(2)
    expect(document.getElementById(describedBy[1]!)?.textContent?.trim()).toBe('Use at most 200 characters.')

    // Esc restores the saved value and clears the error.
    await planDirectory().trigger('focus')
    await planDirectory().trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(planDirectory().element.value).toBe('.harness/plans')
    expect(fieldError()).toBeNull()
    expect(planDirectory().attributes('aria-invalid')).toBeUndefined()
    expect(planDirectory().attributes('aria-describedby')!.split(' ')).toHaveLength(1)
    expect(api.settings.update).not.toHaveBeenCalled()
  })

  it('saves the trimmed plan folder on Enter or blur, and nothing for an unchanged value', async () => {
    await mountWithPlanFiles(true)
    await commit('  .harness/plans  ')
    expect(api.settings.update).not.toHaveBeenCalled()
    expect(planDirectory().element.value).toBe('.harness/plans')

    await commit('  docs/plans  ', 'Enter')
    expect(api.settings.update).toHaveBeenCalledTimes(1)
    expect(api.settings.update).toHaveBeenCalledWith({ body: { planDirectory: 'docs/plans' } })
    expect(useSettingsStore().resolved.planDirectory).toBe('docs/plans')
    expect(planDirectory().element.value).toBe('docs/plans')

    const longest = `p/${'a'.repeat(198)}`
    await commit(longest)
    expect(api.settings.update).toHaveBeenLastCalledWith({ body: { planDirectory: longest } })
    expect(fieldError()).toBeNull()
    expect(toasts.error).not.toHaveBeenCalled()
  })

  it('shows a 400 from the server inline and keeps the saved value', async () => {
    await mountWithPlanFiles(true)
    api.settings.update.mockRejectedValueOnce(new HarnessError({ code: 'validation_error', message: 'Invalid settings.' }))
    await commit('notes/plans')
    await flushPromises()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { planDirectory: 'notes/plans' } })
    expect(toasts.error).not.toHaveBeenCalled()
    expect(useSettingsStore().resolved.planDirectory).toBe('.harness/plans')
    expect(fieldError()).toBe(PLAN_DIRECTORY_FOLDER_ERROR)
    expect(planDirectory().element.value).toBe('notes/plans')
  })

  it('restores the saved plan folder with a toast when saving fails otherwise', async () => {
    await mountWithPlanFiles(true)
    api.settings.update.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    await commit('notes/plans')
    expect(toasts.error).toHaveBeenCalledWith('Something went wrong', { description: 'Disk full.' })
    expect(useSettingsStore().resolved.planDirectory).toBe('.harness/plans')
    expect(planDirectory().element.value).toBe('.harness/plans')
    expect(fieldError()).toBeNull()
  })

  it('drops an invalid draft when plan files are turned off', async () => {
    await mountWithPlanFiles(true)
    await commit('../plans')
    expect(fieldError()).toBe(PLAN_DIRECTORY_FOLDER_ERROR)
    planFiles().click()
    await flushPromises()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { planFiles: false } })
    expect(planDirectory().element.disabled).toBe(true)
    expect(planDirectory().element.value).toBe('.harness/plans')
    expect(fieldError()).toBeNull()
  })

  it('shows a saved plan folder that arrives later unless the user is editing', async () => {
    await mountWithPlanFiles(true)
    useSettingsStore().settings = { ...saved, planDirectory: 'docs/plans' }
    await flushPromises()
    expect(planDirectory().element.value).toBe('docs/plans')

    await planDirectory().trigger('focus')
    await planDirectory().setValue('mine')
    useSettingsStore().settings = { ...saved, planDirectory: 'other/plans' }
    await flushPromises()
    expect(planDirectory().element.value).toBe('mine')
  })

  it('gives the switches and inputs 40px targets on coarse pointers', async () => {
    preloadCatalog()
    await mountAgent()
    for (const id of [testIds.settingsAutoCompact, testIds.settingsPlanFiles])
      expect(byTestId(id).className, id).toContain('pointer-coarse:after:-inset-y-[11px]')
    for (const id of [testIds.settingsSubagentMaxSteps, testIds.settingsPlanDirectory])
      expect(byTestId(id).className, id).toContain('pointer-coarse:h-10')
  })
})

describe('agent settings rules', () => {
  it('warns only for a known model without tool calls', () => {
    expect(subagentModelWarning(undefined)).toBeNull()
    expect(subagentModelWarning(sonnet)).toBeNull()
    expect(subagentModelWarning(noTools)).toBe('Tiny Chat can\'t call tools, so sub-agents can\'t use it.')
    expect(SAME_MODEL_LABEL).toBe('Same model as the chat')
  })

  it('checks the plan folder with the shared settings schema', () => {
    for (const value of ['.harness/plans', 'plans', 'docs/plans', ' docs/plans ', 'docs\\plans', '.plans/2026', 'a'.repeat(200)])
      expect(planDirectoryError(value), value).toBeNull()
    for (const value of ['', ' ', '/plans', '\\plans', 'c:plans', '..', 'a/..', 'a/./b', 'a//b', 'a/', '.git', 'x/.Git/y', 'tab\tname'])
      expect(planDirectoryError(value), value).toBe('Use a folder inside the project, like .harness/plans.')
    expect(planDirectoryError('a'.repeat(201))).toBe('Use at most 200 characters.')
    expect(planDirectoryError(`/${'a'.repeat(250)}`)).toBe('Use at most 200 characters.')
  })
})
