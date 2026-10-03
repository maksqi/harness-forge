<script setup lang="ts">
// The changes panel (docs/UI.md 2.15, 7.21; ADR-036, ADR-037): an h-12 header (the h2 "Changes" that labels the pane,
// the Tabs This chat | Git (changes-view-option, data-value), Refresh (changes-refresh) and Close (changes-close)), the
// summary line (changes-summary, data-count), the rows (ChangesFileRow) or ChangesEmpty, the error alert
// (changes-error, data-code) and the footer notes; one scroll area. It owns the RevertFileDialog. Used as the desktop
// pane (`variant="pane"`, inside ChatWorkspace's <aside>) and inside the right sheet below 1024px (`variant="sheet"`).
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): props and emits below; root changes-panel (data-view = chat |
// git, data-state = loading | ready | error | unavailable). Stub (C20, P8-0b): the header with the title and Close.
import { XIcon } from '@lucide/vue'
import { useId } from 'vue'
import { Button } from '@/components/ui/button'
import { useChangesPanel } from '~/composables/useChangesPanel'
import { testIds } from '~/utils/testids'

defineProps<{
  chatId: string
  projectId: string
  variant: 'pane' | 'sheet'
}>()

const emit = defineEmits<{
  /** Close was clicked (the caller closes the panel and returns focus to the toggle). */
  close: []
}>()

const panel = useChangesPanel()
const headingId = useId()
</script>

<template>
  <div
    :data-testid="testIds.changesPanel"
    :data-view="panel.view.value"
    data-state="loading"
    class="flex min-h-0 min-w-0 flex-1 flex-col"
  >
    <div class="flex h-(--header-height) shrink-0 items-center gap-2 border-b px-4">
      <h2 :id="headingId" class="min-w-0 flex-1 truncate text-sm font-medium">
        Changes
      </h2>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Close changes"
        :data-testid="testIds.changesClose"
        class="-mr-2 text-muted-foreground hover:text-foreground pointer-coarse:size-10"
        @click="emit('close')"
      >
        <XIcon />
      </Button>
    </div>
  </div>
</template>
