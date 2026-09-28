<script setup lang="ts">
// Provider icon + model display name for a model ref (docs/UI.md 7.5, 7.9). Model data comes from the injected
// MODEL_LABEL_RESOLVER (see model-label.ts). Unknown ref -> the raw model id in mono with a warning icon.
import { TriangleAlertIcon } from '@lucide/vue'
import { computed, inject } from 'vue'
import { cn } from '@/lib/utils'
import { MODEL_LABEL_RESOLVER, splitModelRef } from './model-label'
import ProviderIcon from './ProviderIcon.vue'

const props = withDefaults(defineProps<{
  modelRef: string
  size?: 'sm' | 'md'
  showProvider?: boolean
}>(), {
  size: 'md',
  showProvider: false,
})

const resolve = inject(MODEL_LABEL_RESOLVER, null)

const parts = computed(() => splitModelRef(props.modelRef))
const info = computed(() => (resolve ? resolve(props.modelRef) ?? null : null))
const providerId = computed(() => parts.value?.providerId ?? '')
const providerName = computed(() => info.value?.providerName || providerId.value)
</script>

<template>
  <span
    data-slot="model-label"
    :data-model-ref="modelRef"
    :data-state="info ? 'known' : 'unknown'"
    :class="cn('inline-flex min-w-0 items-center gap-1.5', size === 'sm' ? 'text-xs' : 'text-sm')"
  >
    <template v-if="info">
      <ProviderIcon :id="providerId" :icon="info.icon" :name="providerName" size="sm" variant="auto" />
      <span class="min-w-0 truncate">{{ info.name }}</span>
      <span v-if="showProvider && providerName" class="shrink-0 text-muted-foreground">{{ providerName }}</span>
    </template>
    <template v-else>
      <TriangleAlertIcon aria-hidden="true" class="size-3.5 shrink-0 text-warning" />
      <span class="min-w-0 truncate font-mono" :title="modelRef">{{ parts?.modelId ?? modelRef }}</span>
      <span class="sr-only">(unknown model)</span>
    </template>
  </span>
</template>
