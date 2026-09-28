// The MODEL_LABEL_RESOLVER value (components/providers/model-label.ts), built from catalog and provider lookups.
// Auto-imported (utils/).
import type { CatalogModel, ProviderSummary } from '@harness-forge/shared'
import type { ModelLabelResolver } from '~/components/providers/model-label'

export interface ModelLabelSources {
  model: (modelRef: string) => CatalogModel | undefined
  provider: (providerId: string) => ProviderSummary | undefined
}

/** Model name + provider name and icon for a model ref; null (rendered as unknown) when the catalog lacks it. */
export function createModelLabelResolver(sources: ModelLabelSources): ModelLabelResolver {
  return (modelRef) => {
    const model = sources.model(modelRef)
    if (!model)
      return null
    const provider = sources.provider(model.providerId)
    return { name: model.name, providerName: provider?.name, icon: provider?.icon ?? null }
  }
}
