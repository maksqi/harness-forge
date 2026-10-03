<script setup lang="ts">
// A sub-agent block (docs/UI.md 2.16, 7.27, 10.6; ADR-043): ChatMessage renders it for block kind `task` (a tool part
// named `task`). Props, emit and root test id frozen from Gate P9-0b (C25); W9.10 builds the two-line collapsible block
// (`task-block-trigger`, the live line, TaskBody) behind them, renders ToolApprovalCard for an approval-requested call
// and falls back to ToolPart when the input or output does not parse (`taskInputSchema` / `taskOutputSchema`).
// Root `task-block` (`data-state` queued | running | completed | failed | limit | aborted | approval | denied,
// `data-kind` explore | general).
// P9-0b stub: the generic tool row stands in for the block (as before Phase 9), with its approval passed on.
import type { ToolPartLike } from '../chat-format'
import { taskInputSchema, taskOutputSchema } from '@harness-forge/shared'
import { computed } from 'vue'
import { testIds } from '~/utils/testids'
import ToolPart from '../parts/ToolPart.vue'

const props = withDefaults(defineProps<{
  part: ToolPartLike
  /** The message is streaming (a preliminary output is a running sub-agent only then). */
  streaming: boolean
  /** A later message exists: an approval still requested here was superseded. */
  superseded?: boolean
}>(), {
  superseded: false,
})

const emit = defineEmits<{
  approval: [response: { id: string, approved: boolean, toolName: string, alwaysAllow: boolean }]
}>()

const kind = computed(() => {
  const parsed = taskInputSchema.safeParse(props.part.input)
  return parsed.success ? parsed.data.type : undefined
})

const state = computed(() => {
  const part = props.part
  switch (part.state) {
    case 'approval-requested':
      return props.superseded ? 'denied' : 'approval'
    case 'approval-responded':
      if (part.approval.approved === false)
        return 'denied'
      return props.streaming ? 'running' : 'aborted'
    case 'output-denied':
      return 'denied'
    case 'output-error':
      return 'failed'
    case 'output-available': {
      if (part.preliminary === true)
        return props.streaming ? 'running' : 'aborted'
      const parsed = taskOutputSchema.safeParse(part.output)
      return parsed.success ? parsed.data.status : 'completed'
    }
    default:
      return props.streaming ? 'running' : 'aborted'
  }
})
</script>

<template>
  <div :data-testid="testIds.taskBlock" :data-state="state" :data-kind="kind">
    <ToolPart :part="part" :streaming="streaming" :superseded="superseded" @approval="emit('approval', $event)" />
  </div>
</template>
