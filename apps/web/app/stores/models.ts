// Models store (docs/UI.md 11, docs/API.md 5.7): the model catalog (hidden models included), preferences, custom
// models, per-provider refresh and the recently used refs (localStorage['hf-recent-models'], max 5).
// Signatures are frozen after Phase 0.
import type {
  CatalogModel,
  CustomModelInput,
  ProviderSummary,
  ServerEvent,
} from '@harness-forge/shared'
import { parseModelRef, safeParseModelRef } from '@harness-forge/shared'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useApi } from '~/composables/useApi'
import { createCoalescedTask } from '~/utils/coalesce'
import { withHarnessErrors } from '~/utils/errors'
import { omitKey } from '~/utils/records'
import { readStoredJson, writeStoredJson } from '~/utils/storage'
import { useProvidersStore } from './providers'
import { useSettingsStore } from './settings'

export const RECENT_MODELS_KEY = 'hf-recent-models'
export const RECENT_MODELS_MAX = 5

/** Patch of `setPref()`: `hidden: null` / `alias: null` go back to the defaults. */
export interface ModelPrefPatch {
  favorite?: boolean
  hidden?: boolean | null
  alias?: string | null
}

/** One model picker group: a configured provider and its visible models. */
export interface ProviderModelGroup {
  provider: ProviderSummary
  models: CatalogModel[]
}

function readRecentRefs(): string[] {
  const stored = readStoredJson(RECENT_MODELS_KEY)
  if (!Array.isArray(stored))
    return []
  const refs = stored.filter((value): value is string => typeof value === 'string' && safeParseModelRef(value) !== null)
  return [...new Set(refs)].slice(0, RECENT_MODELS_MAX)
}

export const useModelsStore = defineStore('models', () => {
  const api = useApi()

  // ---------- state ----------

  /** Every catalog model of the enabled providers, hidden ones included (`GET /models?includeHidden=true`). */
  const items = ref<CatalogModel[]>([])
  const loaded = ref(false)
  /** Provider ids with a model list refresh in flight. */
  const refreshing = ref<Record<string, boolean>>({})
  /** Recently used model refs, newest first (max 5). */
  const recentRefs = ref<string[]>(readRecentRefs())

  watch(recentRefs, value => writeStoredJson(RECENT_MODELS_KEY, value))

  // ---------- getters ----------

  const index = computed(() => new Map(items.value.map(model => [model.ref, model])))
  /** `byRef(ref)`: the catalog model (hidden or not), or undefined. */
  const byRef = computed(() => (modelRef: string): CatalogModel | undefined => index.value.get(modelRef))

  const configuredProviderIds = computed(() => new Set(useProvidersStore().connected.map(provider => provider.id)))
  /** Models the picker can show: not hidden, and their provider is enabled and configured. */
  const visible = computed(() => items.value.filter(model => !model.hidden && configuredProviderIds.value.has(model.providerId)))
  const visibleIndex = computed(() => new Map(visible.value.map(model => [model.ref, model])))
  /** Starred visible models. */
  const favorites = computed(() => visible.value.filter(model => model.favorite))
  /** Visible models of `recentRefs`, newest first. */
  const recent = computed(() => recentRefs.value
    .map(modelRef => visibleIndex.value.get(modelRef))
    .filter((model): model is CatalogModel => model !== undefined))
  /** Visible models grouped by configured provider, in settings order; providers without visible models are skipped. */
  const groupedByProvider = computed<ProviderModelGroup[]>(() => {
    const byProvider = new Map<string, CatalogModel[]>()
    for (const model of visible.value) {
      const list = byProvider.get(model.providerId)
      if (list)
        list.push(model)
      else
        byProvider.set(model.providerId, [model])
    }
    const groups: ProviderModelGroup[] = []
    for (const provider of useProvidersStore().connected) {
      const models = byProvider.get(provider.id)
      if (models)
        groups.push({ provider, models })
    }
    return groups
  })
  /**
   * Model of a new chat (docs/UI.md 7.9): the `defaultModelRef` setting (even when its provider is not configured,
   * so sending explains what is missing), else the most recent visible model, else the first visible one.
   */
  const defaultRef = computed<string | null>(() =>
    useSettingsStore().resolved.defaultModelRef ?? recent.value[0]?.ref ?? visible.value[0]?.ref ?? null)

  // ---------- helpers ----------

  let changeSeq = 0
  let pendingFetch: Promise<CatalogModel[]> | null = null
  const refetch = createCoalescedTask(async () => {
    await pendingFetch?.catch(() => {})
    return fetchAll()
  })

  function upsert(model: CatalogModel) {
    changeSeq += 1
    if (index.value.has(model.ref))
      items.value = items.value.map(item => (item.ref === model.ref ? model : item))
    else
      items.value = [...items.value, model]
  }

  function patchLocal(modelRef: string, patch: Partial<CatalogModel>) {
    changeSeq += 1
    items.value = items.value.map(item => (item.ref === modelRef ? { ...item, ...patch } : item))
  }

  // ---------- actions ----------

  /** `GET /models?includeHidden=true`. Concurrent calls share one request. Throws `HarnessError`. */
  function fetchAll(): Promise<CatalogModel[]> {
    if (pendingFetch)
      return pendingFetch
    const startedAt = changeSeq
    const request = withHarnessErrors(api.models.list({ query: { includeHidden: true } }))
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

  /** `POST /providers/:id/models/refresh`: a live listing now; replaces that provider's models (hidden included). */
  async function refresh(providerId: string): Promise<CatalogModel[]> {
    refreshing.value = { ...refreshing.value, [providerId]: true }
    try {
      const { items: fresh } = await withHarnessErrors(api.models.refresh({ params: { id: providerId } }))
      changeSeq += 1
      const first = items.value.findIndex(model => model.providerId === providerId)
      const others = items.value.filter(model => model.providerId !== providerId)
      const at = first < 0 ? others.length : first
      items.value = [...others.slice(0, at), ...fresh, ...others.slice(at)]
      return fresh
    }
    finally {
      refreshing.value = omitKey(refreshing.value, providerId)
    }
  }

  /**
   * `PUT /model-prefs` for a model ref (split into `providerId` + `modelId`, never sent in a path). `favorite` and a
   * boolean `hidden` apply at once and roll back on failure; aliases wait for the server (it computes `name`).
   */
  async function setPref(modelRef: string, patch: ModelPrefPatch): Promise<CatalogModel> {
    const { providerId, modelId } = parseModelRef(modelRef)
    const previous = index.value.get(modelRef)
    const optimistic: Partial<CatalogModel> = {}
    if (patch.favorite !== undefined)
      optimistic.favorite = patch.favorite
    if (typeof patch.hidden === 'boolean')
      optimistic.hidden = patch.hidden
    if (previous && Object.keys(optimistic).length > 0)
      patchLocal(modelRef, optimistic)
    try {
      const model = await withHarnessErrors(api.models.updatePrefs({ body: { providerId, modelId, ...patch } }))
      upsert(model)
      return model
    }
    catch (error) {
      if (previous && Object.keys(optimistic).length > 0)
        patchLocal(modelRef, { favorite: previous.favorite, hidden: previous.hidden })
      throw error
    }
  }

  /** `POST /custom-models` (creates or replaces). */
  async function addCustom(input: CustomModelInput): Promise<CatalogModel> {
    const model = await withHarnessErrors(api.models.addCustom({ body: input }))
    upsert(model)
    return model
  }

  /** `DELETE /custom-models?providerId&modelId`. */
  async function removeCustom(providerId: string, modelId: string): Promise<void> {
    await withHarnessErrors(api.models.removeCustom({ query: { providerId, modelId } }))
    changeSeq += 1
    items.value = items.value.filter(model => !(model.providerId === providerId && model.id === modelId && model.custom))
    // The provider may still list the id itself (then it comes back as a non-custom entry).
    if (loaded.value)
      refetch.schedule()
  }

  /** Records a model as used (front of `recentRefs`, max 5). */
  function touchRecent(modelRef: string): void {
    if (safeParseModelRef(modelRef) === null)
      return
    recentRefs.value = [modelRef, ...recentRefs.value.filter(item => item !== modelRef)].slice(0, RECENT_MODELS_MAX)
  }

  /** `catalog.changed`, `provider.changed` and `plugin.changed` refetch the catalog when it is loaded. */
  function applyEvent(event: ServerEvent): void {
    if (!loaded.value)
      return
    if (event.type === 'catalog.changed' || event.type === 'provider.changed' || event.type === 'plugin.changed')
      refetch.schedule()
  }

  return {
    items,
    loaded,
    refreshing,
    recentRefs,
    byRef,
    visible,
    favorites,
    recent,
    groupedByProvider,
    defaultRef,
    fetchAll,
    refresh,
    setPref,
    addCustom,
    removeCustom,
    touchRecent,
    applyEvent,
  }
})
