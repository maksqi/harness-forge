<script setup lang="ts">
// A titled block of the plugin Overview (docs/UI.md 8.8): heading with an optional count and actions, then content.
import { useId } from 'vue'

defineProps<{ title: string, count?: number | null, description?: string }>()
defineSlots<{
  default?: () => any
  actions?: () => any
}>()

const headingId = useId()
</script>

<template>
  <section data-slot="plugin-detail-section" :aria-labelledby="headingId" class="flex flex-col gap-3">
    <header class="flex min-h-7 items-end gap-3">
      <div class="min-w-0 flex-1">
        <h2 :id="headingId" class="flex items-center gap-2 text-sm font-medium">
          {{ title }}
          <span v-if="count != null" class="rounded-md bg-muted px-1.5 text-xs leading-5 font-normal text-muted-foreground tabular-nums">{{ count }}</span>
        </h2>
        <p v-if="description" class="mt-0.5 text-sm text-muted-foreground">
          {{ description }}
        </p>
      </div>
      <div v-if="$slots.actions" class="flex shrink-0 items-center gap-2">
        <slot name="actions" />
      </div>
    </header>
    <slot />
  </section>
</template>
