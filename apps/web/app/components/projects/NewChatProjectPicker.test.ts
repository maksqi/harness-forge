// NewChatProjectPicker skeleton (docs/UI.md 7.20, 10.4; C15, P7-0b): hidden while no project exists, else the root
// pill with data-value. W7.9 adds the menu and the filter rule.
import { mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'
import { projectId, projectSummary } from '~/utils/testing/fixtures'
import NewChatProjectPicker from './NewChatProjectPicker.vue'

vi.mock('~/composables/useApi', () => ({ useApi: () => ({}) }))

let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
})

const root = `[data-testid="${testIds.newChatProject}"]`

describe('newChatProjectPicker', () => {
  it('renders nothing while no project exists', () => {
    const wrapper = mount(NewChatProjectPicker, { props: { modelValue: null }, global: { plugins: [pinia] } })
    expect(wrapper.find(root).exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders its root with the chosen project (none or the id) once projects exist', async () => {
    useProjectsStore().items = [projectSummary({ id: projectId(1), name: 'Website' })]
    const wrapper = mount(NewChatProjectPicker, { props: { modelValue: null }, global: { plugins: [pinia] } })
    const pill = wrapper.get(root)
    expect(pill.element).toBe(wrapper.element)
    expect(pill.attributes('data-value')).toBe('none')
    expect(pill.text()).toContain('No project')

    await wrapper.setProps({ modelValue: projectId(1), disabled: true })
    expect(pill.attributes('data-value')).toBe(projectId(1))
    expect(pill.text()).toContain('Website')
    expect(pill.attributes('disabled')).toBeDefined()
    expect(wrapper.props()).toEqual({ modelValue: projectId(1), disabled: true })
    wrapper.unmount()
  })
})
