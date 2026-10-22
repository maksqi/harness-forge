// Web search store (Phase 14, ADR-063; docs/UI.md 9.15, 11.10; docs/API.md 4.39): the search API configuration of the
// builtin plugin `core-search` (`GET /plugins/core-search/settings`: the backend, whether each backend's key is stored,
// the result count, whether the plugin is on) and the "Test search" route (`POST /web-search/test`). The two global
// switches (`webSearchNative`, `webSearchDefault`) live in the settings store. The only reader of `core-search`'s
// settings and of the test route on the web; key values are write-only (`setKey`) and never kept here.
// Signature from C54 (P14-0b, frozen from Gate P14-0b); W14.10 implements the actions: single flight, `maxAgeMs`, an
// answer older than the last event never wins; `applyEvent` refetches quietly on `plugin.changed` of `core-search` once
// loaded. Until then the actions refuse with `not_implemented` and the configuration stays unknown (`builtinAvailable`
// false).
import type { SecretState, ServerEvent, WebSearchBackend, WebSearchTestResult } from '@harness-forge/shared'
import { HarnessError } from '@harness-forge/shared'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { WEB_SEARCH_BACKEND_LABELS } from '~/components/chat/composer/web-search'

/** The builtin plugin that holds the search API settings and the `search_web` tool. */
export const CORE_SEARCH_PLUGIN_ID = 'core-search'

/** The secret setting of each backend's key in `core-search`. */
export const WEB_SEARCH_KEY_SETTINGS: Readonly<Record<WebSearchBackend, string>> = {
  brave: 'braveApiKey',
  tavily: 'tavilyApiKey',
  exa: 'exaApiKey',
}

/** The search API configuration of `core-search` (never a key value). */
export interface WebSearchConfig {
  backend: WebSearchBackend
  /** From `PluginSettingsView.secrets` (`braveApiKey`, `tavilyApiKey`, `exaApiKey`). */
  keys: Readonly<Record<WebSearchBackend, SecretState>>
  /** Results per search, 1–10. */
  maxResults: number
  /** `core-search` is on. */
  pluginActive: boolean
}

function notImplemented(): HarnessError {
  return new HarnessError({ code: 'not_implemented', message: 'Web search settings are not available yet.' })
}

export const useWebSearchStore = defineStore('web-search', () => {
  // ---------- state ----------

  /** The configuration; null until loaded. */
  const config = shallowRef<WebSearchConfig | null>(null)
  /** When the configuration was loaded (ms); null before the first answer. */
  const loadedAt = ref<number | null>(null)
  /** A `save` / `setKey` is in flight. */
  const saving = ref(false)
  /** A `test` is in flight. */
  const testing = ref(false)
  /** The last successful "Test search". */
  const lastTest = shallowRef<WebSearchTestResult | null>(null)
  /** The last failed "Test search". */
  const testError = shallowRef<HarnessError | null>(null)

  // ---------- getters ----------

  /** The builtin `search_web` can run: `core-search` is on and the selected backend's key is stored (open point 5). */
  const builtinAvailable = computed(() => {
    const current = config.value
    return current !== null && current.pluginActive && current.keys[current.backend]?.set === true
  })

  /** `backendLabel(backend?)`: "Brave Search", "Tavily", "Exa"; default the selected backend (else Brave Search). */
  const backendLabel = computed(() => (backend?: WebSearchBackend): string =>
    WEB_SEARCH_BACKEND_LABELS[backend ?? config.value?.backend ?? 'brave'])

  // ---------- actions ----------

  /** `GET /plugins/core-search/settings` (single flight; an answer younger than `maxAgeMs` is reused). W14.10. */
  async function fetch(_opts: { maxAgeMs?: number } = {}): Promise<WebSearchConfig> {
    throw notImplemented()
  }

  /** `PUT /plugins/core-search/settings` with the backend and / or the result count (optimistic). W14.10. */
  async function save(_patch: { backend?: WebSearchBackend, maxResults?: number }): Promise<WebSearchConfig> {
    throw notImplemented()
  }

  /** Stores (`key`) or removes (`null`, sent as `''`) a backend's key; the value is never kept. W14.10. */
  async function setKey(_backend: WebSearchBackend, _key: string | null): Promise<WebSearchConfig> {
    throw notImplemented()
  }

  /** `POST /web-search/test { backend }` ("Test search"). W14.10. */
  async function test(_backend?: WebSearchBackend): Promise<WebSearchTestResult> {
    throw notImplemented()
  }

  /** `plugin.changed` of `core-search`: refetches quietly when loaded. W14.10. */
  function applyEvent(_event: ServerEvent): void {}

  return {
    config,
    loadedAt,
    saving,
    testing,
    lastTest,
    testError,
    builtinAvailable,
    backendLabel,
    fetch,
    save,
    setKey,
    test,
    applyEvent,
  }
})
