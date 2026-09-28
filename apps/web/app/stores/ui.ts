// UI store (docs/UI.md 11): overlays (command palette, shortcuts dialog, install dialog), the show-thinking
// override, composer focus requests, the open chat and the appearance attributes. Signatures are frozen after
// Phase 0.
import type { AppearanceSettings } from '~/utils/appearance'
import { useEventListener } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { applyAppearanceToDocument, cacheAppearance } from '~/utils/appearance'
import { useChatsStore } from './chats'
import { useSettingsStore } from './settings'

/** Source tab the install dialog opens on (docs/UI.md 8.3). */
export type InstallSource = 'zip' | 'npm' | 'url' | 'folder'

// Window events of the Phase 0 app-shell stubs (C3): ChatNav opens the palette with `hf:open-command-palette`,
// the palette opens the shortcuts dialog with `hf:open-shortcuts`. The store mirrors them into its state and sends
// them from openPalette() / openShortcuts(), so the stubs and store-bound components (W2.4) both work.
export const OPEN_PALETTE_EVENT = 'hf:open-command-palette'
export const OPEN_SHORTCUTS_EVENT = 'hf:open-shortcuts'

export const useUiStore = defineStore('ui', () => {
  // ---------- state ----------

  const paletteOpen = ref(false)
  const shortcutsOpen = ref(false)
  const installDialogOpen = ref(false)
  const installSource = ref<InstallSource>('zip')
  /** The chat menu "Show thinking" choice for this session; null = the `showThinking` setting. */
  const showThinkingOverride = ref<boolean | null>(null)
  /** Incremented by requestComposerFocus(); the composer watches it and focuses itself. */
  const composerFocusRequest = ref(0)
  /** Id of the chat shown on /chat/[id] (null elsewhere); run.finished of other chats marks them unread. */
  const activeChatId = ref<string | null>(null)

  // ---------- getters ----------

  const showThinking = computed(() => showThinkingOverride.value ?? useSettingsStore().resolved.showThinking)

  // ---------- window event bridge ----------

  let announcing = false
  function announce(type: string) {
    if (typeof window === 'undefined' || announcing)
      return
    announcing = true
    try {
      window.dispatchEvent(new CustomEvent(type))
    }
    finally {
      announcing = false
    }
  }

  if (typeof window !== 'undefined') {
    useEventListener(window, OPEN_PALETTE_EVENT, () => {
      paletteOpen.value = true
    })
    useEventListener(window, OPEN_SHORTCUTS_EVENT, () => {
      shortcutsOpen.value = true
    })
  }

  // ---------- actions ----------

  function openPalette() {
    paletteOpen.value = true
    announce(OPEN_PALETTE_EVENT)
  }

  function closePalette() {
    paletteOpen.value = false
  }

  function togglePalette() {
    if (paletteOpen.value)
      closePalette()
    else
      openPalette()
  }

  function openShortcuts() {
    paletteOpen.value = false
    shortcutsOpen.value = true
    announce(OPEN_SHORTCUTS_EVENT)
  }

  /** Opens the single InstallDialog (mounted by pages/plugins.vue) on the given source tab. */
  function openInstall(source: InstallSource = 'zip') {
    installSource.value = source
    installDialogOpen.value = true
  }

  function toggleShowThinking() {
    showThinkingOverride.value = !showThinking.value
  }

  function requestComposerFocus() {
    composerFocusRequest.value += 1
  }

  /** Sets the open chat; opening a chat clears its unread dot. */
  function setActiveChat(id: string | null) {
    activeChatId.value = id
    if (id)
      useChatsStore().markRead(id)
  }

  /** Sets `data-density`, `data-text-size` and `data-reading-font` on <html> and caches them (docs/UI.md 3.5). */
  function applyAppearance(appearance: AppearanceSettings) {
    applyAppearanceToDocument(appearance)
    cacheAppearance(appearance)
  }

  return {
    paletteOpen,
    shortcutsOpen,
    installDialogOpen,
    installSource,
    showThinkingOverride,
    composerFocusRequest,
    activeChatId,
    showThinking,
    openPalette,
    closePalette,
    togglePalette,
    openShortcuts,
    openInstall,
    toggleShowThinking,
    requestComposerFocus,
    setActiveChat,
    applyAppearance,
  }
})
