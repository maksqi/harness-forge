<script setup lang="ts">
// The changes toggle of the chat header (docs/UI.md 2.15, 5.6, 7.21, 14.2; ADR-037), between ChatProjectChip and `⋯`: a
// ghost icon button (PanelRight) with a count pill of the files this chat changed (workspace.changeCount; hidden at 0,
// "9+" above 9), aria-pressed, aria-controls (the pane or the sheet, while open), the label "Show changes" ("Show
// changes, 3 files changed") or "Hide changes" and a tooltip with Alt+C; 40px on coarse pointers. A click keeps focus
// on the toggle. It renders nothing without a project and loads the chat's changes on mount (again when the chat moves
// to another project), so the count is right before the panel opens.
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): props below, no emits; root changes-toggle (data-state = open |
// closed, data-count).
import { PanelRightIcon } from '@lucide/vue'
import { computed, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import KbdCombo from '~/components/common/KbdCombo.vue'
import { CHANGES_SHORTCUT_KEYS, useChangesPanel } from '~/composables/useChangesPanel'
import { useWorkspaceStore } from '~/stores/workspace'
import { testIds } from '~/utils/testids'
import { CHANGES_PANEL_ID } from './changes-rows'

const props = defineProps<{
  chatId: string
  /** The chat's project; null renders nothing. */
  projectId: string | null
}>()

const panel = useChangesPanel()
const workspace = useWorkspaceStore()

const open = computed(() => panel.open.value)
const count = computed(() => workspace.changeCount(props.chatId))
const pill = computed(() => (count.value > 9 ? '9+' : String(count.value)))
const label = computed(() => {
  if (open.value)
    return 'Hide changes'
  if (count.value === 0)
    return 'Show changes'
  return `Show changes, ${count.value} ${count.value === 1 ? 'file' : 'files'} changed`
})

watch(() => [props.chatId, props.projectId] as const, ([chatId, projectId], before) => {
  if (!projectId)
    return
  // A chat that moved to another project: the earlier answer describes another folder.
  const moved = before !== undefined && before[0] === chatId && before[1] !== projectId
  void workspace.fetchChatChanges(chatId, { force: moved })
}, { immediate: true })
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
        :aria-controls="open ? CHANGES_PANEL_ID : undefined"
        :data-testid="testIds.changesToggle"
        :data-state="open ? 'open' : 'closed'"
        :data-count="count"
        class="relative text-muted-foreground hover:text-foreground aria-pressed:text-foreground pointer-coarse:size-10"
        @click="panel.toggle()"
      >
        <PanelRightIcon />
        <span
          v-if="count > 0"
          aria-hidden="true"
          data-slot="changes-count"
          class="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none font-semibold text-primary-foreground tabular-nums"
        >
          {{ pill }}
        </span>
      </Button>
    </TooltipTrigger>
    <TooltipContent side="bottom">
      {{ open ? 'Hide changes' : 'Show changes' }}
      <KbdCombo :keys="CHANGES_SHORTCUT_KEYS" class="max-lg:hidden pointer-coarse:hidden" />
    </TooltipContent>
  </Tooltip>
</template>
