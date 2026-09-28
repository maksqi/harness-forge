import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import AppSidebar from './AppSidebar.vue'
import { DEFAULT_LAST_ROUTES, LAST_ROUTES_KEY, useLastRoutes } from './navigation'

const mocks = vi.hoisted(() => ({
  route: null as null | { path: string, fullPath: string, query: Record<string, string> },
  colorMode: { preference: 'dark', value: 'dark' },
}))

vi.mock('./nuxt-imports', () => ({
  useRoute: () => mocks.route,
  useColorMode: () => mocks.colorMode,
  navigateTo: vi.fn(),
}))

// NuxtLink stand-in: an anchor with the resolved href, so link targets can be asserted.
const NuxtLink = defineComponent({
  props: { to: { type: [String, Object], required: true } },
  setup(props, { slots }) {
    return () => {
      const to = props.to as string | { path: string, query?: Record<string, string> }
      const href = typeof to === 'string' ? to : `${to.path}?${new URLSearchParams(to.query).toString()}`
      return h('a', { href }, slots.default?.())
    }
  },
})

function go(fullPath: string) {
  const [path, search = ''] = fullPath.split('?')
  mocks.route!.path = path!
  mocks.route!.fullPath = fullPath
  mocks.route!.query = Object.fromEntries(new URLSearchParams(search))
}

function mountSidebar() {
  return mount({
    render: () => h(SidebarProvider, null, {
      default: () => h(TooltipProvider, null, { default: () => h(AppSidebar) }),
    }),
  }, { attachTo: document.body, global: { stubs: { NuxtLink } } })
}

describe('appSidebar', () => {
  beforeEach(() => {
    mocks.route = reactive({ path: '/', fullPath: '/', query: {} })
    useLastRoutes().value = { ...DEFAULT_LAST_ROUTES }
  })

  afterEach(() => {
    document.body.replaceChildren()
  })

  it('shows the chat mode on / with the Chat tab active', () => {
    const wrapper = mountSidebar()
    const sidebar = wrapper.get(`[data-testid="${testIds.sidebar}"]`)
    expect(sidebar.attributes('data-state')).toBe('expanded')
    expect(sidebar.attributes('data-mode')).toBe('chat')
    expect(wrapper.get(`[data-testid="${testIds.modeTabChat}"]`).attributes('data-state')).toBe('active')
    expect(wrapper.get(`[data-testid="${testIds.modeTabPlugins}"]`).attributes('data-state')).toBe('inactive')
    expect(wrapper.find(`[data-testid="${testIds.newChat}"]`).exists()).toBe(true)
    expect(wrapper.get(`[data-testid="${testIds.settingsLink}"]`).attributes('href')).toBe('/settings/providers')
    expect(wrapper.find('nav[aria-label="Chats"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('switches content with the route and remembers the last route per mode', async () => {
    const wrapper = mountSidebar()
    go('/plugins?filter=tools')
    await nextTick()
    expect(wrapper.get(`[data-testid="${testIds.modeTabPlugins}"]`).attributes('data-state')).toBe('active')
    expect(wrapper.find('nav[aria-label="Plugins"]').exists()).toBe(true)
    const active = wrapper.findAll(`[data-testid="${testIds.pluginsFilter}"]`).find(row => row.attributes('data-active') !== undefined)
    expect(active?.attributes('data-value')).toBe('tools')

    go('/chat/abc')
    await nextTick()
    expect(wrapper.get(`[data-testid="${testIds.modeTabPlugins}"]`).attributes('href')).toBe('/plugins?filter=tools')
    expect(JSON.parse(sessionStorage.getItem(LAST_ROUTES_KEY) ?? '{}')).toMatchObject({ chat: '/chat/abc', app: '/chat/abc' })
    wrapper.unmount()
  })

  it('replaces the tabs with Back to app and the settings nav in settings mode', async () => {
    const wrapper = mountSidebar()
    go('/plugins')
    await nextTick()
    go('/settings/models')
    await nextTick()
    expect(wrapper.find(`[data-testid="${testIds.modeTabChat}"]`).exists()).toBe(false)
    expect(wrapper.find(`[data-testid="${testIds.settingsLink}"]`).exists()).toBe(false)
    expect(wrapper.get(`[data-testid="${testIds.backToApp}"]`).attributes('href')).toBe('/plugins')
    expect(wrapper.get(`[data-testid="${testIds.settingsNavModels}"]`).attributes('data-state')).toBe('active')
    expect(wrapper.get(`[data-testid="${testIds.settingsNavProviders}"]`).attributes('data-state')).toBe('inactive')
    expect(wrapper.find(`[data-testid="${testIds.themeToggle}"]`).exists()).toBe(true)
    wrapper.unmount()
  })
})
