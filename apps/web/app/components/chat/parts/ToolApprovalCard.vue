<script setup lang="ts">
// Approval card under a tool row (docs/UI.md 2.14, 7.3): "Allow {tool}?" with the source plugin, the arguments, "Always
// allow {tool}" and Deny / Allow. The decision goes up (ChatView answers through the session); the card disappears
// into the row status once the part leaves `approval-requested`. Nothing approves implicitly (no Enter handling).
// Phase 7 (ADR-032, ADR-033): a workspace tool shows ToolApprovalPreview instead of the JSON block; a shell command
// reads "Run this command?" with Deny / Run; tools with workspace access `execute` never offer "Always allow"; tools
// with access `write` offer "Accept all edits in this chat" instead (tool-approval-accept-edits; the decision carries
// `acceptEdits`, and the session switches the chat to `edits` before answering), unless the chat already accepts edits
// (TOOL_APPROVAL_CONTEXT, when a chat view provides it).
// Phase 8 (ADR-038; C20 declares the payload, W8.10 mounts AllowRuleOption): the command card of a tool with workspace
// access `execute` (the builtin shell) shows "Always allow commands starting with" below the warning; Run with it
// checked carries `allowRules` (the shell rules the session creates before the approval is sent; Deny ignores it), and
// Run is disabled while the box is checked with an invalid prefix.
// Phase 11 (ADR-048; C39 declares the prop, W11.12 implements the banner; frozen from Gate P11-0b): `hookReason` = the
// reason of a PreToolUse hook that answered `ask` (the call's `asked` hook record; '' when the hook gave none): the banner
// "A hook asks you to confirm this call: {reason}" (`tool-approval-hook`, `Webhook`, text inside the card's group) under
// the card's title, above the arguments and the buttons.
import type { WorkspaceAccess } from '@harness-forge/shared'
import type { ToolPartLike } from '../chat-format'
import type { AllowRules } from '~/components/workspace/allowlist/allow-rule'
import { WebhookIcon } from '@lucide/vue'
import { computed, inject, ref, useId } from 'vue'
import {
  Confirmation as AiConfirmation,
  ConfirmationActions as AiConfirmationActions,
  ConfirmationRequest as AiConfirmationRequest,
} from '@/components/ai-elements/confirmation'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import AllowRuleOption from '~/components/workspace/allowlist/AllowRuleOption.vue'
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
  /**
   * + Phase 11 (C39 declares it, W11.12 uses it): the reason of a PreToolUse hook that asked for this confirmation
   * (`tool-approval-hook` banner); null = no hook asked.
   */
  hookReason?: string | null
}>(), {
  workspace: null,
  hookReason: null,
})

const emit = defineEmits<{
  /**
   * + Phase 7: `acceptEdits` = "Accept all edits in this chat". + Phase 8: `allowRules` = "Always allow commands
   * starting with" (the builtin shell; W8.10).
   */
  decide: [decision: { approved: boolean, alwaysAllow: boolean, acceptEdits?: boolean, allowRules?: AllowRules }]
}>()

const context = inject(TOOL_APPROVAL_CONTEXT, null)

const checked = ref<boolean | 'indeterminate'>(false)
const pending = ref(false)
const checkboxId = useId()
const args = computed(() => formatToolValue(props.part.input) || '{}')

const previewKind = computed(() => workspaceApprovalKind(props.toolName, props.part.input))
const isCommand = computed(() => previewKind.value === 'terminal')
const label = computed(() => toolApprovalLabel(props.toolName, props.part.input))
/** + Phase 11: the hook banner ("A hook asks you to confirm this call: {reason}"; no colon without a reason). */
const hookBanner = computed(() => {
  const reason = props.hookReason?.trim()
  return reason ? `A hook asks you to confirm this call: ${reason}` : 'A hook asks you to confirm this call'
})

/** "Always allow commands starting with" (Phase 8): the command card of an `execute` tool (the builtin shell). */
const offersRule = computed(() => isCommand.value && props.workspace === 'execute')
const command = computed(() => {
  const input = props.part.input
  const value = typeof input === 'object' && input !== null ? (input as Record<string, unknown>).command : undefined
  return typeof value === 'string' ? value : ''
})
/** The rules to create with Run (null = the box is unchecked) and whether their prefix is valid. */
const allowRules = ref<AllowRules | null>(null)
const ruleValid = ref(true)
const runBlocked = computed(() => offersRule.value && allowRules.value !== null && !ruleValid.value)

/** Which checkbox the card offers: none for `execute` (and for `write` in a chat that already accepts edits). */
const option = computed<'always' | 'accept-edits' | null>(() => {
  if (props.workspace === 'execute')
    return null
  if (props.workspace === 'write')
    return context?.toolMode() === 'edits' ? null : 'accept-edits'
  return 'always'
})

function decide(approved: boolean) {
  if (pending.value || (approved && runBlocked.value))
    return
  pending.value = true
  const isChecked = approved && checked.value === true
  if (option.value === 'accept-edits')
    emit('decide', { approved, alwaysAllow: false, acceptEdits: isChecked })
  else if (approved && offersRule.value && allowRules.value !== null)
    emit('decide', { approved, alwaysAllow: false, allowRules: { prefixes: [...allowRules.value.prefixes], scope: allowRules.value.scope } })
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
      <p
        v-if="hookReason !== null"
        :data-testid="testIds.toolApprovalHook"
        class="flex min-w-0 items-start gap-2 rounded-md bg-muted/60 px-2.5 py-2 text-sm"
      >
        <WebhookIcon aria-hidden="true" class="mt-[3px] size-3.5 shrink-0 text-muted-foreground" />
        <span class="min-w-0 break-words whitespace-pre-wrap">{{ hookBanner }}</span>
      </p>
      <ToolApprovalPreview v-if="previewKind" :tool-name="toolName" :input="part.input" />
      <AllowRuleOption
        v-if="offersRule"
        v-model="allowRules"
        :command="command"
        :disabled="pending"
        @valid="ruleValid = $event"
      />
      <pre v-if="!previewKind" class="max-h-48 overflow-auto rounded-md bg-muted/60 p-2.5 font-mono text-xs whitespace-pre-wrap break-words">{{ args }}</pre>
      <div v-if="option" class="flex min-h-6 items-center gap-2 pointer-coarse:min-h-10">
        <Checkbox
          :id="checkboxId"
          v-model="checked"
          class="pointer-coarse:after:-inset-[13px]"
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
        :disabled="pending || runBlocked"
        :data-testid="testIds.toolApprovalAllow"
        class="pointer-coarse:h-10"
        @click="decide(true)"
      >
        {{ isCommand ? 'Run' : 'Allow' }}
      </Button>
    </AiConfirmationActions>
  </AiConfirmation>
</template>
