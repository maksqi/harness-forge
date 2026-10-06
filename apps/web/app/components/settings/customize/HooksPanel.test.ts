// HooksPanel (docs/UI.md 9.13, 8.4, 10.8; W11.8-T3): the listing per scope, the Run hooks switch, the server-switch
// alerts, the sections, and the row actions: edit / duplicate / copy to personal (the editor modes), turn off (no
// password) and on (fresh auth), copy as JSON, delete with the confirmation and focus, review (the trust dialog) and
// open plugin; the exposes open the editor and the import.
import type { VueWrapper } from '@vue/test-utils'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useAuthStore } from '~/stores/auth'
import { useHooksStore } from '~/stores/hooks'
import { testIds } from '~/utils/testids'
import { authStatus, codeHookEntry, hookEntry, hookId, hookList, personalHook, pluginSummary, projectId, projectSummary, settings, trustSha } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import HooksPanel from './HooksPanel.vue'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  router: { push: vi.fn(), replace: vi.fn() },
  copyText: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('~/components/settings/nuxt-imports', () => ({ useRouter: () => mocks.router, useRoute: () => ({ query: {} }), useHead: vi.fn() }))
vi.mock('~/components/common/clipboard', () => ({ copyText: mocks.copyText }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), mocks.toast) }))

const passwordSet = authStatus({ enabled: true, authenticated: true, source: 'settings', freshUntil: null })
const second = hookEntry({ key: `personal:${hookId(2)}`, id: hookId(2), event: 'Stop', matcher: null, command: 'pnpm lint --quiet' })
const projectHook = hookEntry({ key: `project:${trustSha(1)}`, source: 'project', id: undefined, event: 'PreToolUse', matcher: 'Bash', command: 'sh .claude/hooks/guard.sh', state: 'pending', path: '.claude/settings.json', sha256: trustSha(1) })
const pluginHook = hookEntry({ key: 'plugin:hook-pack:0', source: 'plugin', id: undefined, pluginId: 'hook-pack', event: 'PostToolUse', command: 'sh "$HARNESS_PLUGIN_ROOT/fmt.sh"' })
const globalList = hookList({ items: [hookEntry(), second, pluginHook, codeHookEntry()], project: undefined })
const projectList = hookList({ items: [hookEntry(), second, projectHook, pluginHook, codeHookEntry()] })

let pinia: ReturnType<typeof createPinia>
let api: MockApi
let wrapper: VueWrapper | null = null

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.router.push.mockReset()
  mocks.router.push.mockResolvedValue(undefined)
  mocks.copyText.mockReset()
  mocks.toast.success.mockReset()
  mocks.toast.error.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
  api.hooks.list.mockImplementation(async ({ query }: { query: { projectId?: string } }) => (query.projectId ? projectList : globalList))
  api.settings.get.mockResolvedValue(settings())
  api.plugins.list.mockResolvedValue({ items: [pluginSummary({ id: 'hook-pack', name: 'Hook pack' })] })
  api.projects.list.mockResolvedValue({ items: [projectSummary({ id: projectId(1), name: 'website' })] })
  api.auth.login.mockResolvedValue({ ...passwordSet, freshUntil: Date.now() + 600_000 })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  disposePinia(pinia)
  document.body.replaceChildren()
})

async function mountPanel(projectId: string | null = null, projectName: string | null = null) {
  const mounted = mount(HooksPanel, { props: { projectId, projectName }, attachTo: document.body, global: { plugins: [pinia] } })
  wrapper = mounted
  await flushPromises()
  await nextTick()
  return mounted
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string, root: ParentNode = document.body): T | null {
  return root.querySelector<T>(`[data-testid="${id}"]`)
}

function sections(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.hooksSection}"]`)]
}

function row(key: (row: HTMLElement) => boolean): HTMLElement {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.hookRow}"]`)].find(key)!
}

async function chooseFromMenu(target: HTMLElement, item: string) {
  byTestId(testIds.hookRowMenu, target)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await flushPromises()
  const element = item.startsWith('[') ? document.body.querySelector<HTMLElement>(item) : byTestId(item)
  element!.click()
  await flushPromises()
  await nextTick()
  await flushPromises()
}

const personalRow = (id: string) => (element: HTMLElement) => element.dataset.hookId === id

describe('hooksPanel', () => {
  it('lists the global scope: the switch with its help, Personal and From plugins', async () => {
    await mountPanel()
    expect(api.hooks.list).toHaveBeenCalledWith({ query: {} })
    expect(byTestId(testIds.hooksPanel)).not.toBeNull()
    const toggle = byTestId(testIds.hooksEnabled)!
    expect(toggle.dataset.state).toBe('checked')
    expect(byTestId(testIds.hooksPanel)?.textContent).toContain('Shell commands that run at points of the agent\'s work, like before a tool call. Off: no command hook runs, from any source.')
    expect(byTestId(testIds.hooksDisabled)).toBeNull()
    expect(sections().map(section => [section.dataset.source, section.dataset.count])).toEqual([['personal', '2'], ['plugin', '2']])
    expect(sections()[1]!.textContent).toContain('Hook pack')
    expect(sections()[1]!.textContent).toContain('Code hook')
  })

  it('writes the Run hooks setting at once', async () => {
    api.settings.update.mockImplementation(async ({ body }: { body: object }) => settings(body))
    await mountPanel()
    byTestId(testIds.hooksEnabled)!.click()
    await flushPromises()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { hooksEnabled: false } })
    expect(byTestId(testIds.hooksEnabled)?.dataset.state).toBe('unchecked')
  })

  it('replaces the help with the server-switch alert, safe mode first', async () => {
    api.hooks.list.mockResolvedValue(hookList({ ...globalList, switches: { setting: true, shell: false, safeMode: true } }))
    await mountPanel()
    const alert = byTestId(testIds.hooksDisabled)!
    expect(alert.dataset.reason).toBe('safe-mode')
    expect(alert.textContent).toContain('Hooks are turned off on this server (safe mode).')
    wrapper!.unmount()
    document.body.replaceChildren()

    setActivePinia(pinia = createPinia())
    api.hooks.list.mockResolvedValue(hookList({ ...globalList, switches: { setting: true, shell: false, safeMode: false } }))
    await mountPanel()
    expect(byTestId(testIds.hooksDisabled)?.dataset.reason).toBe('shell-off')
    expect(byTestId(testIds.hooksDisabled)?.textContent).toContain('Hooks are turned off on this server (HF_WORKSPACE_SHELL=0).')
    // The rows still list.
    expect(sections()[0]!.dataset.count).toBe('2')
  })

  it('shows a project\'s hooks with the files, the problems and Review, which opens the trust dialog', async () => {
    api.hooks.list.mockResolvedValue(hookList({ ...projectList, diagnostics: [{ level: 'error', code: 'invalid-json', message: 'The settings file is not valid JSON.', file: '.claude/settings.local.json' }] }))
    await mountPanel(projectId(1), 'website')
    expect(api.hooks.list).toHaveBeenCalledWith({ query: { projectId: projectId(1) } })
    expect(sections().map(section => section.dataset.source)).toEqual(['personal', 'project', 'plugin'])
    const project = sections()[1]!
    expect(project.querySelector('h2')?.textContent?.trim()).toBe('In website · 1')
    expect(project.textContent).toContain('.claude/settings.json')
    expect(project.textContent).toContain('.claude/settings.local.json: The settings file is not valid JSON.')
    byTestId(testIds.customizeTrustReview, project)!.click()
    await flushPromises()
    expect(byTestId(testIds.projectTrustDialog)).not.toBeNull()
  })

  it('replaces the project rows with the issue of an unavailable folder', async () => {
    api.hooks.list.mockResolvedValue(hookList({ items: [hookEntry()], project: { id: projectId(1), available: false, issue: 'The folder does not exist.', files: [], pending: 0, scannedAt: 1 } }))
    await mountPanel(projectId(1), 'website')
    const project = sections()[1]!
    expect(project.dataset.count).toBe('0')
    expect(project.querySelector('[role="alert"]')?.textContent).toContain('The project folder is unavailable: the folder does not exist.')
  })

  it('opens the editor in edit, new and copy mode from the rows', async () => {
    await mountPanel(projectId(1), 'website')
    await chooseFromMenu(row(personalRow(hookId(1))), testIds.hookEdit)
    let editor = byTestId(testIds.hookEditor)!
    expect(editor.dataset.mode).toBe('edit')
    expect(byTestId<HTMLTextAreaElement>(testIds.hookCommand)?.value).toBe('sh .claude/hooks/format.sh')
    document.body.querySelector<HTMLElement>('[data-slot="sheet-close"]')!.click()
    await flushPromises()

    await chooseFromMenu(row(personalRow(hookId(2))), testIds.hookDuplicate)
    editor = byTestId(testIds.hookEditor)!
    expect(editor.dataset.mode).toBe('new')
    expect(byTestId(testIds.hookEvent)?.dataset.value).toBe('Stop')
    document.body.querySelector<HTMLElement>('[data-slot="sheet-close"]')!.click()
    await flushPromises()

    await chooseFromMenu(row(element => element.dataset.source === 'project'), testIds.hookDuplicate)
    expect(byTestId(testIds.hookEditor)?.dataset.mode).toBe('copy')
    expect(byTestId<HTMLInputElement>(testIds.hookMatcher)?.value).toBe('Bash')
  })

  it('turns a hook off without a password and on with one', async () => {
    useAuthStore().status = passwordSet
    api.hooks.update.mockResolvedValue(personalHook({ enabled: false }))
    await mountPanel()
    await chooseFromMenu(row(personalRow(hookId(1))), testIds.hookToggle)
    expect(byTestId(testIds.confirmPasswordDialog)).toBeNull()
    expect(api.hooks.update).toHaveBeenCalledWith({ params: { id: hookId(1) }, body: { enabled: false } })

    api.hooks.list.mockResolvedValue(hookList({ items: [hookEntry({ state: 'off' })], project: undefined }))
    await useHooksStore().fetch(null)
    await flushPromises()
    api.hooks.update.mockClear()
    await chooseFromMenu(row(personalRow(hookId(1))), testIds.hookToggle)
    expect(byTestId(testIds.confirmPasswordDialog)?.textContent).toContain('Saving a hook needs your password.')
    expect(api.hooks.update).not.toHaveBeenCalled()
    const password = byTestId<HTMLInputElement>(testIds.confirmPasswordInput)!
    password.value = 'correct-horse'
    password.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    byTestId(testIds.confirmPasswordSubmit)!.click()
    await flushPromises()
    expect(api.hooks.update).toHaveBeenCalledWith({ params: { id: hookId(1) }, body: { enabled: true } })
  })

  it('toasts a failed turn-off', async () => {
    api.hooks.update.mockRejectedValue(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    await mountPanel()
    await chooseFromMenu(row(personalRow(hookId(1))), testIds.hookToggle)
    expect(mocks.toast.error).toHaveBeenCalledWith('Something went wrong', { description: 'Disk full.' })
    expect(row(personalRow(hookId(1))).dataset.state).toBe('active')
  })

  it('copies a row as Claude Code JSON', async () => {
    mocks.copyText.mockResolvedValue(true)
    await mountPanel()
    await chooseFromMenu(row(personalRow(hookId(2))), testIds.hookCopyJson)
    expect(JSON.parse(mocks.copyText.mock.calls[0]![0] as string)).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'pnpm lint --quiet' }] }] } })
    expect(mocks.toast.success).toHaveBeenCalledWith('Copied hook as JSON')
  })

  it('deletes after the confirmation, toasts and moves focus to the next row', async () => {
    api.hooks.remove.mockResolvedValue(undefined)
    await mountPanel()
    await chooseFromMenu(row(personalRow(hookId(1))), testIds.hookDelete)
    const dialog = document.body.querySelector<HTMLElement>('[data-slot="confirm-dialog"]')!
    expect(dialog.textContent).toContain('Delete this hook?')
    expect(dialog.textContent).toContain('It stops running at once.')
    const confirm = byTestId(testIds.hookDeleteConfirm)!
    expect(confirm.textContent?.trim()).toBe('Delete hook')
    api.hooks.list.mockResolvedValue(hookList({ items: [second, pluginHook], project: undefined }))
    confirm.click()
    await flushPromises()
    await nextTick()
    expect(api.hooks.remove).toHaveBeenCalledWith({ params: { id: hookId(1) } })
    expect(mocks.toast.success).toHaveBeenCalledWith('Deleted hook')
    expect(document.activeElement).toBe(byTestId(testIds.hookRowMenu, row(personalRow(hookId(2)))))
  })

  it('opens the trust dialog on a project row and the plugin of a plugin row', async () => {
    await mountPanel(projectId(1), 'website')
    await chooseFromMenu(row(element => element.dataset.source === 'project'), testIds.hookReview)
    expect(byTestId(testIds.projectTrustDialog)).not.toBeNull()
    expect(wrapper!.findComponent({ name: 'ProjectTrustDialog' }).props('focusKey')).toBe(trustSha(1))
    document.body.querySelector<HTMLElement>(`[data-testid="${testIds.projectTrustDialog}"] [data-slot="dialog-close"]`)?.click()
    wrapper!.findComponent({ name: 'ProjectTrustDialog' }).vm.$emit('update:open', false)
    await flushPromises()

    await chooseFromMenu(row(element => element.dataset.source === 'plugin' && element.dataset.kind === 'command'), '[data-action="open-plugin"]')
    expect(mocks.router.push).toHaveBeenCalledWith('/plugins/hook-pack')
  })

  it('opens the editor and the import through its exposes and refetches after a save', async () => {
    const panel = await mountPanel()
    panel.vm.create()
    await flushPromises()
    expect(byTestId(testIds.hookEditor)?.dataset.mode).toBe('new')
    api.hooks.list.mockClear()
    wrapper!.findComponent({ name: 'HookEditor' }).vm.$emit('saved', personalHook({ id: hookId(3) }))
    await flushPromises()
    expect(api.hooks.list).toHaveBeenCalled()
    wrapper!.findComponent({ name: 'HookEditor' }).vm.$emit('update:open', false)
    await flushPromises()
    panel.vm.import()
    await flushPromises()
    expect(byTestId(testIds.hookImportDialog)).not.toBeNull()
  })

  it('shows the load error with Retry', async () => {
    api.hooks.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'The database is locked.' }))
    await mountPanel()
    const alert = document.body.querySelector<HTMLElement>('[data-slot="settings-load-error"]')!
    expect(alert.textContent).toContain('Could not load your hooks')
    ;[...alert.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Retry')!.click()
    await flushPromises()
    expect(document.body.querySelector('[data-slot="settings-load-error"]')).toBeNull()
    expect(sections()).toHaveLength(2)
  })
})
