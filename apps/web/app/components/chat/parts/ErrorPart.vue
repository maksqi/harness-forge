<script setup lang="ts">
// Error at the end of a message (docs/UI.md 7.4): the HarnessError alert with its action ("Open settings" ->
// /settings/providers?configure=<id>, Retry, Refresh models, Log in, View logs), plus "Choose model" / "New chat"
// where the table asks for them. Retry goes up (regenerate of the failed message); the rest is handled here.
import type { HarnessErrorUiAction } from '~/components/common/harness-error'
import { computed, inject } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { toHarnessErrorView } from '~/components/common/harness-error'
import HarnessErrorAlert from '~/components/common/HarnessErrorAlert.vue'
import { useModelsStore } from '~/stores/models'
import { useProvidersStore } from '~/stores/providers'
import { toHarnessError } from '~/utils/errors'
import { loginPath } from '~/utils/redirect'
import { testIds } from '~/utils/testids'
import { CHAT_VIEW_ACTIONS } from '../chat-context'
import { useRoute, useRouter } from '../nuxt-imports'

const props = defineProps<{ error: unknown }>()
const emit = defineEmits<{ retry: [] }>()

const providers = useProvidersStore()
const models = useModelsStore()
const route = useRoute()
const router = useRouter()
const actions = inject(CHAT_VIEW_ACTIONS, null)

const view = computed(() => toHarnessErrorView(props.error))
const providerId = computed(() => view.value.providerId)
const providerName = computed(() => (providerId.value ? providers.byId(providerId.value)?.name : undefined))
const pluginId = computed(() => {
  const details = view.value.details
  return typeof details === 'object' && details !== null && typeof (details as { pluginId?: unknown }).pluginId === 'string'
    ? (details as { pluginId: string }).pluginId
    : null
})

type ExtraAction = 'choose-model' | 'new-chat'
const extraActions = computed<ExtraAction[]>(() => {
  const list: ExtraAction[] = []
  if (view.value.code === 'context_overflow')
    list.push('new-chat')
  if ((view.value.code === 'model_not_found' || view.value.code === 'context_overflow') && actions)
    list.push('choose-model')
  return list
})
const extraLabels: Record<ExtraAction, string> = { 'choose-model': 'Choose model', 'new-chat': 'New chat' }

async function refreshModels() {
  try {
    if (providerId.value)
      await models.refresh(providerId.value)
    else
      await models.fetchAll()
    toast.success('Models refreshed')
  }
  catch (error) {
    const failure = toHarnessError(error)
    toast.error('Could not refresh the models', { description: failure.message })
  }
}

function onAction(action: HarnessErrorUiAction) {
  switch (action) {
    case 'configure-provider':
      void router.push(providerId.value
        ? `/settings/providers?configure=${encodeURIComponent(providerId.value)}`
        : '/settings/providers')
      return
    case 'retry':
      emit('retry')
      return
    case 'refresh-models':
      void refreshModels()
      return
    case 'login':
      void router.push(loginPath(route.fullPath))
      return
    case 'view-logs':
      void router.push(pluginId.value ? `/plugins/${encodeURIComponent(pluginId.value)}?tab=logs` : '/plugins')
  }
}

function onExtra(action: ExtraAction) {
  if (action === 'new-chat')
    void router.push('/')
  else
    actions?.openModelPicker()
}
</script>

<template>
  <div data-slot="error-part" class="flex flex-col gap-2">
    <HarnessErrorAlert
      :error="error"
      :provider-name="providerName"
      :data-testid="testIds.chatError"
      @action="onAction"
    />
    <div v-if="extraActions.length" class="flex flex-wrap gap-2">
      <Button
        v-for="action in extraActions"
        :key="action"
        type="button"
        size="sm"
        variant="outline"
        :data-action="action"
        :data-testid="testIds.chatErrorAction"
        @click="onExtra(action)"
      >
        {{ extraLabels[action] }}
      </Button>
    </div>
  </div>
</template>
