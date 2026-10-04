<script setup lang="ts">
// The plan file of an approved `exit_plan_mode` call (docs/UI.md 7.25, 10.7, 14.2; ADR-047). ToolPart renders it first
// in the body of the row (the share page shows no chip).
// - saved (`planPath`; `data-state="saved"`, `data-path`): "Saved to" and a mono path chip (`FileText`, the folder cut in
//   the middle so the file name stays visible, the full path in a tooltip; its accessible name is "Plan saved to
//   {path}"), Copy path, and in a project chat Show changes (opens the changes panel on its "This chat" view through
//   useChangesPanel, focused; the file is journaled under the reply);
// - failed (`planError`; `data-state="failed"`): a warning line "Couldn't save the plan file: {error}";
// - neither: nothing.
// Props and the root test id are frozen from Gate P10-0b (C33).
import { FileTextIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import CopyButton from '~/components/common/CopyButton.vue'
import { useChangesPanel } from '~/composables/useChangesPanel'
import { testIds } from '~/utils/testids'

const props = defineProps<{ planPath: string | null, planError: string | null, projectChat: boolean }>()

/** The folder (with its trailing slash) and the file name: the folder is the part that gets cut. */
const pathParts = computed(() => {
  const path = props.planPath ?? ''
  const slash = path.lastIndexOf('/')
  return slash === -1 ? { folder: '', file: path } : { folder: path.slice(0, slash + 1), file: path.slice(slash + 1) }
})

function showChanges() {
  const panel = useChangesPanel()
  panel.view.value = 'chat'
  panel.setOpen(true, { focus: true })
}
</script>

<template>
  <div
    v-if="planPath"
    :data-testid="testIds.planFile"
    data-state="saved"
    :data-path="planPath"
    class="mb-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm"
  >
    <span class="shrink-0 text-muted-foreground">Saved to</span>
    <Tooltip>
      <TooltipTrigger as-child>
        <span
          data-slot="plan-file-path"
          tabindex="0"
          class="inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md border bg-card px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span class="sr-only">Plan saved to {{ planPath }}</span>
          <FileTextIcon aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
          <span v-if="pathParts.folder" aria-hidden="true" class="min-w-0 truncate text-muted-foreground">{{ pathParts.folder }}</span>
          <span aria-hidden="true" class="shrink-0">{{ pathParts.file }}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent class="font-mono">
        {{ planPath }}
      </TooltipContent>
    </Tooltip>
    <CopyButton :text="planPath" label="Copy path" data-slot="plan-file-copy" />
    <button
      v-if="projectChat"
      type="button"
      data-slot="plan-file-show-changes"
      class="flex h-7 shrink-0 items-center rounded-sm px-1 text-xs font-medium text-muted-foreground underline decoration-primary/60 underline-offset-2 outline-none hover:text-foreground hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:h-10"
      @click="showChanges"
    >
      Show changes
    </button>
  </div>
  <p
    v-else-if="planError"
    :data-testid="testIds.planFile"
    data-state="failed"
    class="mb-2 flex min-w-0 items-start gap-1.5 text-sm text-warning"
  >
    <TriangleAlertIcon aria-hidden="true" class="mt-0.5 size-3.5 shrink-0" />
    <span class="min-w-0 break-words">Couldn't save the plan file: {{ planError }}</span>
  </p>
</template>
