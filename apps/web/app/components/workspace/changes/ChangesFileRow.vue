<script setup lang="ts">
// One file of the changes panel (docs/UI.md 2.15, 7.21): an accordion row whose button (aria-expanded, aria-controls)
// shows the 16px status tile (statusTile), the path in mono (truncated from the start; a rename reads
// `{origPath} → {path}`), `+a −d` (This chat, when known), the "changed outside this chat" mark and Revert file
// (changes-file-revert, Undo2, "Revert {path}"; not for a row that is not revertible), then ChangesFileDiff while open.
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): props and emits below; root changes-file (data-path, data-status,
// data-state = open | closed, data-conflict = true when the file changed outside this chat). Stub (C20, P8-0b): the
// path button, Revert and the diff, without the tile, the counts or the styling of W8.8.
import type { ChangesRow, ChangesView } from './changes-rows'
import { Undo2Icon } from '@lucide/vue'
import { useId } from 'vue'
import { Button } from '@/components/ui/button'
import { testIds } from '~/utils/testids'
import ChangesFileDiff from './ChangesFileDiff.vue'

const props = defineProps<{
  chatId: string
  view: ChangesView
  row: ChangesRow
  /** The row is expanded (its diff loads). */
  open: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  /** Revert file was clicked (the panel opens the RevertFileDialog). */
  'revert': [row: ChangesRow]
}>()

const diffId = useId()

function toggle() {
  emit('update:open', !props.open)
}
</script>

<template>
  <div
    :data-testid="testIds.changesFile"
    :data-path="row.path"
    :data-status="row.status"
    :data-state="open ? 'open' : 'closed'"
    :data-conflict="row.changedOutside ? 'true' : undefined"
    class="flex min-w-0 flex-col"
  >
    <div class="flex min-w-0 items-center gap-1">
      <button
        type="button"
        :aria-expanded="open"
        :aria-controls="open ? diffId : undefined"
        :title="row.path"
        class="min-w-0 flex-1 truncate rounded-sm px-1 text-left font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        @click="toggle"
      >
        {{ row.origPath ? `${row.origPath} → ${row.path}` : row.path }}
      </button>
      <Button
        v-if="row.revertible"
        type="button"
        variant="ghost"
        size="icon-xs"
        :aria-label="`Revert ${row.path}`"
        :data-testid="testIds.changesFileRevert"
        :data-path="row.path"
        class="text-muted-foreground hover:text-foreground pointer-coarse:size-10"
        @click="emit('revert', row)"
      >
        <Undo2Icon class="size-3.5" />
      </Button>
    </div>
    <div v-if="open" :id="diffId">
      <ChangesFileDiff :chat-id="chatId" :view="view" :path="row.path" />
    </div>
  </div>
</template>
