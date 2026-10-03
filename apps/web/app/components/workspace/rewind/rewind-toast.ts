// The result toast of a rewind (docs/UI.md 7.22): "Restored {n} files" (with the skipped lines) and Undo when the answer
// has a `batchId` -> `useWorkspaceStore().undo(chatId, batchId)` (`POST /chats/:id/changes/undo`, conflicts `skip`),
// then the undo's own result toast; a failed undo -> "Couldn't undo the rewind" with the server message. ChatView shows
// it when its RewindDialog emits `restored`. Call `useRewindResultToast()` during setup.
import type { RestoreResult } from '@harness-forge/shared'
import type { RewindResultText } from './rewind'
import { markRaw } from 'vue'
import { toast } from 'vue-sonner'
import { useWorkspaceStore } from '~/stores/workspace'
import { toHarnessError } from '~/utils/errors'
import { rewindResultText } from './rewind'
import RewindResultToast from './RewindResultToast.vue'

/** How long a rewind toast (and its Undo) stays; the batch itself can be undone later from the changes panel. */
export const REWIND_TOAST_MS = 8000

export const REWIND_UNDO_FAILED_TITLE = 'Couldn\'t undo the rewind'

export function useRewindResultToast(): (chatId: string, result: RestoreResult) => void {
  const workspace = useWorkspaceStore()

  function show(text: RewindResultText, onUndo?: () => void): void {
    toast.custom(markRaw(RewindResultToast), {
      duration: REWIND_TOAST_MS,
      componentProps: { title: text.title, lines: text.lines, undoable: onUndo !== undefined, onUndo },
    })
  }

  function undo(chatId: string, batchId: string): void {
    workspace.undo(chatId, batchId)
      .then(answer => show(rewindResultText(answer)))
      .catch(error => toast.error(REWIND_UNDO_FAILED_TITLE, { description: toHarnessError(error).message }))
  }

  return (chatId, result) => {
    const text = rewindResultText(result)
    const batchId = result.batchId
    show(text, batchId !== null ? () => undo(chatId, batchId) : undefined)
  }
}
