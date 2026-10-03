// AddProjectDialog (docs/UI.md 9.10, 10.4, 8.4; W7.9-T5): the default name, New folder and its name rules, the submit
// rules (a folder below a root, or a new folder), fresh auth (prompt first when the session is not fresh, prompt after a
// refusal, cancel shows nothing), every inline error code, the "No workspace folders" alert, and success.
import type { ProjectBrowse } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { useAuthStore } from '~/stores/auth'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'
import { authStatus, projectId, projectSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import AddProjectDialog from './AddProjectDialog.vue'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  toast: Object.assign(vi.fn(), { custom: vi.fn(), error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))

let api: MockApi
let pinia: ReturnType<typeof createPinia>

const ROOT = '/srv/workspaces'

function listing(path: string | null, names: string[] = [], available = true): ProjectBrowse {
  return {
    path,
    parent: null,
    roots: [{ path: ROOT, available }],
    entries: names.map(name => ({ name, path: `${path}/${name}`, projectId: null })),
    truncated: false,
  }
}

const created = projectSummary({ id: projectId(4), name: 'website', path: `${ROOT}/website` })
const passwordSet = authStatus({ enabled: true, authenticated: true, source: 'settings', freshUntil: null })
const freshNeeded = () => new HarnessError({ code: 'forbidden', message: 'Log in again to continue.', action: 'login' })

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.toast.success.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
  api.projects.browse.mockImplementation(async ({ query }: { query: { path?: string } }) => {
    if (!query.path)
      return listing(null)
    if (query.path === ROOT)
      return listing(ROOT, ['website', 'notes'])
    return listing(query.path, ['src'])
  })
  api.auth.login.mockImplementation(async ({ body }: { body: { password: string } }) => {
    if (body.password !== 'correct-horse')
      throw new HarnessError({ code: 'unauthorized', message: 'Invalid password' })
    return { ...passwordSet, freshUntil: Date.now() + 600_000 }
  })
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
})

function mountDialog(initialPath: string | null = null) {
  const open = ref(true)
  const createdEvents: unknown[] = []
  const Host = defineComponent({
    setup: () => () => h(AddProjectDialog, {
      'open': open.value,
      'initialPath': initialPath,
      'onUpdate:open': (value: boolean) => {
        open.value = value
      },
      'onCreated': (project: unknown) => createdEvents.push(project),
    }),
  })
  const wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
  return { wrapper, open, createdEvents }
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]`)
}

function entry(path: string): HTMLButtonElement {
  return [...document.body.querySelectorAll<HTMLButtonElement>(`[data-testid="${testIds.folderBrowserEntry}"]`)].find(item => item.dataset.path === path)!
}

function submitButton(): HTMLButtonElement {
  return byTestId<HTMLButtonElement>(testIds.addProjectSubmit)!
}

function nameInput(): HTMLInputElement {
  return byTestId<HTMLInputElement>(testIds.addProjectName)!
}

async function type(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}

async function openFolder(path: string) {
  entry(path).click()
  await flushPromises()
}

async function submit() {
  submitButton().click()
  await flushPromises()
}

describe('addProjectDialog: form', () => {
  it('opens on the roots with focus on the first entry; Add project needs a folder below a root', async () => {
    const { wrapper } = mountDialog()
    await flushPromises()
    const dialog = byTestId(testIds.addProjectDialog)!
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(byTestId(testIds.folderBrowser)?.dataset.path).toBe('')
    expect(document.activeElement).toBe(entry(ROOT))
    expect(submitButton().disabled).toBe(true)
    expect(byTestId(testIds.folderBrowserNew)).toBeNull()

    // A root itself is not a project folder (without a new folder inside it).
    await openFolder(ROOT)
    expect(byTestId(testIds.folderBrowser)?.dataset.path).toBe(ROOT)
    expect(nameInput().value).toBe('')
    expect(submitButton().disabled).toBe(true)

    await openFolder(`${ROOT}/website`)
    expect(nameInput().value).toBe('website')
    expect(dialog.textContent).toContain(`Selected: ${ROOT}/website`)
    expect(submitButton().disabled).toBe(false)
    wrapper.unmount()
  })

  it('keeps an edited name when the folder changes, and follows the folder again once cleared', async () => {
    const { wrapper } = mountDialog(`${ROOT}/website`)
    await flushPromises()
    expect(nameInput().value).toBe('website')
    await type(nameInput(), 'My site')
    await openFolder(`${ROOT}/website/src`)
    expect(nameInput().value).toBe('My site')
    await type(nameInput(), '   ')
    expect(submitButton().disabled).toBe(true)
    await type(nameInput(), '')
    document.body.querySelector<HTMLButtonElement>(`[data-testid="${testIds.folderBrowserUp}"]`)!.click()
    await flushPromises()
    expect(nameInput().value).toBe('website')
    expect(nameInput().maxLength).toBe(80)
    wrapper.unmount()
  })

  it('checks the new folder name like folderNameSchema and names the project after it', async () => {
    const { wrapper } = mountDialog(ROOT)
    await flushPromises()
    const toggle = byTestId<HTMLButtonElement>(testIds.folderBrowserNew)!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    toggle.click()
    await flushPromises()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const input = byTestId<HTMLInputElement>(testIds.folderBrowserNewInput)!
    // Revealed but empty: nothing to create yet.
    expect(submitButton().disabled).toBe(true)

    for (const [value, message] of [
      ['a/b', 'Use a name without slashes.'],
      ['a\\b', 'Use a name without slashes.'],
      ['.', 'Folder names can\'t start with a dot.'],
      ['..', 'Folder names can\'t start with a dot.'],
      ['.git', 'Folder names can\'t start with a dot.'],
      ['x'.repeat(256), 'Use at most 255 characters.'],
    ] as const) {
      await type(input, value)
      expect(byTestId(testIds.addProjectDialog)!.textContent).toContain(message)
      expect(input.getAttribute('aria-invalid')).toBe('true')
      expect(submitButton().disabled).toBe(true)
    }

    await type(input, '  demo  ')
    expect(input.getAttribute('aria-invalid')).toBeNull()
    expect(nameInput().value).toBe('demo')
    expect(byTestId(testIds.addProjectDialog)!.textContent).toContain(`Selected: ${ROOT}/demo`)
    expect(submitButton().disabled).toBe(false)

    api.projects.create.mockResolvedValueOnce(projectSummary({ id: projectId(5), name: 'demo', path: `${ROOT}/demo` }))
    await submit()
    expect(api.projects.create).toHaveBeenCalledWith({ body: { name: 'demo', path: ROOT, newFolder: 'demo' } })

    wrapper.unmount()
  })

  it('creates the project, adds it to the store, says so, emits created and closes', async () => {
    const { wrapper, open, createdEvents } = mountDialog(`${ROOT}/website`)
    await flushPromises()
    api.projects.create.mockResolvedValueOnce(created)
    await submit()
    expect(api.projects.create).toHaveBeenCalledWith({ body: { name: 'website', path: `${ROOT}/website` } })
    expect(api.auth.login).not.toHaveBeenCalled()
    expect(mocks.toast.success).toHaveBeenCalledWith('Project added')
    expect(createdEvents).toEqual([created])
    expect(open.value).toBe(false)
    expect(useProjectsStore().byId(projectId(4))).toEqual(created)
    wrapper.unmount()
  })

  it('shows the alert and keeps Add project disabled when every workspace folder is missing', async () => {
    api.projects.browse.mockImplementation(async ({ query }: { query: { path?: string } }) => listing(query.path ?? null, [], false))
    const { wrapper } = mountDialog()
    await flushPromises()
    const dialog = byTestId(testIds.addProjectDialog)!
    expect(dialog.textContent).toContain('No workspace folders. Set HF_WORKSPACE_ROOTS on the server.')
    expect(entry(ROOT).disabled).toBe(true)
    expect(submitButton().disabled).toBe(true)
    wrapper.unmount()
  })

  it('starts over each time it opens', async () => {
    const { wrapper, open } = mountDialog(`${ROOT}/website`)
    await flushPromises()
    await type(nameInput(), 'Changed')
    open.value = false
    await nextTick()
    await flushPromises()
    open.value = true
    await flushPromises()
    expect(nameInput().value).toBe('website')
    wrapper.unmount()
  })
})

describe('addProjectDialog: fresh auth', () => {
  it('asks for the password first when the session is not fresh, then creates the project', async () => {
    useAuthStore().status = passwordSet
    const { wrapper, createdEvents } = mountDialog(`${ROOT}/website`)
    await flushPromises()
    api.projects.create.mockResolvedValueOnce(created)
    await submit()
    expect(api.projects.create).not.toHaveBeenCalled()
    const prompt = byTestId(testIds.confirmPasswordDialog)!
    expect(prompt.textContent).toContain('Adding a project needs your password.')
    await type(byTestId<HTMLInputElement>(testIds.confirmPasswordInput)!, 'correct-horse')
    byTestId<HTMLButtonElement>(testIds.confirmPasswordSubmit)!.click()
    await flushPromises()
    expect(api.auth.login).toHaveBeenCalledWith({ body: { password: 'correct-horse' } })
    expect(api.projects.create).toHaveBeenCalledTimes(1)
    expect(createdEvents).toEqual([created])
    wrapper.unmount()
  })

  it('asks for the password after a fresh-auth refusal and retries once', async () => {
    useAuthStore().status = { ...passwordSet, freshUntil: Date.now() + 60_000 }
    const { wrapper, createdEvents } = mountDialog(`${ROOT}/website`)
    await flushPromises()
    api.projects.create.mockRejectedValueOnce(freshNeeded()).mockResolvedValueOnce(created)
    await submit()
    expect(byTestId(testIds.confirmPasswordDialog)).not.toBeNull()
    await type(byTestId<HTMLInputElement>(testIds.confirmPasswordInput)!, 'correct-horse')
    byTestId<HTMLButtonElement>(testIds.confirmPasswordSubmit)!.click()
    await flushPromises()
    expect(api.projects.create).toHaveBeenCalledTimes(2)
    expect(createdEvents).toEqual([created])
    wrapper.unmount()
  })

  it('shows nothing when the password prompt is cancelled', async () => {
    useAuthStore().status = passwordSet
    const { wrapper, open } = mountDialog(`${ROOT}/website`)
    await flushPromises()
    await submit()
    const prompt = byTestId(testIds.confirmPasswordDialog)!
    ;[...prompt.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Cancel')!.click()
    await flushPromises()
    expect(byTestId(testIds.confirmPasswordDialog)).toBeNull()
    expect(byTestId(testIds.addProjectError)).toBeNull()
    expect(api.projects.create).not.toHaveBeenCalled()
    expect(open.value).toBe(true)
    expect(submitButton().disabled).toBe(false)
    wrapper.unmount()
  })
})

describe('addProjectDialog: errors', () => {
  async function failWith(error: HarnessError, newFolder?: string) {
    const { wrapper } = mountDialog(newFolder ? ROOT : `${ROOT}/website`)
    await flushPromises()
    if (newFolder) {
      byTestId<HTMLButtonElement>(testIds.folderBrowserNew)!.click()
      await flushPromises()
      await type(byTestId<HTMLInputElement>(testIds.folderBrowserNewInput)!, newFolder)
    }
    api.projects.create.mockRejectedValueOnce(error)
    await submit()
    const element = byTestId(testIds.addProjectError)!
    const result = { code: element.dataset.code, text: element.textContent?.trim(), role: element.getAttribute('role') }
    wrapper.unmount()
    document.body.replaceChildren()
    return result
  }

  it('maps every error code to its inline text', async () => {
    const exists = () => new HarnessError({ code: 'conflict', message: 'Conflict.', details: { reason: 'exists' } })
    expect(await failWith(exists())).toEqual({ code: 'conflict', text: 'A project for this folder already exists.', role: 'alert' })
    expect((await failWith(exists(), 'demo')).text).toBe('A folder with this name already exists.')
    expect(await failWith(new HarnessError({ code: 'validation_error', message: 'Choose a folder inside the workspace folders.' })))
      .toMatchObject({ code: 'validation_error', text: 'Choose a folder inside the workspace folders.' })
    // Another 400 message (the data directory, the project cap) is shown as the server wrote it.
    expect((await failWith(new HarnessError({ code: 'validation_error', message: 'This folder contains the harness-forge data directory.' }))).text)
      .toBe('This folder contains the harness-forge data directory.')
    expect(await failWith(new HarnessError({ code: 'forbidden', message: 'Not allowed.' })))
      .toMatchObject({ code: 'forbidden', text: 'Choose a folder inside the workspace folders.' })
    expect(await failWith(new HarnessError({ code: 'not_found', message: 'No such folder.' })))
      .toMatchObject({ code: 'not_found', text: 'This folder no longer exists.' })
    expect(await failWith(new HarnessError({ code: 'internal_error', message: 'Something went wrong.' })))
      .toMatchObject({ code: 'internal_error', text: 'Something went wrong.' })
  })

  it('clears the error when the folder or the name changes', async () => {
    const { wrapper } = mountDialog(`${ROOT}/website`)
    await flushPromises()
    api.projects.create.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'Conflict.', details: { reason: 'exists' } }))
    await submit()
    expect(byTestId(testIds.addProjectError)).not.toBeNull()
    await type(nameInput(), 'Other')
    expect(byTestId(testIds.addProjectError)).toBeNull()
    wrapper.unmount()
  })
})
