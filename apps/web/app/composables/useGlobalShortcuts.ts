// Global keyboard shortcuts (docs/UI.md 11.2, 12): Mod+K command palette, Mod+Shift+O new chat, Mod+/ shortcuts
// dialog, Shift+Esc focus the composer (chat pages), plus the display-only Mod+B entry (the SidebarProvider
// handles it). Called from CommandPalette.vue, which layouts/default.vue mounts once. Every shortcut goes through
// the shared useShortcuts() registry (its single keydown listener lives in plugins/shortcuts.client.ts), which
// resolves Mod to Meta on macOS and Ctrl elsewhere and skips Alt shortcuts when the `altShortcuts` setting is off.
import type { ShortcutRegistry } from './useShortcuts'
import { effectScope, getCurrentScope, onScopeDispose } from 'vue'
import { createGlobalShortcutDefs, isBrowserReserved } from '~/components/app-shell/chat-nav/global-shortcuts'
import { useNewChat } from '~/components/app-shell/chat-nav/new-chat'
import { modeOfPath } from '~/components/app-shell/navigation'
import { useRoute } from '~/components/app-shell/nuxt-imports'
import { useUiStore } from '~/stores/ui'
import { useShortcuts } from './useShortcuts'

export interface UseGlobalShortcutsOptions {
  /** Default: the app-wide registry. Tests pass their own (e.g. with `isMac`). */
  registry?: ShortcutRegistry
}

interface ActiveRegistration {
  users: number
  stop: () => void
}

// One registration per registry, shared by every caller: a second mounted palette (layout switch, hot reload)
// never registers the shortcuts twice. The last caller to go away unregisters them.
const active = new WeakMap<ShortcutRegistry, ActiveRegistration>()

function register(registry: ShortcutRegistry): ActiveRegistration {
  const ui = useUiStore()
  const route = useRoute()
  const newChat = useNewChat()
  const defs = createGlobalShortcutDefs({
    newChat: () => void newChat(),
    togglePalette: () => {
      ui.shortcutsOpen = false
      ui.togglePalette()
    },
    toggleShortcuts: () => {
      if (ui.shortcutsOpen)
        ui.shortcutsOpen = false
      else
        ui.openShortcuts()
    },
    focusComposer: () => ui.requestComposerFocus(),
    canFocusComposer: () => modeOfPath(route.path) === 'chat' && !ui.paletteOpen && !ui.shortcutsOpen,
  }).filter(def => !isBrowserReserved(def.keys, registry.isMac))
  // The registry unregisters when the scope that registered stops: use a detached one owned by this entry.
  const scope = effectScope(true)
  scope.run(() => registry.register(defs))
  return { users: 0, stop: () => scope.stop() }
}

/** Registers the global shortcuts once (idempotent); they stay registered while at least one caller's scope lives. */
export function useGlobalShortcuts(options: UseGlobalShortcutsOptions = {}): void {
  const registry = options.registry ?? useShortcuts()
  let entry = active.get(registry)
  if (!entry) {
    entry = register(registry)
    active.set(registry, entry)
  }
  const current = entry
  current.users += 1
  if (!getCurrentScope())
    return
  onScopeDispose(() => {
    current.users -= 1
    if (current.users > 0)
      return
    current.stop()
    if (active.get(registry) === current)
      active.delete(registry)
  })
}
