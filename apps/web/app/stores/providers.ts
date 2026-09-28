// Providers store (docs/UI.md 11, docs/API.md 5.5-5.6): provider list, enable switch, credentials and tests.
// Signatures are frozen after Phase 0.
import type {
  ProviderSummary,
  ProviderTestResult,
  ProviderUpdate,
  ServerEvent,
} from '@harness-forge/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useApi } from '~/composables/useApi'
import { createCoalescedTask } from '~/utils/coalesce'
import { withHarnessErrors } from '~/utils/errors'
import { omitKey } from '~/utils/records'

/** Enabled and its required credentials resolve (stored, env or local): its models can be used. */
export function isProviderConfigured(provider: ProviderSummary): boolean {
  return provider.enabled && provider.status !== 'not_configured'
}

export const useProvidersStore = defineStore('providers', () => {
  const api = useApi()

  // ---------- state ----------

  /** Every registered provider in registry order (builtins first, then plugin providers by id). */
  const items = ref<ProviderSummary[]>([])
  const loaded = ref(false)
  /** Provider ids with a connection test in flight. */
  const testing = ref<Record<string, boolean>>({})

  // ---------- getters ----------

  const index = computed(() => new Map(items.value.map(provider => [provider.id, provider])))
  /** `byId(id)`: the provider, or undefined. */
  const byId = computed(() => (id: string): ProviderSummary | undefined => index.value.get(id))
  /**
   * Enabled providers whose credentials resolve (`status` is `connected`, `env` or `error`), in settings order: the
   * groups of the model picker and of Settings -> Models.
   */
  const connected = computed(() => items.value.filter(isProviderConfigured))
  /** At least one configured provider has chat models (drives the "Connect a provider" callout). */
  const hasUsableProvider = computed(() => connected.value.some(provider => provider.modelCount > 0))

  // ---------- helpers ----------

  // Bumped by every local change so a list request that started earlier is followed by one more refetch.
  let changeSeq = 0
  let pendingFetch: Promise<ProviderSummary[]> | null = null
  // Background refetch after events: waits for a request in flight (it may predate the event), then loads again.
  const refetch = createCoalescedTask(async () => {
    await pendingFetch?.catch(() => {})
    return fetchAll()
  })

  function upsert(provider: ProviderSummary, insert = true) {
    changeSeq += 1
    const position = items.value.findIndex(item => item.id === provider.id)
    if (position >= 0)
      items.value = items.value.map(item => (item.id === provider.id ? provider : item))
    else if (insert)
      items.value = [...items.value, provider]
  }

  function patchLocal(id: string, patch: Partial<ProviderSummary>) {
    changeSeq += 1
    items.value = items.value.map(item => (item.id === id ? { ...item, ...patch } : item))
  }

  // ---------- actions ----------

  /** `GET /providers`. Concurrent calls share one request. Throws `HarnessError`. */
  function fetchAll(): Promise<ProviderSummary[]> {
    if (pendingFetch)
      return pendingFetch
    const startedAt = changeSeq
    const request = withHarnessErrors(api.providers.list())
      .then(({ items: next }) => {
        items.value = next
        loaded.value = true
        if (changeSeq !== startedAt)
          refetch.schedule()
        return next
      })
      .finally(() => {
        pendingFetch = null
      })
    pendingFetch = request
    return request
  }

  /** `PATCH /providers/:id`. */
  async function update(id: string, patch: ProviderUpdate): Promise<ProviderSummary> {
    const provider = await withHarnessErrors(api.providers.update({ params: { id }, body: patch }))
    upsert(provider)
    return provider
  }

  /** The enable switch: optimistic, rolled back when the request fails. */
  async function setEnabled(id: string, enabled: boolean): Promise<ProviderSummary> {
    const previous = index.value.get(id)?.enabled
    patchLocal(id, { enabled })
    try {
      return await update(id, { enabled })
    }
    catch (error) {
      if (previous !== undefined && index.value.get(id)?.enabled === enabled)
        patchLocal(id, { enabled: previous })
      throw error
    }
  }

  /** `PUT /providers/:id/credentials`: `''` clears a stored value, omitted keys are unchanged. */
  async function saveCredentials(id: string, values: Record<string, string>): Promise<ProviderSummary> {
    const provider = await withHarnessErrors(api.credentials.set({ params: { id }, body: { values } }))
    upsert(provider)
    return provider
  }

  /** `DELETE /providers/:id/credentials`: removes every stored value (env fallbacks keep working). */
  async function clearCredentials(id: string): Promise<ProviderSummary> {
    const provider = await withHarnessErrors(api.credentials.clear({ params: { id } }))
    upsert(provider)
    return provider
  }

  /**
   * `POST /providers/:id/test`. With `draft` the candidate values are tested and nothing is stored; without it the
   * stored credentials are validated and the result is persisted (a `provider.changed` event follows). A failed test
   * resolves with `ok: false` and `error`; only request failures throw.
   */
  async function test(id: string, draft?: Record<string, string>): Promise<ProviderTestResult> {
    testing.value = { ...testing.value, [id]: true }
    try {
      return await withHarnessErrors(api.providers.test({ params: { id }, body: draft ? { values: draft } : {} }))
    }
    finally {
      testing.value = omitKey(testing.value, id)
    }
  }

  /** `provider.changed` patches or removes one provider; `plugin.changed` refetches the list when loaded. */
  function applyEvent(event: ServerEvent): void {
    if (event.type === 'provider.changed') {
      const { id, provider } = event.data
      if (provider) {
        upsert(provider, loaded.value)
      }
      else if (index.value.has(id)) {
        changeSeq += 1
        items.value = items.value.filter(item => item.id !== id)
      }
    }
    else if (event.type === 'plugin.changed' && loaded.value) {
      refetch.schedule()
    }
  }

  return {
    items,
    loaded,
    testing,
    byId,
    connected,
    hasUsableProvider,
    fetchAll,
    update,
    setEnabled,
    saveCredentials,
    clearCredentials,
    test,
    applyEvent,
  }
})
