import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'
import SharedChatView from '~/components/share/SharedChatView.vue'
import { testIds } from '~/utils/testids'
import SharePage from './[token].vue'

const TOKEN = '0bN3aK9xQ7fLm2PzRt5_uV-wXy8zAb1Cd2Ef3G'
const OTHER_TOKEN = 'Zz9Yy8Xx7Ww6Vv5U-u4Tt3Ss2Rr1Qq0Pp_Oo9N'

const mocks = vi.hoisted(() => ({
  route: null as null | { params: Record<string, string | string[]> },
  definePageMeta: vi.fn(),
}))

vi.mock('~/components/share/nuxt-imports', () => ({
  useRoute: () => mocks.route,
  useHead: vi.fn(),
}))

beforeEach(() => {
  mocks.route = reactive({ params: { token: TOKEN } })
  mocks.definePageMeta.mockReset()
  // definePageMeta is a Nuxt compiler macro; without Nuxt the page calls it as a global.
  vi.stubGlobal('definePageMeta', mocks.definePageMeta)
})

afterEach(() => {
  vi.unstubAllGlobals()
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
})
