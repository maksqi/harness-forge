<script setup lang="ts">
// Submitted state (docs/UI.md 7.6): one transcript line with a shimmering "Thinking…" until the reply starts.
// Phase 9 (ADR-040, docs/UI.md 7.24): "Compacting conversation…" instead while the session's transient activity is
// `compacting` (a summary is being written before or during the reply).
import { computed } from 'vue'
import { testIds } from '~/utils/testids'

const props = withDefaults(defineProps<{
  /** + Phase 9: the session's transient activity; 'compacting' shows "Compacting conversation…". */
  activity?: 'compacting' | null
}>(), {
  activity: null,
})

const label = computed(() => (props.activity === 'compacting' ? 'Compacting conversation…' : 'Thinking…'))
</script>

<template>
  <p :data-testid="testIds.submittedPlaceholder" class="h-[1lh] text-muted-foreground" aria-hidden="true">
    <span class="hf-shimmer-text">{{ label }}</span>
  </p>
</template>
