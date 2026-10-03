<script setup lang="ts">
// The toast after a rewind (docs/UI.md 7.22, 15): "Restored {n} files" with the skipped lines below it and Undo
// (toast-undo) when the rewind wrote something; also the toast of that undo (no button). Rendered by vue-sonner through
// `toast.custom()` so the button can carry its data-testid, styled like the app's other toasts (popover tokens).
// vue-sonner passes `isPaused` and a `closeToast` listener to custom toasts.
import { HistoryIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { testIds } from '~/utils/testids'

withDefaults(defineProps<{
  title: string
  /** Description lines ("Skipped 2 files changed outside this chat"). */
  lines?: readonly string[]
  /** Offer Undo. */
  undoable?: boolean
  isPaused?: boolean
}>(), {
  lines: () => [],
  undoable: false,
  isPaused: false,
})

const emit = defineEmits<{
  undo: []
  closeToast: []
}>()

function undo() {
  emit('undo')
  emit('closeToast')
}
</script>

<template>
  <div
    data-slot="rewind-result-toast"
    class="flex w-(--width) items-center gap-3 rounded-2xl border border-border bg-popover py-2.5 pr-2.5 pl-4 text-[13px] text-popover-foreground shadow-lg"
  >
    <HistoryIcon aria-hidden="true" class="size-4 shrink-0 self-start mt-0.5 text-muted-foreground" />
    <div class="grid min-w-0 flex-1 gap-0.5">
      <span class="truncate font-medium">{{ title }}</span>
      <span v-for="line in lines" :key="line" class="text-muted-foreground">{{ line }}</span>
    </div>
    <Button
      v-if="undoable"
      type="button"
      size="xs"
      variant="secondary"
      :data-testid="testIds.toastUndo"
      class="px-2.5 pointer-coarse:h-10"
      @click="undo"
    >
      Undo
    </Button>
  </div>
</template>
