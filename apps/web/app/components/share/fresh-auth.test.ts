// useShareFreshAuth (docs/UI.md 7.14, 8.4): the password prompt first when the session is not fresh, once more after a
// 403 `login`, one shared prompt for concurrent requests, and cancellation.
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useAuthStore } from '~/stores/auth'
import { authStatus } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { FreshAuthCancelledError, isFreshAuthCancelled, needsFreshAuth, useShareFreshAuth } from './fresh-auth'

const mocks = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api, useApiFetch: () => vi.fn() }))

const LOGIN_REQUIRED = new HarnessError({ code: 'forbidden', message: 'Confirm your password.', action: 'login' })

let api: MockApi

function setup(fresh: boolean) {
  setActivePinia(createPinia())
  useAuthStore().status = authStatus({ enabled: true, source: 'env', freshUntil: fresh ? Date.now() + 60_000 : null })
  api.auth.login.mockResolvedValue(authStatus({ enabled: true, source: 'env', freshUntil: Date.now() + 10 * 60_000 }))
  return effectScope().run(() => useShareFreshAuth())!
}

async function flush() {
  for (let round = 0; round < 5; round++)
    await Promise.resolve()
}

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
})

describe('useShareFreshAuth', () => {
  it('runs the request at once while the session is fresh', async () => {
    const fresh = setup(true)
    const task = vi.fn(async () => 'done')
    await expect(fresh.run(task)).resolves.toBe('done')
    expect(task).toHaveBeenCalledTimes(1)
    expect(fresh.open.value).toBe(false)
  })

  it('asks for the password first when the session is not fresh', async () => {
    const fresh = setup(false)
    const task = vi.fn(async () => 'done')
    const result = fresh.run(task)
    await flush()
    expect(fresh.open.value).toBe(true)
    expect(task).not.toHaveBeenCalled()

    await fresh.submit('secret')
    expect(api.auth.login).toHaveBeenCalledWith({ body: { password: 'secret' } })
    expect(fresh.open.value).toBe(false)
    await expect(result).resolves.toBe('done')
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('prompts after a 403 login answer and retries once', async () => {
    const fresh = setup(true)
    const task = vi.fn().mockRejectedValueOnce(LOGIN_REQUIRED).mockResolvedValueOnce('done')
    const result = fresh.run(task)
    await flush()
    expect(fresh.open.value).toBe(true)
    await fresh.submit('secret')
    await expect(result).resolves.toBe('done')
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('reports a refusal that follows a successful prompt instead of asking again', async () => {
    const fresh = setup(false)
    const task = vi.fn().mockRejectedValue(LOGIN_REQUIRED)
    const result = fresh.run(task)
    await flush()
    await fresh.submit('secret')
    await expect(result).rejects.toBe(LOGIN_REQUIRED)
    expect(task).toHaveBeenCalledTimes(1)
    expect(fresh.open.value).toBe(false)
  })

  it('passes other failures through without a prompt', async () => {
    const fresh = setup(true)
    const failure = new HarnessError({ code: 'payload_too_large', message: 'Too large.' })
    await expect(fresh.run(async () => {
      throw failure
    })).rejects.toBe(failure)
    expect(fresh.open.value).toBe(false)
  })

  it('shares one prompt between concurrent requests and cancels them all when closed', async () => {
    const fresh = setup(false)
    const first = fresh.run(async () => 1)
    const second = fresh.run(async () => 2)
    await flush()
    expect(fresh.open.value).toBe(true)
    fresh.setOpen(false)
    await expect(first).rejects.toBeInstanceOf(FreshAuthCancelledError)
    const reason = await second.catch((error: unknown) => error)
    expect(isFreshAuthCancelled(reason)).toBe(true)
    expect(fresh.open.value).toBe(false)
  })

  it('keeps the prompt open with "Wrong password" or the rate-limit wait', async () => {
    const fresh = setup(false)
    const result = fresh.run(async () => 'done')
    await flush()
    api.auth.login.mockRejectedValueOnce(new HarnessError({ code: 'unauthorized', message: 'Invalid password', action: 'login' }))
    await fresh.submit('wrong')
    expect(fresh.open.value).toBe(true)
    expect(fresh.error.value).toBe('Wrong password')

    api.auth.login.mockRejectedValueOnce(new HarnessError({ code: 'rate_limited', message: 'Too many attempts.', retryAfterMs: 29_500 }))
    await fresh.submit('wrong again')
    expect(fresh.error.value).toBe('Too many attempts. Try again in 30s.')

    await fresh.submit('right')
    expect(fresh.error.value).toBeNull()
    await expect(result).resolves.toBe('done')
  })

  it('recognizes the fresh-auth refusal', () => {
    expect(needsFreshAuth(LOGIN_REQUIRED)).toBe(true)
    expect(needsFreshAuth(new HarnessError({ code: 'forbidden', message: 'Origin check failed.' }))).toBe(false)
    expect(needsFreshAuth(new HarnessError({ code: 'unauthorized', message: 'Log in.', action: 'login' }))).toBe(false)
  })
})
