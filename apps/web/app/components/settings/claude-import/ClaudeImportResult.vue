<script setup lang="ts">
// Step 3 of the import (Phase 12, ADR-055; docs/UI.md 9.14, 10.9): `claude-import-result` (`data-count` = the imported
// items) with the lines of `resultLines(result)`: "Imported {n} items · {s} skipped · {f} failed", the failed items and
// the warnings. Store-free.
// Props and the root test id are frozen from Gate P12-0b (C46 stub); W12.10 implements the result in P12-A.
import type { ClaudeImportApplyResult } from '@harness-forge/shared'
import { computed } from 'vue'
import { testIds } from '~/utils/testids'
import { resultLines } from './claude-import'

const props = defineProps<{ result: ClaudeImportApplyResult }>()

const lines = computed(() => resultLines(props.result))
const imported = computed(() => props.result.counts.created + props.result.counts.updated)
</script>

<template>
  <div :data-testid="testIds.claudeImportResult" :data-count="imported" class="grid min-w-0 gap-1 text-sm">
    <p v-for="(line, index) in lines" :key="index" :class="index === 0 ? 'font-medium' : 'text-muted-foreground'">
      {{ line }}
    </p>
  </div>
</template>
