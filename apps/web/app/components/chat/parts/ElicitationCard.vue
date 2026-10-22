<script setup lang="ts">
// An MCP server's question under its running tool row (Phase 14, ADR-060; docs/UI.md 2.20, 7.35, 10.10, 14): a `<form>`
// in a `role="region"` named "{server} needs more information": the countdown to `expiresAt`, × "Dismiss request"
// (cancel), the message as plain text (never Markdown or links: it is untrusted), one field per form field
// (`elicitation-field`, `data-name`, `data-type`), the caution "Share only what you would give {server}. Never enter
// passwords here.", Decline and Submit. `busy` = the answer is being posted (`submitting`); `issues` = a 400 answer's
// field issues; `gone` = "This request is no longer open.". Never takes focus by itself; `focusFirst()` (the jump pill)
// focuses the first field, else Submit. ToolPart renders it through TOOL_ELICITATIONS.
// Props, emits, the exposed `focusFirst` and the root test id are frozen from Gate P14-0b (C54 stub); W14.9 implements the
// card in P14-A (`parseElicitationForm`'s fields, `elicitationInitialValues`, `coerceElicitationValue`,
// `validateElicitationAnswer`, `isSensitiveField` of `@harness-forge/shared`).
import type { ElicitationFieldIssue, McpElicitation, McpElicitationAnswerBody } from '@harness-forge/shared'
import { MessageCircleQuestionIcon } from '@lucide/vue'
import { computed, useId, useTemplateRef } from 'vue'
import { testIds } from '~/utils/testids'

const props = withDefaults(defineProps<{
  request: McpElicitation
  /** The answer is being posted (`data-state="submitting"`). */
  busy?: boolean
  /** A 400 answer's field issues. */
  issues?: readonly ElicitationFieldIssue[]
  /** A 'gone' answer: "This request is no longer open.". */
  gone?: boolean
}>(), {
  busy: false,
  issues: () => [],
  gone: false,
})

defineEmits<{
  respond: [answer: McpElicitationAnswerBody]
}>()

const headingId = useId()
const root = useTemplateRef<HTMLElement>('root')
const state = computed(() => (props.busy ? 'submitting' : 'pending'))

/** Focuses the first field, else Submit (the jump pill). */
function focusFirst(): void {
  root.value?.querySelector<HTMLElement>('input, select, textarea, button')?.focus()
}

defineExpose({ focusFirst })
</script>

<template>
  <section
    ref="root"
    role="region"
    :aria-labelledby="headingId"
    :aria-busy="busy ? 'true' : undefined"
    :data-testid="testIds.elicitationCard"
    :data-state="state"
    :data-server-id="request.serverId"
    class="rounded-lg border bg-card p-3 text-sm"
  >
    <h4 :id="headingId" class="flex items-center gap-2 font-medium">
      <MessageCircleQuestionIcon aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" />
      <span class="min-w-0 truncate">{{ request.serverName }} needs more information</span>
    </h4>
    <p :data-testid="testIds.elicitationMessage" class="mt-2 break-words whitespace-pre-wrap text-muted-foreground">
      {{ request.message }}
    </p>
  </section>
</template>
