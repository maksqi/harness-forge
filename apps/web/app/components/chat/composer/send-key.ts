// Send key matrix of the composer (docs/UI.md 7.7, 12), from the `sendKey` setting:
//   enter     -> Enter sends, Shift+Enter inserts a newline (Mod+Enter also sends)
//   mod-enter -> Mod+Enter sends, Enter and Shift+Enter insert a newline
// Mod is Command or Ctrl (either is accepted on every platform). Enter during an IME composition is ignored.
import type { SendKey } from '@harness-forge/shared'

export type EnterKeyAction = 'send' | 'newline'

export type EnterKeyEvent = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing' | 'keyCode'>

/** IME composition in progress (Safari reports keyCode 229 on the confirming Enter). */
export function isComposingEvent(event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>): boolean {
  return event.isComposing || event.keyCode === 229
}

/** What Enter does in the composer; null for other keys and for Enter during an IME composition. */
export function enterKeyAction(event: EnterKeyEvent, sendKey: SendKey): EnterKeyAction | null {
  if (event.key !== 'Enter' || isComposingEvent(event))
    return null
  const mod = event.metaKey || event.ctrlKey
  if (event.shiftKey || event.altKey)
    return 'newline'
  if (mod)
    return 'send'
  return sendKey === 'enter' ? 'send' : 'newline'
}

/** The combo shown for "Send message" in the shortcuts list. */
export function sendKeyCombo(sendKey: SendKey): string {
  return sendKey === 'enter' ? 'enter' : 'mod+enter'
}
