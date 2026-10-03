<script setup lang="ts">
// Approval preview of a workspace tool call (docs/UI.md 2.14, 7.3, 7.19; ADR-032): replaces the JSON block of
// ToolApprovalCard. `edit_file` -> a DiffView of diffLines(old_string, new_string); `write_file` -> "Create or
// overwrite {path} · {n} lines" + a 20-line FileContent; `shell` -> the command card with a warning.
// Contract (docs/UI.md 10.4): props below, no emits; root tool-approval-preview (data-kind = diff | content |
// command); renders nothing when workspaceApprovalView(toolName, input) is null (the card then keeps its JSON block).
// Stub (C15, P7-0b): implemented by W7.11 in P7-A; props are frozen. workspaceApprovalView is still a stub that
// returns null, so this renders nothing yet.
import type { WorkspaceToolView } from './workspace-tools'
import { computed } from 'vue'
import { testIds } from '~/utils/testids'
import { workspaceApprovalView } from './workspace-tools'

const props = defineProps<{
  toolName: string
  input: unknown
}>()

const KIND_OF_VIEW: Record<WorkspaceToolView['kind'], 'diff' | 'content' | 'command' | null> = {
  diff: 'diff',
  file: 'content',
  terminal: 'command',
  list: null,
}

const kind = computed(() => {
  const view = workspaceApprovalView(props.toolName, props.input)
  return view ? KIND_OF_VIEW[view.kind] : null
})
</script>

<template>
  <div
    v-if="kind"
    :data-testid="testIds.toolApprovalPreview"
    :data-kind="kind"
    class="flex flex-col gap-2"
  />
</template>
