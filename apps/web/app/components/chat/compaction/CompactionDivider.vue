<script setup lang="ts">
// Compaction divider (docs/UI.md 7.24, 10.6; ADR-040): a full-width row at the position of a `data-compaction` part
// (ChatMessage renders it for block kind `compaction`). Props and root test id frozen from Gate P9-0b (C25); W9.11
// builds the real divider (rules, meta line, "Show summary" with the summary card) behind them.
// Root `compaction-divider` with `data-kind` (the trigger), `data-variant` and `data-count` (messages summarized);
// `role="group"` named by the label. A marker has no state: it is always finished.
import type { CompactionData } from '@harness-forge/shared'
import type { CompactionVariant } from './compaction'
import { computed } from 'vue'
import { testIds } from '~/utils/testids'
import { compactionLabel } from './compaction'

const props = defineProps<{
  data: CompactionData
  /** 'history' = the first rendered block of its message; 'run' = after other blocks of its message (in-run). */
  variant: CompactionVariant
}>()

const label = computed(() => compactionLabel(props.data, props.variant))
</script>

<template>
  <div
    :data-testid="testIds.compactionDivider"
    :data-kind="data.trigger"
    :data-variant="variant"
    :data-count="data.messagesCompacted"
    role="group"
    :aria-label="label"
    class="flex items-center gap-3 text-xs text-muted-foreground"
  >
    <span aria-hidden="true" class="h-px flex-1 bg-border" />
    <span>{{ label }}</span>
    <span aria-hidden="true" class="h-px flex-1 bg-border" />
  </div>
</template>
