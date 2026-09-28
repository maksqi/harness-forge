<script setup lang="ts">
// Drag-and-drop overlay over the chat pane (docs/UI.md 7.7): dashed ring inset, "Drop files to attach". Rendered in
// <body> with the pane's viewport rectangle so no ancestor can clip or offset it; it never takes pointer events,
// so the document keeps receiving the drag.
import type { DropZoneRect } from '~/composables/useComposerDropZone'
import { FileUpIcon } from '@lucide/vue'
import { computed } from 'vue'
import { testIds } from '~/utils/testids'

const props = defineProps<{
  active: boolean
  rect: DropZoneRect | null
}>()

const style = computed(() => {
  const rect = props.rect
  if (!rect)
    return { inset: '0px' }
  return { top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px` }
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="active"
      :data-testid="testIds.composerDropOverlay"
      class="pointer-events-none fixed z-40 p-3 animate-in fade-in-0 duration-(--duration-fast)"
      :style="style"
    >
      <div class="flex size-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-ring bg-background/85 text-sm font-medium text-foreground">
        <FileUpIcon aria-hidden="true" class="size-6 text-primary" />
        Drop files to attach
        <span class="text-xs font-normal text-muted-foreground">Images, PDFs and text files up to 20 MB</span>
      </div>
    </div>
  </Teleport>
</template>
