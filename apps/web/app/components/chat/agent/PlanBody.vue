<script setup lang="ts">
// The plan of an `exit_plan_mode` call (docs/UI.md 7.25, 10.6; ADR-041): inside PlanApprovalCard, the body of the plan
// row and the share page. Store-free. Props frozen from Gate P9-0b (C25). The plan renders as Markdown (the safe
// `Markdown` wrapper: raw HTML escaped); "Your feedback: …" follows it when the user sent feedback with the decision.
// No root test id (`data-slot="plan-body"`).
import Markdown from '~/components/common/Markdown.vue'

withDefaults(defineProps<{
  /** The plan (Markdown). */
  plan: string
  /** The feedback sent with the decision (the approval's reason); shown as "Your feedback: …". */
  feedback?: string | null
}>(), {
  feedback: null,
})
</script>

<template>
  <div data-slot="plan-body" class="flex min-w-0 flex-col gap-2 text-sm">
    <Markdown :content="plan" :final="true" />
    <p v-if="feedback" data-slot="plan-feedback-text" class="border-t pt-2 whitespace-pre-wrap break-words text-muted-foreground">
      Your feedback: {{ feedback }}
    </p>
  </div>
</template>
