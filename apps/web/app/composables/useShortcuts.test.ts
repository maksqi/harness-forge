import type { ShortcutDef, ShortcutRegistry } from './useShortcuts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope } from 'vue'
import { createShortcutRegistry, useShortcuts } from './useShortcuts'

interface KeyInit {
  key: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  isComposing?: boolean
  repeat?: boolean
}

let installed: ShortcutRegistry | null = null

function setup(options: { isMac?: boolean, altEnabled?: () => boolean } = {}) {
  const registry = createShortcutRegistry({ isMac: options.isMac ?? false, altEnabled: options.altEnabled })
  window.addEventListener('keydown', registry.handleKeydown)
  installed = registry
  return registry
}

/** Dispatches a keydown on `target` (default body) and returns it (check `defaultPrevented`). */
function press(init: KeyInit, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: '', ...init })
  target.dispatchEvent(event)
  return event
}

function def(overrides: Partial<ShortcutDef> & Pick<ShortcutDef, 'keys'>): ShortcutDef {
  return { id: overrides.keys, description: overrides.keys, group: 'General', handler: vi.fn(), ...overrides }
}

afterEach(() => {
  if (installed)
    window.removeEventListener('keydown', installed.handleKeydown)
  installed = null
  document.body.replaceChildren()
})

describe('useShortcuts', () => {
  it('maps mod to Ctrl off macOS and to Meta on macOS', () => {
    const other = setup({ isMac: false })
    const newChat = def({ id: 'new-chat', keys: 'mod+shift+o' })
    other.register(newChat)
    press({ key: 'O', code: 'KeyO', metaKey: true, shiftKey: true })
    expect(newChat.handler).not.toHaveBeenCalled()
    const event = press({ key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true })
    expect(newChat.handler).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    window.removeEventListener('keydown', other.handleKeydown)

    const mac = setup({ isMac: true })
    const palette = def({ id: 'palette', keys: 'mod+k' })
    mac.register(palette)
    press({ key: 'k', code: 'KeyK', ctrlKey: true })
    expect(palette.handler).not.toHaveBeenCalled()
    press({ key: 'k', code: 'KeyK', metaKey: true })
    expect(palette.handler).toHaveBeenCalledTimes(1)
  })

  it('requires the exact modifiers', () => {
    const registry = setup()
    const palette = def({ keys: 'mod+k' })
    registry.register(palette)
    press({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true })
    press({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true })
    press({ key: 'k', code: 'KeyK' })
    expect(palette.handler).not.toHaveBeenCalled()
  })

  it('lets later registrations win and restores the earlier one on unregister', () => {
    const registry = setup()
    const first = def({ id: 'first', keys: 'mod+k' })
    const second = def({ id: 'second', keys: 'mod+k' })
    registry.register(first)
    const unregister = registry.register(second)
    press({ key: 'k', code: 'KeyK', ctrlKey: true })
    expect(second.handler).toHaveBeenCalledTimes(1)
    expect(first.handler).not.toHaveBeenCalled()
    unregister()
    press({ key: 'k', code: 'KeyK', ctrlKey: true })
    expect(first.handler).toHaveBeenCalledTimes(1)
  })

  it('skips display-only shortcuts and shortcuts whose `when` is false', () => {
    const registry = setup()
    const sidebar = def({ keys: 'mod+b', handler: undefined })
    const gated = def({ keys: 'mod+j', when: () => false })
    registry.register([sidebar, gated])
    expect(press({ key: 'b', code: 'KeyB', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(press({ key: 'j', code: 'KeyJ', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(gated.handler).not.toHaveBeenCalled()
  })

  it('ignores typing in inputs unless allowed, and CodeMirror unless allowed there', () => {
    const registry = setup()
    const focus = def({ id: 'focus-composer', keys: 'shift+escape' })
    const palette = def({ id: 'palette', keys: 'mod+k', allowInInputs: true, allowInEditor: true })
    const shortcuts = def({ id: 'shortcuts', keys: 'mod+/', allowInInputs: true })
    registry.register([focus, palette, shortcuts])

    const input = document.createElement('input')
    const editor = document.createElement('div')
    editor.className = 'cm-editor'
    const content = document.createElement('div')
    content.setAttribute('contenteditable', 'true')
    editor.append(content)
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    document.body.append(input, editor, checkbox)

    press({ key: 'Escape', code: 'Escape', shiftKey: true }, input)
    expect(focus.handler).not.toHaveBeenCalled()
    press({ key: 'Escape', code: 'Escape', shiftKey: true }, checkbox)
    expect(focus.handler).toHaveBeenCalledTimes(1)

    press({ key: 'k', code: 'KeyK', ctrlKey: true }, input)
    press({ key: 'k', code: 'KeyK', ctrlKey: true }, content)
    expect(palette.handler).toHaveBeenCalledTimes(2)

    press({ key: '/', code: 'Slash', ctrlKey: true }, input)
    expect(shortcuts.handler).toHaveBeenCalledTimes(1)
    press({ key: '/', code: 'Slash', ctrlKey: true }, content)
    expect(shortcuts.handler).toHaveBeenCalledTimes(1)
  })

  it('matches Alt shortcuts by event.code, never with Ctrl or Meta, and honors the altShortcuts setting', () => {
    let altEnabled = true
    const registry = setup({ isMac: true, altEnabled: () => altEnabled })
    const picker = def({ id: 'model-picker', keys: 'alt+code:KeyM', alt: true })
    registry.register(picker)
    // Option+M types a symbol on macOS: the physical key still matches.
    press({ key: 'µ', code: 'KeyM', altKey: true })
    expect(picker.handler).toHaveBeenCalledTimes(1)
    press({ key: 'm', code: 'KeyM', altKey: true, ctrlKey: true })
    press({ key: 'm', code: 'KeyM', altKey: true, metaKey: true })
    expect(picker.handler).toHaveBeenCalledTimes(1)
    altEnabled = false
    expect(press({ key: 'µ', code: 'KeyM', altKey: true }).defaultPrevented).toBe(false)
    expect(picker.handler).toHaveBeenCalledTimes(1)
  })

  it('reads the altShortcuts setting connected later', () => {
    const registry = setup()
    const effort = def({ keys: 'alt+code:KeyR' })
    registry.register(effort)
    registry.setAltEnabled(() => false)
    press({ key: 'r', code: 'KeyR', altKey: true })
    expect(effort.handler).not.toHaveBeenCalled()
  })

  it('falls back to the physical key on non-Latin layouts', () => {
    const registry = setup()
    const palette = def({ keys: 'mod+k' })
    registry.register(palette)
    press({ key: 'κ', code: 'KeyK', ctrlKey: true })
    expect(palette.handler).toHaveBeenCalledTimes(1)
  })

  it('ignores Shift for punctuation that needs it on some layouts', () => {
    const registry = setup()
    const shortcuts = def({ keys: 'mod+/' })
    registry.register(shortcuts)
    press({ key: '/', code: 'Digit7', ctrlKey: true, shiftKey: true })
    expect(shortcuts.handler).toHaveBeenCalledTimes(1)
  })

  it('ignores IME composition and events already handled, and does not repeat', () => {
    const registry = setup()
    const palette = def({ keys: 'mod+k' })
    registry.register(palette)
    press({ key: 'k', code: 'KeyK', ctrlKey: true, isComposing: true })
    const handled = new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, cancelable: true })
    handled.preventDefault()
    registry.handleKeydown(handled)
    expect(palette.handler).not.toHaveBeenCalled()
    const repeated = press({ key: 'k', code: 'KeyK', ctrlKey: true, repeat: true })
    expect(repeated.defaultPrevented).toBe(true)
    expect(palette.handler).not.toHaveBeenCalled()
  })

  it('lists one entry per id in group order, reactively', () => {
    const registry = createShortcutRegistry({ isMac: false })
    const ids = computed(() => registry.list().map(item => item.id))
    registry.register([
      def({ id: 'model', keys: 'alt+code:KeyM', group: 'Chat' }),
      def({ id: 'palette', keys: 'mod+k' }),
      def({ id: 'save', keys: 'mod+s', group: 'Editor' }),
    ])
    expect(ids.value).toEqual(['palette', 'model', 'save'])
    const unregister = registry.register(def({ id: 'palette', keys: 'mod+k', description: 'Search chats' }))
    expect(registry.list().filter(item => item.id === 'palette')).toHaveLength(1)
    expect(registry.list()[0]?.description).toBe('Search chats')
    unregister()
    expect(registry.list()[0]?.description).toBe('mod+k')
  })

  it('unregisters automatically when the scope ends', () => {
    const registry = setup()
    const palette = def({ keys: 'mod+k' })
    const scope = effectScope()
    scope.run(() => registry.register(palette))
    expect(registry.list()).toHaveLength(1)
    scope.stop()
    expect(registry.list()).toHaveLength(0)
    press({ key: 'k', code: 'KeyK', ctrlKey: true })
    expect(palette.handler).not.toHaveBeenCalled()
  })

  it('formats combos per platform', () => {
    expect(createShortcutRegistry({ isMac: true }).format('mod+shift+o')).toEqual(['⌘', '⇧', 'O'])
    expect(createShortcutRegistry({ isMac: false }).format('mod+shift+o')).toEqual(['Ctrl', 'Shift', 'O'])
    expect(createShortcutRegistry({ isMac: false }).format('alt+code:KeyM')).toEqual(['Alt', 'M'])
  })

  it('shares one registry across the app', () => {
    expect(useShortcuts()).toBe(useShortcuts())
  })
})
