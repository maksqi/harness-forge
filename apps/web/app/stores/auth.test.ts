import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authStatus } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { useAuthStore } from './auth'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>

let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
  vi.useRealTimers()
})

describe('auth store', () => {
  it('treats auth as not required when the status cannot be loaded (Phase 0 stubs answer 501)', async () => {
    const auth = useAuthStore()
    await expect(auth.fetchStatus()).rejects.toMatchObject({ code: 'not_implemented' })
    expect(auth.loaded).toBe(true)
    expect(auth.status).toBeNull()
    expect(auth.requiresLogin).toBe(false)
    expect(auth.authenticated).toBe(false)
    expect(auth.fresh).toBe(true)
  })

  it('requires a login when a password is set and there is no session', async () => {
    api.auth.status.mockResolvedValue(authStatus({ enabled: true, authenticated: false, source: 'env' }))
    const auth = useAuthStore()
    await auth.fetchStatus()
    expect(auth.requiresLogin).toBe(true)
    expect(auth.authenticated).toBe(false)
    expect(auth.passwordFromEnv).toBe(true)
  })

  it('shares one request between concurrent status loads', async () => {
    api.auth.status.mockResolvedValue(authStatus())
    const auth = useAuthStore()
    await Promise.all([auth.fetchStatus(), auth.fetchStatus()])
    expect(api.auth.status).toHaveBeenCalledTimes(1)
    expect(auth.authenticated).toBe(true)
  })

  it('logs in and keeps the fresh-auth window until freshUntil', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    api.auth.login.mockResolvedValue(authStatus({ enabled: true, authenticated: true, source: 'settings', freshUntil: now + 600_000 }))
    const auth = useAuthStore()
    await auth.login('secret')
    expect(api.auth.login).toHaveBeenCalledWith({ body: { password: 'secret' } })
    expect(auth.requiresLogin).toBe(false)
    expect(auth.fresh).toBe(true)
    await vi.advanceTimersByTimeAsync(600_100)
    expect(auth.fresh).toBe(false)
  })

  it('surfaces a wrong password as a HarnessError', async () => {
    api.auth.login.mockRejectedValue(new HarnessError({ code: 'unauthorized', message: 'Invalid password' }))
    const auth = useAuthStore()
    await expect(auth.login('nope')).rejects.toBeInstanceOf(HarnessError)
    await expect(auth.login('nope')).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('logs in first when changing the password with a stale session', async () => {
    api.auth.status.mockResolvedValue(authStatus({ enabled: true, authenticated: true, source: 'settings', freshUntil: null }))
    api.auth.login.mockResolvedValue(authStatus({ enabled: true, authenticated: true, source: 'settings', freshUntil: Date.now() + 600_000 }))
    api.auth.setPassword.mockResolvedValue(authStatus({ enabled: true, authenticated: true, source: 'settings', freshUntil: Date.now() + 600_000 }))
    const auth = useAuthStore()
    await auth.fetchStatus()
    expect(auth.fresh).toBe(false)
    await auth.changePassword({ current: 'old-password', next: 'new-password' })
    expect(api.auth.login).toHaveBeenCalledWith({ body: { password: 'old-password' } })
    expect(api.auth.setPassword).toHaveBeenCalledWith({ body: { currentPassword: 'old-password', newPassword: 'new-password' } })
  })

  it('sets a first password without logging in', async () => {
    api.auth.status.mockResolvedValue(authStatus())
    api.auth.setPassword.mockResolvedValue(authStatus({ enabled: true, authenticated: true, source: 'settings' }))
    const auth = useAuthStore()
    await auth.fetchStatus()
    await auth.changePassword({ next: 'first-password' })
    expect(api.auth.login).not.toHaveBeenCalled()
    expect(api.auth.setPassword).toHaveBeenCalledWith({ body: { newPassword: 'first-password' } })
    expect(auth.status?.enabled).toBe(true)
  })

  it('logs out and reloads the status', async () => {
    api.auth.status.mockResolvedValueOnce(authStatus({ enabled: true, authenticated: true, source: 'settings' }))
    api.auth.logout.mockResolvedValue(undefined)
    api.auth.status.mockResolvedValueOnce(authStatus({ enabled: true, authenticated: false, source: 'settings' }))
    const auth = useAuthStore()
    await auth.fetchStatus()
    await auth.logout()
    expect(api.auth.status).toHaveBeenCalledTimes(2)
    expect(auth.requiresLogin).toBe(true)
  })

  it('marks the session as gone after a 401, and an older status request cannot undo it', async () => {
    let resolveStatus: (value: ReturnType<typeof authStatus>) => void = () => {}
    api.auth.status.mockReturnValue(new Promise((resolve) => {
      resolveStatus = resolve
    }))
    const auth = useAuthStore()
    const pending = auth.fetchStatus()
    auth.markUnauthenticated()
    resolveStatus(authStatus())
    await pending
    expect(auth.requiresLogin).toBe(true)
    expect(auth.authenticated).toBe(false)
  })
})
