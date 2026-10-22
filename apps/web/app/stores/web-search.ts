// Web search store (Phase 14, ADR-063; docs/UI.md 9.15, 11.10; docs/API.md 4.39): the search API configuration of the
// builtin plugin `core-search` (`GET /plugins/core-search/settings`: the backend, whether each backend's key is stored,
// the result count; `GET /plugins/core-search`: whether the plugin is on) and the "Test search" route
// (`POST /web-search/test`). The two global switches (`webSearchNative`, `webSearchDefault`) live in the settings store.
// The only reader of `core-search`'s settings and of the test route on the web; key values are write-only (`setKey`)
// and never kept here.
// Signature from C54 (P14-0b, frozen from Gate P14-0b); W14.10 implements the actions:
// - `fetch` is single flight (concurrent calls share one request) and reuses a configuration younger than `maxAgeMs`
//   (without `maxAgeMs` it always asks the server). An answer older than the last `plugin.changed` event of
//   `core-search` never wins: it is dropped and the newer request decides. A fetch answer that raced a write is dropped
//   too (the write's own answer carries the newer values).
// - `save` is optimistic (a failure rolls back the keys that still hold the patched values); `setKey` is not (the row
//   shows "Key saved" only once the server stored it). A write's answer applies only when no newer write started.
// - `applyEvent` (`plugin.changed` of `core-search`) takes the plugin's state from the event at once and refetches
//   quietly once loaded; an event that arrived while writes ran refetches once they settle.
import type { HarnessError, PluginSettingsView, SecretState, ServerEvent, WebSearchBackend, WebSearchTestResult } from '@harness-forge/shared'
import { WEB_SEARCH_BACKENDS } from '@harness-forge/shared'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { WEB_SEARCH_BACKEND_LABELS } from '~/components/chat/composer/web-search'
import { useApi } from '~/composables/useApi'
import { toHarnessError, withHarnessErrors } from '~/utils/errors'

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

/** The `backend` setting's default (the `core-search` manifest). */
const DEFAULT_BACKEND: WebSearchBackend = 'brave'
/** The `maxResults` setting's default and bounds (the `core-search` manifest). */
const DEFAULT_MAX_RESULTS = 5
const MAX_RESULTS_MIN = 1
const MAX_RESULTS_MAX = 10

const NO_KEY: SecretState = { set: false, hint: null, source: null }

function isBackend(value: unknown): value is WebSearchBackend {
  return typeof value === 'string' && (WEB_SEARCH_BACKENDS as readonly string[]).includes(value)
}

function readMaxResults(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MAX_RESULTS_MIN && value <= MAX_RESULTS_MAX
    ? value
    : DEFAULT_MAX_RESULTS
}

/** The configuration of a settings answer; values the store cannot read fall back to the manifest defaults. */
function configOf(view: PluginSettingsView, pluginActive: boolean): WebSearchConfig {
  const keys = {} as Record<WebSearchBackend, SecretState>
  for (const backend of WEB_SEARCH_BACKENDS) {
    const state = view.secrets[WEB_SEARCH_KEY_SETTINGS[backend]]
    keys[backend] = state ? { set: state.set, hint: state.hint, source: state.source } : { ...NO_KEY }
  }
  return {
    backend: isBackend(view.values.backend) ? view.values.backend : DEFAULT_BACKEND,
    keys,
    maxResults: readMaxResults(view.values.maxResults),
    pluginActive,
  }
}

export const useWebSearchStore = defineStore('web-search', () => {
  const api = useApi()

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
    WEB_SEARCH_BACKEND_LABELS[backend ?? config.value?.backend ?? DEFAULT_BACKEND])

  // ---------- bookkeeping ----------

  /** Bumped by every `plugin.changed` of `core-search`: an answer to an earlier request never wins. */
  let eventSeq = 0
  /** The `eventSeq` the current configuration was loaded at (a later event makes it stale for `maxAgeMs`). */
  let loadedEventSeq = -1
  /** Bumped by every write; a write's answer applies only while it is the latest one. */
  let writeSeq = 0
  let writesInFlight = 0
  /** An event arrived, or a write failed after a newer answer was dropped, while writes ran: refetch once they settle. */
  let refetchAfterWrites = false
  /** A write's answer was dropped because a newer write had started. */
  let droppedWriteAnswer = false
  let pendingFetch: { promise: Promise<WebSearchConfig>, eventSeq: number } | null = null
  let pendingTest: Promise<WebSearchTestResult> | null = null

  /** `atEvent`: the `eventSeq` when the answer's request started (an event after it keeps the configuration stale). */
  function applyLoaded(next: WebSearchConfig, atEvent: number): WebSearchConfig {
    config.value = next
    loadedAt.value = Date.now()
    loadedEventSeq = atEvent
    return next
  }

  function quietRefetch(): void {
    fetch().catch(() => {})
  }

  // ---------- actions ----------

  /** One request: the settings and the plugin's state, together. */
  function request(): Promise<WebSearchConfig> {
    const startedEvent = eventSeq
    const startedWrite = writeSeq
    const params = { params: { id: CORE_SEARCH_PLUGIN_ID } }
    const promise: Promise<WebSearchConfig> = withHarnessErrors(Promise.all([api.plugins.getSettings(params), api.plugins.get(params)]))
      .then(([view, plugin]) => {
        // An event arrived meanwhile: this answer may predate it. A newer answer already loaded wins; else the newer
        // request decides (joined while it runs).
        if (startedEvent !== eventSeq)
          return loadedEventSeq === eventSeq && config.value !== null ? config.value : fetch()
        const next = configOf(view, plugin.state === 'active')
        // A write started meanwhile (or still runs): its own answer carries the newer values.
        if (config.value !== null && (startedWrite !== writeSeq || writesInFlight > 0))
          return config.value
        return applyLoaded(next, startedEvent)
      })
      .finally(() => {
        if (pendingFetch?.promise === promise)
          pendingFetch = null
      })
    pendingFetch = { promise, eventSeq: startedEvent }
    return promise
  }

  /** `GET /plugins/core-search/settings` (single flight; an answer younger than `maxAgeMs` is reused). */
  async function fetch(opts: { maxAgeMs?: number } = {}): Promise<WebSearchConfig> {
    const current = config.value
    if (opts.maxAgeMs !== undefined && current !== null && loadedAt.value !== null && loadedEventSeq === eventSeq
      && Date.now() - loadedAt.value < opts.maxAgeMs) {
      return current
    }
    if (pendingFetch && pendingFetch.eventSeq === eventSeq)
      return pendingFetch.promise
    return request()
  }

  /** Runs one `PUT /plugins/core-search/settings`; `optimistic` patches the configuration first (rolled back on failure). */
  async function write(values: Record<string, unknown>, optimistic: Partial<Pick<WebSearchConfig, 'backend' | 'maxResults'>> | null): Promise<WebSearchConfig> {
    const base = config.value ?? await fetch()
    const startedEvent = eventSeq
    const seq = ++writeSeq
    writesInFlight += 1
    saving.value = true
    if (optimistic)
      config.value = { ...base, ...optimistic }
    try {
      const view = await withHarnessErrors(api.plugins.updateSettings({ params: { id: CORE_SEARCH_PLUGIN_ID }, body: { values } }))
      const current = config.value ?? base
      if (seq !== writeSeq) {
        droppedWriteAnswer = true
        return current
      }
      return applyLoaded(configOf(view, current.pluginActive), startedEvent)
    }
    catch (error) {
      if (optimistic && config.value) {
        const restored = { ...config.value }
        for (const key of Object.keys(optimistic) as Array<keyof typeof optimistic>) {
          if (restored[key] === optimistic[key])
            (restored as Record<string, unknown>)[key] = base[key]
        }
        config.value = restored
      }
      if (droppedWriteAnswer)
        refetchAfterWrites = true
      throw error
    }
    finally {
      writesInFlight -= 1
      saving.value = writesInFlight > 0
      if (writesInFlight === 0) {
        const refetch = refetchAfterWrites
        refetchAfterWrites = false
        droppedWriteAnswer = false
        if (refetch && loadedAt.value !== null)
          quietRefetch()
      }
    }
  }

  /** `PUT /plugins/core-search/settings` with the backend and / or the result count (optimistic). */
  async function save(patch: { backend?: WebSearchBackend, maxResults?: number }): Promise<WebSearchConfig> {
    const values: Record<string, unknown> = {}
    const optimistic: Partial<Pick<WebSearchConfig, 'backend' | 'maxResults'>> = {}
    if (patch.backend !== undefined) {
      values.backend = patch.backend
      optimistic.backend = patch.backend
    }
    if (patch.maxResults !== undefined) {
      values.maxResults = patch.maxResults
      optimistic.maxResults = patch.maxResults
    }
    if (Object.keys(values).length === 0)
      return config.value ?? fetch()
    return write(values, optimistic)
  }

  /** Stores (`key`) or removes (`null`, sent as `''`) a backend's key; the value is never kept. */
  async function setKey(backend: WebSearchBackend, key: string | null): Promise<WebSearchConfig> {
    return write({ [WEB_SEARCH_KEY_SETTINGS[backend]]: key ?? '' }, null)
  }

  /** `POST /web-search/test { backend }` ("Test search"); concurrent calls share the running test. */
  function test(backend?: WebSearchBackend): Promise<WebSearchTestResult> {
    if (pendingTest)
      return pendingTest
    testing.value = true
    lastTest.value = null
    testError.value = null
    const promise = withHarnessErrors(api.webSearch.test({ body: backend === undefined ? {} : { backend } }))
      .then((result) => {
        lastTest.value = result
        return result
      })
      .catch((error: unknown) => {
        testError.value = toHarnessError(error)
        throw error
      })
      .finally(() => {
        testing.value = false
        pendingTest = null
      })
    pendingTest = promise
    return promise
  }

  /** `plugin.changed` of `core-search`: the plugin's state at once, then a quiet refetch when loaded. */
  function applyEvent(event: ServerEvent): void {
    if (event.type !== 'plugin.changed' || event.data.id !== CORE_SEARCH_PLUGIN_ID)
      return
    eventSeq += 1
    const pluginActive = event.data.plugin?.state === 'active'
    if (config.value && config.value.pluginActive !== pluginActive)
      config.value = { ...config.value, pluginActive }
    if (writesInFlight > 0)
      refetchAfterWrites = true
    if (loadedAt.value !== null)
      quietRefetch()
  }

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
