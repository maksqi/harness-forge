<script setup lang="ts">
// The summary of a finished workspace tool row (docs/UI.md 7.19): `+12 −3` (each side in its tone, tabular-nums),
// `exit 1`, `timed out`, `lines 1–120 of 340`, `17 files`, ... Rendered before the row status by ToolPart and
// ShareToolRow. Root tool-row-summary (data-tone = muted | success | destructive | warning). Store-free.
import type { WorkspaceRowSummary } from './workspace-tools'
import { computed } from 'vue'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import { MINUS_SIGN } from './workspace-tools'

const props = defineProps<{ summary: WorkspaceRowSummary }>()

const DIFF = new RegExp(`^\\+(\\d+) ${MINUS_SIGN}(\\d+)$`)
const diff = computed(() => {
  const match = props.summary.text.match(DIFF)
  return match ? { additions: match[1]!, deletions: match[2]! } : null
})

const TONE_CLASS: Record<WorkspaceRowSummary['tone'], string> = {
  muted: 'text-muted-foreground',
  success: 'text-success',
  destructive: 'text-destructive',
  warning: 'text-warning',
}
</script>

<template>
  <span
    :data-testid="testIds.toolRowSummary"
    :data-tone="summary.tone"
    :class="cn('shrink-0 font-mono text-xs whitespace-nowrap tabular-nums', TONE_CLASS[summary.tone])"
  >
    <template v-if="diff">
      <span class="text-success">+{{ diff.additions }}</span>{{ ' ' }}<span class="text-destructive">{{ MINUS_SIGN }}{{ diff.deletions }}</span>
    </template>
    <template v-else>{{ summary.text }}</template>
  </span>
</template>
