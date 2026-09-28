<script setup lang="ts">
// "3h ago" with the absolute local time in `title` (docs/UI.md 9.3). Refreshes every 30s.
import { computed } from 'vue'
import { formatAbsoluteTime, formatRelativeTime, toDate, useSharedNow } from './relative-time'

const props = defineProps<{ at: string | number | Date }>()

const now = useSharedNow()
const date = computed(() => toDate(props.at))
const relative = computed(() => (date.value ? formatRelativeTime(date.value, now.value) : ''))
const absolute = computed(() => (date.value ? formatAbsoluteTime(date.value) : ''))
const iso = computed(() => date.value?.toISOString())
</script>

<template>
  <time data-slot="relative-time" :datetime="iso" :title="absolute || undefined" class="tabular-nums">{{ relative }}</time>
</template>
