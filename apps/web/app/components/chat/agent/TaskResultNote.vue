<script setup lang="ts">
// The result of a background agent in the transcript (docs/UI.md 7.29, 10.7; ADR-046): a full-width dashed note,
// `role="note"` named "Background agent result: {description}", "Background agent finished / failed / stopped /
// reached its step limit · {label} · {description}", the meta "{n} tool calls · 3m 2s", the report's first sentence and
// Show report / Hide report. Store-free: ChatMessage renders it for block kind `task-result` (variant inline) and for a
// carrier message (variant turn). Props and the root test id are frozen from Gate P10-0b (C33 stub); W10.11 implements
// the note in P10-A. The stub shows line 1 and the first sentence.
import type { TaskResultData } from '@harness-forge/shared'
import { computed } from 'vue'
import { testIds } from '~/utils/testids'
import { firstSentence, taskTypeLabel } from './agent-tools'

const props = defineProps<{ result: TaskResultData, variant: 'inline' | 'turn' }>()

const STATUS_TEXT: Readonly<Record<string, string>> = {
  completed: 'Background agent finished',
  failed: 'Background agent failed',
  aborted: 'Background agent stopped',
  limit: 'Background agent reached its step limit',
}

const output = computed(() => props.result.output)
const heading = computed(() => STATUS_TEXT[output.value.status] ?? 'Background agent finished')
const summary = computed(() => firstSentence(output.value.report) || firstSentence(output.value.error ?? '') || 'No report.')
</script>

<template>
  <div
    :data-testid="testIds.taskResult"
    :data-task-id="result.taskId"
    :data-status="output.status"
    :data-variant="variant"
    role="note"
    :aria-label="`Background agent result: ${output.description}`"
    class="flex w-full min-w-0 flex-col gap-0.5 rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-sm"
  >
    <p class="min-w-0 truncate">
      {{ heading }} · {{ taskTypeLabel(output.type) }} · {{ output.description }}
    </p>
    <p class="min-w-0 truncate text-muted-foreground">
      {{ summary }}
    </p>
  </div>
</template>
