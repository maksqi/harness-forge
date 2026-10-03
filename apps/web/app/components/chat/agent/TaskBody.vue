<script setup lang="ts">
// The expanded part of a sub-agent block (docs/UI.md 7.27, 10.6; ADR-043): the prompt, the steps (TaskStepRow, "Show
// all {n} steps" = `task-steps-more`), the report (`task-report`), the meta line and a failure alert. Store-free (the
// share page reuses it through ShareToolRow); `input` and `output` are parsed inside (`taskInputSchema` /
// `taskOutputSchema`), and an unparsable value renders nothing. Props frozen from Gate P9-0b (C25); W9.10 builds it.
// No root test id (`data-slot="task-body"`).
defineProps<{
  input: unknown
  output: unknown
  /** The sub-agent is running (its last step may still run). */
  running: boolean
}>()
</script>

<template>
  <div data-slot="task-body" class="flex flex-col gap-2" />
</template>
