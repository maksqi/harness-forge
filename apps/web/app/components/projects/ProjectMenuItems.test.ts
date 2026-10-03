// ProjectMenuItems skeleton (docs/UI.md 7.20, 10.4; C15, P7-0b): radio items inside the caller's menu content, the
// "No project" item, the projects sorted by name and the select event. W7.9 adds the path line and the missing-folder
// icon.
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
    expect(options().map(option => option.dataset.value)).toEqual(['none', projectId(2), projectId(1)])
    expect(options().map(option => option.dataset.state)).toEqual(['unchecked', 'unchecked', 'checked'])
    expect(wrapper.findComponent(ProjectMenuItems).props()).toEqual({ modelValue: projectId(1), includeNone: true })
    wrapper.unmount()
  })

  it('leaves out No project with includeNone false and emits the picked project', async () => {
    const { wrapper, onSelect } = mountItems({ modelValue: null, includeNone: false })
    await flushPromises()
    expect(options().map(option => option.dataset.value)).toEqual([projectId(2), projectId(1)])
    options()[0]!.click()
    await flushPromises()
    expect(onSelect).toHaveBeenCalledWith(projectId(2))
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
