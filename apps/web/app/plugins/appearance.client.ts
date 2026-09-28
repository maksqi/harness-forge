// UI boot (docs/UI.md 3.5, 11): applies the cached density, text size and reading font to <html> before the app
// mounts so nothing jumps, creates the ui store (it mirrors the app-shell stubs' hf:open-* events from the first
// click), then loads the settings once the user has access; `settings.fetch()` applies the server values (and
// refreshes the cache). A failed load (e.g. 501 in Phase 0) keeps the defaults quietly.
import { watch } from 'vue'
import { defineNuxtPlugin } from '#imports'
import { useAuthStore } from '~/stores/auth'
import { useSettingsStore } from '~/stores/settings'
import { useUiStore } from '~/stores/ui'
import { applyAppearanceToDocument, readCachedAppearance } from '~/utils/appearance'

export default defineNuxtPlugin(() => {
  const cached = readCachedAppearance()
  if (cached)
    applyAppearanceToDocument(cached)
  useUiStore()

  const auth = useAuthStore()
  const settings = useSettingsStore()
  watch(() => auth.loaded && !auth.requiresLogin, (ready) => {
    if (ready && !settings.loaded)
      settings.fetch().catch(() => {})
  }, { immediate: true })
})
