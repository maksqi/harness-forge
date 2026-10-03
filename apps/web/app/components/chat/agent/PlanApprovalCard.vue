<script setup lang="ts">
// The plan approval card (docs/UI.md 2.16, 7.25, 10.6; ADR-041): ToolPart renders it instead of ToolApprovalCard while
// an `exit_plan_mode` call of `core-agent` awaits its decision. Props, emit and root test id frozen from Gate P9-0b
// (C25); W9.10 builds the card (the plan region, the feedback field, "Keep planning" · "Approve, ask before edits" ·
// "Approve, accept edits") behind them. `decide` carries `mode` only with `approved: true`, and `feedback` (at most
// `LIMITS.approvalReasonMaxChars`) with either choice; ToolPart sends them on as the approval's `planMode` / `reason`.
// Root `plan-approval` (`data-state` pending | sending).
// P9-0b stub: until W9.10 builds the card, the plain approval card stands in (Allow / Deny, as before Phase 9), so a
// plan can still be answered; its "Always allow" choice is not passed on.
import type { ToolPartLike } from '../chat-format'
import { testIds } from '~/utils/testids'
import ToolApprovalCard from '../parts/ToolApprovalCard.vue'

withDefaults(defineProps<{
  part: ToolPartLike
  /** The plugin that provides the tool ("from core-agent"), when known. */
  source?: string | null
  /** Every control is disabled (the decision is being sent). */
  disabled?: boolean
}>(), {
  source: null,
  disabled: false,
})

const emit = defineEmits<{
  decide: [decision: { approved: boolean, mode?: 'edits' | 'ask', feedback?: string }]
}>()
</script>

<template>
  <div
    :data-testid="testIds.planApproval"
    :data-state="disabled ? 'sending' : 'pending'"
    role="group"
    aria-label="Plan ready for review"
  >
    <ToolApprovalCard
      :part="part"
      tool-name="exit_plan_mode"
      :source="source"
      @decide="decision => emit('decide', { approved: decision.approved })"
    />
  </div>
</template>
