// Installs the single `keydown` listener of the shortcut registry (docs/UI.md 11.2, 12) and connects Alt
// shortcuts to the `altShortcuts` setting. Shortcuts themselves are registered by components (W2.3, W2.4, W3.4).
import { defineNuxtPlugin } from '#imports'
import { useShortcuts } from '~/composables/useShortcuts'
import { useSettingsStore } from '~/stores/settings'

export default defineNuxtPlugin(() => {
  const settings = useSettingsStore()
  const shortcuts = useShortcuts()
  shortcuts.setAltEnabled(() => settings.resolved.altShortcuts)
  window.addEventListener('keydown', shortcuts.handleKeydown)
})
