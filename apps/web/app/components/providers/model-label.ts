// ModelLabel data source. ModelLabel stays presentational: the app provides a resolver that reads the models and
// providers stores (C5), e.g. in a Nuxt plugin:
//   nuxtApp.vueApp.provide(MODEL_LABEL_RESOLVER, ref => { const m = models.byRef(ref); ... })
// Without a resolver every ref renders as unknown (raw model id + warning icon).
import type { InjectionKey } from 'vue'
import type { IconRefLike } from './provider-icon'

export interface ModelLabelInfo {
  /** Model display name (`CatalogModel.name`). */
  name: string
  /** Provider UI name (`ProviderSummary.name`), shown with `showProvider` and used as the icon name. */
  providerName?: string
  /** Provider icon URLs (`ProviderSummary.icon`). */
  icon?: IconRefLike | null
}

export type ModelLabelResolver = (modelRef: string) => ModelLabelInfo | null | undefined

export const MODEL_LABEL_RESOLVER: InjectionKey<ModelLabelResolver> = Symbol('hf-model-label-resolver')

/** `providerId:modelId`, split on the first colon (docs/DECISIONS.md); null when there is no colon. */
export function splitModelRef(modelRef: string): { providerId: string, modelId: string } | null {
  const index = modelRef.indexOf(':')
  if (index <= 0 || index === modelRef.length - 1)
    return null
  return { providerId: modelRef.slice(0, index), modelId: modelRef.slice(index + 1) }
}
