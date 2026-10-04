<script setup lang="ts">
// The "Deleted {name}" toast of the Customize page (docs/UI.md 9.12, 15) with its Undo button (toast-undo), rendered by
// vue-sonner through `toast.custom()` so the button can carry its data-testid. Styled like the app's other toasts
// (popover tokens). vue-sonner passes `isPaused` and a `closeToast` listener to custom toasts.
import { Trash2Icon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { testIds } from '~/utils/testids'

withDefaults(defineProps<{
  title: string
  isPaused?: boolean
}>(), {
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
    data-slot="customization-deleted-toast"
    class="flex w-(--width) items-center gap-3 rounded-2xl border border-border bg-popover py-2.5 pr-2.5 pl-4 text-[13px] text-popover-foreground shadow-lg"
  >
    <Trash2Icon aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" />
    <span class="min-w-0 flex-1 truncate font-medium">{{ title }}</span>
    <Button
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
