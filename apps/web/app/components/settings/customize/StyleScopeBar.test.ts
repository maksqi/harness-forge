// StyleScopeBar (docs/UI.md 9.13, 10.8; W11.8-T6): "Your default" without a project (the setting `outputStyle`), "Style
// in {project}" with Same as your default and the line "Your default: {name}" with one (`projects.update`), and a
// chosen style that is no longer an option.
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { styleOptions } from '~/components/chat/composer/output-style'
import { useProjectsStore } from '~/stores/projects'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import { projectId, projectSummary, settings, styleEntry } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import StyleScopeBar from './StyleScopeBar.vue'

const mocks = vi.hoisted(() => ({ api: null as unknown, toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), mocks.toast) }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.toast.error.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
})

const options = styleOptions([styleEntry()])

function trigger(): HTMLElement {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testIds.customizeStyleDefault}"]`)!
}

async function choose(value: string): Promise<void> {
  trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await flushPromises()
  const item = [...document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')].find(option => option.dataset.value === value)!
  item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await flushPromises()
}

describe('styleScopeBar', () => {
  it('shows and writes the global default without a project', async () => {
    api.settings.update.mockImplementation(async ({ body }: { body: object }) => settings(body))
    const wrapper = mount(StyleScopeBar, { props: { projectId: null, projectName: null, options }, attachTo: document.body, global: { plugins: [pinia] } })
    expect(trigger().dataset.value).toBe('default')
    expect(trigger().textContent?.trim()).toBe('Default')
    expect(wrapper.text()).toContain('Your default')
    expect(wrapper.text()).not.toContain('Your default:')
    await choose('terse')
    expect(api.settings.update).toHaveBeenCalledWith({ body: { outputStyle: 'terse' } })
    expect(trigger().dataset.value).toBe('terse')
    expect(trigger().textContent?.trim()).toBe('Terse')
    wrapper.unmount()
  })

  it('shows the project\'s style or Same as your default, and writes the project', async () => {
    useSettingsStore().settings = settings({ outputStyle: 'explanatory' })
    const projects = useProjectsStore()
    projects.items = [projectSummary({ outputStyle: 'terse' }), projectSummary({ id: projectId(2), name: 'notes', outputStyle: null })]
    api.projects.update.mockImplementation(async ({ body }: { body: object }) => projectSummary({ ...body }))
    const styled = mount(StyleScopeBar, { props: { projectId: projectId(1), projectName: 'website', options }, attachTo: document.body, global: { plugins: [pinia] } })
    expect(trigger().dataset.value).toBe('terse')
    expect(styled.text()).toContain('Style in website')
    expect(styled.text()).toContain('Your default: Explanatory')
    await choose('')
    expect(api.projects.update).toHaveBeenCalledWith({ params: { id: projectId(1) }, body: { outputStyle: null } })
    styled.unmount()
    document.body.replaceChildren()

    const same = mount(StyleScopeBar, { props: { projectId: projectId(2), projectName: 'notes', options }, attachTo: document.body, global: { plugins: [pinia] } })
    expect(trigger().dataset.value).toBe('')
    expect(trigger().textContent?.trim()).toBe('Same as your default')
    await choose('learning')
    expect(api.projects.update).toHaveBeenLastCalledWith({ params: { id: projectId(2) }, body: { outputStyle: 'learning' } })
    same.unmount()
  })

  it('lists a chosen style that is not an option as not available and toasts a failed save', async () => {
    useSettingsStore().settings = settings({ outputStyle: 'gone' })
    api.settings.update.mockRejectedValue(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    const wrapper = mount(StyleScopeBar, { props: { projectId: null, projectName: null, options }, attachTo: document.body, global: { plugins: [pinia] } })
    expect(trigger().textContent?.trim()).toBe('gone')
    trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()
    const missing = [...document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')].find(option => option.dataset.value === 'gone')!
    expect(missing.textContent).toContain('Not available')
    missing.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    await choose('learning')
    expect(mocks.toast.error).toHaveBeenCalledWith('Something went wrong', { description: 'Disk full.' })
    wrapper.unmount()
  })
})
