import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { testIds } from '~/utils/testids'
import { authStatus } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { loginFailure, rateLimitMessage, secondsUntil } from './login'
import LoginForm from './LoginForm.vue'

const mock = vi.hoisted(() => ({ api: null as unknown, navigateTo: vi.fn() }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))
vi.mock('./nuxt-imports', () => ({ navigateTo: mock.navigateTo }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  mock.navigateTo.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
  vi.useRealTimers()
  document.body.replaceChildren()
})

function mountForm(redirect?: unknown) {
  return mount(LoginForm, { props: { redirect }, attachTo: document.body, global: { plugins: [pinia] } })
}

async function logIn(wrapper: ReturnType<typeof mountForm>, password: string) {
  await wrapper.get(`[data-testid="${testIds.loginPassword}"]`).setValue(password)
  await wrapper.get(`[data-testid="${testIds.loginForm}"]`).trigger('submit')
  await flushPromises()
}

describe('loginForm', () => {
  it('goes to a safe ?redirect= target after logging in', async () => {
    api.auth.login.mockResolvedValue(authStatus({ enabled: true, authenticated: true, source: 'settings' }))
    const wrapper = mountForm('/settings/about')
    expect(wrapper.get(`[data-testid="${testIds.loginSubmit}"]`).attributes('disabled')).toBeDefined()

    await logIn(wrapper, 'correct horse')

    expect(api.auth.login).toHaveBeenCalledWith({ body: { password: 'correct horse' } })
    expect(mock.navigateTo).toHaveBeenCalledWith('/settings/about', { replace: true })
    expect(wrapper.find(`[data-testid="${testIds.loginError}"]`).exists()).toBe(false)
  })

  it.each([
    ['//evil.example/phish', '/'],
    ['https://evil.example', '/'],
    ['/\\evil.example', '/'],
    ['/login?redirect=/x', '/'],
    [undefined, '/'],
    [['/chat/abc', '/other'], '/chat/abc'],
  ])('redirect %j goes to %s', async (redirect, target) => {
    api.auth.login.mockResolvedValue(authStatus({ enabled: true, authenticated: true, source: 'settings' }))
    const wrapper = mountForm(redirect)
    await logIn(wrapper, 'pw')
    expect(mock.navigateTo).toHaveBeenCalledWith(target, { replace: true })
  })

  it('says "Wrong password" and stays on the page', async () => {
    api.auth.login.mockRejectedValue(new HarnessError({ code: 'unauthorized', message: 'Invalid password' }))
    const wrapper = mountForm('/plugins')

    await logIn(wrapper, 'nope')

    const error = wrapper.get(`[data-testid="${testIds.loginError}"]`)
    expect(error.text()).toBe('Wrong password')
    expect(error.attributes('role')).toBe('alert')
    expect(wrapper.get(`[data-testid="${testIds.loginPassword}"]`).attributes('aria-invalid')).toBe('true')
    expect(mock.navigateTo).not.toHaveBeenCalled()
  })

  it('counts down a rate limit and blocks Log in meanwhile', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    api.auth.login.mockRejectedValue(new HarnessError({ code: 'rate_limited', message: 'Too many attempts', retryAfterMs: 30_000 }))
    const wrapper = mountForm()

    await logIn(wrapper, 'guess')

    const submit = () => wrapper.get(`[data-testid="${testIds.loginSubmit}"]`)
    expect(wrapper.get(`[data-testid="${testIds.loginError}"]`).text()).toBe('Too many attempts. Try again in 30s.')
    expect(submit().attributes('disabled')).toBeDefined()

    vi.advanceTimersByTime(12_000)
    await nextTick()
    expect(wrapper.get(`[data-testid="${testIds.loginError}"]`).text()).toBe('Too many attempts. Try again in 18s.')

    vi.advanceTimersByTime(18_500)
    await nextTick()
    expect(wrapper.find(`[data-testid="${testIds.loginError}"]`).exists()).toBe(false)
    expect(submit().attributes('disabled')).toBeUndefined()
  })
})

describe('login rules', () => {
  it('maps login failures to messages', () => {
    expect(loginFailure(new HarnessError({ code: 'unauthorized', message: 'Invalid password' })))
      .toEqual({ message: 'Wrong password', retryAt: null })
    expect(loginFailure(new HarnessError({ code: 'rate_limited', message: 'x', retryAfterMs: 5000 }), 1000))
      .toEqual({ message: '', retryAt: 6000 })
    expect(loginFailure(new HarnessError({ code: 'rate_limited', message: 'x' }), 1000).retryAt).toBe(2000)
    expect(loginFailure(new HarnessError({ code: 'internal_error', message: 'Server unavailable.' })).message)
      .toBe('Server unavailable.')
    expect(rateLimitMessage(29.2)).toBe('Too many attempts. Try again in 30s.')
    expect(secondsUntil(6000, 1000)).toBe(5)
    expect(secondsUntil(6000, 7000)).toBe(0)
    expect(secondsUntil(null, 7000)).toBe(0)
  })
})
