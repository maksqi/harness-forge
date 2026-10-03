<script setup lang="ts">
// One file of the changes panel (docs/UI.md 2.15, 7.21, 14.2): an accordion row whose button (aria-expanded,
// aria-controls) shows the 16px status tile (statusTile: the letter in text-foreground on a tint, with sr-only text),
// the path in mono (truncated from the start, the full path in `title`; a rename reads `{origPath} → {path}`), `+a −d`
// (This chat, when known; read as diffStatsLabel) and the "changed outside this chat" mark (TriangleAlert), then Revert
// file (changes-file-revert, Undo2, "Revert {path}"; shown on hover or focus-within and always on coarse pointers at
// 40px; not for a row that is not revertible), then ChangesFileDiff while open.
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): props and emits below; root changes-file (data-path, data-status,
// data-state = open | closed, data-conflict = true when the file changed outside this chat).
import type { ChangesRow, ChangesStatus, ChangesView } from './changes-rows'
import { ChevronRightIcon, TriangleAlertIcon, Undo2Icon } from '@lucide/vue'
import { computed, useId } from 'vue'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { diffStatsLabel, MINUS_SIGN } from '~/components/chat/parts/tools/workspace-tools'
import { testIds } from '~/utils/testids'
import { rowLabel, statusTile } from './changes-rows'
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
/** U+200E LEFT-TO-RIGHT MARK: keeps a leading dot (`.github/…`) in place inside the right-to-left truncation. */
const LRM = '\u200E'

/** The tints of the status tiles (docs/UI.md 7.21; the letter stays text-foreground for contrast, 14.3). */
const TILE_CLASS: Record<ChangesStatus, string> = {
  added: 'bg-success/15',
  modified: 'bg-warning/15',
  deleted: 'bg-destructive/15',
  untracked: 'bg-muted',
  renamed: 'bg-info/15',
  conflicted: 'bg-destructive/15',
  typechange: 'bg-muted',
}

const tile = computed(() => statusTile(props.row.status))
const label = computed(() => rowLabel(props.row))
/** `+a −d` when a count is known (This chat). */
const counts = computed(() => {
  const { additions, deletions } = props.row
  if (additions === null && deletions === null)
    return null
  return { additions: additions ?? 0, deletions: deletions ?? 0 }
})

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
    class="group/row flex min-w-0 flex-col"
  >
    <div class="flex min-w-0 items-center gap-0.5 pr-1.5 hover:bg-muted/50">
      <button
        type="button"
        :aria-expanded="open"
        :aria-controls="open ? diffId : undefined"
        :title="label"
        class="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-sm py-1 pl-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-10"
        @click="toggle"
      >
        <ChevronRightIcon
          aria-hidden="true"
          :class="cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--duration-fast) motion-reduce:transition-none', open && 'rotate-90')"
        />
        <span
          data-slot="changes-status"
          :class="cn('flex size-4 shrink-0 items-center justify-center rounded-[3px] font-mono text-[10px] leading-none font-semibold text-foreground', TILE_CLASS[row.status])"
        >
          <span aria-hidden="true">{{ tile.letter }}</span>
          <span class="sr-only">{{ `${tile.label} ` }}</span>
        </span>
        <!-- Truncated from the start: right-to-left overflow with left-to-right marks around the path. -->
        <span class="min-w-0 flex-1 truncate text-left font-mono text-xs [direction:rtl]">{{ `${LRM}${label}${LRM}` }}</span>
        <template v-if="counts">
          <span aria-hidden="true" data-slot="changes-counts" class="flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums">
            <span v-if="counts.additions > 0 || counts.deletions === 0" class="text-success">+{{ counts.additions }}</span>
            <span v-if="counts.deletions > 0" class="text-destructive">{{ MINUS_SIGN }}{{ counts.deletions }}</span>
          </span>
          <span class="sr-only">, {{ diffStatsLabel(counts.additions, counts.deletions) }}</span>
        </template>
        <template v-if="row.changedOutside">
          <TriangleAlertIcon aria-hidden="true" data-slot="changes-conflict" class="size-3.5 shrink-0 text-warning" />
          <span class="sr-only">, changed outside this chat</span>
        </template>
      </button>
      <Button
        v-if="row.revertible"
        type="button"
        variant="ghost"
        size="icon-xs"
        :aria-label="`Revert ${row.path}`"
        :title="`Revert ${row.path}`"
        :data-testid="testIds.changesFileRevert"
        :data-path="row.path"
        class="shrink-0 text-muted-foreground opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 pointer-coarse:size-10 pointer-coarse:opacity-100"
        @click="emit('revert', row)"
      >
        <Undo2Icon class="size-3.5" />
      </Button>
    </div>
    <div v-if="open" :id="diffId" class="min-w-0 px-2 pt-1 pb-2.5">
      <ChangesFileDiff :chat-id="chatId" :view="view" :path="row.path" />
    </div>
  </div>
</template>
