// RotateKeyDialog (docs/UI.md 9.8, 8.4, 10.4; docs/API.md 5.23; W7.13): the effects list, the typed ROTATE, the
// rotation through useFreshAuth (prompt first, prompt after a refusal, cancel), the toast and the emits, the 409
// answers (env-key / key-mismatch inline, busy as a toast) and the pending dialog that cannot be closed.
import type { KeyRotationResult, KeyStatus } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useAuthStore } from '~/stores/auth'
import { testIds } from '~/utils/testids'
import { authStatus, keyStatus } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { BUSY_MESSAGE } from './data'
import RotateKeyDialog from './RotateKeyDialog.vue'

const mocks = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

const passwordSet = authStatus({ enabled: true, authenticated: true, source: 'settings', freshUntil: null })
const freshNeeded = () => new HarnessError({ code: 'forbidden', message: 'Log in again to continue.', action: 'login' })
const conflict = (reason: string, message: string) => new HarnessError({ code: 'conflict', message, details: { reason } })

function rotation(overrides: Partial<KeyRotationResult> = {}): KeyRotationResult {
  return {
    keyVersion: 2,
    rotatedAt: 1_759_000_000_000,
    secrets: 4,
    skippedSecrets: 0,
    shares: 3,
    approvalsExpired: 1,
    chats: 1,
    runsStopped: 0,
    ...overrides,
  }
}

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

/** Mounts the dialog open; `update:open` drives the prop like a parent's v-model. */
async function mountDialog(status: KeyStatus | null = keyStatus({ shares: 3, pendingApprovals: 2 })) {
  const wrapper = mount(RotateKeyDialog, {
    props: {
      'open': true,
      status,
      'onUpdate:open': (value: boolean) => wrapper.setProps({ open: value }),
    },
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

async function click(element: HTMLElement | null | undefined): Promise<void> {
  expect(element).toBeTruthy()
  element!.click()
  await flushPromises()
}

async function type(id: string, value: string): Promise<void> {
  const input = byTestId<HTMLInputElement>(id)
  expect(input).not.toBeNull()
  input!.value = value
  input!.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

function submit(): HTMLButtonElement {
  return byTestId<HTMLButtonElement>(testIds.keyRotateSubmit)!
}

function inlineError(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-slot="key-rotate-error"]')
}

async function confirmRotation(): Promise<void> {
  await type(testIds.keyRotateConfirm, 'ROTATE')
  await click(submit())
}

async function submitPassword(password: string): Promise<void> {
  await type(testIds.confirmPasswordInput, password)
  await click(byTestId(testIds.confirmPasswordSubmit))
}

describe('rotateKeyDialog', () => {
  it('renders its content while open and nothing while closed', async () => {
    const status = keyStatus()
    const wrapper = mount(RotateKeyDialog, { props: { open: true, status }, attachTo: document.body, global: { plugins: [pinia] } })
    wrappers.push(wrapper)
    await flushPromises()
    const content = byTestId(testIds.keyRotateDialog)
    expect(content?.getAttribute('role')).toBe('dialog')
    expect(content?.textContent).toContain('Rotate the master key?')
    expect(content?.textContent).toContain('A new key encrypts every saved secret again.')
    expect(wrapper.props()).toEqual({ open: true, status })

    await wrapper.setProps({ open: false, status: null })
    await flushPromises()
    expect(byTestId(testIds.keyRotateDialog)).toBeNull()
  })

  it('lists the effects with the counts of the status, and without them while unknown', async () => {
    const wrapper = await mountDialog(keyStatus({ shares: 3, pendingApprovals: 2 }))
    const items = () => [...document.body.querySelectorAll('[data-slot="key-rotate-effects"] li')].map(item => item.textContent?.trim())
    expect(items()).toEqual([
      'Other browsers and devices are signed out; you stay signed in.',
      'Every share link changes (3 links): copy the new links from Shared links.',
      'Running replies stop and pending approvals expire (2 waiting).',
      'Older versions of harness-forge can\'t read the secrets afterwards: back up the data directory first.',
    ])

    await wrapper.setProps({ status: null })
    expect(items()[1]).toBe('Every share link changes: copy the new links from Shared links.')
    expect(items()[2]).toBe('Running replies stop and pending approvals expire.')
  })

  it('focuses the confirmation and enables Rotate key only for exactly ROTATE', async () => {
    await mountDialog()
    const input = byTestId<HTMLInputElement>(testIds.keyRotateConfirm)!
    expect(document.activeElement).toBe(input)
    expect(input.closest('div')?.textContent).toContain('Type ROTATE to confirm')
    expect(submit().disabled).toBe(true)
    for (const value of ['rotate', 'Rotate', 'ROTAT', 'ROTATE ', ' ROTATE']) {
      await type(testIds.keyRotateConfirm, value)
      expect(submit().disabled).toBe(true)
    }
    await type(testIds.keyRotateConfirm, 'ROTATE')
    expect(submit().disabled).toBe(false)

    // Enter with anything else typed does nothing.
    await type(testIds.keyRotateConfirm, 'rotate')
    input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(api.keys.rotate).not.toHaveBeenCalled()
  })

  it('closes on Escape while idle', async () => {
    const wrapper = await mountDialog()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(wrapper.emitted('update:open')).toEqual([[false]])
    expect(byTestId(testIds.keyRotateDialog)).toBeNull()
  })

  it('rotates without a prompt when no password is set, then toasts, emits rotated and closes', async () => {
    const result = rotation()
    api.keys.rotate.mockResolvedValue(result)
    const wrapper = await mountDialog()
    await confirmRotation()

    expect(api.keys.rotate).toHaveBeenCalledTimes(1)
    expect(api.keys.rotate).toHaveBeenCalledWith({ body: { confirm: 'ROTATE' } })
    expect(api.auth.login).not.toHaveBeenCalled()
    expect(byTestId(testIds.confirmPasswordDialog)).toBeNull()
    expect(toasts.success).toHaveBeenCalledWith('Master key rotated', { description: '4 secrets encrypted again · 1 approval expired' })
    expect(wrapper.emitted('rotated')).toEqual([[result]])
    expect(wrapper.emitted('update:open')).toEqual([[false]])
    expect(byTestId(testIds.keyRotateDialog)).toBeNull()
  })

  it('asks for the password first when the session is not fresh', async () => {
    useAuthStore().status = passwordSet
    api.keys.rotate.mockResolvedValue(rotation({ secrets: 1, approvalsExpired: 0 }))
    const wrapper = await mountDialog()
    await confirmRotation()

    const prompt = byTestId(testIds.confirmPasswordDialog)
    expect(prompt?.textContent).toContain('Rotating the master key needs your password.')
    expect(api.keys.rotate).not.toHaveBeenCalled()
    // The rotate dialog stays open and locked behind the prompt.
    expect(byTestId(testIds.keyRotateDialog)).not.toBeNull()
    expect(submit().disabled).toBe(true)

    await submitPassword('wrong')
    expect(byTestId(testIds.confirmPasswordDialog)?.textContent).toContain('Wrong password')
    expect(api.keys.rotate).not.toHaveBeenCalled()

    await submitPassword('correct-horse')
    expect(api.auth.login).toHaveBeenLastCalledWith({ body: { password: 'correct-horse' } })
    expect(api.keys.rotate).toHaveBeenCalledTimes(1)
    expect(toasts.success).toHaveBeenCalledWith('Master key rotated', { description: '1 secret encrypted again · 0 approvals expired' })
    expect(wrapper.emitted('rotated')).toHaveLength(1)
    expect(byTestId(testIds.keyRotateDialog)).toBeNull()
  })

  it('asks for the password after a fresh-auth refusal and retries once', async () => {
    useAuthStore().status = { ...passwordSet, freshUntil: Date.now() + 60_000 }
    api.keys.rotate.mockRejectedValueOnce(freshNeeded()).mockResolvedValueOnce(rotation())
    const wrapper = await mountDialog()
    await confirmRotation()

    expect(api.keys.rotate).toHaveBeenCalledTimes(1)
    expect(byTestId(testIds.confirmPasswordDialog)).not.toBeNull()
    await submitPassword('correct-horse')

    expect(api.keys.rotate).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('rotated')).toHaveLength(1)
  })

  it('reports a second refusal inside the dialog', async () => {
    useAuthStore().status = { ...passwordSet, freshUntil: Date.now() + 60_000 }
    api.keys.rotate.mockRejectedValue(freshNeeded())
    const wrapper = await mountDialog()
    await confirmRotation()
    await submitPassword('correct-horse')

    expect(api.keys.rotate).toHaveBeenCalledTimes(2)
    expect(byTestId(testIds.confirmPasswordDialog)).toBeNull()
    expect(inlineError()?.dataset.code).toBe('forbidden')
    expect(inlineError()?.textContent).toContain('Log in again to continue.')
    expect(wrapper.emitted('rotated')).toBeUndefined()
    expect(byTestId(testIds.keyRotateDialog)).not.toBeNull()
  })

  it('does nothing when the password prompt is cancelled', async () => {
    useAuthStore().status = passwordSet
    const wrapper = await mountDialog()
    await confirmRotation()
    const cancel = [...byTestId(testIds.confirmPasswordDialog)!.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Cancel')
    await click(cancel)

    expect(byTestId(testIds.confirmPasswordDialog)).toBeNull()
    expect(api.keys.rotate).not.toHaveBeenCalled()
    expect(toasts.error).not.toHaveBeenCalled()
    expect(inlineError()).toBeNull()
    expect(wrapper.emitted('rotated')).toBeUndefined()
    expect(byTestId(testIds.keyRotateDialog)).not.toBeNull()
    expect(submit().disabled).toBe(false)
    expect(document.activeElement).toBe(submit())
  })

  it.each([
    ['env-key', 'The master key comes from HF_MASTER_KEY: stop the server and run the rotate-key command.'],
    ['key-mismatch', 'The master key does not match the stored secrets.'],
  ])('shows the server message of a 409 %s inside the dialog', async (reason, message) => {
    api.keys.rotate.mockRejectedValue(conflict(reason, message))
    const wrapper = await mountDialog()
    await confirmRotation()

    const alert = inlineError()
    expect(alert?.getAttribute('role')).toBe('alert')
    expect(alert?.dataset.code).toBe('conflict')
    expect(alert?.dataset.reason).toBe(reason)
    expect(alert?.textContent).toContain('Couldn\'t rotate the key')
    expect(alert?.textContent).toContain(message)
    expect(toasts.error).not.toHaveBeenCalled()
    expect(toasts.success).not.toHaveBeenCalled()
    expect(wrapper.emitted('rotated')).toBeUndefined()
    expect(byTestId(testIds.keyRotateDialog)).not.toBeNull()

    // Editing the confirmation clears the message.
    await type(testIds.keyRotateConfirm, 'ROTAT')
    expect(inlineError()).toBeNull()
  })

  it('shows the busy toast when another data task runs', async () => {
    api.keys.rotate.mockRejectedValue(conflict('busy', 'Another data task is running. Try again when it finishes.'))
    const wrapper = await mountDialog()
    await confirmRotation()

    expect(toasts.error).toHaveBeenCalledWith(BUSY_MESSAGE)
    expect(inlineError()).toBeNull()
    expect(wrapper.emitted('rotated')).toBeUndefined()
    expect(byTestId(testIds.keyRotateDialog)).not.toBeNull()
    expect(submit().disabled).toBe(false)
  })

  it('stays open while the request runs', async () => {
    let finish!: (result: KeyRotationResult) => void
    api.keys.rotate.mockReturnValue(new Promise<KeyRotationResult>((resolve) => {
      finish = resolve
    }))
    const wrapper = await mountDialog()
    await confirmRotation()

    expect(submit().disabled).toBe(true)
    expect(submit().getAttribute('aria-busy')).toBe('true')
    expect(byTestId<HTMLInputElement>(testIds.keyRotateConfirm)!.disabled).toBe(true)
    const cancel = [...byTestId(testIds.keyRotateDialog)!.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Cancel')
    expect((cancel as HTMLButtonElement).disabled).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(wrapper.emitted('update:open')).toBeUndefined()
    expect(byTestId(testIds.keyRotateDialog)).not.toBeNull()

    finish(rotation())
    await flushPromises()
    expect(wrapper.emitted('update:open')).toEqual([[false]])
  })

  it('starts over every time it opens', async () => {
    api.keys.rotate.mockRejectedValue(conflict('key-mismatch', 'The master key does not match the stored secrets.'))
    const wrapper = await mountDialog()
    await confirmRotation()
    expect(inlineError()).not.toBeNull()

    await wrapper.setProps({ open: false })
    await flushPromises()
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(byTestId<HTMLInputElement>(testIds.keyRotateConfirm)!.value).toBe('')
    expect(inlineError()).toBeNull()
    expect(submit().disabled).toBe(true)
  })
})
