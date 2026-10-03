<script setup lang="ts">
// Approval card under a tool row (docs/UI.md 2.14, 7.3): "Allow {tool}?" with the source plugin, the arguments, "Always
// allow {tool}" and Deny / Allow. The decision goes up (ChatView answers through the session); the card disappears
// into the row status once the part leaves `approval-requested`. Nothing approves implicitly (no Enter handling).
// Phase 7 (ADR-032, ADR-033): a workspace tool shows ToolApprovalPreview instead of the JSON block; a shell command
// reads "Run this command?" with Deny / Run; tools with workspace access `execute` never offer "Always allow"; tools
// with access `write` offer "Accept all edits in this chat" instead (tool-approval-accept-edits; the decision carries
// `acceptEdits`, and the session switches the chat to `edits` before answering), unless the chat already accepts edits
// (TOOL_APPROVAL_CONTEXT, when a chat view provides it).
import type { WorkspaceAccess } from '@harness-forge/shared'
import type { ToolPartLike } from '../chat-format'
import { computed, inject, ref, useId } from 'vue'
import {
  Confirmation as AiConfirmation,
  ConfirmationActions as AiConfirmationActions,
  ConfirmationRequest as AiConfirmationRequest,
} from '@/components/ai-elements/confirmation'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { testIds } from '~/utils/testids'
import { formatToolValue } from '../chat-format'
import { TOOL_APPROVAL_CONTEXT } from './tool-approval-context'
import { toolApprovalLabel } from './tool-row'
import ToolApprovalPreview from './tools/ToolApprovalPreview.vue'
import { workspaceApprovalKind } from './tools/workspace-tools'

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

const context = inject(TOOL_APPROVAL_CONTEXT, null)

const checked = ref<boolean | 'indeterminate'>(false)
const pending = ref(false)
const checkboxId = useId()
const args = computed(() => formatToolValue(props.part.input) || '{}')

const previewKind = computed(() => workspaceApprovalKind(props.toolName, props.part.input))
const isCommand = computed(() => previewKind.value === 'terminal')
const label = computed(() => toolApprovalLabel(props.toolName, props.part.input))

/** Which checkbox the card offers: none for `execute` (and for `write` in a chat that already accepts edits). */
const option = computed<'always' | 'accept-edits' | null>(() => {
  if (props.workspace === 'execute')
    return null
  if (props.workspace === 'write')
    return context?.toolMode() === 'edits' ? null : 'accept-edits'
  return 'always'
})

function decide(approved: boolean) {
  if (pending.value)
    return
  pending.value = true
  const isChecked = approved && checked.value === true
  if (option.value === 'accept-edits')
    emit('decide', { approved, alwaysAllow: false, acceptEdits: isChecked })
  else
    emit('decide', { approved, alwaysAllow: option.value === 'always' && isChecked })
}
</script>

<template>
  <AiConfirmation
    v-if="part.state === 'approval-requested'"
    :approval="part.approval"
    :state="part.state"
    role="group"
    :aria-label="label"
    :data-testid="testIds.toolApproval"
    :data-tool-name="toolName"
    class="min-w-0 gap-3 border-warning/50 bg-warning/5 px-3.5 py-3 text-foreground dark:bg-warning/10"
  >
    <AiConfirmationRequest>
      <div class="flex items-start justify-between gap-3">
        <p v-if="isCommand" class="min-w-0 text-sm font-semibold">
          Run this command?
        </p>
        <p v-else class="min-w-0 text-sm">
          Allow <span class="font-mono font-semibold break-all">{{ toolName }}</span>?
        </p>
        <span v-if="source" class="shrink-0 text-xs text-muted-foreground">from {{ source }}</span>
      </div>
      <ToolApprovalPreview v-if="previewKind" :tool-name="toolName" :input="part.input" />
      <pre v-else class="max-h-48 overflow-auto rounded-md bg-muted/60 p-2.5 font-mono text-xs whitespace-pre-wrap break-words">{{ args }}</pre>
      <div v-if="option" class="flex min-h-6 items-center gap-2 pointer-coarse:min-h-10">
        <Checkbox
          :id="checkboxId"
          v-model="checked"
          :disabled="pending"
          :data-testid="option === 'accept-edits' ? testIds.toolApprovalAcceptEdits : testIds.toolApprovalAlways"
        />
        <label v-if="option === 'accept-edits'" :for="checkboxId" class="text-sm select-none">
          Accept all edits in this chat
        </label>
        <label v-else :for="checkboxId" class="text-sm select-none">
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
        class="pointer-coarse:h-10"
        @click="decide(false)"
      >
        Deny
      </Button>
      <Button
        type="button"
        size="sm"
        :disabled="pending"
        :data-testid="testIds.toolApprovalAllow"
        class="pointer-coarse:h-10"
        @click="decide(true)"
      >
        {{ isCommand ? 'Run' : 'Allow' }}
      </Button>
    </AiConfirmationActions>
  </AiConfirmation>
</template>
