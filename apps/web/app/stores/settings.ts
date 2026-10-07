// Settings store (docs/UI.md 11, docs/API.md 5.3): global settings with defaults, optimistic updates, and the
// appearance keys applied to <html> through the ui store. Signatures are frozen after Phase 0.
import type { Settings } from '@harness-forge/shared'
import { DEFAULT_SETTINGS } from '@harness-forge/shared'
import { defineStore } from 'pinia'
import { computed, ref, toRaw } from 'vue'
import { useApi } from '~/composables/useApi'
import { APPEARANCE_KEYS, pickAppearance } from '~/utils/appearance'
import { withHarnessErrors } from '~/utils/errors'
import { useUiStore } from './ui'

/**
 * Whether a stored value is still the optimistic one of a patch: identical, or (Phase 12: the object setting
 * `modelAliases`, which the store hands back as a reactive proxy) the same JSON.
 */
function isPatchedValue(current: unknown, patched: unknown): boolean {
  const raw = toRaw(current)
  if (Object.is(raw, patched))
    return true
  return typeof raw === 'object' && raw !== null && typeof patched === 'object' && patched !== null
    && JSON.stringify(raw) === JSON.stringify(patched)
}

export const useSettingsStore = defineStore('settings', () => {
  const api = useApi()

  // ---------- state ----------

  /** Settings from the server (optimistic values included); null until loaded or first updated. */
  const settings = ref<Settings | null>(null)
  /** `fetch()` succeeded at least once. */
  const loaded = ref(false)
  /** An update is in flight. */
  const saving = ref(false)

  // ---------- getters ----------

  /** Every key present: server values over `DEFAULT_SETTINGS`. Safe to read before loading. */
  const resolved = computed<Settings>(() => ({ ...DEFAULT_SETTINGS, ...settings.value }))

  // ---------- actions ----------

  let pendingFetch: Promise<Settings> | null = null
  let updateSeq = 0
  let updatesInFlight = 0

  function applyAppearance(value: Settings) {
    useUiStore().applyAppearance(pickAppearance(value))
  }

  /** `GET /settings`; applies the appearance keys. Concurrent calls share one request. Throws `HarnessError`. */
  function fetch(): Promise<Settings> {
    if (pendingFetch)
      return pendingFetch
    const startedAt = updateSeq
    const request = withHarnessErrors(api.settings.get())
      .then((next) => {
        // An update started meanwhile: its own response carries the newer values.
        if (updateSeq === startedAt)
          settings.value = next
        loaded.value = true
        applyAppearance(resolved.value)
        return resolved.value
      })
      .finally(() => {
        pendingFetch = null
      })
    pendingFetch = request
    return request
  }

  /**
   * `PUT /settings` with a partial patch. Optimistic: the values apply at once and roll back when the request fails
   * (keys changed again meanwhile keep their newer value). Appearance keys are re-applied to <html>.
   * Throws `HarnessError`; callers show the toast.
   */
  async function update(patch: Partial<Settings>): Promise<Settings> {
    const keys = Object.keys(patch) as Array<keyof Settings>
    if (keys.length === 0)
      return resolved.value
    const before = resolved.value
    const seq = ++updateSeq
    const touchesAppearance = keys.some(key => (APPEARANCE_KEYS as ReadonlyArray<keyof Settings>).includes(key))
    settings.value = { ...before, ...patch }
    if (touchesAppearance)
      applyAppearance(settings.value)
    updatesInFlight += 1
    saving.value = true
    try {
      const next = await withHarnessErrors(api.settings.update({ body: patch }))
      if (seq === updateSeq) {
        settings.value = next
        if (touchesAppearance)
          applyAppearance(next)
      }
      return next
    }
    catch (error) {
      const current: Record<keyof Settings, unknown> = { ...resolved.value }
      for (const key of keys) {
        if (isPatchedValue(current[key], patch[key]))
          current[key] = before[key]
      }
      settings.value = current as Settings
      if (touchesAppearance)
        applyAppearance(settings.value)
      throw error
    }
    finally {
      updatesInFlight -= 1
      saving.value = updatesInFlight > 0
    }
  }

  return {
    settings,
    loaded,
    saving,
    resolved,
    fetch,
    update,
  }
})
