// SettingsNav (docs/UI.md 5.5; Phase 14, C54): the Web search entry right after Media, active on /settings/search.
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testIds } from '~/utils/testids'
import { byTestId, mountInShell, settle } from './chat-nav/testing'
import SettingsNav from './SettingsNav.vue'

const mocks = vi.hoisted(() => ({ route: { path: '/settings/search', fullPath: '/settings/search', query: {} } }))
vi.mock('./nuxt-imports', () => ({
  useRoute: () => mocks.route,
  navigateTo: vi.fn(),
  useColorMode: () => ({ preference: 'dark', value: 'dark' }),
}))

let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
})

describe('settingsNav', () => {
  it('lists Web search right after Media and marks it active on its page', async () => {
    const wrapper = mountInShell(SettingsNav)
    await settle()
    const links = [...document.querySelectorAll<HTMLElement>('nav[aria-label="Settings"] [data-testid^="settings-nav-"]')]
    const ids = links.map(link => link.dataset.testid)
    expect(ids.indexOf(testIds.settingsNavSearch)).toBe(ids.indexOf(testIds.settingsNavMedia) + 1)
    const search = byTestId(testIds.settingsNavSearch)!
    expect(search.dataset.state).toBe('active')
    expect(search.getAttribute('href')).toBe('/settings/search')
    expect(search.textContent).toContain('Web search')
    expect(byTestId(testIds.settingsNavMedia)!.dataset.state).toBe('inactive')
    wrapper.unmount()
  })
})
