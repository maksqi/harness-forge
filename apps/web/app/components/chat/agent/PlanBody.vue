<script setup lang="ts">
// The plan of an `exit_plan_mode` call (docs/UI.md 7.25, 10.6; ADR-041): inside PlanApprovalCard, the body of the plan
// row and the share page. Store-free. Props frozen from Gate P9-0b (C25); W9.10 renders the plan as Markdown and
// "Your feedback: …" below it. No root test id (`data-slot="plan-body"`).
withDefaults(defineProps<{
  /** The plan (Markdown). */
  plan: string
  /** The feedback sent with "Keep planning" (the denial reason); shown as "Your feedback: …". */
  feedback?: string | null
}>(), {
  feedback: null,
})
</script>

<template>
  <div data-slot="plan-body" class="flex flex-col gap-2 text-sm">
    <p class="whitespace-pre-wrap">
      {{ plan }}
    </p>
    <p v-if="feedback" class="text-muted-foreground">
      Your feedback: {{ feedback }}
    </p>
  </div>
</template>
