<script setup lang="ts">
// AlertDialog wrapper for destructive confirmations (e.g. "Uninstall {name}?"). The caller owns `open` and
// closes the dialog after its action; while `pending`, the dialog cannot be dismissed.
// Non-prop attributes (e.g. data-testid="plugin-uninstall-confirm") go to the confirm button.
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  pending?: boolean
}>(), {
  confirmLabel: 'Delete',
  cancelLabel: 'Cancel',
  destructive: true,
  pending: false,
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  'confirm': []
}>()

defineSlots<{
  /** Extra body under the description, e.g. a "Keep settings and stored data" checkbox. */
  default?: () => any
}>()

function onOpenChange(value: boolean) {
  if (!value && props.pending)
    return
  emit('update:open', value)
}
</script>

<template>
  <AlertDialog :open="open" @update:open="onOpenChange">
    <AlertDialogContent data-slot="confirm-dialog">
      <AlertDialogHeader>
        <AlertDialogTitle>{{ title }}</AlertDialogTitle>
        <AlertDialogDescription v-if="description">
          {{ description }}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <slot />
      <AlertDialogFooter>
        <AlertDialogCancel :disabled="pending">
          {{ cancelLabel }}
        </AlertDialogCancel>
        <Button
          type="button"
          :variant="destructive ? 'destructive' : 'default'"
          :disabled="pending"
          :aria-busy="pending || undefined"
          v-bind="$attrs"
          @click="emit('confirm')"
        >
          <Spinner v-if="pending" data-icon="inline-start" />
          {{ confirmLabel }}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
