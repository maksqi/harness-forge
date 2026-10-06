// HookImportDialog (docs/UI.md 9.13, 8.4, 10.8; W11.8-T5): a pasted Claude Code settings file previewed (an invalid
// matcher unchecked and disabled, a prompt hook noted), the errors, "Add {n} hooks" creating the checked handlers under
// one password prompt, the toast and the emits, and Choose file….
import type { VueWrapper } from '@vue/test-utils'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useAuthStore } from '~/stores/auth'
import { testIds } from '~/utils/testids'
import { authStatus, hookId, personalHook } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import HookImportDialog from './HookImportDialog.vue'

const mocks = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

const passwordSet = authStatus({ enabled: true, authenticated: true, source: 'settings', freshUntil: null })

/** A Claude Code `.claude/settings.json` with permissions, two hook groups (one with a regex matcher) and a prompt hook. */
const SETTINGS = JSON.stringify({
  permissions: { allow: ['Bash(npm run lint)'] },
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh', timeout: 60 }] },
      { matcher: '^Bash.*$', hooks: [{ type: 'command', command: './x.sh' }] },
    ],
    Stop: [{ hooks: [{ type: 'command', command: 'pnpm lint' }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'prompt', prompt: 'Check the request.' }] }],
  },
}, null, 2)

let pinia: ReturnType<typeof createPinia>
let api: MockApi
let wrappers: VueWrapper[] = []

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  toasts.success.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
  api.auth.login.mockResolvedValue({ ...passwordSet, freshUntil: Date.now() + 600_000 })
})

afterEach(() => {
  for (const wrapper of wrappers)
    wrapper.unmount()
  wrappers = []
  disposePinia(pinia)
  document.body.replaceChildren()
})

async function mountDialog() {
  const wrapper = mount(HookImportDialog, {
    props: { 'open': true, 'onUpdate:open': (value: boolean) => wrapper.setProps({ open: value }) },
    attachTo: document.body,
    global: { plugins: [pinia] },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]`)
}

function items(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.hookImportItem}"]`)]
}

async function paste(text: string): Promise<void> {
  const input = byTestId<HTMLTextAreaElement>(testIds.hookImportInput)!
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  await flushPromises()
}

describe('hookImportDialog', () => {
  it('renders the title, the help and Choose file…', async () => {
    await mountDialog()
    const dialog = byTestId(testIds.hookImportDialog)!
    expect(dialog.textContent).toContain('Import hooks')
    expect(dialog.textContent).toContain('Paste Claude Code settings JSON (the whole file or its "hooks" object).')
    expect(byTestId<HTMLInputElement>(testIds.hookImportFile)?.getAttribute('accept')).toBe('.json,application/json')
    expect(byTestId<HTMLButtonElement>(testIds.hookImportSubmit)?.disabled).toBe(true)
  })

  it('previews a real Claude Code settings file: the invalid matcher unchecked, the prompt hook noted', async () => {
    await mountDialog()
    await paste(SETTINGS)
    const preview = byTestId(testIds.hookImportPreview)!
    expect(preview.dataset.count).toBe('3')
    expect(preview.textContent).toContain('Found 3 hooks')
    expect(items().map(item => [item.dataset.event, item.dataset.state])).toEqual([
      ['PreToolUse', 'ready'],
      ['PreToolUse', 'invalid'],
      ['Stop', 'ready'],
    ])
    const invalid = items()[1]!
    expect(invalid.textContent).toContain('Use tool names, | and * only.')
    expect(invalid.textContent).toContain('^Bash.*$')
    const box = invalid.querySelector<HTMLElement>('[data-slot="checkbox"]')!
    expect(box.dataset.state).toBe('unchecked')
    expect(box.hasAttribute('disabled') || box.dataset.disabled !== undefined).toBe(true)
    expect(byTestId(testIds.hookImportDialog)?.textContent).toContain('Ignored: "prompt" hooks aren\'t supported.')
    const submit = byTestId<HTMLButtonElement>(testIds.hookImportSubmit)!
    expect(submit.textContent?.trim()).toBe('Add 2 hooks')
    expect(submit.dataset.count).toBe('2')

    // Unchecking a ready handler leaves one.
    items()[0]!.querySelector<HTMLElement>('[data-slot="checkbox"]')!.click()
    await flushPromises()
    expect(byTestId(testIds.hookImportSubmit)?.textContent?.trim()).toBe('Add 1 hook')
  })

  it('shows the errors of invalid JSON and of a file without hooks', async () => {
    await mountDialog()
    await paste('{ "hooks": ')
    expect(byTestId(testIds.hookImportError)?.textContent?.trim()).toBe('This isn\'t valid JSON.')
    await paste('{ "permissions": {} }')
    expect(byTestId(testIds.hookImportError)?.textContent?.trim()).toBe('No hooks found.')
    expect(byTestId(testIds.hookImportPreview)).toBeNull()
  })

  it('adds the checked hooks under one password prompt, toasts, emits imported and closes', async () => {
    useAuthStore().status = passwordSet
    api.hooks.create
      .mockResolvedValueOnce(personalHook({ id: hookId(2), event: 'PreToolUse', matcher: 'Bash', command: './guard.sh', timeout: 60 }))
      .mockResolvedValueOnce(personalHook({ id: hookId(3), event: 'Stop', matcher: null, command: 'pnpm lint' }))
    const wrapper = await mountDialog()
    await paste(SETTINGS)
    byTestId(testIds.hookImportSubmit)!.click()
    await flushPromises()
    expect(byTestId(testIds.confirmPasswordDialog)?.textContent).toContain('Saving a hook needs your password.')
    expect(api.hooks.create).not.toHaveBeenCalled()
    const password = byTestId<HTMLInputElement>(testIds.confirmPasswordInput)!
    password.value = 'correct-horse'
    password.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    byTestId(testIds.confirmPasswordSubmit)!.click()
    await flushPromises()
    expect(api.auth.login).toHaveBeenCalledTimes(1)
    expect(api.hooks.create.mock.calls.map(call => call[0])).toEqual([
      { body: { event: 'PreToolUse', matcher: 'Bash', command: './guard.sh', timeout: 60, enabled: true } },
      { body: { event: 'Stop', matcher: null, command: 'pnpm lint', timeout: null, enabled: true } },
    ])
    expect(toasts.success).toHaveBeenCalledWith('Added 2 hooks')
    expect(wrapper.emitted('imported')?.[0]?.[0]).toHaveLength(2)
    expect(byTestId(testIds.hookImportDialog)).toBeNull()
  })

  it('does not create a hook twice when a later request fails, and reports the failure', async () => {
    api.hooks.create
      .mockResolvedValueOnce(personalHook({ id: hookId(2) }))
      .mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'At most 100 personal hooks can be stored; delete one first.', details: { reason: 'exists' } }))
    const wrapper = await mountDialog()
    await paste(SETTINGS)
    byTestId(testIds.hookImportSubmit)!.click()
    await flushPromises()
    const error = document.body.querySelector<HTMLElement>('[data-slot="hook-import-submit-error"]')!
    expect(error.dataset.code).toBe('conflict')
    expect(error.textContent).toContain('Added 1 hook')
    expect(wrapper.emitted('imported')?.[0]?.[0]).toHaveLength(1)
    api.hooks.create.mockResolvedValueOnce(personalHook({ id: hookId(3) }))
    byTestId(testIds.hookImportSubmit)!.click()
    await flushPromises()
    expect(api.hooks.create).toHaveBeenCalledTimes(3)
    expect(toasts.success).toHaveBeenCalledWith('Added 2 hooks')
  })

  it('reads a chosen file and refuses one above 256 KB', async () => {
    api.hooks.create.mockResolvedValue(personalHook())
    await mountDialog()
    const input = byTestId<HTMLInputElement>(testIds.hookImportFile)!
    const file = new File([SETTINGS], 'settings.json', { type: 'application/json' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    input.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(items()).toHaveLength(3))
    expect(byTestId<HTMLTextAreaElement>(testIds.hookImportInput)?.value).toBe(SETTINGS)

    const huge = new File(['x'.repeat(256 * 1024 + 1)], 'huge.json')
    Object.defineProperty(input, 'files', { value: [huge], configurable: true })
    input.dispatchEvent(new Event('change'))
    await flushPromises()
    expect(byTestId(testIds.hookImportError)?.textContent?.trim()).toBe('huge.json is too large')
  })

  it('adds with Mod+Enter', async () => {
    api.hooks.create.mockResolvedValue(personalHook())
    await mountDialog()
    await paste(SETTINGS)
    byTestId(testIds.hookImportInput)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
    await flushPromises()
    expect(api.hooks.create).toHaveBeenCalledTimes(2)
  })
})
