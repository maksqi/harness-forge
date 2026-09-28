import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { testIds } from '~/utils/testids'
import { byTestId, mountInShell } from './chat-nav/testing'
import ModeTabs from './ModeTabs.vue'
import { DEFAULT_LAST_ROUTES, useLastRoutes } from './navigation'

const mocks = vi.hoisted(() => ({
  route: null as null | { path: string, fullPath: string, query: Record<string, string> },
  navigateTo: vi.fn(),
}))

vi.mock('./nuxt-imports', () => ({
  useRoute: () => mocks.route,
  navigateTo: mocks.navigateTo,
  useColorMode: () => ({ preference: 'dark', value: 'dark' }),
}))

/** Pixels of the Tailwind spacing utility `utility-N` among the element's classes (4px per step), else null. */
function spacingPx(element: Element, utility: string): number | null {
  const prefix = `${utility}-`
  const steps = [...element.classList]
    .filter(name => name.startsWith(prefix) && /^\d+(?:\.\d+)?$/.test(name.slice(prefix.length)))
    .map(name => Number(name.slice(prefix.length)))
  return steps.length > 0 ? steps[0]! * 4 : null
}

beforeEach(() => {
  mocks.route = reactive({ path: '/', fullPath: '/', query: {} })
  mocks.navigateTo.mockReset()
  useLastRoutes().value = { ...DEFAULT_LAST_ROUTES, plugins: '/plugins?filter=tools' }
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('modeTabs', () => {
  it('links each tab to the last route of its mode and marks the current mode active', () => {
    const wrapper = mountInShell(ModeTabs)
    const chat = byTestId(testIds.modeTabChat)!
    const plugins = byTestId(testIds.modeTabPlugins)!
    expect(chat.getAttribute('href')).toBe('/')
    expect(plugins.getAttribute('href')).toBe('/plugins?filter=tools')
    expect(chat.dataset.state).toBe('active')
    expect(plugins.dataset.state).toBe('inactive')
    expect(document.body.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Sidebar mode')
    wrapper.unmount()
  })

  it('makes the tabs 40px touch targets on coarse pointers and keeps the 32px list on desktop (UI.md 14.5)', () => {
    const wrapper = mountInShell(ModeTabs)
    const list = document.body.querySelector('[role="tablist"]')!
    const padding = spacingPx(list, 'p')!
    expect(padding).toBe(2)
    // Desktop: the h-8 segmented control of UI.md 5.1.
    expect(spacingPx(list, 'h')).toBe(32)
    // Touch: every tab fills the list's content box (h-full), so it is the list height minus its padding.
    const coarseList = spacingPx(list, 'pointer-coarse:h')!
    expect(coarseList - 2 * padding).toBeGreaterThanOrEqual(40)
    for (const tab of [byTestId(testIds.modeTabChat)!, byTestId(testIds.modeTabPlugins)!]) {
      expect(tab.classList).toContain('h-full')
      expect(spacingPx(tab, 'pointer-coarse:h')).toBeNull()
    }
    wrapper.unmount()
  })

  it('activates a tab with Space by navigating to its route', () => {
    const wrapper = mountInShell(ModeTabs)
    byTestId(testIds.modeTabPlugins)!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    expect(mocks.navigateTo).toHaveBeenCalledWith('/plugins?filter=tools')
    wrapper.unmount()
  })
})
