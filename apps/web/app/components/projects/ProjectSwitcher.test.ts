// ProjectSwitcher skeleton (docs/UI.md 7.20, 10.4; C15, P7-0b): the root test id and its data-value follow the chats
// store filter. W7.9 adds the menu.
import { mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useChatsStore } from '~/stores/chats'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'
import { projectId, projectSummary } from '~/utils/testing/fixtures'
import { stubLocalStorage } from '~/utils/testing/storage'
import ProjectSwitcher from './ProjectSwitcher.vue'

vi.mock('~/composables/useApi', () => ({ useApi: () => ({}) }))

let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  stubLocalStorage()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
  vi.unstubAllGlobals()
})

describe('projectSwitcher', () => {
  it('renders its root with the current filter as data-value', async () => {
    useProjectsStore().items = [projectSummary({ id: projectId(1), name: 'Website' })]
    const chats = useChatsStore()
    const wrapper = mount(ProjectSwitcher, { global: { plugins: [pinia] } })
    const root = wrapper.get(`[data-testid="${testIds.projectSwitcher}"]`)
    expect(root.element).toBe(wrapper.element)
    expect(root.attributes('data-value')).toBe('all')
    expect(root.text()).toContain('All chats')

    await chats.setProjectFilter('none')
    await nextTick()
    expect(root.attributes('data-value')).toBe('none')
    expect(root.text()).toContain('No project')

    await chats.setProjectFilter(projectId(1))
    await nextTick()
    expect(root.attributes('data-value')).toBe(projectId(1))
    expect(root.text()).toContain('Website')
    wrapper.unmount()
  })
})
