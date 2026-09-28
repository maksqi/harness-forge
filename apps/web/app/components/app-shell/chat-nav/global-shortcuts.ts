// App-wide shortcuts of docs/UI.md 12 that W2.4 owns: their ids, the definitions registered by
// useGlobalShortcuts(), and the browser-reserved combos that are never registered.
import type { ShortcutDef } from '~/composables/useShortcuts'

export const GLOBAL_SHORTCUT_IDS = {
  newChat: 'new-chat',
  commandPalette: 'command-palette',
  toggleSidebar: 'toggle-sidebar',
  showShortcuts: 'show-shortcuts',
  focusComposer: 'focus-composer',
} as const

/**
 * Combos the browser keeps for itself (docs/UI.md 12). A page cannot reliably override them, so the app never
 * binds them: New chat is Mod+Shift+O, not Mod+N.
 */
export const BROWSER_RESERVED_COMBOS: readonly string[] = [
  'mod+n',
  'mod+shift+n',
  'mod+t',
  'mod+shift+t',
  'mod+w',
  'mod+shift+w',
  'mod+tab',
  'mod+l',
  'mod+r',
  'mod+d',
  'mod+p',
  'mod+q',
]

const MODIFIERS = ['ctrl', 'meta', 'alt', 'shift'] as const

const TOKEN_ALIASES: Record<string, string> = {
  control: 'ctrl',
  cmd: 'meta',
  command: 'meta',
  option: 'alt',
  esc: 'escape',
  return: 'enter',
}

/** A comparable form of a combo: `mod` resolved for the platform, modifiers in a fixed order, then the key. */
export function canonicalCombo(keys: string, isMac: boolean): string {
  const modifiers = new Set<string>()
  const rest: string[] = []
  for (const part of keys.split('+').map(token => token.trim().toLowerCase()).filter(Boolean)) {
    const token = part === 'mod' ? (isMac ? 'meta' : 'ctrl') : (TOKEN_ALIASES[part] ?? part)
    if ((MODIFIERS as readonly string[]).includes(token))
      modifiers.add(token)
    else
      rest.push(token)
  }
  return [...MODIFIERS.filter(modifier => modifiers.has(modifier)), ...rest].join('+')
}

/** True when `keys` is one of the browser-reserved combos on this platform. */
export function isBrowserReserved(keys: string, isMac: boolean): boolean {
  const combo = canonicalCombo(keys, isMac)
  return BROWSER_RESERVED_COMBOS.some(reserved => canonicalCombo(reserved, isMac) === combo)
}

export interface GlobalShortcutActions {
  newChat: () => void
  togglePalette: () => void
  toggleShortcuts: () => void
  focusComposer: () => void
  /** Shift+Esc only applies on chat pages with no overlay open. */
  canFocusComposer: () => boolean
}

/**
 * The global shortcuts (docs/UI.md 12), in the order ShortcutsDialog lists them. Mod+B is display-only: the
 * shadcn SidebarProvider handles it.
 */
export function createGlobalShortcutDefs(actions: GlobalShortcutActions): ShortcutDef[] {
  return [
    {
      id: GLOBAL_SHORTCUT_IDS.newChat,
      keys: 'mod+shift+o',
      description: 'New chat',
      group: 'General',
      handler: () => actions.newChat(),
      allowInInputs: true,
    },
    {
      id: GLOBAL_SHORTCUT_IDS.commandPalette,
      keys: 'mod+k',
      description: 'Search chats and commands',
      group: 'General',
      handler: () => actions.togglePalette(),
      allowInInputs: true,
      allowInEditor: true,
    },
    {
      id: GLOBAL_SHORTCUT_IDS.toggleSidebar,
      keys: 'mod+b',
      description: 'Toggle sidebar',
      group: 'General',
    },
    {
      id: GLOBAL_SHORTCUT_IDS.showShortcuts,
      keys: 'mod+/',
      description: 'Show keyboard shortcuts',
      group: 'General',
      handler: () => actions.toggleShortcuts(),
      allowInInputs: true,
    },
    {
      id: GLOBAL_SHORTCUT_IDS.focusComposer,
      keys: 'shift+escape',
      description: 'Focus the composer',
      group: 'Chat',
      handler: () => actions.focusComposer(),
      when: () => actions.canFocusComposer(),
    },
  ]
}
