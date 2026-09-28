// The selected model as the composer sees it (docs/UI.md 7.7, 7.9-7.12): catalog entry, provider, availability,
// effort options, tool support and context window, all derived from the models / providers / plugins stores.
// `loadComposerCatalog()` loads what the composer and the model picker read (quietly: a failed load keeps the
// stores empty and is retried on the next mount or server event).
import type { CatalogModel, ProviderSummary, ReasoningEffort } from '@harness-forge/shared'
import type { ComputedRef, MaybeRefOrGetter } from 'vue'
import { safeParseModelRef } from '@harness-forge/shared'
import { computed, toValue } from 'vue'
import { effortOptions } from '~/components/chat/composer/effort'
import { useModelsStore } from '~/stores/models'
import { usePluginsStore } from '~/stores/plugins'
import { useProvidersStore } from '~/stores/providers'

export interface ComposerModel {
  /** Catalog entry of the ref (hidden models included); undefined when unknown or not loaded. */
  model: ComputedRef<CatalogModel | undefined>
  provider: ComputedRef<ProviderSummary | undefined>
  /** Model name, else the model id of the ref, else ''. */
  displayName: ComputedRef<string>
  /**
   * False when a ref is set but its provider is gone or disabled (docs/UI.md 7.9: Send is disabled). A provider
   * without credentials stays available: sending then explains what is missing. True while providers load.
   */
  available: ComputedRef<boolean>
  /** Effort menu options (`auto` first); empty when the model has no effort control. */
  efforts: ComputedRef<ReasoningEffort[]>
  /** The permission menu applies: at least one usable tool exists and the model can call tools. */
  toolsAvailable: ComputedRef<boolean>
  contextWindow: ComputedRef<number | null>
}

export function useComposerModel(modelRef: MaybeRefOrGetter<string | null | undefined>): ComposerModel {
  const models = useModelsStore()
  const providers = useProvidersStore()
  const plugins = usePluginsStore()

  const selected = computed(() => toValue(modelRef) ?? null)
  const parts = computed(() => (selected.value ? safeParseModelRef(selected.value) : null))
  const model = computed(() => (selected.value ? models.byRef(selected.value) : undefined))
  const provider = computed(() => (parts.value ? providers.byId(parts.value.providerId) : undefined))
  const displayName = computed(() => model.value?.name ?? parts.value?.modelId ?? selected.value ?? '')
  const available = computed(() => {
    if (!selected.value)
      return false
    if (!parts.value)
      return false
    if (!providers.loaded)
      return true
    return provider.value?.enabled === true
  })
  const efforts = computed(() => effortOptions(model.value))
  const toolsAvailable = computed(() => plugins.hasTools && model.value?.capabilities.tools === true)
  const contextWindow = computed(() => model.value?.contextWindow ?? null)

  return { model, provider, displayName, available, efforts, toolsAvailable, contextWindow }
}

function quietly(task: () => Promise<unknown>) {
  task().catch(() => {})
}

/** Loads providers and models when not loaded yet (the model picker, ModelLabel and the composer read them). */
export function loadModelCatalog(): void {
  const providers = useProvidersStore()
  const models = useModelsStore()
  if (!providers.loaded)
    quietly(() => providers.fetchAll())
  if (!models.loaded)
    quietly(() => models.fetchAll())
}

/** Everything the composer reads: the model catalog, the tool list (permission menu) and server commands. */
export function loadComposerCatalog(): void {
  loadModelCatalog()
  const plugins = usePluginsStore()
  if (!plugins.toolsLoaded)
    quietly(() => plugins.fetchTools())
  if (!plugins.commandsLoaded)
    quietly(() => plugins.fetchCommands())
}
