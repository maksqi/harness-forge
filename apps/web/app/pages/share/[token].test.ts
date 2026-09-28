import { mount } from '@vue/test-utils'
import { setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h, nextTick, reactive } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import SharedChatView from '~/components/share/SharedChatView.vue'
import { OTHER_TOKEN, settle, shareView, TOKEN } from '~/components/share/testing'
import ShareLayout from '~/layouts/share.vue'
import { testIds } from '~/utils/testids'
import SharePage from './[token].vue'

const mocks = vi.hoisted(() => ({
  route: null as null | { params: Record<string, string | string[]> },
  definePageMeta: vi.fn(),
  /** Every `api.<module>.<action>` the page touched. */
  calls: [] as Array<{ key: string, input: unknown }>,
  view: null as unknown,
}))

vi.mock('~/components/share/nuxt-imports', () => ({
  useRoute: () => mocks.route,
  useHead: vi.fn(),
}))
// A recording stand-in for the typed client: shares.view answers, anything else rejects.
vi.mock('~/composables/useApi', () => ({
  useApi: () => new Proxy({}, {
    get: (_target, module) => new Proxy({}, {
      get: (_inner, action) => async (input: unknown) => {
        const key = `${String(module)}.${String(action)}`
        mocks.calls.push({ key, input })
        if (key === 'shares.view')
          return mocks.view
        throw new Error(`unexpected call ${key}`)
      },
    }),
  }),
  useApiFetch: () => vi.fn(),
}))
// Markdown reads the color mode; the layout's ThemeToggle too, through the shell's module.
vi.mock('~/components/chat/nuxt-imports', () => ({
  useColorMode: () => ({ value: 'dark', preference: 'dark' }),
  useRoute: vi.fn(),
  useRouter: vi.fn(),
  navigateTo: vi.fn(),
}))
vi.mock('~/components/app-shell/nuxt-imports', () => ({
  useColorMode: () => reactive({ value: 'dark', preference: 'dark' }),
  useRoute: vi.fn(),
  navigateTo: vi.fn(),
}))

beforeEach(() => {
  mocks.route = reactive({ params: { token: TOKEN } })
  mocks.definePageMeta.mockReset()
  mocks.calls = []
  mocks.view = shareView({
    title: 'Refactor auth flow',
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', modelRef: 'mock:echo', parts: [{ type: 'text', text: 'Hi there' }] },
    ],
  })
  // No active Pinia: the share page and its layout must not touch any store.
  setActivePinia(undefined)
  // definePageMeta is a Nuxt compiler macro; without Nuxt the page calls it as a global.
  vi.stubGlobal('definePageMeta', mocks.definePageMeta)
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('share page', () => {
  it('uses the share layout and renders SharedChatView with the token route param', () => {
    const wrapper = mount(SharePage)
    expect(mocks.definePageMeta).toHaveBeenCalledWith({ layout: 'share' })
    expect(wrapper.getComponent(SharedChatView).props('token')).toBe(TOKEN)
    expect(wrapper.find(`[data-testid="${testIds.sharePage}"]`).exists()).toBe(true)
    wrapper.unmount()
  })

  it('follows the route param and passes an empty token for a repeated param', async () => {
    const wrapper = mount(SharePage)
    mocks.route!.params.token = OTHER_TOKEN
    await nextTick()
    expect(wrapper.getComponent(SharedChatView).props('token')).toBe(OTHER_TOKEN)
    mocks.route!.params.token = [TOKEN, OTHER_TOKEN]
    await nextTick()
    expect(wrapper.getComponent(SharedChatView).props('token')).toBe('')
    wrapper.unmount()
  })

  it('renders the snapshot inside the share layout without any store, calling only shares.view', async () => {
    // app.vue provides the TooltipProvider around every layout.
    const wrapper = mount({
      render: () => h(TooltipProvider, null, {
        default: () => h(ShareLayout, null, { default: () => h(SharePage) }),
      }),
    }, { attachTo: document.body })
    await settle()
    await new Promise(resolve => setTimeout(resolve, 30))
    const page = wrapper.get(`main [data-testid="${testIds.sharePage}"]`)
    expect(page.attributes('data-state')).toBe('ready')
    expect(wrapper.get(`[data-testid="${testIds.shareTitle}"]`).text()).toBe('Refactor auth flow')
    expect(wrapper.findAll(`[data-testid="${testIds.shareMessage}"]`)).toHaveLength(2)
    expect(page.text()).toContain('Hi there')
    expect(mocks.calls).toEqual([{ key: 'shares.view', input: { params: { token: TOKEN } } }])
    // No app shell: no sidebar, composer or chat header.
    for (const id of [testIds.sidebar, testIds.composer, testIds.chatHeader])
      expect(wrapper.find(`[data-testid="${id}"]`).exists(), id).toBe(false)
    wrapper.unmount()
  })
})
