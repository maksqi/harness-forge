<script setup lang="ts">
// The plan approval card (docs/UI.md 2.16, 7.3, 7.25, 10.6, 14; ADR-041): ToolPart renders it instead of
// ToolApprovalCard while an `exit_plan_mode` call of `core-agent` awaits its decision. Props, emit and root test id
// frozen from Gate P9-0b (C25).
// AiConfirmation in the info tone, a `role="group"` named "Plan ready for review": the plan (PlanBody) in a focusable,
// scrolling `role="region"` named "Plan" (`plan-approval-plan`, at most 45dvh), the optional feedback field
// (`plan-feedback`, 1 to 4 rows, at most `LIMITS.approvalReasonMaxChars`: a longer text shows "Use at most 2,000
// characters." and disables the buttons) and the buttons "Keep planning" · "Approve, ask before edits" · "Approve,
// accept edits" (stacked full width below `sm`, the primary one on top; 40px on coarse pointers). There is no implicit
// approval on Enter (the field is a plain textarea, not a form). `decide` carries `mode` only with `approved: true`
// and the trimmed feedback with either choice. Every control is disabled while the decision is sent (after a click, or
// while `disabled`); the card never takes focus when it appears, and after a decision focus goes back to the composer
// (desktop).
// Root `plan-approval` (`data-state` pending | sending).
import type { ToolPartLike } from '../chat-format'
import { LIMITS } from '@harness-forge/shared'
import { ClipboardListIcon } from '@lucide/vue'
import { computed, ref, useId } from 'vue'
import {
  Confirmation as AiConfirmation,
  ConfirmationActions as AiConfirmationActions,
  ConfirmationRequest as AiConfirmationRequest,
} from '@/components/ai-elements/confirmation'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'
import { planOf } from './agent-tools'
import PlanBody from './PlanBody.vue'

const props = withDefaults(defineProps<{
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

/** The feedback cap: the server's limit for an approval reason (2,000 characters). */
const FEEDBACK_MAX = LIMITS.approvalReasonMaxChars

const ui = useUiStore()
const feedback = ref('')
const pending = ref(false)
const feedbackId = useId()
const errorId = useId()

const plan = computed(() => {
  const value = planOf(props.part.input)
  if (value !== null)
    return value
  const input = props.part.input
  const raw = typeof input === 'object' && input !== null ? (input as Record<string, unknown>).plan : undefined
  return typeof raw === 'string' ? raw : ''
})
const sending = computed(() => props.disabled || pending.value)
const tooLong = computed(() => feedback.value.length > FEEDBACK_MAX)
const blocked = computed(() => sending.value || tooLong.value)

function prefersTouch(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches
}

function decide(approved: boolean, mode?: 'edits' | 'ask') {
  if (blocked.value)
    return
  pending.value = true
  const text = feedback.value.trim()
  emit('decide', {
    approved,
    ...(approved && mode ? { mode } : {}),
    ...(text ? { feedback: text } : {}),
  })
  if (!prefersTouch())
    ui.requestComposerFocus()
}

const BUTTON_CLASS = 'w-full sm:w-auto max-sm:h-10 pointer-coarse:h-10'
</script>

<template>
  <AiConfirmation
    :approval="part.approval"
    :state="part.state"
    role="group"
    aria-label="Plan ready for review"
    :data-testid="testIds.planApproval"
    :data-state="sending ? 'sending' : 'pending'"
    class="min-w-0 gap-3 border-info/50 bg-info/5 px-3.5 py-3 text-foreground dark:bg-info/10"
  >
    <AiConfirmationRequest>
      <div class="flex items-start justify-between gap-3">
        <p class="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <ClipboardListIcon aria-hidden="true" class="size-4 shrink-0 text-info" />
          Plan ready for review
        </p>
        <span v-if="source" class="shrink-0 text-xs text-muted-foreground">from {{ source }}</span>
      </div>
      <div
        :data-testid="testIds.planApprovalPlan"
        role="region"
        aria-label="Plan"
        tabindex="0"
        class="max-h-[45dvh] min-w-0 overflow-auto overscroll-contain rounded-md border bg-background/70 px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <PlanBody :plan="plan" />
      </div>
      <div class="flex min-w-0 flex-col gap-1">
        <Textarea
          :id="feedbackId"
          v-model="feedback"
          :data-testid="testIds.planFeedback"
          rows="1"
          aria-label="Feedback for the agent (optional)"
          placeholder="Feedback for the agent (optional)"
          :disabled="sending"
          :aria-invalid="tooLong || undefined"
          :aria-describedby="tooLong ? errorId : undefined"
          class="max-h-28 min-h-9 resize-none overflow-y-auto bg-background/70 py-1.5 dark:bg-input/30"
        />
        <p v-if="tooLong" :id="errorId" role="alert" class="text-xs text-destructive">
          Use at most 2,000 characters.
        </p>
      </div>
    </AiConfirmationRequest>
    <AiConfirmationActions class="flex w-full flex-col-reverse items-stretch gap-2 self-stretch sm:flex-row sm:items-center sm:justify-end">
      <Button
        type="button"
        variant="outline"
        size="sm"
        :disabled="blocked"
        :data-testid="testIds.planKeepPlanning"
        class="sm:mr-auto" :class="[BUTTON_CLASS]"
        @click="decide(false)"
      >
        Keep planning
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        :disabled="blocked"
        :data-testid="testIds.planApproveAsk"
        :class="BUTTON_CLASS"
        @click="decide(true, 'ask')"
      >
        Approve, ask before edits
      </Button>
      <Button
        type="button"
        size="sm"
        :disabled="blocked"
        :data-testid="testIds.planApproveEdits"
        :class="BUTTON_CLASS"
        @click="decide(true, 'edits')"
      >
        Approve, accept edits
      </Button>
    </AiConfirmationActions>
  </AiConfirmation>
</template>
