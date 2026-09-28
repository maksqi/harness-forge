<script setup lang="ts">
// One block of a settings page (docs/UI.md 9): title, optional description, content, and a rule above every
// section that follows another one.
import { useId } from 'vue'

defineProps<{ title: string, description?: string }>()
defineSlots<{
  default?: () => any
  /** Controls on the right of the title (e.g. a Refresh button). */
  actions?: () => any
}>()

const headingId = useId()
</script>

<template>
  <section
    data-slot="settings-section"
    :aria-labelledby="headingId"
    class="flex flex-col gap-4 py-6 [&+&]:border-t [&+&]:border-border"
  >
    <header class="flex items-start gap-3">
      <div class="min-w-0 flex-1">
        <h2 :id="headingId" class="text-base font-medium tracking-tight">
          {{ title }}
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
