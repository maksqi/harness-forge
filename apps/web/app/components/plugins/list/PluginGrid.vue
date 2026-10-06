<script setup lang="ts">
// The card grid of the list page (docs/UI.md 8.2): one column, two from md, three from xl, 12px gaps; six skeleton
// cards while the list loads. Card events are forwarded with their plugin. Phase 12 (ADR-054): each card gets the update
// a marketplace offers for it (`useMarketplacesStore().updateOf`).
import type { PluginSummary } from '@harness-forge/shared'
import { Skeleton } from '@/components/ui/skeleton'
import { useMarketplacesStore } from '~/stores/marketplaces'
import PluginCard from './PluginCard.vue'

withDefaults(defineProps<{ plugins: readonly PluginSummary[], loading?: boolean }>(), { loading: false })

const emit = defineEmits<{
  'update:enabled': [plugin: PluginSummary, value: boolean]
  'viewLogs': [plugin: PluginSummary]
  'review': [plugin: PluginSummary]
}>()

const GRID = 'grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3'

const marketplaces = useMarketplacesStore()
</script>

<template>
  <div v-if="loading" :class="GRID" aria-busy="true" aria-label="Loading plugins">
    <div v-for="index in 6" :key="index" class="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div class="flex items-start gap-3">
        <Skeleton class="size-9 rounded-lg" />
        <div class="flex flex-1 flex-col gap-1.5 pt-0.5">
          <Skeleton class="h-3.5 w-32" />
          <Skeleton class="h-3 w-12" />
        </div>
        <Skeleton class="mt-1.5 h-3.5 w-6 rounded-full" />
      </div>
      <div class="flex flex-col gap-1.5">
        <Skeleton class="h-3 w-full" />
        <Skeleton class="h-3 w-2/3" />
      </div>
      <div class="mt-1 flex gap-1.5">
        <Skeleton class="h-5 w-12" />
        <Skeleton class="h-5 w-20" />
      </div>
    </div>
  </div>
  <div v-else role="list" aria-label="Plugins" :class="GRID">
    <div v-for="plugin in plugins" :key="plugin.id" role="listitem" class="flex min-w-0">
      <PluginCard
        :plugin="plugin"
        :update="marketplaces.updateOf(plugin.id)"
        class="flex-1"
        @update:enabled="value => emit('update:enabled', plugin, value)"
        @view-logs="emit('viewLogs', plugin)"
        @review="emit('review', plugin)"
      />
    </div>
  </div>
</template>
