<script setup lang="ts">
// Approval preview of a workspace tool call (docs/UI.md 2.14, 7.3, 7.19; ADR-032): replaces the JSON block of
// ToolApprovalCard. `edit_file` -> a DiffView of diffLines(old_string, new_string) (line numbers off: they would be the
// snippet's, not the file's) with an "All occurrences" badge for `replace_all`; `write_file` -> "Create or overwrite
// {path} · {n} lines" + a 20-line FileContent; `shell` -> the description, the command in a large mono block, "In
// {project}" and the timeout when known, and the warning "Runs on the server with the server user's permissions."
// Phase 8 (ADR-038, W8.10): the meta line uses the sticky folder: "In {project}/{cwd}" where `cwd` is the call's `cwd`
// input, else the chat's current shell folder (TOOL_APPROVAL_CONTEXT.shellCwd()), left out for the project folder.
// Contract (docs/UI.md 10.4): props below, no emits; root tool-approval-preview (data-kind = diff | content |
// command); renders nothing when workspaceApprovalView(toolName, input) is null (the card then keeps its JSON block).
import type { WorkspaceToolView } from './workspace-tools'
import { editFileToolInputSchema, shellToolInputSchema } from '@harness-forge/shared'
import { TriangleAlertIcon } from '@lucide/vue'
import { computed, inject } from 'vue'
import { Badge } from '@/components/ui/badge'
import { testIds } from '~/utils/testids'
import { TOOL_APPROVAL_CONTEXT } from '../tool-approval-context'
import DiffView from './DiffView.vue'
import FileContent from './FileContent.vue'
import { shellFolder, workspaceApprovalView } from './workspace-tools'

const props = defineProps<{
  toolName: string
  input: unknown
}>()

const context = inject(TOOL_APPROVAL_CONTEXT, null)

const KIND_OF_VIEW: Record<WorkspaceToolView['kind'], 'diff' | 'content' | 'command' | null> = {
  diff: 'diff',
  file: 'content',
  terminal: 'command',
  list: null,
}

const view = computed(() => workspaceApprovalView(props.toolName, props.input))
const kind = computed(() => (view.value ? KIND_OF_VIEW[view.value.kind] : null))

const replaceAll = computed(() => {
  if (view.value?.kind !== 'diff')
    return false
  const parsed = editFileToolInputSchema.safeParse(props.input)
  return parsed.success && parsed.data.replace_all === true
})

const shell = computed(() => {
  if (view.value?.kind !== 'terminal')
    return null
  const parsed = shellToolInputSchema.safeParse(props.input)
  if (!parsed.success)
    return null
  const { command, cwd, timeout_ms: timeoutMs, description } = parsed.data
  const project = context?.projectName() ?? null
  // The call's own folder wins (`.` too); else where the chat's previous shell call ended.
  const folder = shellFolder(cwd ?? context?.shellCwd() ?? null)
  const where = project ? `In ${project}${folder ? `/${folder}` : ''}` : folder ? `In ${folder}` : null
  const timeout = timeoutMs === undefined ? null : `timeout ${Math.round(timeoutMs / 1000)}s`
  const meta = [where, timeout].filter((part): part is string => part !== null).join(' · ')
  return { command, description: description?.trim() || null, meta }
})

function lineCount(lines: number): string {
  return `${lines} ${lines === 1 ? 'line' : 'lines'}`
}
</script>

<template>
  <div
    v-if="kind && view"
    :data-testid="testIds.toolApprovalPreview"
    :data-kind="kind"
    class="flex min-w-0 flex-col gap-2"
  >
    <template v-if="view.kind === 'diff'">
      <Badge v-if="replaceAll" variant="secondary" data-slot="replace-all" class="self-start">
        All occurrences
      </Badge>
      <DiffView :hunks="view.hunks" :path="view.path" :line-numbers="false" />
    </template>

    <template v-else-if="view.kind === 'file'">
      <p class="min-w-0 text-sm break-words">
        Create or overwrite <span class="font-mono break-all">{{ view.path }}</span> · {{ lineCount(view.endLine) }}
      </p>
      <FileContent :path="view.path" :content="view.content" :start-line="1" :total-lines="view.totalLines" />
    </template>

    <template v-else-if="shell">
      <p v-if="shell.description" data-slot="command-description" class="min-w-0 text-sm break-words">
        {{ shell.description }}
      </p>
      <pre
        data-slot="command"
        class="max-h-60 min-w-0 overflow-auto rounded-md border bg-muted/60 p-3 font-mono text-sm leading-relaxed whitespace-pre-wrap break-words text-foreground"
      >{{ shell.command }}</pre>
      <p v-if="shell.meta" data-slot="command-meta" class="min-w-0 text-xs break-words text-muted-foreground">
        {{ shell.meta }}
      </p>
      <p data-slot="command-warning" class="flex items-start gap-1.5 text-xs text-foreground">
        <TriangleAlertIcon aria-hidden="true" class="mt-px size-3.5 shrink-0 text-warning" />
        <span>Runs on the server with the server user's permissions.</span>
      </p>
    </template>
  </div>
</template>
