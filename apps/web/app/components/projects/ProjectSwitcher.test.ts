// ProjectSwitcher (docs/UI.md 5.3, 7.20, 10.4; W7.9-T3): the trigger follows the chats store filter, the menu lists All
// chats, No project and the projects (path and chat count), a pick reloads the list with `projectId`, "Add project…"
// opens the switcher's own dialog and filters by the new project, "Manage projects" links to Settings -> Projects.
import type { VueWrapper } from '@vue/test-utils'
import type { MockApi } from '~/utils/testing/mock-api'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { SidebarMenu, SidebarMenuItem } from '@/components/ui/sidebar'
import { allByTestId, byTestId, mountInShell, settle } from '~/components/app-shell/chat-nav/testing'
import { PROJECT_FILTER_KEY, useChatsStore } from '~/stores/chats'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'
import { projectId, projectSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import AddProjectDialog from './AddProjectDialog.vue'
import ProjectSwitcher from './ProjectSwitcher.vue'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  toast: Object.assign(vi.fn(), { custom: vi.fn(), error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
}))

vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let storage: Storage
let wrapper: VueWrapper | null = null

const website = projectSummary({ id: projectId(1), name: 'Website', path: '/srv/workspaces/website', chatCount: 12 })
const notes = projectSummary({ id: projectId(2), name: 'Notes', path: '/srv/workspaces/notes', chatCount: 1, available: false, issue: 'The folder does not exist.' })

const Host = defineComponent({
  setup: () => () => h(SidebarMenu, null, { default: () => h(SidebarMenuItem, null, { default: () => h(ProjectSwitcher) }) }),
})

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  storage = stubLocalStorage()
  pinia = createPinia()
  setActivePinia(pinia)
  api.chats.list.mockResolvedValue({ items: [], nextCursor: null })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  disposePinia(pinia)
  vi.unstubAllGlobals()
})

async function mountSwitcher(items = [website, notes]) {
  api.projects.list.mockResolvedValue({ items })
  wrapper = mountInShell(Host)
  await settle()
}

function trigger(): HTMLElement {
  return byTestId(testIds.projectSwitcher)!
}

async function openMenu() {
  trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await settle()
}

function options(): HTMLElement[] {
  return allByTestId(testIds.projectSwitcherOption)
}

describe('projectSwitcher: trigger', () => {
  it('shows the current filter: All chats, No project, a project, or its missing folder', async () => {
    await mountSwitcher()
    expect(api.projects.list).toHaveBeenCalledTimes(1)
    const chats = useChatsStore()
    expect(trigger().dataset.value).toBe('all')
    expect(trigger().textContent).toContain('All chats')
    expect(trigger().getAttribute('aria-label')).toBe('Project filter: All chats')
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu')

    await chats.setProjectFilter('none')
    await settle()
    expect(trigger().dataset.value).toBe('none')
    expect(trigger().getAttribute('aria-label')).toBe('Project filter: No project')

    await chats.setProjectFilter(projectId(1))
    await settle()
    expect(trigger().dataset.value).toBe(projectId(1))
    expect(trigger().textContent).toContain('Website')
    expect(trigger().querySelector('svg.text-warning\\!')).toBeNull()

    await chats.setProjectFilter(projectId(2))
    await settle()
    expect(trigger().textContent).toContain('Notes')
    expect(trigger().querySelector('svg.text-warning\\!')).not.toBeNull()
  })

  it('names a stored project "Project" until the projects arrive', async () => {
    storage.setItem(PROJECT_FILTER_KEY, projectId(1))
    api.projects.list.mockReturnValue(new Promise(() => {}))
    wrapper = mountInShell(Host)
    await settle()
    expect(trigger().dataset.value).toBe(projectId(1))
    expect(trigger().textContent).toContain('Project')
    expect(useProjectsStore().loading).toBe(true)
  })
})

describe('projectSwitcher: menu', () => {
  it('lists All chats, No project and the projects by name with path and chat count, then Add and Manage', async () => {
    await mountSwitcher()
    await openMenu()
    // Opening refreshes the projects (chat counts change without an event).
    expect(api.projects.list).toHaveBeenCalledTimes(2)
    expect(options().map(option => option.dataset.value)).toEqual(['all', 'none', projectId(2), projectId(1)])
    expect(options().map(option => option.dataset.state)).toEqual(['checked', 'unchecked', 'unchecked', 'unchecked'])
    const site = options()[3]!
    expect(site.textContent).toContain('Website')
    expect(site.querySelector('.font-mono')?.textContent).toBe('/srv/workspaces/website')
    expect(site.textContent).toContain('12')
    expect(options()[2]!.textContent).toContain('Notes, folder not found')
    expect(byTestId(testIds.projectAdd)?.textContent?.trim()).toBe('Add project…')
    const manage = byTestId(testIds.projectManage)!
    expect(manage.textContent?.trim()).toBe('Manage projects')
    expect(manage.getAttribute('href')).toBe('/settings/projects')
  })

  it('holds All chats, Add project… and Manage projects while no project exists', async () => {
    await mountSwitcher([])
    await openMenu()
    expect(options().map(option => option.dataset.value)).toEqual(['all'])
    expect(byTestId(testIds.projectAdd)).not.toBeNull()
    expect(byTestId(testIds.projectManage)).not.toBeNull()
  })

  it('filters the list by the picked option and remembers it', async () => {
    await mountSwitcher()
    await openMenu()
    options().find(option => option.dataset.value === projectId(1))!.click()
    await settle()
    expect(api.chats.list).toHaveBeenLastCalledWith({ query: { limit: 50, projectId: projectId(1) } })
    expect(storage.getItem(PROJECT_FILTER_KEY)).toBe(projectId(1))
    expect(trigger().dataset.value).toBe(projectId(1))
    expect(options()).toEqual([])

    await openMenu()
    options().find(option => option.dataset.value === 'none')!.click()
    await settle()
    expect(api.chats.list).toHaveBeenLastCalledWith({ query: { limit: 50, projectId: 'none' } })
    expect(useChatsStore().projectFilter).toBe('none')
  })

  it('opens its own Add project dialog, and filters by the project it created', async () => {
    api.projects.browse.mockResolvedValue({ path: null, parent: null, roots: [{ path: '/srv/workspaces', available: true }], entries: [], truncated: false })
    await mountSwitcher()
    await openMenu()
    byTestId(testIds.projectAdd)!.click()
    await settle(6)
    expect(byTestId(testIds.addProjectDialog)).not.toBeNull()

    const created = projectSummary({ id: projectId(3), name: 'Demo', path: '/srv/workspaces/demo' })
    useProjectsStore().items = [...useProjectsStore().items, created]
    wrapper!.findComponent(AddProjectDialog).vm.$emit('created', created)
    await settle()
    expect(useChatsStore().projectFilter).toBe(projectId(3))
    expect(api.chats.list).toHaveBeenLastCalledWith({ query: { limit: 50, projectId: projectId(3) } })
  })
})
