<script setup lang="ts">
// Submitted state (docs/UI.md 7.6): one transcript line with a shimmering "Thinking…" until the reply starts.
// Phase 9 (ADR-040, docs/UI.md 7.24): "Compacting conversation…" instead while the session's transient activity is
// `compacting` (a summary is being written before or during the reply).
// Phase 11 (ADR-048; C39 widens the prop, W11.12 owns it; frozen from Gate P11-0b): "Running hooks…" while it is `hooks`
// (command hooks of a message-level event run: UserPromptSubmit, SessionStart, Stop, PreCompact).
import { computed } from 'vue'
import { testIds } from '~/utils/testids'

const props = withDefaults(defineProps<{
  /**
   * + Phase 9: the session's transient activity; 'compacting' shows "Compacting conversation…". + Phase 11: 'hooks'
   * shows "Running hooks…".
   */
  activity?: 'compacting' | 'hooks' | null
}>(), {
  activity: null,
})

const label = computed(() => {
  if (props.activity === 'compacting')
    return 'Compacting conversation…'
  return props.activity === 'hooks' ? 'Running hooks…' : 'Thinking…'
})
</script>

<template>
  <p :data-testid="testIds.submittedPlaceholder" class="h-[1lh] text-muted-foreground" aria-hidden="true">
    <span class="hf-shimmer-text">{{ label }}</span>
  </p>
</template>
