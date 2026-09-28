// Provides MODEL_LABEL_RESOLVER (components/providers/model-label.ts) from the models and providers stores, so
// every ModelLabel resolves `providerId:modelId` to the model name and the provider icon. The resolver only reads
// (reactively): components that show models load the stores; until then refs render as unknown.
import { defineNuxtPlugin } from '#imports'
import { MODEL_LABEL_RESOLVER } from '~/components/providers/model-label'
import { useModelsStore } from '~/stores/models'
import { useProvidersStore } from '~/stores/providers'
import { createModelLabelResolver } from '~/utils/model-label'

export default defineNuxtPlugin((nuxtApp) => {
  const models = useModelsStore()
  const providers = useProvidersStore()
  nuxtApp.vueApp.provide(MODEL_LABEL_RESOLVER, createModelLabelResolver({
    model: modelRef => models.byRef(modelRef),
    provider: providerId => providers.byId(providerId),
  }))
})
