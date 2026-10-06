// HookEditor (docs/UI.md 9.13, 8.4, 10.8; W11.8-T4): the sheet per mode, the fields, the matcher preview, the inline
// rules, create and edit through useFreshAuth (prompt first; an edit that only turns the hook off asks nothing), the
// server's matcher refusal on the field, other errors in `hook-error`, Mod+Enter and the discard confirmation.
import type { VueWrapper } from '@vue/test-utils'
import type { HookDraft } from './hooks'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useAuthStore } from '~/stores/auth'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import { authStatus, hookId, personalHook, toolSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import HookEditor from './HookEditor.vue'

const mocks = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

const passwordSet = authStatus({ enabled: true, authenticated: true, source: 'settings', freshUntil: null })

let pinia: ReturnType<typeof createPinia>
let api: MockApi
let wrappers: VueWrapper[] = []

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  toasts.success.mockReset()
  toasts.error.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
  const plugins = usePluginsStore()
  plugins.tools = ['shell', 'read_file', 'write_file', 'edit_file'].map(name => toolSummary({ name, pluginId: 'core-workspace' }))
  plugins.toolsLoaded = true
  api.auth.login.mockImplementation(async ({ body }: { body: { password: string } }) => {
    if (body.password !== 'correct-horse')
      throw new HarnessError({ code: 'unauthorized', message: 'Invalid password' })
    return { ...passwordSet, freshUntil: Date.now() + 600_000 }
  })
})

afterEach(() => {
  for (const wrapper of wrappers)
    wrapper.unmount()
  wrappers = []
  disposePinia(pinia)
  document.body.replaceChildren()
})

async function mountEditor(props: { mode: 'new' | 'edit' | 'copy', hook?: ReturnType<typeof personalHook> | null, draft?: HookDraft | null }) {
  const wrapper = mount(HookEditor, {
    props: {
      'open': true,
      'mode': props.mode,
      'hook': props.hook ?? null,
      'draft': props.draft ?? null,
      'onUpdate:open': (value: boolean) => wrapper.setProps({ open: value }),
    },
    attachTo: document.body,
    global: { plugins: [pinia] },
  })
  wrappers.push(wrapper)
  await flushPromises()
  await nextTick()
  return wrapper
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]`)
}

async function type(id: string, value: string): Promise<void> {
  const input = byTestId<HTMLInputElement>(id)
  expect(input).not.toBeNull()
  input!.value = value
  input!.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

async function chooseEvent(event: string): Promise<void> {
  byTestId(testIds.hookEvent)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await flushPromises()
  const item = [...document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')].find(option => option.dataset.value === event)!
  item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await flushPromises()
}

async function save(): Promise<void> {
  byTestId(testIds.hookSave)!.click()
  await flushPromises()
}

describe('hookEditor', () => {
  it('renders the new sheet with the warning, the fields and the event descriptions', async () => {
    await mountEditor({ mode: 'new' })
    const sheet = byTestId(testIds.hookEditor)!
    expect(sheet.dataset.mode).toBe('new')
    expect(sheet.textContent).toContain('New hook')
    expect(byTestId(testIds.hookWarning)?.textContent).toContain('Hooks run shell commands on your server with harness-forge\'s permissions, without asking, whenever their event happens. Only add commands you understand.')
    expect(byTestId(testIds.hookEvent)?.dataset.value).toBe('PreToolUse')
    expect(sheet.textContent).toContain('Before a tool runs. It can block the call, allow it without asking or change its input.')
    expect(byTestId(testIds.hookMatcher)).not.toBeNull()
    expect(byTestId(testIds.hookCommand)).not.toBeNull()
    expect(byTestId(testIds.hookTimeout)).not.toBeNull()
    expect(byTestId(testIds.hookEditorEnabled)?.dataset.state).toBe('checked')
    expect(document.activeElement).toBe(byTestId(testIds.hookEvent))
  })

  it('hides the tools for events without a tool matcher', async () => {
    await mountEditor({ mode: 'new' })
    await chooseEvent('Stop')
    expect(byTestId(testIds.hookEvent)?.dataset.value).toBe('Stop')
    expect(byTestId(testIds.hookMatcher)).toBeNull()
    expect(byTestId(testIds.hookEditor)?.textContent).toContain('When the agent finishes a reply. It can make it continue.')
  })

  it('previews the matcher after a pause, with the Claude names in brackets', async () => {
    await mountEditor({ mode: 'new' })
    const preview = byTestId(testIds.hookMatcherPreview)!
    expect(preview.getAttribute('aria-live')).toBe('polite')
    await type(testIds.hookMatcher, 'Bash|Edit')
    await vi.waitFor(() => expect(preview.textContent?.trim()).toBe('Matches shell (Bash), edit_file (Edit)'))
    expect(preview.dataset.count).toBe('2')
    await type(testIds.hookMatcher, 'Deploy')
    await vi.waitFor(() => expect(preview.textContent?.trim()).toBe('No tool is named Deploy now.'))
  })

  it('creates a hook after the password prompt, toasts, emits saved and closes', async () => {
    useAuthStore().status = passwordSet
    const created = personalHook({ id: hookId(2), event: 'PreToolUse', matcher: 'Bash', command: './scripts/guard.sh', timeout: 30 })
    api.hooks.create.mockResolvedValue(created)
    const wrapper = await mountEditor({ mode: 'new' })
    await type(testIds.hookMatcher, ' Bash ')
    await type(testIds.hookCommand, './scripts/guard.sh')
    await type(testIds.hookTimeout, '30')
    await save()
    const prompt = byTestId(testIds.confirmPasswordDialog)
    expect(prompt?.textContent).toContain('Saving a hook needs your password.')
    expect(api.hooks.create).not.toHaveBeenCalled()
    await type(testIds.confirmPasswordInput, 'correct-horse')
    byTestId(testIds.confirmPasswordSubmit)!.click()
    await flushPromises()
    expect(api.hooks.create).toHaveBeenCalledWith({ body: { event: 'PreToolUse', matcher: 'Bash', command: './scripts/guard.sh', timeout: 30, enabled: true } })
    expect(toasts.success).toHaveBeenCalledWith('Hook saved')
    expect(wrapper.emitted('saved')?.[0]).toEqual([created])
    expect(byTestId(testIds.hookEditor)).toBeNull()
  })

  it('refuses an invalid matcher, an empty command and a bad timeout inline without a request', async () => {
    await mountEditor({ mode: 'new' })
    await type(testIds.hookMatcher, '^Bash.*$')
    await type(testIds.hookTimeout, '900')
    await save()
    expect(api.hooks.create).not.toHaveBeenCalled()
    const editor = byTestId(testIds.hookEditor)!
    expect(editor.textContent).toContain('Use tool names, | and * only.')
    expect(editor.textContent).toContain('Add the command.')
    expect(editor.textContent).toContain('Enter a whole number from 1 to 600.')
    expect(byTestId(testIds.hookMatcher)?.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(byTestId(testIds.hookMatcher))
  })

  it('shows a matcher the server refused on the field and other errors in the form alert', async () => {
    api.hooks.create.mockRejectedValueOnce(new HarnessError({ code: 'validation_error', message: 'Invalid request.', details: { issues: [{ path: ['matcher'], message: 'Invalid matcher', code: 'custom' }] } }))
    await mountEditor({ mode: 'new' })
    await type(testIds.hookMatcher, 'Bash')
    await type(testIds.hookCommand, 'sh guard.sh')
    await save()
    expect(byTestId(testIds.hookMatcherPreview)?.textContent?.trim()).toBe('Use tool names, | and * only.')
    expect(byTestId(testIds.hookError)).toBeNull()

    api.hooks.create.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'At most 100 personal hooks can be stored; delete one first.', details: { reason: 'exists' } }))
    await type(testIds.hookMatcher, 'Write')
    await save()
    const error = byTestId(testIds.hookError)!
    expect(error.dataset.code).toBe('conflict')
    expect(error.textContent).toContain('At most 100 personal hooks can be stored; delete one first.')
  })

  it('edits only the changed fields and turns a hook off without a password', async () => {
    useAuthStore().status = passwordSet
    const hook = personalHook({ event: 'PreToolUse', matcher: 'Bash', command: 'sh guard.sh', timeout: null, enabled: true })
    api.hooks.update.mockResolvedValue({ ...hook, enabled: false })
    await mountEditor({ mode: 'edit', hook })
    expect(byTestId(testIds.hookEditor)?.textContent).toContain('Edit hook')
    expect(document.activeElement).toBe(byTestId(testIds.hookCommand))
    byTestId(testIds.hookEditorEnabled)!.click()
    await flushPromises()
    await save()
    expect(byTestId(testIds.confirmPasswordDialog)).toBeNull()
    expect(api.hooks.update).toHaveBeenCalledWith({ params: { id: hook.id }, body: { enabled: false } })
    expect(toasts.success).toHaveBeenCalledWith('Hook saved')
  })

  it('asks for the password for any other edit', async () => {
    useAuthStore().status = passwordSet
    const hook = personalHook({ event: 'PreToolUse', matcher: 'Bash', command: 'sh guard.sh', timeout: null })
    api.hooks.update.mockResolvedValue({ ...hook, timeout: 10 })
    await mountEditor({ mode: 'edit', hook })
    await type(testIds.hookTimeout, '10')
    await save()
    expect(byTestId(testIds.confirmPasswordDialog)?.textContent).toContain('Saving a hook needs your password.')
    expect(api.hooks.update).not.toHaveBeenCalled()
  })

  it('saves with Mod+Enter in any field', async () => {
    api.hooks.create.mockResolvedValue(personalHook())
    await mountEditor({ mode: 'copy', draft: { event: 'PostToolUse', matcher: 'Write|Edit', command: 'prettier --write .', timeout: null, enabled: true } })
    expect(byTestId(testIds.hookEditor)?.dataset.mode).toBe('copy')
    expect(byTestId(testIds.hookEditor)?.textContent).toContain('Copy hook')
    byTestId(testIds.hookCommand)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
    await flushPromises()
    expect(api.hooks.create).toHaveBeenCalledWith({ body: { event: 'PostToolUse', matcher: 'Write|Edit', command: 'prettier --write .', timeout: null, enabled: true } })
  })

  it('asks before discarding changes and closes without asking when nothing changed', async () => {
    const wrapper = await mountEditor({ mode: 'new' })
    await type(testIds.hookCommand, 'pnpm lint')
    document.body.querySelector<HTMLElement>('[data-slot="sheet-close"]')!.click()
    await flushPromises()
    expect(byTestId(testIds.hookDiscardConfirm)?.textContent?.trim()).toBe('Discard')
    expect(document.body.textContent).toContain('Discard changes?')
    byTestId(testIds.hookDiscardConfirm)!.click()
    await flushPromises()
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
    expect(byTestId(testIds.hookEditor)).toBeNull()

    const clean = await mountEditor({ mode: 'new' })
    document.body.querySelector<HTMLElement>('[data-slot="sheet-close"]')!.click()
    await flushPromises()
    expect(byTestId(testIds.hookDiscardConfirm)).toBeNull()
    expect(clean.emitted('update:open')?.at(-1)).toEqual([false])
  })

  it('renders nothing while closed', async () => {
    const wrapper = mount(HookEditor, { props: { open: false, mode: 'new', hook: null }, attachTo: document.body, global: { plugins: [pinia] } })
    wrappers.push(wrapper)
    await flushPromises()
    expect(byTestId(testIds.hookEditor)).toBeNull()
  })
})
