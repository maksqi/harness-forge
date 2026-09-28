import type { VueWrapper } from '@vue/test-utils'
import type { EffectScope } from 'vue'
import type { ShortcutDef } from '~/composables/useShortcuts'
import { DEFAULT_SETTINGS } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useShortcuts } from '~/composables/useShortcuts'
import { useSettingsStore } from '~/stores/settings'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import { byTestId, mountInShell, settle } from './chat-nav/testing'
import ShortcutsDialog from './ShortcutsDialog.vue'

const mocks = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))

let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper | null = null
let scope: EffectScope | null = null

const DEFS: ShortcutDef[] = [
  { id: 'new-chat', keys: 'mod+shift+o', description: 'New chat', group: 'General', handler: () => {} },
  { id: 'toggle-sidebar', keys: 'mod+b', description: 'Toggle sidebar', group: 'General' },
  { id: 'model-picker', keys: 'alt+code:KeyM', description: 'Choose model', group: 'Chat', handler: () => {} },
  { id: 'focus-composer', keys: 'shift+escape', description: 'Focus the composer', group: 'Chat', handler: () => {} },
  { id: 'effort', keys: 'alt+r', description: 'Set reasoning effort', group: 'Composer', handler: () => {} },
]

function register(defs: ShortcutDef[] = DEFS) {
  scope ??= effectScope(true)
  return scope.run(() => useShortcuts().register(defs))!
}

async function openDialog() {
  wrapper = mountInShell(ShortcutsDialog)
  useUiStore().openShortcuts()
  await settle()
  return byTestId(testIds.shortcutsDialog)!
}

function sections(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>('section[data-group]')).map(section => [
    section.dataset.group,
    Array.from(section.querySelectorAll('dt')).map(term => term.textContent?.trim()),
  ])
}

function rowOf(dialog: HTMLElement, id: string) {
  return dialog.querySelector<HTMLElement>(`[data-shortcut-id="${id}"]`)!
}

beforeEach(() => {
  mocks.api = createMockApi()
  stubLocalStorage()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  scope?.stop()
  scope = null
  document.body.replaceChildren()
  disposePinia(pinia)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('shortcutsDialog', () => {
  it('lists the registry grouped General, Chat, Composer with platform key labels', async () => {
    register()
    const dialog = await openDialog()
    expect(dialog.textContent).toContain('Keyboard shortcuts')
    expect(sections(dialog)).toEqual([
      ['General', ['New chat', 'Toggle sidebar']],
      ['Chat', ['Choose model', 'Focus the composer']],
      ['Composer', ['Set reasoning effort']],
    ])
    // Not macOS in happy-dom: Mod reads Ctrl, and each key is its own cap.
    const caps = Array.from(rowOf(dialog, 'new-chat').querySelectorAll('[data-slot="kbd"]')).map(cap => cap.textContent?.trim())
    expect(caps).toEqual(['Ctrl', 'Shift', 'O'])
    expect(Array.from(rowOf(dialog, 'model-picker').querySelectorAll('[data-slot="kbd"]')).map(cap => cap.textContent?.trim())).toEqual(['Alt', 'M'])
  })

  it('uses macOS symbols on Apple platforms', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    register()
    const dialog = await openDialog()
    const caps = Array.from(rowOf(dialog, 'new-chat').querySelectorAll('[data-slot="kbd"]')).map(cap => cap.textContent?.trim())
    expect(caps).toEqual(['⌘⇧O'])
  })

  it('follows registrations while open', async () => {
    const unregister = register([DEFS[0]!])
    const dialog = await openDialog()
    expect(sections(dialog)).toEqual([['General', ['New chat']]])
    register([{ id: 'save', keys: 'mod+s', description: 'Save the file', group: 'Editor', handler: () => {} }])
    await settle()
    expect(sections(dialog)).toEqual([['General', ['New chat']], ['Editor', ['Save the file']]])
    unregister()
    await settle()
    expect(sections(dialog)).toEqual([['Editor', ['Save the file']]])
  })

  it('marks Alt shortcuts as off while the altShortcuts setting is off, with a link to the setting', async () => {
    register()
    useSettingsStore().settings = { ...DEFAULT_SETTINGS, altShortcuts: false }
    const dialog = await openDialog()
    expect(rowOf(dialog, 'model-picker').dataset.state).toBe('off')
    expect(rowOf(dialog, 'effort').dataset.state).toBe('off')
    expect(rowOf(dialog, 'model-picker').textContent).toContain('Off')
    expect(rowOf(dialog, 'new-chat').dataset.state).toBe('on')
    const link = dialog.querySelector<HTMLAnchorElement>('a[href="/settings/general"]')!
    expect(dialog.textContent).toContain('Alt shortcuts are off.')
    link.click()
    await settle()
    expect(useUiStore().shortcutsOpen).toBe(false)
  })

  it('shows every shortcut as on (and no note) while Alt shortcuts are enabled', async () => {
    register()
    const dialog = await openDialog()
    expect(dialog.querySelectorAll('[data-state="off"]')).toHaveLength(0)
    expect(dialog.textContent).not.toContain('Alt shortcuts are off.')
  })

  it('is bound to ui.shortcutsOpen', async () => {
    register()
    await openDialog()
    const ui = useUiStore()
    ui.shortcutsOpen = false
    await settle()
    expect(byTestId(testIds.shortcutsDialog)).toBeNull()
    ui.openShortcuts()
    await settle()
    expect(byTestId(testIds.shortcutsDialog)).not.toBeNull()
    // Escape closes it and writes the store.
    byTestId(testIds.shortcutsDialog)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    expect(ui.shortcutsOpen).toBe(false)
  })
})
