<script setup lang="ts">
// `data-notice` part (docs/API.md 6.4): one muted line, e.g. "Older messages were trimmed to fit the context".
import type { NoticeData } from '@harness-forge/shared'
import { InfoIcon, TriangleAlertIcon } from '@lucide/vue'

defineProps<{ notice: NoticeData }>()
</script>

<template>
  <p
    data-slot="notice-part"
    :data-level="notice.level"
    :data-code="notice.code"
    class="flex items-start gap-2 text-xs text-muted-foreground"
  >
    <TriangleAlertIcon v-if="notice.level === 'warning'" aria-hidden="true" class="mt-px size-3.5 shrink-0 text-warning" />
    <InfoIcon v-else aria-hidden="true" class="mt-px size-3.5 shrink-0" />
    <span class="min-w-0 break-words">{{ notice.message }}</span>
  </p>
</template>
