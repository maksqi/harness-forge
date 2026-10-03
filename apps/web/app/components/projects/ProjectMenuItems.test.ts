// ProjectMenuItems (docs/UI.md 7.20, 10.4): radio items inside the caller's menu content, the "No project" item, the
// projects sorted by name with their path, the missing-folder warning and the select event.
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'
import { projectId, projectSummary } from '~/utils/testing/fixtures'
import ProjectMenuItems from './ProjectMenuItems.vue'

vi.mock('~/composables/useApi', () => ({ useApi: () => ({}) }))

let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  useProjectsStore().items = [
    projectSummary({ id: projectId(1), name: 'Website' }),
    projectSummary({ id: projectId(2), name: 'API', path: '/srv/workspaces/api' }),
    projectSummary({ id: projectId(3), name: 'Notes', path: '/srv/workspaces/notes', available: false, issue: 'The folder does not exist.' }),
  ]
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
})

function mountItems(props: { modelValue: string | null, includeNone?: boolean }) {
  const onSelect = vi.fn()
  const Host = defineComponent({
    setup: () => () => h(DropdownMenu, { open: true }, {
      default: () => [
        h(DropdownMenuTrigger, null, { default: () => 'Move to project' }),
        h(DropdownMenuContent, null, { default: () => h(ProjectMenuItems, { ...props, onSelect }) }),
      ],
    }),
  })
  const wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
  return { wrapper, onSelect }
}

function options(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.projectOption}"]`)]
}

describe('projectMenuItems', () => {
  it('lists No project, then the projects by name, with the selected one checked', async () => {
    const { wrapper } = mountItems({ modelValue: projectId(1) })
    await flushPromises()
    expect(options().map(option => option.dataset.value)).toEqual(['none', projectId(2), projectId(3), projectId(1)])
    expect(options().map(option => option.dataset.state)).toEqual(['unchecked', 'unchecked', 'unchecked', 'checked'])
    expect(options().map(option => option.getAttribute('role'))).toEqual(['menuitemradio', 'menuitemradio', 'menuitemradio', 'menuitemradio'])
    expect(wrapper.findComponent(ProjectMenuItems).props()).toEqual({ modelValue: projectId(1), includeNone: true })
    wrapper.unmount()
  })

  it('leaves out No project with includeNone false and emits the picked project', async () => {
    const { wrapper, onSelect } = mountItems({ modelValue: null, includeNone: false })
    await flushPromises()
    expect(options().map(option => option.dataset.value)).toEqual([projectId(2), projectId(3), projectId(1)])
    options()[0]!.click()
    await flushPromises()
    expect(onSelect).toHaveBeenCalledWith(projectId(2))
    wrapper.unmount()
  })

  it('shows each path in mono on a second line and warns about a missing folder', async () => {
    const { wrapper } = mountItems({ modelValue: null })
    await flushPromises()
    const [, api, notes] = options()
    expect(api!.querySelector('.font-mono')?.textContent).toBe('/srv/workspaces/api')
    expect(api!.querySelector('.text-warning')).toBeNull()
    expect(notes!.querySelector('svg.text-warning')).not.toBeNull()
    expect(notes!.textContent).toContain('Notes, folder not found')
    wrapper.unmount()
  })

  it('emits nothing when the selected item is picked again', async () => {
    const { wrapper, onSelect } = mountItems({ modelValue: projectId(1) })
    await flushPromises()
    options().find(option => option.dataset.value === projectId(1))!.click()
    await flushPromises()
    expect(onSelect).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('emits null for No project', async () => {
    const { wrapper, onSelect } = mountItems({ modelValue: projectId(1) })
    await flushPromises()
    options()[0]!.click()
    await flushPromises()
    expect(onSelect).toHaveBeenCalledWith(null)
    wrapper.unmount()
  })
})
