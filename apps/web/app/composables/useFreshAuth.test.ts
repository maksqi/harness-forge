// useFreshAuth (docs/UI.md 8.4, 11.3): the prompt first for `required` tasks of a session that is not fresh, a prompt
// after a 403 `login` otherwise, exactly one more run per prompt, one shared prompt, cancel and dispose, the login texts
// and the inline `login()`.
import type { AuthStatus } from '@harness-forge/shared'
import type { EffectScope } from 'vue'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useAuthStore } from '~/stores/auth'
import { authStatus } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { FreshAuthCancelledError, isFreshAuthCancelled, isFreshAuthRequired, loginErrorText, useFreshAuth } from './useFreshAuth'

const mocks = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))

const PASSWORD = 'correct horse'
const freshNeeded = () => new HarnessError({ code: 'forbidden', message: 'Confirm your password to continue.', action: 'login' })
const wrongPassword = () => new HarnessError({ code: 'unauthorized', message: 'Invalid password', action: 'login' })

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let scope: EffectScope

/** No password (`enabled: false`), a stale session (`freshUntil: null`) or a fresh one. */
function statusOf(state: 'none' | 'stale' | 'fresh'): AuthStatus {
  if (state === 'none')
    return authStatus()
  return authStatus({ enabled: true, source: 'settings', freshUntil: state === 'fresh' ? Date.now() + 5 * 60_000 : null })
}

function setup(state: 'none' | 'stale' | 'fresh' | 'unknown' = 'fresh') {
  useAuthStore().status = state === 'unknown' ? null : statusOf(state)
  return scope.run(() => useFreshAuth())!
}

async function flush() {
  for (let round = 0; round < 5; round++)
    await Promise.resolve()
}

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  scope = effectScope()
  api.auth.login.mockImplementation(async ({ body }: { body: { password: string } }) => {
    if (body.password !== PASSWORD)
      throw wrongPassword()
    return authStatus({ enabled: true, source: 'settings', freshUntil: Date.now() + 10 * 60_000 })
  })
})

afterEach(() => {
  scope.stop()
  disposePinia(pinia)
  vi.useRealTimers()
})

describe('helpers', () => {
  it('recognizes the fresh-auth refusal and the cancellation', () => {
    expect(isFreshAuthRequired(freshNeeded())).toBe(true)
    expect(isFreshAuthRequired({ error: { code: 'forbidden', message: 'x', action: 'login' } })).toBe(true)
    expect(isFreshAuthRequired(new HarnessError({ code: 'forbidden', message: 'Builtin plugins cannot be removed.' }))).toBe(false)
    expect(isFreshAuthRequired(new HarnessError({ code: 'unauthorized', message: 'Log in.', action: 'login' }))).toBe(false)
    expect(isFreshAuthCancelled(new FreshAuthCancelledError())).toBe(true)
    expect(isFreshAuthCancelled(new Error('Password confirmation cancelled.'))).toBe(false)
  })

  it('words login failures: wrong password, the rate-limit wait, else the server message', () => {
    expect(loginErrorText(wrongPassword())).toBe('Wrong password')
    expect(loginErrorText(new HarnessError({ code: 'rate_limited', message: 'Slow down', retryAfterMs: 27_400 }), 1_000))
      .toBe('Too many attempts. Try again in 28s.')
    expect(loginErrorText(new HarnessError({ code: 'rate_limited', message: 'Slow down' }))).toBe('Too many attempts. Try again in 1s.')
    // A 403 from the login itself is not a wrong password.
    expect(loginErrorText(new HarnessError({ code: 'forbidden', message: 'Origin check failed.' }))).toBe('Origin check failed.')
    expect(loginErrorText(new HarnessError({ code: 'internal_error', message: 'The database is locked.' }))).toBe('The database is locked.')
  })
})

describe('useFreshAuth: needed', () => {
  it('is true only with a password and a session that is not fresh', () => {
    expect(setup('none').needed.value).toBe(false)
    expect(setup('fresh').needed.value).toBe(false)
    expect(setup('unknown').needed.value).toBe(false)
    expect(setup('stale').needed.value).toBe(true)
  })
})

describe('useFreshAuth: run', () => {
  it('runs the task at once while the session is fresh, required or not', async () => {
    const fresh = setup('fresh')
    const task = vi.fn(async () => 'done')
    await expect(fresh.run(task)).resolves.toBe('done')
    await expect(fresh.run(task, { required: true })).resolves.toBe('done')
    expect(task).toHaveBeenCalledTimes(2)
    expect(fresh.open.value).toBe(false)
    expect(api.auth.login).not.toHaveBeenCalled()
  })

  it('asks for the password first for a required task when the session is not fresh', async () => {
    const fresh = setup('stale')
    const task = vi.fn(async () => 'done')
    const result = fresh.run(task, { required: true })
    await flush()
    expect(fresh.open.value).toBe(true)
    expect(task).not.toHaveBeenCalled()

    await fresh.submit(PASSWORD)
    expect(api.auth.login).toHaveBeenCalledWith({ body: { password: PASSWORD } })
    expect(fresh.open.value).toBe(false)
    await expect(result).resolves.toBe('done')
    expect(task).toHaveBeenCalledTimes(1)
    expect(fresh.needed.value).toBe(false)
  })

  it('runs a task that is not required first, then prompts after a 403 login and runs it once more', async () => {
    const fresh = setup('stale')
    const task = vi.fn().mockRejectedValueOnce(freshNeeded()).mockResolvedValueOnce('reloaded')
    const result = fresh.run(task)
    await flush()
    expect(task).toHaveBeenCalledTimes(1)
    expect(fresh.open.value).toBe(true)

    await fresh.submit(PASSWORD)
    await expect(result).resolves.toBe('reloaded')
    expect(task).toHaveBeenCalledTimes(2)
    expect(fresh.open.value).toBe(false)
  })

  it('throws a second refusal instead of asking again', async () => {
    const fresh = setup('fresh')
    const refusal = freshNeeded()
    const task = vi.fn().mockRejectedValue(refusal)
    const result = fresh.run(task)
    await flush()
    await fresh.submit(PASSWORD)
    await expect(result).rejects.toBe(refusal)
    expect(task).toHaveBeenCalledTimes(2)
    expect(api.auth.login).toHaveBeenCalledTimes(1)
    expect(fresh.open.value).toBe(false)
  })

  it('reports a refusal that follows the prompt of a required task', async () => {
    const fresh = setup('stale')
    const refusal = freshNeeded()
    const task = vi.fn().mockRejectedValue(refusal)
    const result = fresh.run(task, { required: true })
    await flush()
    await fresh.submit(PASSWORD)
    await expect(result).rejects.toBe(refusal)
    expect(task).toHaveBeenCalledTimes(1)
    expect(fresh.open.value).toBe(false)
  })

  it('passes other failures through without a prompt', async () => {
    const fresh = setup('fresh')
    const failure = new HarnessError({ code: 'not_found', message: 'Gone.' })
    await expect(fresh.run(async () => {
      throw failure
    })).rejects.toBe(failure)
    expect(fresh.open.value).toBe(false)
  })

  it('shares one prompt between concurrent tasks and runs each of them once after the login', async () => {
    const fresh = setup('stale')
    const first = vi.fn(async () => 1)
    const second = vi.fn().mockRejectedValueOnce(freshNeeded()).mockResolvedValueOnce(2)
    const results = Promise.all([fresh.run(first, { required: true }), fresh.run(second)])
    await flush()
    expect(fresh.open.value).toBe(true)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)

    await fresh.submit(PASSWORD)
    await expect(results).resolves.toEqual([1, 2])
    expect(api.auth.login).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
  })

  it('rejects every waiting task with the cancel error when the prompt is closed', async () => {
    const fresh = setup('stale')
    const first = fresh.run(async () => 1, { required: true })
    const second = fresh.run(async () => 2, { required: true })
    await flush()
    fresh.setOpen(false)
    await expect(first).rejects.toBeInstanceOf(FreshAuthCancelledError)
    const reason = await second.catch((error: unknown) => error)
    expect(isFreshAuthCancelled(reason)).toBe(true)
    expect(fresh.open.value).toBe(false)
    expect(api.auth.login).not.toHaveBeenCalled()
  })

  it('cancel() closes the prompt and rejects the waiting tasks', async () => {
    const fresh = setup('fresh')
    const task = vi.fn().mockRejectedValue(freshNeeded())
    const result = fresh.run(task)
    await flush()
    expect(fresh.open.value).toBe(true)
    fresh.cancel()
    await expect(result).rejects.toBeInstanceOf(FreshAuthCancelledError)
    expect(fresh.open.value).toBe(false)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('cancels when its scope ends (the component unmounts)', async () => {
    const fresh = setup('stale')
    const task = vi.fn(async () => 'done')
    const result = fresh.run(task, { required: true })
    await flush()
    expect(fresh.open.value).toBe(true)
    scope.stop()
    await expect(result).rejects.toBeInstanceOf(FreshAuthCancelledError)
    expect(fresh.open.value).toBe(false)
    expect(task).not.toHaveBeenCalled()
  })

  it('keeps the prompt open while the login runs, and a prompt closed meanwhile stays cancelled', async () => {
    const fresh = setup('stale')
    let finish: (status: AuthStatus) => void = () => {}
    api.auth.login.mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve
    }))
    const task = vi.fn(async () => 'done')
    const outcome = fresh.run(task, { required: true }).catch((error: unknown) => error)
    await flush()
    const submitted = fresh.submit(PASSWORD)
    expect(fresh.pending.value).toBe(true)
    fresh.setOpen(false)
    expect(fresh.open.value).toBe(true)
    // A second submit while the login runs is ignored.
    await fresh.submit(PASSWORD)
    expect(api.auth.login).toHaveBeenCalledTimes(1)

    fresh.cancel()
    finish(statusOf('fresh'))
    await submitted
    expect(await outcome).toBeInstanceOf(FreshAuthCancelledError)
    expect(task).not.toHaveBeenCalled()
    expect(fresh.pending.value).toBe(false)
    expect(fresh.open.value).toBe(false)
  })
})

describe('useFreshAuth: prompt errors', () => {
  it('keeps the prompt open with "Wrong password", then the server message of a 403 from the login', async () => {
    const fresh = setup('stale')
    const result = fresh.run(async () => 'done', { required: true })
    await flush()
    await fresh.submit('nope')
    expect(fresh.open.value).toBe(true)
    expect(fresh.error.value).toBe('Wrong password')

    api.auth.login.mockRejectedValueOnce(new HarnessError({ code: 'forbidden', message: 'Origin check failed.' }))
    await fresh.submit(PASSWORD)
    expect(fresh.open.value).toBe(true)
    expect(fresh.error.value).toBe('Origin check failed.')

    await fresh.submit(PASSWORD)
    expect(fresh.error.value).toBeNull()
    await expect(result).resolves.toBe('done')
  })

  it('counts a rate limit down and clears it when the wait is over', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 28, 12) })
    const fresh = setup('stale')
    const result = fresh.run(async () => 'done', { required: true })
    await flush()
    api.auth.login.mockRejectedValueOnce(new HarnessError({ code: 'rate_limited', message: 'Too many attempts.', retryAfterMs: 29_500 }))
    await fresh.submit('guess')
    expect(fresh.error.value).toBe('Too many attempts. Try again in 30s.')

    vi.advanceTimersByTime(12_000)
    expect(fresh.error.value).toBe('Too many attempts. Try again in 18s.')
    vi.advanceTimersByTime(18_000)
    expect(fresh.error.value).toBeNull()
    expect(fresh.open.value).toBe(true)

    await fresh.submit(PASSWORD)
    await expect(result).resolves.toBe('done')
  })

  it('starts every prompt without the error of the last one', async () => {
    const fresh = setup('stale')
    const first = fresh.run(async () => 1, { required: true })
    await flush()
    await fresh.submit('nope')
    expect(fresh.error.value).toBe('Wrong password')
    fresh.setOpen(false)
    await expect(first).rejects.toBeInstanceOf(FreshAuthCancelledError)
    expect(fresh.error.value).toBeNull()

    const second = fresh.run(async () => 2, { required: true })
    await flush()
    expect(fresh.open.value).toBe(true)
    expect(fresh.error.value).toBeNull()
    fresh.cancel()
    await expect(second).rejects.toBeInstanceOf(FreshAuthCancelledError)
  })
})

describe('useFreshAuth: login and confirm', () => {
  it('login() logs in for an inline password field and returns null, or the error text', async () => {
    const fresh = setup('stale')
    await expect(fresh.login('nope')).resolves.toBe('Wrong password')
    api.auth.login.mockRejectedValueOnce(new HarnessError({ code: 'rate_limited', message: 'Too many attempts.', retryAfterMs: 4_000 }))
    await expect(fresh.login(PASSWORD)).resolves.toBe('Too many attempts. Try again in 4s.')
    expect(fresh.needed.value).toBe(true)

    await expect(fresh.login(PASSWORD)).resolves.toBeNull()
    expect(api.auth.login).toHaveBeenLastCalledWith({ body: { password: PASSWORD } })
    expect(fresh.needed.value).toBe(false)
    // The inline field never touches the prompt.
    expect(fresh.open.value).toBe(false)
    expect(fresh.error.value).toBeNull()
  })

  it('confirm() opens the prompt now: it resolves after the login and rejects when closed', async () => {
    const fresh = setup('fresh')
    const confirmed = fresh.confirm()
    expect(fresh.open.value).toBe(true)
    // Joining the open prompt.
    expect(fresh.confirm()).toBe(confirmed)
    await fresh.submit(PASSWORD)
    await expect(confirmed).resolves.toBeUndefined()
    expect(fresh.open.value).toBe(false)

    const closed = fresh.confirm()
    fresh.setOpen(false)
    await expect(closed).rejects.toBeInstanceOf(FreshAuthCancelledError)
  })
})
