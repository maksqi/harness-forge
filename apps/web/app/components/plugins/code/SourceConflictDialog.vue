<script setup lang="ts">
// A save answered `409 conflict` (`stale`): the file changed on the server after it was opened (another tab, the file
// system). The user keeps editing, loads the server version (dropping the edits) or overwrites it.
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

const props = withDefaults(defineProps<{
  open: boolean
  path: string
  pending?: boolean
}>(), {
  pending: false,
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  'reload': []
  'overwrite': []
}>()

function onOpenChange(value: boolean) {
  if (!value && props.pending)
    return
  emit('update:open', value)
}
</script>

<template>
  <AlertDialog :open="open" @update:open="onOpenChange">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>The file changed on the server</AlertDialogTitle>
        <AlertDialogDescription>
          {{ path }} was changed after you opened it. Load the server version (your edits are dropped) or overwrite it
          with your version.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel :disabled="pending">
          Keep editing
        </AlertDialogCancel>
        <Button type="button" variant="outline" :disabled="pending" @click="emit('reload')">
          Load server version
        </Button>
        <Button type="button" variant="destructive" :disabled="pending" :aria-busy="pending || undefined" @click="emit('overwrite')">
          <Spinner v-if="pending" data-icon="inline-start" />
          Overwrite
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
