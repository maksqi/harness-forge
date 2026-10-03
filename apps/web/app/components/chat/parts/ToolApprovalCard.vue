<script setup lang="ts">
// Approval card under a tool row (docs/UI.md 7.3): "Allow {tool}?" with the source plugin, the arguments, "Always
// allow {tool}" and Deny / Allow. The decision goes up (ChatView answers through the session); the card disappears
// into the row status once the part leaves `approval-requested`. Nothing approves implicitly (no Enter handling).
import type { WorkspaceAccess } from '@harness-forge/shared'
import type { ToolPartLike } from '../chat-format'
import { computed, ref, useId } from 'vue'
import {
  Confirmation as AiConfirmation,
  ConfirmationActions as AiConfirmationActions,
  ConfirmationRequest as AiConfirmationRequest,
} from '@/components/ai-elements/confirmation'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { testIds } from '~/utils/testids'
import { formatToolValue } from '../chat-format'

const props = withDefaults(defineProps<{
  part: ToolPartLike
  toolName: string
  /** Plugin that provides the tool ("from core-tools"), when known. */
  source?: string | null
  /**
   * + Phase 7 (C15 declares it, W7.11 uses it): `ToolSummary.workspace` of the tool; 'execute' hides "Always allow",
   * 'write' offers "Accept all edits in this chat" (tool-approval-accept-edits).
   */
  workspace?: WorkspaceAccess | null
}>(), {
  workspace: null,
})

const emit = defineEmits<{
  /** + Phase 7: `acceptEdits` = "Accept all edits in this chat". */
  decide: [decision: { approved: boolean, alwaysAllow: boolean, acceptEdits?: boolean }]
}>()

const alwaysAllow = ref<boolean | 'indeterminate'>(false)
const pending = ref(false)
const checkboxId = useId()
const args = computed(() => formatToolValue(props.part.input) || '{}')

function decide(approved: boolean) {
  if (pending.value)
    return
  pending.value = true
  emit('decide', { approved, alwaysAllow: approved && alwaysAllow.value === true })
}
</script>

<template>
  <AiConfirmation
    v-if="part.state === 'approval-requested'"
    :approval="part.approval"
    :state="part.state"
    role="group"
    :aria-label="`Approval needed: ${toolName}`"
    :data-testid="testIds.toolApproval"
    :data-tool-name="toolName"
    class="gap-3 border-warning/50 bg-warning/5 px-3.5 py-3 text-foreground dark:bg-warning/10"
  >
    <AiConfirmationRequest>
      <div class="flex items-start justify-between gap-3">
        <p class="min-w-0 text-sm">
          Allow <span class="font-mono font-semibold break-all">{{ toolName }}</span>?
        </p>
        <span v-if="source" class="shrink-0 text-xs text-muted-foreground">from {{ source }}</span>
      </div>
      <pre class="max-h-48 overflow-auto rounded-md bg-muted/60 p-2.5 font-mono text-xs whitespace-pre-wrap break-words">{{ args }}</pre>
      <div class="flex items-center gap-2">
        <Checkbox
          :id="checkboxId"
          v-model="alwaysAllow"
          :disabled="pending"
          :data-testid="testIds.toolApprovalAlways"
        />
        <label :for="checkboxId" class="text-sm select-none">
          Always allow <span class="font-mono">{{ toolName }}</span>
        </label>
      </div>
    </AiConfirmationRequest>
    <AiConfirmationActions>
      <Button
        type="button"
        variant="outline"
        size="sm"
        :disabled="pending"
        :data-testid="testIds.toolApprovalDeny"
        @click="decide(false)"
      >
        Deny
      </Button>
      <Button
        type="button"
        size="sm"
        :disabled="pending"
        :data-testid="testIds.toolApprovalAllow"
        @click="decide(true)"
      >
        Allow
      </Button>
    </AiConfirmationActions>
  </AiConfirmation>
</template>
