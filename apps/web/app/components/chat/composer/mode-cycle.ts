// Shift+Tab in the composer textarea cycles the permission mode (docs/UI.md 7.11, 11.6, 12; ADR-041): Ask -> Accept
// edits -> Plan -> Ask in a project chat; outside project chats only Ask; from Auto or Off the next mode is Ask.
// ChatComposer calls `useModeCycle().handleKeydown` from the textarea's keydown after the mention and slash menus; it
// is not a registry shortcut (the registry only lists MODE_CYCLE_SHORTCUT for the shortcuts dialog).
// C25 ships the final signatures in P9-0b (frozen from Gate P9-0b); W9.10 implements `useModeCycle` in P9-A: it takes
// the key only for Shift+Tab without other modifiers, outside IME composition, while `enabled()` and the next mode
// differs, then calls `set(next)` and `announce("Permission mode: Plan")`. Otherwise it returns false, so the native
// reverse focus move happens (no keyboard trap). Inert in P9-0b: it never takes the key.
import type { ToolMode } from '@harness-forge/shared'
import type { ShortcutDef } from '~/composables/useShortcuts'

/** The display-only entry of the shortcuts dialog (group Composer). */
export const MODE_CYCLE_SHORTCUT: Readonly<ShortcutDef> = {
  id: 'composer-cycle-mode',
  keys: 'shift+tab',
  description: 'Switch the permission mode',
  group: 'Composer',
}

/** The cycle of a project chat; outside one only Ask. */
const PROJECT_CYCLE: readonly ToolMode[] = ['ask', 'edits', 'plan']

/** The mode after `current` (project chat: ask -> edits -> plan -> ask; outside: ask; auto / off -> ask). */
export function nextToolMode(current: ToolMode, opts: { projectChat: boolean }): ToolMode {
  if (!opts.projectChat)
    return 'ask'
  const index = PROJECT_CYCLE.indexOf(current)
  return index === -1 ? 'ask' : PROJECT_CYCLE[(index + 1) % PROJECT_CYCLE.length]!
}

export interface ModeCycleOptions {
  /** `settings.resolved.shiftTabModes`, the permission menu shows and no slash or mention menu is open. */
  enabled: () => boolean
  current: () => ToolMode
  projectChat: () => boolean
  /** The composer's `update:toolMode`. */
  set: (mode: ToolMode) => void
  /** The composer's polite region ("Permission mode: Plan"). */
  announce: (text: string) => void
}

export interface ModeCycle {
  /** True = consumed (the default was prevented and the mode switched); false = the native focus move. */
  handleKeydown: (event: KeyboardEvent) => boolean
}

/** Shift+Tab mode switching of one composer. P9-0b stub: never takes the key (W9.10 implements it). */
export function useModeCycle(_opts: ModeCycleOptions): ModeCycle {
  return {
    handleKeydown: () => false,
  }
}
