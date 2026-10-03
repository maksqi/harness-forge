import { describe, expect, it } from 'vitest'
import { effectScope } from 'vue'
import { MODE_CYCLE_SHORTCUT } from '~/components/chat/composer/mode-cycle'
import { useComposerShortcuts } from './useComposerShortcuts'
import { useShortcuts } from './useShortcuts'

describe('useComposerShortcuts', () => {
  it('lists the display-only Shift+Tab mode cycle for the shortcuts dialog and removes it with the scope', () => {
    const scope = effectScope()
    scope.run(() => useComposerShortcuts({
      openModelPicker: () => {},
      openEffortMenu: () => {},
      openPermissionMenu: () => {},
      stop: () => {},
      canOpenEffort: () => true,
      canOpenPermission: () => true,
      canStop: () => false,
      sendKey: () => 'enter',
    }))
    const entry = useShortcuts().list().find(shortcut => shortcut.id === MODE_CYCLE_SHORTCUT.id)
    expect(entry).toMatchObject({ keys: 'shift+tab', group: 'Composer', description: 'Switch the permission mode' })
    expect(entry?.handler).toBeUndefined()
    scope.stop()
    expect(useShortcuts().list().some(shortcut => shortcut.id === MODE_CYCLE_SHORTCUT.id)).toBe(false)
  })
})
