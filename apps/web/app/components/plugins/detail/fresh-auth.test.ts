import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authStatus } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { FreshAuthCancelledError, isFreshAuthCancelled, loginFailureMessage, needsFreshAuth, useFreshAuth } from './fresh-auth'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let api: MockApi
let pinia: ReturnType<typeof createPinia>

const freshNeeded = () => new HarnessError({ code: 'forbidden', message: 'Log in again to continue.', action: 'login' })

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  api.auth.login.mockImplementation(async ({ body }: { body: { password: string } }) => {
    if (body.password !== 'correct-horse')
      throw new HarnessError({ code: 'unauthorized', message: 'Invalid password' })
    return authStatus({ enabled: true, authenticated: true, source: 'settings', freshUntil: Date.now() + 600_000 })
  })
})

afterEach(() => {
  disposePinia(pinia)
})

describe('fresh auth', () => {
  it('recognizes the fresh-auth failure and words login failures', () => {
    expect(needsFreshAuth(freshNeeded())).toBe(true)
    expect(needsFreshAuth(new HarnessError({ code: 'forbidden', message: 'Builtin plugins cannot be removed.' }))).toBe(false)
    expect(needsFreshAuth({ error: { code: 'forbidden', message: 'x', action: 'login' } })).toBe(true)
    expect(loginFailureMessage(new HarnessError({ code: 'unauthorized', message: 'Invalid password' }))).toBe('Wrong password')
    expect(loginFailureMessage(new HarnessError({ code: 'rate_limited', message: 'Slow down', retryAfterMs: 27_400 }))).toBe('Too many attempts. Try again in 28s.')
    expect(isFreshAuthCancelled(new FreshAuthCancelledError())).toBe(true)
  })

  it('runs the task once when it succeeds, and rethrows other errors', async () => {
    const fresh = useFreshAuth()
    await expect(fresh.run(async () => 'done')).resolves.toBe('done')
    await expect(fresh.run(async () => {
      throw new HarnessError({ code: 'not_found', message: 'Gone' })
    })).rejects.toMatchObject({ code: 'not_found' })
    expect(fresh.open.value).toBe(false)
  })

  it('asks for the password, logs in and retries the request once', async () => {
    const fresh = useFreshAuth()
    const task = vi.fn()
      .mockRejectedValueOnce(freshNeeded())
      .mockResolvedValueOnce('reloaded')
    const result = fresh.run(task)
    await flushPromises()
    expect(fresh.open.value).toBe(true)
    expect(task).toHaveBeenCalledTimes(1)

    await fresh.submit('wrong')
    expect(fresh.error.value).toBe('Wrong password')
    expect(fresh.open.value).toBe(true)
    expect(task).toHaveBeenCalledTimes(1)

    await fresh.submit('correct-horse')
    await expect(result).resolves.toBe('reloaded')
    expect(api.auth.login).toHaveBeenLastCalledWith({ body: { password: 'correct-horse' } })
    expect(task).toHaveBeenCalledTimes(2)
    expect(fresh.open.value).toBe(false)
    expect(fresh.error.value).toBeNull()
  })

  it('retries only once: a second failure is reported', async () => {
    const fresh = useFreshAuth()
    const task = vi.fn().mockRejectedValue(freshNeeded())
    const result = fresh.run(task)
    await flushPromises()
    await fresh.submit('correct-horse')
    await expect(result).rejects.toMatchObject({ code: 'forbidden', action: 'login' })
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('cancels when the prompt is closed', async () => {
    const fresh = useFreshAuth()
    const task = vi.fn().mockRejectedValue(freshNeeded())
    const result = fresh.run(task)
    await flushPromises()
    fresh.setOpen(false)
    await expect(result).rejects.toBeInstanceOf(FreshAuthCancelledError)
    expect(task).toHaveBeenCalledTimes(1)
    expect(api.auth.login).not.toHaveBeenCalled()
  })
})
