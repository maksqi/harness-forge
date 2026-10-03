// Settings -> Projects (docs/UI.md 9.10, 10.4; W7.9-T6): the page frame with Add project, the skeleton, the load error
// with Retry, the rows (path, chat count, missing folder, project file), rename, the instructions dialog, delete with
// its confirmation and the 409 toast, the empty state, and `?add=1`.
import type { VueWrapper } from '@vue/test-utils'
import type { ComputedRef } from 'vue'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import ProjectsPage from '~/pages/settings/projects.vue'
import { useChatsStore } from '~/stores/chats'
import { testIds } from '~/utils/testids'
import { chatId, chatSummary, projectId, projectSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import ProjectsSettings from './ProjectsSettings.vue'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  useHead: vi.fn(),
  route: null as null | { path: string, query: Record<string, string | undefined> },
  router: { replace: vi.fn() },
  toast: Object.assign(vi.fn(), { custom: vi.fn(), error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
}))

vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
// SettingsPage sets the tab title through the settings nuxt-imports module ('#imports' does not resolve in Vitest).
vi.mock('~/components/settings/nuxt-imports', () => ({
  useHead: mocks.useHead,
  useRoute: () => mocks.route,
  useRouter: () => mocks.router,
}))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper | null = null

const website = projectSummary({ id: projectId(1), name: 'website', path: '/srv/workspaces/website', chatCount: 12, instructionsFile: 'AGENTS.md' })
const notes = projectSummary({ id: projectId(2), name: 'Notes', path: '/srv/workspaces/notes', chatCount: 1, available: false, issue: 'The folder does not exist.' })

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.useHead.mockReset()
  mocks.route = reactive({ path: '/settings/projects', query: {} })
  mocks.router.replace.mockReset()
  mocks.router.replace.mockImplementation(async ({ query }: { query: Record<string, string | undefined> }) => {
    mocks.route!.query = query
  })
  for (const fn of [mocks.toast.success, mocks.toast.error])
    fn.mockReset()
  stubLocalStorage()
  pinia = createPinia()
  setActivePinia(pinia)
  api.projects.browse.mockResolvedValue({ path: null, parent: null, roots: [{ path: '/srv/workspaces', available: true }], entries: [], truncated: false })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  disposePinia(pinia)
  vi.unstubAllGlobals()
})

function mountIn(component: object) {
  const Host = defineComponent({ setup: () => () => h(TooltipProvider, null, { default: () => h(component) }) })
  wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
  return wrapper
}

async function mountSettings(items = [website, notes]) {
  api.projects.list.mockResolvedValue({ items })
  mountIn(ProjectsSettings)
  await flushPromises()
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string, root: ParentNode = document.body): T | null {
  return root.querySelector<T>(`[data-testid="${id}"]`)
}

function rows(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.projectRow}"]`)]
}

function row(id: string): HTMLElement {
  return rows().find(element => element.dataset.projectId === id)!
}

async function chooseFromMenu(id: string, item: string) {
  byTestId(testIds.projectRowMenu, row(id))!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await flushPromises()
  byTestId(item)!.click()
  await flushPromises()
  await nextTick()
  await flushPromises()
}

describe('settings projects page', () => {
  it('renders ProjectsSettings in the settings page frame with the Add project action, which sets ?add=1', async () => {
    api.projects.list.mockResolvedValue({ items: [website] })
    mountIn(ProjectsPage)
    await flushPromises()
    const header = byTestId(testIds.pageHeader)!
    expect(header.querySelector('h1')?.textContent).toBe('Projects')
    expect(header.textContent).toContain('Folders on the server that chats can read and edit.')
    expect(byTestId(testIds.projectsSettings)).not.toBeNull()
    const head = mocks.useHead.mock.calls[0]?.[0] as { title: ComputedRef<string> } | undefined
    expect(head?.title.value).toBe('Projects · harness-forge')

    const add = byTestId<HTMLButtonElement>(testIds.projectAdd, header)!
    expect(add.textContent?.trim()).toBe('Add project')
    add.click()
    await flushPromises()
    expect(mocks.router.replace).toHaveBeenCalledWith({ query: { add: '1' } })
    // ProjectsSettings opened the dialog and dropped the parameter again.
    expect(byTestId(testIds.addProjectDialog)).not.toBeNull()
    expect(mocks.route!.query).toEqual({})
  })
})

describe('projectsSettings', () => {
  it('shows a skeleton while loading, then the rows sorted by name with path, chat count and states', async () => {
    let resolve: (value: unknown) => void = () => {}
    api.projects.list.mockReturnValueOnce(new Promise((done) => {
      resolve = done
    }))
    mountIn(ProjectsSettings)
    await flushPromises()
    expect(byTestId(testIds.projectsSettings)!.querySelector('[aria-busy="true"]')).not.toBeNull()
    resolve({ items: [website, notes] })
    await flushPromises()

    expect(rows().map(element => element.dataset.projectId)).toEqual([projectId(2), projectId(1)])
    const site = row(projectId(1))
    expect(site.textContent).toContain('website')
    const path = site.querySelector<HTMLElement>('.font-mono')!
    expect(path.textContent?.trim()).toBe('/srv/workspaces/website')
    expect(path.title).toBe('/srv/workspaces/website')
    expect(site.textContent).toContain('12 chats')
    expect(site.textContent).toContain('Uses AGENTS.md')
    expect(byTestId(testIds.projectMissing, site)).toBeNull()

    const old = row(projectId(2))
    expect(old.textContent).toContain('1 chat')
    const badge = byTestId(testIds.projectMissing, old)!
    expect(badge.textContent?.trim()).toBe('Folder not found')
    expect(badge.getAttribute('aria-description')).toBe('The folder does not exist.')
    expect(byTestId(testIds.projectRowMenu, old)!.getAttribute('aria-label')).toBe('Actions for Notes')
  })

  it('shows the load error with Retry', async () => {
    api.projects.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Something went wrong.' }))
    mountIn(ProjectsSettings)
    await flushPromises()
    const alert = document.body.querySelector<HTMLElement>('[data-slot="settings-load-error"]')!
    expect(alert.textContent).toContain('Could not load the projects')
    expect(alert.textContent).toContain('Something went wrong.')
    api.projects.list.mockResolvedValueOnce({ items: [website] })
    ;[...alert.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Retry')!.click()
    await flushPromises()
    expect(rows()).toHaveLength(1)
  })

  it('shows the empty state with its own Add project', async () => {
    await mountSettings([])
    const empty = byTestId(testIds.projectsEmpty)!
    expect(empty.textContent).toContain('No projects yet. A project is a folder on the server that chats can read and edit.')
    byTestId<HTMLButtonElement>(testIds.projectAdd, empty)!.click()
    await flushPromises()
    expect(byTestId(testIds.addProjectDialog)).not.toBeNull()
  })

  it('opens the Add project dialog for ?add=1 and drops the parameter', async () => {
    mocks.route!.query = { add: '1', other: 'x' }
    await mountSettings()
    expect(byTestId(testIds.addProjectDialog)).not.toBeNull()
    expect(mocks.router.replace).toHaveBeenCalledWith({ query: { other: 'x' } })
  })

  it('renames a project inline (at most 80 characters) and gives focus back to its menu button', async () => {
    await mountSettings()
    api.projects.update.mockImplementation(async ({ body }: { body: { name: string } }) => ({ ...website, name: body.name }))
    await chooseFromMenu(projectId(1), testIds.projectRename)
    const input = byTestId<HTMLInputElement>(testIds.projectRenameInput)!
    expect(input.value).toBe('website')
    expect(input.maxLength).toBe(80)
    expect(document.activeElement).toBe(input)
    input.value = 'Site'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(api.projects.update).toHaveBeenCalledWith({ params: { id: projectId(1) }, body: { name: 'Site' } })
    expect(byTestId(testIds.projectRenameInput)).toBeNull()
    expect(row(projectId(1)).textContent).toContain('Site')
    expect(document.activeElement).toBe(byTestId(testIds.projectRowMenu, row(projectId(1))))
  })

  it('shows a toast and the old name when a rename fails', async () => {
    await mountSettings()
    api.projects.update.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Project not found.' }))
    await chooseFromMenu(projectId(1), testIds.projectRename)
    const input = byTestId<HTMLInputElement>(testIds.projectRenameInput)!
    input.value = 'Broken'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(mocks.toast.error).toHaveBeenCalledWith(expect.any(String), { description: 'Project not found.' })
    expect(row(projectId(1)).textContent).toContain('website')
  })

  it('opens the instructions dialog of the row', async () => {
    await mountSettings()
    await chooseFromMenu(projectId(1), testIds.projectInstructions)
    const dialog = byTestId(testIds.projectInstructionsDialog)!
    expect(dialog.textContent).toContain('Instructions for website')
    expect(dialog.textContent).toContain('This folder has AGENTS.md; it is added first.')
  })

  it('deletes a project after the confirmation: toast, row gone, its chats detached', async () => {
    await mountSettings()
    const chats = useChatsStore()
    api.chats.list.mockResolvedValueOnce({ items: [chatSummary({ id: chatId(1), projectId: projectId(1) })], nextCursor: null })
    await chats.fetchPage()

    await chooseFromMenu(projectId(1), testIds.projectDelete)
    const confirm = byTestId<HTMLButtonElement>(testIds.projectDeleteConfirm)!
    const dialog = confirm.closest('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('Delete website?')
    expect(dialog.textContent).toContain('Its 12 chats stay and move to No project. The folder and its files are not touched.')
    expect(confirm.textContent?.trim()).toBe('Delete project')

    api.projects.remove.mockResolvedValueOnce(undefined)
    confirm.click()
    await flushPromises()
    expect(api.projects.remove).toHaveBeenCalledWith({ params: { id: projectId(1) } })
    expect(mocks.toast.success).toHaveBeenCalledWith('Project deleted')
    expect(rows().map(element => element.dataset.projectId)).toEqual([projectId(2)])
    expect(chats.byId(chatId(1))?.projectId).toBeNull()
    expect(byTestId(testIds.projectDeleteConfirm)).toBeNull()
  })

  it('explains a 409 run-active and keeps the project', async () => {
    await mountSettings()
    await chooseFromMenu(projectId(2), testIds.projectDelete)
    const confirm = byTestId<HTMLButtonElement>(testIds.projectDeleteConfirm)!
    expect(confirm.closest('[role="alertdialog"]')!.textContent).toContain('Its 1 chat stays and moves to No project.')
    api.projects.remove.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'Busy.', details: { reason: 'run-active', chatId: chatId(1) } }))
    confirm.click()
    await flushPromises()
    expect(mocks.toast.error).toHaveBeenCalledWith('Wait for the responses in this project to finish before deleting it.')
    expect(rows()).toHaveLength(2)
  })
})
