// NewChatProjectPicker (docs/UI.md 7.20, 10.4; W7.9-T4): hidden while no project exists; the pill shows the v-model's
// project (No project for null or an unknown id); a pick updates the v-model, and also the chats store filter unless
// the filter is All chats.
import type { MockApi } from '~/utils/testing/mock-api'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { PROJECT_FILTER_KEY, useChatsStore } from '~/stores/chats'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'
import { projectId, projectSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import NewChatProjectPicker from './NewChatProjectPicker.vue'

const mocks = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let storage: Storage

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  storage = stubLocalStorage()
  pinia = createPinia()
  setActivePinia(pinia)
  api.chats.list.mockResolvedValue({ items: [], nextCursor: null })
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

const root = `[data-testid="${testIds.newChatProject}"]`

function seedProjects() {
  const projects = useProjectsStore()
  projects.items = [
    projectSummary({ id: projectId(1), name: 'Website' }),
    projectSummary({ id: projectId(2), name: 'Notes', path: '/srv/workspaces/notes', available: false }),
  ]
  projects.loaded = true
}

function mountPicker(initial: string | null) {
  const model = ref<string | null>(initial)
  const updates: Array<string | null> = []
  const Host = defineComponent({
    setup: () => () => h(NewChatProjectPicker, {
      'modelValue': model.value,
      'onUpdate:modelValue': (value: string | null) => {
        updates.push(value)
        model.value = value
      },
    }),
  })
  const wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
  return { wrapper, model, updates }
}

async function openAndPick(wrapper: ReturnType<typeof mount>, value: string) {
  wrapper.get(root).element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await flushPromises()
  const option = [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.projectOption}"]`)]
    .find(item => item.dataset.value === value)!
  option.click()
  await flushPromises()
}

describe('newChatProjectPicker', () => {
  it('renders nothing while no project exists, and loads the projects', async () => {
    api.projects.list.mockResolvedValueOnce({ items: [] })
    const wrapper = mount(NewChatProjectPicker, { props: { modelValue: null }, global: { plugins: [pinia] } })
    await flushPromises()
    expect(api.projects.list).toHaveBeenCalledTimes(1)
    expect(wrapper.find(root).exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows the chosen project, No project for null or an unknown id, and a missing folder', async () => {
    seedProjects()
    const wrapper = mount(NewChatProjectPicker, { props: { modelValue: null }, global: { plugins: [pinia] } })
    const pill = wrapper.get(root)
    expect(pill.attributes('data-value')).toBe('none')
    expect(pill.text()).toContain('No project')
    expect(pill.attributes('aria-haspopup')).toBe('menu')

    await wrapper.setProps({ modelValue: projectId(1) })
    expect(pill.attributes('data-value')).toBe(projectId(1))
    expect(pill.text()).toContain('Website')

    await wrapper.setProps({ modelValue: projectId(2) })
    expect(pill.attributes('aria-label')).toBe('Project: Notes, folder not found')
    expect(pill.find('svg.text-warning').exists()).toBe(true)

    await wrapper.setProps({ modelValue: projectId(9), disabled: true })
    expect(pill.attributes('data-value')).toBe('none')
    expect(pill.text()).toContain('No project')
    expect(pill.attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('updates the v-model and leaves the filter alone while it shows all chats', async () => {
    seedProjects()
    const { wrapper, model, updates } = mountPicker(null)
    await openAndPick(wrapper, projectId(1))
    expect(updates).toEqual([projectId(1)])
    expect(model.value).toBe(projectId(1))
    expect(useChatsStore().projectFilter).toBe('all')
    expect(api.chats.list).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('makes the filter follow the pick when it is not All chats (No project -> none)', async () => {
    storage.setItem(PROJECT_FILTER_KEY, projectId(2))
    seedProjects()
    const { wrapper, updates } = mountPicker(projectId(2))
    await openAndPick(wrapper, projectId(1))
    expect(updates).toEqual([projectId(1)])
    expect(useChatsStore().projectFilter).toBe(projectId(1))
    expect(api.chats.list).toHaveBeenLastCalledWith({ query: { limit: 50, projectId: projectId(1) } })

    await openAndPick(wrapper, 'none')
    expect(updates).toEqual([projectId(1), null])
    expect(useChatsStore().projectFilter).toBe('none')
    wrapper.unmount()
  })
})
