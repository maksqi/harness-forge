// Platform-aware key combo formatting for KbdCombo (docs/UI.md section 12).
// Combo strings use the useShortcuts() syntax: tokens joined by '+', e.g. 'mod+shift+o', 'alt+m', 'code:KeyM'.
// `mod` is Command on macOS and Ctrl elsewhere.

export interface KeyToken {
  /** Visible label: a glyph on macOS ('⌘'), a word elsewhere ('Ctrl'). */
  label: string
  /** Spoken name for screen readers ('Command', 'Ctrl'). */
  name: string
}

interface KeyNames {
  mac: [label: string, name: string]
  other: [label: string, name: string]
}

const NAMED_KEYS: Record<string, KeyNames> = {
  mod: { mac: ['⌘', 'Command'], other: ['Ctrl', 'Ctrl'] },
  meta: { mac: ['⌘', 'Command'], other: ['Meta', 'Meta'] },
  ctrl: { mac: ['⌃', 'Control'], other: ['Ctrl', 'Ctrl'] },
  control: { mac: ['⌃', 'Control'], other: ['Ctrl', 'Ctrl'] },
  alt: { mac: ['⌥', 'Option'], other: ['Alt', 'Alt'] },
  option: { mac: ['⌥', 'Option'], other: ['Alt', 'Alt'] },
  shift: { mac: ['⇧', 'Shift'], other: ['Shift', 'Shift'] },
  enter: { mac: ['↵', 'Return'], other: ['Enter', 'Enter'] },
  return: { mac: ['↵', 'Return'], other: ['Enter', 'Enter'] },
  escape: { mac: ['Esc', 'Escape'], other: ['Esc', 'Escape'] },
  esc: { mac: ['Esc', 'Escape'], other: ['Esc', 'Escape'] },
  tab: { mac: ['⇥', 'Tab'], other: ['Tab', 'Tab'] },
  space: { mac: ['Space', 'Space'], other: ['Space', 'Space'] },
  backspace: { mac: ['⌫', 'Delete'], other: ['Backspace', 'Backspace'] },
  delete: { mac: ['⌦', 'Forward delete'], other: ['Del', 'Delete'] },
  arrowup: { mac: ['↑', 'Up arrow'], other: ['↑', 'Up arrow'] },
  arrowdown: { mac: ['↓', 'Down arrow'], other: ['↓', 'Down arrow'] },
  arrowleft: { mac: ['←', 'Left arrow'], other: ['←', 'Left arrow'] },
  arrowright: { mac: ['→', 'Right arrow'], other: ['→', 'Right arrow'] },
  up: { mac: ['↑', 'Up arrow'], other: ['↑', 'Up arrow'] },
  down: { mac: ['↓', 'Down arrow'], other: ['↓', 'Down arrow'] },
  slash: { mac: ['/', 'Slash'], other: ['/', 'Slash'] },
}

// event.code values used with the 'code:' prefix (Alt shortcuts match the physical key).
const CODE_KEYS: Record<string, string> = {
  Slash: '/',
  Backslash: '\\',
  Period: '.',
  Comma: ',',
  Semicolon: ';',
  Quote: '\'',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: 'space',
  Enter: 'enter',
  Escape: 'escape',
}

function keyFromCode(code: string): string {
  if (/^Key[A-Z]$/.test(code))
    return code.slice(3)
  if (/^Digit\d$/.test(code))
    return code.slice(5)
  return CODE_KEYS[code] ?? code
}

/** Splits a combo into display tokens for the given platform. Unknown keys are shown as typed. */
export function formatKeys(keys: string, mac: boolean): KeyToken[] {
  return keys
    .split('+')
    .map(part => part.trim())
    .filter(Boolean)
    .map((part) => {
      const key = part.startsWith('code:') ? keyFromCode(part.slice(5)) : part
      const named = NAMED_KEYS[key.toLowerCase()]
      if (named) {
        const [label, name] = mac ? named.mac : named.other
        return { label, name }
      }
      const label = key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1)
      return { label, name: label }
    })
}

/** True on macOS and iOS/iPadOS, where `mod` means Command. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined')
    return false
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent || ''
  return /mac|iphone|ipad|ipod/i.test(platform)
}
