<script setup lang="ts">
// The changes toggle of the chat header (docs/UI.md 2.15, 5.6, 7.21; ADR-037), between ChatProjectChip and `⋯`: a
// ghost icon button (PanelRight) with a count pill of the files this chat changed (workspace.changeCount; hidden at 0,
// "9+" above 9), aria-pressed, aria-controls (the pane or the sheet), the label "Show changes" ("Show changes, 3 files
// changed") or "Hide changes" and a tooltip with Alt+C; 40px on coarse pointers. It renders nothing without a project
// and loads the chat's changes once on mount (W8.8), so the count is right before the panel opens.
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): props below, no emits; root changes-toggle (data-state = open |
// closed, data-count). Stub (C20, P8-0b): toggles the shared panel state; no fetch, no pill, no shortcut yet.
import { PanelRightIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useChangesPanel } from '~/composables/useChangesPanel'
import { useWorkspaceStore } from '~/stores/workspace'
import { testIds } from '~/utils/testids'

const props = defineProps<{
  chatId: string
  /** The chat's project; null renders nothing. */
  projectId: string | null
}>()

const panel = useChangesPanel()
const workspace = useWorkspaceStore()

const open = computed(() => panel.open.value)
const count = computed(() => workspace.changeCount(props.chatId))
const label = computed(() => (open.value ? 'Hide changes' : 'Show changes'))
</script>

<template>
  <Tooltip v-if="projectId">
    <TooltipTrigger as-child>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        :aria-label="label"
        :aria-pressed="open"
        :data-testid="testIds.changesToggle"
        :data-state="open ? 'open' : 'closed'"
        :data-count="count"
        class="text-muted-foreground hover:text-foreground pointer-coarse:size-10"
        @click="panel.toggle()"
      >
        <PanelRightIcon />
      </Button>
    </TooltipTrigger>
    <TooltipContent side="bottom">
      {{ label }}
    </TooltipContent>
  </Tooltip>
</template>
