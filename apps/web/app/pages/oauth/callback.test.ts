// The sign-in callback route (Phase 14, ADR-059; docs/UI.md 6, 8.14; C54): `/oauth/callback` uses the `auth` layout (no
// sidebar, so `rememberRoute` never sees the `?code=` URL) around OAuthCallbackView, and the auth middleware keeps the
// query when it sends a visitor without a session to the login.
import { mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import OAuthCallbackView from '~/components/oauth/OAuthCallbackView.vue'
import AuthLayout from '~/layouts/auth.vue'
import { authRedirectFor } from '~/utils/redirect'
import { testIds } from '~/utils/testids'
import { createMockApi } from '~/utils/testing/mock-api'
import CallbackPage from './callback.vue'

const mocks = vi.hoisted(() => ({ api: null as unknown, definePageMeta: vi.fn(), useHead: vi.fn(), replace: vi.fn(), navigateTo: vi.fn() }))
vi.mock('~/components/settings/nuxt-imports', () => ({
  useHead: mocks.useHead,
  useRoute: () => ({ query: {}, fullPath: '/oauth/callback' }),
  useRouter: () => ({ replace: mocks.replace }),
  navigateTo: mocks.navigateTo,
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))

let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  mocks.api = createMockApi()
  mocks.definePageMeta.mockReset()
  mocks.replace.mockReset().mockResolvedValue(undefined)
  pinia = createPinia()
  setActivePinia(pinia)
  // definePageMeta is a Nuxt compiler macro; without Nuxt the page calls it as a global.
  vi.stubGlobal('definePageMeta', mocks.definePageMeta)
})

afterEach(() => {
  vi.unstubAllGlobals()
  disposePinia(pinia)
  document.body.replaceChildren()
})

describe('oauth callback page', () => {
  it('uses the auth layout and renders OAuthCallbackView', () => {
    const wrapper = mount(CallbackPage, { global: { plugins: [pinia] } })
    expect(mocks.definePageMeta).toHaveBeenCalledWith({ layout: 'auth' })
    expect(mocks.useHead).toHaveBeenCalledWith({ title: 'Signing in · harness-forge' })
    expect(wrapper.findComponent(OAuthCallbackView).exists()).toBe(true)
    expect(wrapper.find(`[data-testid="${testIds.oauthCallback}"]`).attributes('data-state')).toBe('working')
    wrapper.unmount()
  })

  it('the auth layout has no sidebar (AppSidebar is the only caller of rememberRoute)', () => {
    const wrapper = mount(AuthLayout, { slots: { default: () => h(CallbackPage) }, global: { plugins: [pinia] } })
    expect(wrapper.find(`[data-testid="${testIds.oauthCallback}"]`).exists()).toBe(true)
    expect(wrapper.find(`[data-testid="${testIds.sidebar}"]`).exists()).toBe(false)
    expect(wrapper.find('[data-sidebar]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('without a session the login keeps the callback query', () => {
    const fullPath = '/oauth/callback?code=sample-code&state=sampleState0000000000001&iss=https%3A%2F%2Fauth.example.com'
    const target = authRedirectFor({ path: '/oauth/callback', fullPath, query: {} }, { requiresLogin: true, authenticated: false })
    expect(target).toBe(`/login?redirect=${encodeURIComponent(fullPath)}`)
    expect(authRedirectFor({ path: '/oauth/callback', fullPath, query: {} }, { requiresLogin: false, authenticated: true })).toBeNull()
  })
})
