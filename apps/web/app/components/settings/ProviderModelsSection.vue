<script setup lang="ts">
// One connected provider in Settings -> Models (docs/UI.md 9.3): a collapsible header (icon, name, model count,
// "Updated 3h ago", Refresh, Add custom model) over its ModelsTable.
import type { CatalogModel, ProviderSummary } from '@harness-forge/shared'
import { ChevronRightIcon, PlusIcon, RotateCwIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import RelativeTime from '~/components/common/RelativeTime.vue'
import ProviderIcon from '~/components/providers/ProviderIcon.vue'
import { useModelsStore } from '~/stores/models'
import { testIds } from '~/utils/testids'
import ModelsTable from './ModelsTable.vue'
import { toastError } from './notify'
import { formatModelCount } from './providers'

const props = defineProps<{
  provider: ProviderSummary
  models: CatalogModel[]
  /** Every model of the provider (the filter may show fewer). */
  total: number
  /** A filter is active: the count reads "3 of 23". */
  filtered: boolean
}>()

const emit = defineEmits<{ addCustom: [] }>()

const open = defineModel<boolean>('open', { default: true })

const store = useModelsStore()
const refreshing = computed(() => store.refreshing[props.provider.id] === true)
const countLabel = computed(() => (props.filtered
  ? `${props.models.length} of ${formatModelCount(props.total)}`
  : formatModelCount(props.total)))

/** Spinner while running; the count and "Updated just now" confirm success, a failure toasts. */
async function refresh() {
  try {
    await store.refresh(props.provider.id)
  }
  catch (error) {
    toastError(error, props.provider.name)
  }
}
</script>

<template>
  <Collapsible
    v-model:open="open"
    :data-testid="testIds.modelsSection"
    :data-provider-id="provider.id"
    class="overflow-hidden rounded-xl border bg-card"
  >
    <div class="flex items-center gap-2 py-2 pr-2 pl-3">
      <CollapsibleTrigger
        class="group/section -my-1 flex min-w-0 flex-1 items-center gap-2.5 rounded-md py-1 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ChevronRightIcon
          aria-hidden="true"
          class="size-4 shrink-0 text-muted-foreground transition-transform duration-(--duration-fast) group-data-[state=open]/section:rotate-90"
        />
        <ProviderIcon :id="provider.id" :icon="provider.icon" :name="provider.name" size="md" variant="color" />
        <span class="min-w-0 truncate text-sm font-medium">{{ provider.name }}</span>
        <span class="shrink-0 text-xs text-muted-foreground tabular-nums">{{ countLabel }}</span>
      </CollapsibleTrigger>
      <span v-if="provider.modelsFetchedAt" class="hidden shrink-0 text-xs text-muted-foreground md:inline">
        Updated <RelativeTime :at="provider.modelsFetchedAt" />
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        :disabled="refreshing"
        :aria-label="`Refresh ${provider.name} models`"
        :title="refreshing ? 'Refreshing…' : 'Refresh models'"
        :aria-busy="refreshing || undefined"
        :data-testid="testIds.modelsRefresh"
        :data-provider-id="provider.id"
        class="shrink-0 text-muted-foreground hover:text-foreground"
        @click="refresh"
      >
        <RotateCwIcon aria-hidden="true" :class="cn('size-4', refreshing && 'animate-spin')" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        :data-testid="testIds.customModelAdd"
        :data-provider-id="provider.id"
        :aria-label="`Add a custom ${provider.name} model`"
        class="shrink-0 text-muted-foreground hover:text-foreground"
        @click="emit('addCustom')"
      >
        <PlusIcon aria-hidden="true" data-icon="inline-start" />
        <span class="hidden sm:inline">Add custom model</span>
        <span class="sm:hidden">Add</span>
      </Button>
    </div>
    <CollapsibleContent class="border-t">
      <ModelsTable v-if="models.length" :models="models" :provider-name="provider.name" />
      <p v-else class="px-4 py-6 text-center text-sm text-muted-foreground">
        No models yet. Refresh the list or add a custom model.
      </p>
    </CollapsibleContent>
  </Collapsible>
</template>
