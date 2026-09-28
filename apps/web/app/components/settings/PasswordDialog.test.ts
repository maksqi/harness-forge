import type { PasswordDialogMode } from './password'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { useAuthStore } from '~/stores/auth'
import { testIds } from '~/utils/testids'
import { authStatus } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { changePasswordWithFreshAuth, passwordFailure, passwordState } from './password'
import PasswordDialog from './PasswordDialog.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

const passwordSet = authStatus({ enabled: true, authenticated: true, source: 'settings', freshUntil: null })

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  toasts.success.mockReset()
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
})

function mountDialog(mode: PasswordDialogMode) {
  const open = ref(true)
  const done = vi.fn()
  const Host = defineComponent({
    setup: () => () => h(PasswordDialog, {
      'open': open.value,
      mode,
      'onUpdate:open': (value: boolean) => {
        open.value = value
      },
      'onDone': done,
    }),
  })
  mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
  return { open, done }
}

function field(id: string): HTMLInputElement | null {
  return document.body.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)
}

async function fill(id: string, value: string) {
  const input = field(id)!
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

async function submit() {
  document.body.querySelector<HTMLButtonElement>(`[data-testid="${testIds.passwordSave}"]`)!.click()
  await flushPromises()
}

function dialogText(): string {
  return document.body.querySelector(`[data-testid="${testIds.passwordDialog}"]`)?.textContent ?? ''
}

describe('passwordDialog', () => {
  it('validates the new password before setting it', async () => {
    api.auth.setPassword.mockResolvedValue(passwordSet)
    const { open, done } = mountDialog('set')
    await flushPromises()
    expect(field(testIds.passwordCurrent)).toBeNull()

    await fill(testIds.passwordNew, 'short')
    await fill(testIds.passwordConfirm, 'other')
    await submit()
    expect(dialogText()).toContain('Use at least 8 characters.')
    expect(dialogText()).toContain('Passwords do not match.')
    expect(api.auth.setPassword).not.toHaveBeenCalled()

    await fill(testIds.passwordNew, 'correct horse battery')
    await fill(testIds.passwordConfirm, 'correct horse battery')
    expect(dialogText()).not.toContain('Passwords do not match.')
    await submit()

    expect(api.auth.setPassword).toHaveBeenCalledWith({ body: { newPassword: 'correct horse battery' } })
    expect(toasts.success).toHaveBeenCalledWith('Password set')
    expect(done).toHaveBeenCalledWith('set')
    expect(open.value).toBe(false)
    expect(useAuthStore().status).toEqual(passwordSet)
  })

  it('logs in with the current password first when the session is not fresh', async () => {
    const calls: string[] = []
    api.auth.login.mockImplementation(async () => {
      calls.push('login')
      return { ...passwordSet, freshUntil: Date.now() + 600_000 }
    })
    api.auth.setPassword.mockImplementation(async () => {
      calls.push('setPassword')
      return passwordSet
    })
    useAuthStore().status = passwordSet
    mountDialog('change')
    await flushPromises()

    await fill(testIds.passwordCurrent, 'old password')
    await fill(testIds.passwordNew, 'new password 1')
    await fill(testIds.passwordConfirm, 'new password 1')
    await submit()

    expect(calls).toEqual(['login', 'setPassword'])
    expect(api.auth.login).toHaveBeenCalledWith({ body: { password: 'old password' } })
    expect(api.auth.setPassword).toHaveBeenCalledWith({ body: { currentPassword: 'old password', newPassword: 'new password 1' } })
    expect(toasts.success).toHaveBeenCalledWith('Password changed')
  })

  it('answers a fresh-auth 403 with one login and one retry', async () => {
    api.auth.login.mockResolvedValue({ ...passwordSet, freshUntil: Date.now() + 600_000 })
    api.auth.setPassword
      .mockRejectedValueOnce(new HarnessError({ code: 'forbidden', message: 'Log in again to continue.', action: 'login' }))
      .mockResolvedValueOnce(passwordSet)
    useAuthStore().status = { ...passwordSet, freshUntil: Date.now() + 60_000 }
    mountDialog('change')
    await flushPromises()

    await fill(testIds.passwordCurrent, 'old password')
    await fill(testIds.passwordNew, 'new password 1')
    await fill(testIds.passwordConfirm, 'new password 1')
    await submit()

    expect(api.auth.login).toHaveBeenCalledTimes(1)
    expect(api.auth.setPassword).toHaveBeenCalledTimes(2)
    expect(toasts.success).toHaveBeenCalledWith('Password changed')
  })

  it('shows "Wrong password" under the current password until it changes', async () => {
    api.auth.login.mockRejectedValue(new HarnessError({ code: 'unauthorized', message: 'Invalid password' }))
    useAuthStore().status = passwordSet
    const { open } = mountDialog('remove')
    await flushPromises()
    expect(field(testIds.passwordNew)).toBeNull()

    await fill(testIds.passwordCurrent, 'guess')
    await submit()
    expect(dialogText()).toContain('Wrong password')
    expect(field(testIds.passwordCurrent)!.getAttribute('aria-invalid')).toBe('true')
    expect(api.auth.setPassword).not.toHaveBeenCalled()
    expect(open.value).toBe(true)

    await fill(testIds.passwordCurrent, 'guess again')
    expect(dialogText()).not.toContain('Wrong password')
  })

  it('removes the password with the current one', async () => {
    const removed = authStatus()
    api.auth.setPassword.mockResolvedValue(removed)
    useAuthStore().status = { ...passwordSet, freshUntil: Date.now() + 60_000 }
    mountDialog('remove')
    await flushPromises()

    await submit()
    expect(dialogText()).toContain('Enter your current password.')
    await fill(testIds.passwordCurrent, 'old password')
    await submit()

    expect(api.auth.setPassword).toHaveBeenCalledWith({ body: { currentPassword: 'old password', newPassword: null } })
    expect(toasts.success).toHaveBeenCalledWith('Password removed')
    expect(useAuthStore().status).toEqual(removed)
  })

  it('explains a password managed by HF_PASSWORD', async () => {
    api.auth.setPassword.mockRejectedValue(new HarnessError({
      code: 'conflict',
      message: 'The password is set by HF_PASSWORD.',
      details: { reason: 'env-password' },
    }))
    mountDialog('set')
    await flushPromises()

    await fill(testIds.passwordNew, 'correct horse battery')
    await fill(testIds.passwordConfirm, 'correct horse battery')
    await submit()
    expect(dialogText()).toContain('The password is set by HF_PASSWORD on the server. Change it there.')
  })
})

describe('password rules', () => {
  it('reads the password state from the auth status', () => {
    expect(passwordState(null)).toBe('unknown')
    expect(passwordState(authStatus())).toBe('none')
    expect(passwordState(passwordSet)).toBe('settings')
    expect(passwordState({ ...passwordSet, source: 'env' })).toBe('env')
  })

  it('maps failures to fields and messages', () => {
    expect(passwordFailure(new HarnessError({ code: 'forbidden', message: 'x' }))).toEqual({ field: 'current', message: 'Wrong password' })
    expect(passwordFailure(new HarnessError({ code: 'rate_limited', message: 'x', retryAfterMs: 4200 })))
      .toEqual({ field: 'current', message: 'Too many attempts. Try again in 5s.' })
    expect(passwordFailure(new HarnessError({ code: 'conflict', message: 'x', details: { reason: 'insecure-bind' } })).message)
      .toContain('HF_INSECURE=1')
    expect(passwordFailure(new HarnessError({ code: 'validation_error', message: 'Bad input.' })))
      .toEqual({ field: null, message: 'Bad input.' })
  })

  it('does not retry other failures', async () => {
    const auth = {
      changePassword: vi.fn().mockRejectedValue(new HarnessError({ code: 'forbidden', message: 'Wrong password' })),
      login: vi.fn(),
    }
    await expect(changePasswordWithFreshAuth(auth, { current: 'x', next: 'long enough' })).rejects.toMatchObject({ code: 'forbidden' })
    expect(auth.login).not.toHaveBeenCalled()
  })
})
