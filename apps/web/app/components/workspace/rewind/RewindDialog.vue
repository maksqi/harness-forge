<script setup lang="ts">
// "Rewind files to here?" (docs/UI.md 2.15, 7.22; ADR-036), owned by ChatView like the delete-version dialog: opening
// it loads `GET /api/chats/:id/rewind?messageId=` (aborted when it closes; a skeleton meanwhile) and lists the files
// (rewind-file: data-path, data-action = restore | delete | unavailable, data-conflict), the force checkbox
// (rewind-force) when a file changed outside this chat, "Shell changes aren't tracked." and the commands that ran
// (rewind-shell-command); Cancel · Restore files and edit (rewind-restore-edit) · Restore files (rewind-restore) ->
// `POST /api/chats/:id/rewind`, then the result toast with Undo (workspace.undo) and `restored`; inline errors
// (rewind-error, data-code). The preview and apply are one-shot calls (useApi()); ChatView calls
// transcript.startEdit(messageId) after `restored(…, 'edit')`.
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): props and emits below; root rewind-dialog (data-state = loading |
// ready | empty | error | restoring) on the wrapper of the dialog's content (reka owns the DialogContent's own
// data-state open | closed, which drives its animations). Stub (C20, P8-0b): the title, the text and Cancel; nothing
// is loaded yet. Closed by default (ChatView opens it with a message id).
import type { RestoreResult } from '@harness-forge/shared'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { testIds } from '~/utils/testids'

defineProps<{
  open: boolean
  chatId: string
  /** The user message to rewind the files to; null while closed. */
  messageId: string | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  /** After a restore: `then` = 'edit' for "Restore files and edit" (ChatView opens the editor on the message). */
  'restored': [result: RestoreResult, then: 'none' | 'edit']
}>()
</script>

<template>
  <Dialog :open="open && messageId !== null" @update:open="emit('update:open', $event)">
    <DialogContent class="max-h-[90dvh] w-[calc(100vw-1rem)] max-w-lg overflow-y-auto">
      <div :data-testid="testIds.rewindDialog" data-state="loading" class="grid min-w-0 gap-6">
        <DialogHeader>
          <DialogTitle>Rewind files to here?</DialogTitle>
          <DialogDescription>
            Files the agent changed after this message go back to how they were before it. The conversation stays as it
            is.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline" class="pointer-coarse:h-10">
              Cancel
            </Button>
          </DialogClose>
        </DialogFooter>
      </div>
    </DialogContent>
  </Dialog>
</template>
