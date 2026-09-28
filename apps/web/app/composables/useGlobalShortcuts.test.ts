import type { EffectScope } from 'vue'
import type { ShortcutRegistry } from './useShortcuts'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, reactive } from 'vue'
import {
  BROWSER_RESERVED_COMBOS,
  canonicalCombo,
  createGlobalShortcutDefs,
  GLOBAL_SHORTCUT_IDS,
  isBrowserReserved,
} from '~/components/app-shell/chat-nav/global-shortcuts'
import { press, settle } from '~/components/app-shell/chat-nav/testing'
import { useUiStore } from '~/stores/ui'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import { useGlobalShortcuts } from './useGlobalShortcuts'
import { createShortcutRegistry } from './useShortcuts'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  route: null as null | { path: string, fullPath: string },
  navigateTo: vi.fn(),
}))

vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('~/components/app-shell/nuxt-imports', () => ({
  useRoute: () => mocks.route,
  navigateTo: mocks.navigateTo,
  useColorMode: () => ({ preference: 'dark', value: 'dark' }),
}))

let pinia: ReturnType<typeof createPinia>
let registry: ShortcutRegistry
const scopes: EffectScope[] = []

function install(options: { isMac?: boolean, altEnabled?: () => boolean } = {}) {
  registry = createShortcutRegistry({ isMac: options.isMac ?? false, altEnabled: options.altEnabled })
  window.addEventListener('keydown', registry.handleKeydown)
  return registry
}

function use() {
  const scope = effectScope(true)
  scope.run(() => useGlobalShortcuts({ registry }))
  scopes.push(scope)
  return scope
}

function ctrl(key: string, init: KeyboardEventInit = {}, target?: EventTarget) {
  return press({ key, code: `Key${key.toUpperCase()}`, ctrlKey: true, ...init }, target ?? document.body)
}

function go(path: string) {
  mocks.route!.path = path
  mocks.route!.fullPath = path
}

beforeEach(() => {
  mocks.api = createMockApi()
  mocks.route = reactive({ path: '/', fullPath: '/' })
  mocks.navigateTo.mockReset()
  stubLocalStorage()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  for (const scope of scopes.splice(0))
    scope.stop()
  if (registry)
    window.removeEventListener('keydown', registry.handleKeydown)
  document.body.replaceChildren()
  disposePinia(pinia)
  vi.unstubAllGlobals()
})

describe('useGlobalShortcuts: registration', () => {
  it('registers each shortcut exactly once, in the documented groups, however many callers there are', () => {
    install()
    const register = vi.spyOn(registry, 'register')
    const first = use()
    const second = use()
    expect(register).toHaveBeenCalledTimes(1)
    expect(registry.list().map(def => [def.id, def.keys, def.group])).toEqual([
      [GLOBAL_SHORTCUT_IDS.newChat, 'mod+shift+o', 'General'],
      [GLOBAL_SHORTCUT_IDS.commandPalette, 'mod+k', 'General'],
      [GLOBAL_SHORTCUT_IDS.toggleSidebar, 'mod+b', 'General'],
      [GLOBAL_SHORTCUT_IDS.showShortcuts, 'mod+/', 'General'],
      [GLOBAL_SHORTCUT_IDS.focusComposer, 'shift+escape', 'Chat'],
    ])

    // One Ctrl+K toggles once (a double registration would toggle twice and cancel out).
    ctrl('k')
    expect(useUiStore().paletteOpen).toBe(true)

    first.stop()
    expect(registry.list()).toHaveLength(5)
    second.stop()
    expect(registry.list()).toEqual([])
    ctrl('k')
    expect(useUiStore().paletteOpen).toBe(true)

    use()
    expect(register).toHaveBeenCalledTimes(2)
    expect(registry.list()).toHaveLength(5)
  })

  it('never binds a browser-reserved combo', () => {
    for (const isMac of [false, true]) {
      const defs = createGlobalShortcutDefs({
        newChat: () => {},
        togglePalette: () => {},
        toggleShortcuts: () => {},
        focusComposer: () => {},
        canFocusComposer: () => true,
      })
      expect(defs.filter(def => isBrowserReserved(def.keys, isMac))).toEqual([])
    }
    expect(isBrowserReserved('mod+n', false)).toBe(true)
    expect(isBrowserReserved('ctrl+shift+w', false)).toBe(true)
    expect(isBrowserReserved('meta+w', true)).toBe(true)
    expect(isBrowserReserved('cmd+q', true)).toBe(true)
    expect(isBrowserReserved('ctrl+w', true)).toBe(false)
    expect(isBrowserReserved('mod+shift+o', false)).toBe(false)
    expect(isBrowserReserved('mod+k', true)).toBe(false)
    expect(BROWSER_RESERVED_COMBOS).toContain('mod+p')
    expect(canonicalCombo('Shift+Mod+N', false)).toBe('ctrl+shift+n')
    expect(canonicalCombo('shift+esc', true)).toBe('shift+escape')
  })
})

describe('useGlobalShortcuts: keys', () => {
  it('maps Mod to Ctrl off macOS and to Meta on macOS', () => {
    install({ isMac: false })
    use()
    const ui = useUiStore()
    press({ key: 'k', code: 'KeyK', metaKey: true })
    expect(ui.paletteOpen).toBe(false)
    ctrl('k')
    expect(ui.paletteOpen).toBe(true)
    for (const scope of scopes.splice(0))
      scope.stop()
    window.removeEventListener('keydown', registry.handleKeydown)

    install({ isMac: true })
    use()
    ui.closePalette()
    ctrl('k')
    expect(ui.paletteOpen).toBe(false)
    const event = press({ key: 'k', code: 'KeyK', metaKey: true })
    expect(ui.paletteOpen).toBe(true)
    expect(event.defaultPrevented).toBe(true)
  })

  it('mod+K toggles the palette from inputs and CodeMirror, and closes the shortcuts dialog', () => {
    install()
    use()
    const ui = useUiStore()
    ui.openShortcuts()
    const textarea = document.body.appendChild(document.createElement('textarea'))
    ctrl('k', {}, textarea)
    expect(ui.paletteOpen).toBe(true)
    expect(ui.shortcutsOpen).toBe(false)

    const editor = document.body.appendChild(document.createElement('div'))
    editor.className = 'cm-editor'
    const content = editor.appendChild(document.createElement('div'))
    content.setAttribute('contenteditable', 'true')
    ctrl('k', {}, content)
    expect(ui.paletteOpen).toBe(false)
  })

  it('mod+Shift+O starts a new chat from anywhere, including inputs', async () => {
    install()
    use()
    const ui = useUiStore()
    go('/chat/abc')
    ui.openPalette()
    const input = document.body.appendChild(document.createElement('input'))
    const event = press({ key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true }, input)
    expect(event.defaultPrevented).toBe(true)
    await settle()
    expect(mocks.navigateTo).toHaveBeenCalledWith('/')
    expect(ui.paletteOpen).toBe(false)
    expect(ui.composerFocusRequest).toBe(1)
  })

  it('does not focus the composer on touch devices after Mod+Shift+O', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)', media: query }))
    install()
    use()
    press({ key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true })
    await settle()
    expect(mocks.navigateTo).toHaveBeenCalledWith('/')
    expect(useUiStore().composerFocusRequest).toBe(0)
  })

  it('mod+/ opens the shortcuts dialog (closing the palette) and closes it again', () => {
    install()
    use()
    const ui = useUiStore()
    ui.openPalette()
    const input = document.body.appendChild(document.createElement('input'))
    const event = press({ key: '/', code: 'Slash', ctrlKey: true }, input)
    expect(event.defaultPrevented).toBe(true)
    expect(ui.shortcutsOpen).toBe(true)
    expect(ui.paletteOpen).toBe(false)
    // Layouts where "/" needs Shift still match.
    press({ key: '/', code: 'Digit7', ctrlKey: true, shiftKey: true })
    expect(ui.shortcutsOpen).toBe(false)
  })

  it('shift+Esc focuses the composer on chat pages only, with no overlay open and not from inputs', () => {
    install()
    use()
    const ui = useUiStore()
    const shiftEsc = (target?: EventTarget) => press({ key: 'Escape', code: 'Escape', shiftKey: true }, target ?? document.body)

    shiftEsc()
    expect(ui.composerFocusRequest).toBe(1)
    go('/chat/abc')
    shiftEsc()
    expect(ui.composerFocusRequest).toBe(2)

    go('/settings/general')
    shiftEsc()
    go('/plugins')
    shiftEsc()
    expect(ui.composerFocusRequest).toBe(2)

    go('/chat/abc')
    ui.openPalette()
    shiftEsc()
    ui.closePalette()
    ui.openShortcuts()
    shiftEsc()
    ui.shortcutsOpen = false
    shiftEsc(document.body.appendChild(document.createElement('input')))
    expect(ui.composerFocusRequest).toBe(2)
    // Plain Escape is not ours.
    press({ key: 'Escape', code: 'Escape' })
    expect(ui.composerFocusRequest).toBe(2)
  })

  it('mod+B is listed but left to the SidebarProvider', () => {
    install()
    use()
    const entry = registry.list().find(def => def.id === GLOBAL_SHORTCUT_IDS.toggleSidebar)
    expect(entry?.handler).toBeUndefined()
    const event = ctrl('b')
    expect(event.defaultPrevented).toBe(false)
  })

  it('keeps working when Alt shortcuts are turned off (none of them uses Alt)', () => {
    install({ altEnabled: () => false })
    use()
    ctrl('k')
    expect(useUiStore().paletteOpen).toBe(true)
    expect(registry.list().some(def => def.alt || def.keys.includes('alt'))).toBe(false)
  })
})
