<script setup lang="ts">
// Step 3 of the import (Phase 12, ADR-055; docs/UI.md 2.19, 9.14, 10.9): `claude-import-result` (`data-count` = the
// imported items) with the lines of `resultLines(result)`: "Imported {n} items · {s} skipped · {f} failed" (announced in
// a polite region), then the default slot (the dialog puts the turned-off lines there: they need the plan), the failed
// items with their messages and the server's warnings. Store-free.
// Props and the root test id are frozen from Gate P12-0b (C46 stub); body W12.10 (P12-A).
import type { ClaudeImportApplyResult } from '@harness-forge/shared'
import { CircleAlertIcon, CircleCheckIcon } from '@lucide/vue'
import { computed } from 'vue'
import { testIds } from '~/utils/testids'
import { resultLines } from './claude-import'

const props = defineProps<{ result: ClaudeImportApplyResult }>()

defineSlots<{
  /** Lines after the headline (the turned-off counts). */
  default?: () => unknown
}>()

const lines = computed(() => resultLines(props.result))
const imported = computed(() => props.result.counts.created + props.result.counts.updated)
const failed = computed(() => props.result.counts.failed > 0)
</script>

<template>
  <div :data-testid="testIds.claudeImportResult" :data-count="imported" class="flex min-w-0 items-start gap-3 text-sm">
    <CircleAlertIcon v-if="failed" aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-destructive" />
    <CircleCheckIcon v-else aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-success" />
    <div class="grid min-w-0 gap-1">
      <p class="font-medium tabular-nums" role="status" aria-live="polite" data-slot="claude-import-headline">
        {{ lines[0] }}
      </p>
      <slot />
      <p v-for="(line, index) in lines.slice(1)" :key="index" class="break-words text-muted-foreground">
        {{ line }}
      </p>
    </div>
  </div>
</template>
