// Composer shortcuts in the shared registry (docs/UI.md 11.2, 12): Alt+M model picker, Alt+R effort menu (reasoning
// models), Alt+P permission menu (when tools exist) matched by `event.code` (Option+M types a symbol on macOS),
// and Esc to stop a running response when focus is outside inputs and overlays (inside the composer the textarea
// handles Esc itself). Display-only entries list the send key, Shift+Enter and the edit-last key. Registrations
// end with the calling scope (the mounted composer).
import type { SendKey } from '@harness-forge/shared'
import type { ShortcutDef } from '~/composables/useShortcuts'
import { getCurrentScope, onScopeDispose, watch } from 'vue'
import { sendKeyCombo } from '~/components/chat/composer/send-key'
import { useShortcuts } from '~/composables/useShortcuts'

export interface ComposerShortcutHandlers {
  openModelPicker: () => void
  openEffortMenu: () => void
  openPermissionMenu: () => void
  stop: () => void
  /** The effort menu is shown (the model reasons). */
  canOpenEffort: () => boolean
  /** The permission menu is shown (tools exist). */
  canOpenPermission: () => boolean
  /** A response is running. */
  canStop: () => boolean
  sendKey: () => SendKey
}

export const COMPOSER_SHORTCUT_KEYS = {
  modelPicker: 'alt+code:KeyM',
  effortMenu: 'alt+code:KeyR',
  permissionMenu: 'alt+code:KeyP',
  stop: 'escape',
} as const

/** Focus is in a dialog, popover or menu: its own keys (Esc closes it) come first. */
export function focusInOverlay(): boolean {
  if (typeof document === 'undefined')
    return false
  const active = document.activeElement
  return !!active?.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')
}

export function useComposerShortcuts(handlers: ComposerShortcutHandlers): void {
  const shortcuts = useShortcuts()
  const idle = () => !focusInOverlay()

  const actions: ShortcutDef[] = [
    {
      id: 'composer-model-picker',
      keys: COMPOSER_SHORTCUT_KEYS.modelPicker,
      description: 'Choose a model',
      group: 'Composer',
      alt: true,
      allowInInputs: true,
      when: idle,
      handler: () => handlers.openModelPicker(),
    },
    {
      id: 'composer-effort',
      keys: COMPOSER_SHORTCUT_KEYS.effortMenu,
      description: 'Set reasoning effort',
      group: 'Composer',
      alt: true,
      allowInInputs: true,
      when: () => idle() && handlers.canOpenEffort(),
      handler: () => handlers.openEffortMenu(),
    },
    {
      id: 'composer-permission',
      keys: COMPOSER_SHORTCUT_KEYS.permissionMenu,
      description: 'Set permission mode',
      group: 'Composer',
      alt: true,
      allowInInputs: true,
      when: () => idle() && handlers.canOpenPermission(),
      handler: () => handlers.openPermissionMenu(),
    },
    {
      id: 'composer-stop',
      keys: COMPOSER_SHORTCUT_KEYS.stop,
      description: 'Stop the response',
      group: 'Chat',
      when: () => idle() && handlers.canStop(),
      handler: () => handlers.stop(),
    },
  ]
  const unregisterActions = shortcuts.register(actions)

  // Display-only (no handler): the textarea handles these keys.
  let unregisterHints: (() => void) | undefined
  function registerHints(sendKey: SendKey) {
    unregisterHints?.()
    unregisterHints = shortcuts.register([
      { id: 'composer-send', keys: sendKeyCombo(sendKey), description: 'Send message', group: 'Composer' },
      { id: 'composer-newline', keys: 'shift+enter', description: 'New line', group: 'Composer' },
      { id: 'composer-edit-last', keys: 'arrowup', description: 'Edit the last message (empty composer)', group: 'Composer' },
    ])
  }
  watch(handlers.sendKey, registerHints, { immediate: true })

  if (getCurrentScope()) {
    onScopeDispose(() => {
      unregisterActions()
      unregisterHints?.()
    })
  }
}
