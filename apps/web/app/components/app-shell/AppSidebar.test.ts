import { mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { sidebarMenuButtonVariants, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import { createMockApi } from '~/utils/testing/mock-api'
import AppSidebar from './AppSidebar.vue'
import { press, settle } from './chat-nav/testing'
import { DEFAULT_LAST_ROUTES, LAST_ROUTES_KEY, useLastRoutes } from './navigation'

const mocks = vi.hoisted(() => ({
  route: null as null | { path: string, fullPath: string, query: Record<string, string> },
  colorMode: { preference: 'dark', value: 'dark' },
  api: null as unknown,
}))

// ChatNav / PluginsNav read Pinia stores over the typed client ('#imports' does not resolve in Vitest).
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))

let pinia: ReturnType<typeof createPinia>

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

/**
 * The layout's shell; `withTrigger` adds a SidebarTrigger like the page headers have (it opens the mobile sheet),
 * `collapsed` starts in icon mode.
 */
function mountSidebar({ withTrigger = false, collapsed = false } = {}) {
  return mount({
    render: () => h(SidebarProvider, collapsed ? { defaultOpen: false } : null, {
      default: () => h(TooltipProvider, null, { default: () => [h(AppSidebar), withTrigger && h(SidebarTrigger)] }),
    }),
  }, { attachTo: document.body, global: { stubs: { NuxtLink } } })
}

/** Below md: the SidebarProvider's `(max-width: 768px)` query matches. */
function stubMobileViewport() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 768px)',
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}

beforeEach(() => {
  mocks.api = createMockApi()
  pinia = createPinia()
  setActivePinia(pinia)
  mocks.route = reactive({ path: '/', fullPath: '/', query: {} })
  useLastRoutes().value = { ...DEFAULT_LAST_ROUTES }
})

afterEach(() => {
  document.body.replaceChildren()
  disposePinia(pinia)
  vi.unstubAllGlobals()
})

describe('appSidebar', () => {
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

  it('opens as an 18rem sheet below md: no width rule of the sheet outranks the sidebar width (UI.md 14.5)', async () => {
    stubMobileViewport()
    const wrapper = mountSidebar({ withTrigger: true })
    await settle()
    expect(document.body.querySelector(`[data-testid="${testIds.sidebar}"]`)).toBeNull()

    wrapper.get('[data-slot="sidebar-trigger"]').element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle()
    const sheet = document.body.querySelector<HTMLElement>('[role="dialog"][data-mobile="true"]')!
    expect(sheet).not.toBeNull()
    expect(sheet.dataset.side).toBe('left')
    expect(sheet.style.getPropertyValue('--sidebar-width')).toBe('18rem')
    expect(sheet.querySelector(`[data-testid="${testIds.sidebar}"]`)?.getAttribute('data-state')).toBe('expanded')
    // SheetContent's own `data-[side=left]:w-3/4` beats a plain `w-*` class (attribute selector, higher specificity):
    // the sheet was 75% of the screen (292.5px at 390px). Every width rule left must be the sidebar width.
    const widths = [...sheet.classList].filter(name => /(?:^|:)w-/.test(name))
    expect(widths).toContain('data-[side=left]:w-(--sidebar-width)')
    expect(widths.filter(name => !name.endsWith('w-(--sidebar-width)'))).toEqual([])
    wrapper.unmount()
  })
})

describe('appSidebar: the icon rail on touch devices (UI.md 14.5)', () => {
  const RAIL_BUTTON = ['pointer-coarse:group-data-[collapsible=icon]:size-10!', 'pointer-coarse:group-data-[collapsible=icon]:p-3!']

  it('is 3.5rem wide on a coarse pointer and 3rem otherwise, set by classes instead of the inline style', () => {
    const wrapper = mountSidebar({ collapsed: true })
    const shell = wrapper.get<HTMLElement>('[data-slot="sidebar-wrapper"]')
    expect(shell.classes()).toEqual(expect.arrayContaining(['[--sidebar-width-icon:3rem]', 'pointer-coarse:[--sidebar-width-icon:3.5rem]']))
    // An inline value would outrank both classes.
    expect(shell.element.style.getPropertyValue('--sidebar-width-icon')).toBe('')
    expect(shell.element.style.getPropertyValue('--sidebar-width')).toBe('16rem')
    wrapper.unmount()
  })

  it('makes every rail button, the brand and the theme menu a 40px target on a coarse pointer', () => {
    const wrapper = mountSidebar({ collapsed: true })
    expect(wrapper.get(`[data-testid="${testIds.sidebar}"]`).attributes('data-state')).toBe('collapsed')
    const buttons = wrapper.findAll('[data-sidebar="menu-button"]')
    // Chat | Plugins, New chat, Search and Settings.
    expect(buttons.length).toBeGreaterThanOrEqual(4)
    for (const button of buttons) {
      expect(button.classes(), button.attributes('data-testid')).toEqual(expect.arrayContaining(RAIL_BUTTON))
      // The row height classes of the app (SIDEBAR_ROW_CLASS) keep the rail rules.
      expect(button.classes()).toContain('group-data-[collapsible=icon]:size-8!')
    }
    const brand = wrapper.get('button[aria-label="Expand sidebar"]')
    expect(brand.classes()).toEqual(expect.arrayContaining(['size-8', 'pointer-coarse:size-10']))
    expect(wrapper.get(`[data-testid="${testIds.themeToggle}"]`).classes()).toEqual(expect.arrayContaining(['size-8', 'pointer-coarse:size-10']))
    wrapper.unmount()
  })

  it('keeps the zero padding of large menu buttons on a coarse pointer', () => {
    const large = cn(sidebarMenuButtonVariants({ size: 'lg' })).split(' ')
    expect(large).toEqual(expect.arrayContaining(['group-data-[collapsible=icon]:p-0!', 'pointer-coarse:group-data-[collapsible=icon]:p-0!']))
    expect(large).not.toContain('pointer-coarse:group-data-[collapsible=icon]:p-3!')
    expect(cn(sidebarMenuButtonVariants()).split(' ')).toEqual(expect.arrayContaining(RAIL_BUTTON))
  })
})

describe('appSidebar: Mod+B', () => {
  function sidebarState(wrapper: ReturnType<typeof mountSidebar>) {
    return wrapper.get(`[data-testid="${testIds.sidebar}"]`).attributes('data-state')
  }

  it('toggles the sidebar whatever the case of the key: Caps Lock and non-Latin layouts', async () => {
    const wrapper = mountSidebar()
    expect(sidebarState(wrapper)).toBe('expanded')
    const combos: [string, KeyboardEventInit & { key: string }][] = [
      ['Ctrl+B', { key: 'b', code: 'KeyB', ctrlKey: true }],
      ['Ctrl+B with Caps Lock', { key: 'B', code: 'KeyB', ctrlKey: true }],
      ['Cmd+B with Caps Lock', { key: 'B', code: 'KeyB', metaKey: true }],
      ['Cmd+B', { key: 'b', code: 'KeyB', metaKey: true }],
      ['Ctrl+B on a Greek layout', { key: 'β', code: 'KeyB', ctrlKey: true }],
    ]
    let expected = 'expanded'
    for (const [name, init] of combos) {
      const event = press(init, document.body)
      await nextTick()
      expected = expected === 'expanded' ? 'collapsed' : 'expanded'
      expect(sidebarState(wrapper), name).toBe(expected)
      expect(event.defaultPrevented, name).toBe(true)
    }
    wrapper.unmount()
  })

  it('ignores B without Mod, Alt combos, other letters on the B key, IME composition and handled events', async () => {
    const wrapper = mountSidebar()
    const ignored: [string, KeyboardEventInit & { key: string }][] = [
      ['B', { key: 'b', code: 'KeyB' }],
      ['Shift+B', { key: 'B', code: 'KeyB', shiftKey: true }],
      ['Ctrl+Shift+B (the browser bookmarks bar)', { key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true }],
      ['Cmd+Shift+B (the browser bookmarks bar)', { key: 'B', code: 'KeyB', metaKey: true, shiftKey: true }],
      ['Ctrl+Alt+B', { key: 'b', code: 'KeyB', ctrlKey: true, altKey: true }],
      ['AltGr+B typing a quote', { key: '”', code: 'KeyB', ctrlKey: true, altKey: true }],
      ['Ctrl+X on Dvorak (the physical B key)', { key: 'x', code: 'KeyB', ctrlKey: true }],
      ['Ctrl+B during IME composition', { key: 'Process', code: 'KeyB', ctrlKey: true, isComposing: true }],
    ]
    for (const [name, init] of ignored) {
      const event = press(init, document.body)
      await nextTick()
      expect(sidebarState(wrapper), name).toBe('expanded')
      expect(event.defaultPrevented, name).toBe(false)
    }

    // A handler closer to the target took the key first (CodeMirror binds Ctrl+B on macOS): it wins.
    const takeKey = (event: Event) => event.preventDefault()
    document.body.addEventListener('keydown', takeKey)
    press({ key: 'b', code: 'KeyB', ctrlKey: true }, document.body)
    document.body.removeEventListener('keydown', takeKey)
    await nextTick()
    expect(sidebarState(wrapper)).toBe('expanded')
    wrapper.unmount()
  })
})
