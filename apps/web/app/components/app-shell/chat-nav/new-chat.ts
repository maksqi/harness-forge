// "New chat" (docs/UI.md 5.3, 12, 14.1): shared by the sidebar row, the command palette and Mod+Shift+O.
import { nextTick } from 'vue'
import { useUiStore } from '~/stores/ui'
import { navigateTo } from '../nuxt-imports'

/** Touch devices never get automatic composer focus: the on-screen keyboard would pop up (docs/UI.md 14.1). */
export function prefersTouch(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches
}

/**
 * Returns the "start a new chat" action: closes the palette and the shortcuts dialog, goes to `/` and asks the
 * composer to focus itself (`ui.requestComposerFocus()`), except on touch devices. Call it during setup.
 */
export function useNewChat(): () => Promise<void> {
  const ui = useUiStore()
  return async () => {
    ui.closePalette()
    ui.shortcutsOpen = false
    try {
      await navigateTo('/')
    }
    catch {
      // A navigation guard refused the route: stay where we are and leave focus alone.
      return
    }
    await nextTick()
    if (!prefersTouch())
      ui.requestComposerFocus()
  }
}
