// The LobeHub icon list of the icon picker (`GET /api/icons/lobe`, docs/API.md 5.8), loaded once per page load and
// shared by every picker, plus the icon URLs of a slug (served by the server only, ADR-010).
import type { IconRef, LobeIconEntry } from '@harness-forge/shared'
import { apiUrl } from '@harness-forge/shared'
import { reactive, readonly } from 'vue'
import { useApi } from '~/composables/useApi'

interface LobeIconsState {
  items: LobeIconEntry[]
  version: string
  loaded: boolean
  loading: boolean
  error: unknown
}

const state = reactive<LobeIconsState>({ items: [], version: '', loaded: false, loading: false, error: null })
let pending: Promise<void> | null = null

/** URL of one icon file (a mono slug, or `<slug>-color`). */
export function lobeIconUrl(slug: string, version: string): string {
  const url = apiUrl('icons.get', { params: { slug } })
  return version ? `${url}?v=${encodeURIComponent(version)}` : url
}

/** `IconRef` of a slug: mono always, color when the `-color` variant exists. */
export function lobeIconRef(slug: string, hasColor: boolean, version: string): IconRef {
  return { mono: lobeIconUrl(slug, version), ...(hasColor ? { color: lobeIconUrl(`${slug}-color`, version) } : {}) }
}

export function useLobeIcons() {
  const api = useApi()

  function load(force = false): Promise<void> {
    if (pending)
      return pending
    if (state.loaded && !force)
      return Promise.resolve()
    state.loading = true
    state.error = null
    pending = api.icons.list()
      .then((list) => {
        state.items = list.items
        state.version = list.version
        state.loaded = true
      })
      .catch((error: unknown) => {
        state.error = error
      })
      .finally(() => {
        state.loading = false
        pending = null
      })
    return pending
  }

  /** `IconRef` of a slug with the variants of the loaded list (mono only until the list arrives). */
  function iconOf(slug: string): IconRef {
    const entry = state.items.find(item => item.slug === slug)
    return lobeIconRef(slug, entry?.hasColor ?? false, state.version)
  }

  return { state: readonly(state), load, iconOf }
}

/** Tests: forget the loaded list. */
export function resetLobeIcons(): void {
  state.items = []
  state.version = ''
  state.loaded = false
  state.loading = false
  state.error = null
  pending = null
}
