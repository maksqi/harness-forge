<script setup lang="ts">
// One tool call of a sub-agent (docs/UI.md 7.27, 10.6; ADR-043), inside TaskBody. Store-free. Props and root test id
// frozen from Gate P9-0b (C25); W9.10 builds the row (the tool's icon and name, the summary, the result preview, the
// status; a denied step reads "Skipped" with the tooltip "Sub-agents can't ask for approval, so this was skipped.").
// Root `task-step` (`data-tool-name`, `data-state` running | done | error | denied).
import type { TaskStep } from '@harness-forge/shared'
import { testIds } from '~/utils/testids'

defineProps<{
  step: TaskStep
  /** The sub-agent is running (a `running` step spins only then). */
  running: boolean
}>()
</script>

<template>
  <div
    :data-testid="testIds.taskStep"
    :data-tool-name="step.toolName"
    :data-state="step.state"
    class="flex min-w-0 items-center gap-2 text-xs"
  >
    <span class="shrink-0 font-mono">{{ step.toolName }}</span>
    <span class="min-w-0 truncate text-muted-foreground">{{ step.summary }}</span>
  </div>
</template>
