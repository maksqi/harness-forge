// The toasts of a revert and of its Undo (docs/UI.md 7.21, 15): "Reverted {path}" with Undo (toast-undo) ->
// `workspace.undo(chatId, batchId)` (conflicts: 'skip') -> "Restored {path}" or "{path} changed after the revert, so it
// was not restored."; the error toasts of a revert (409 run-active / stale, 404, 400) and of an undo.
import type { HarnessError, RestoreResult } from '@harness-forge/shared'
import { markRaw } from 'vue'
import { toast } from 'vue-sonner'
import { useWorkspaceStore } from '~/stores/workspace'
import { toHarnessError } from '~/utils/errors'
import RevertedToast from './RevertedToast.vue'

/** How long the "Reverted {path}" toast offers Undo. */
export const REVERT_UNDO_MS = 8000

export const REVERT_RUN_ACTIVE_MESSAGE = 'Wait for the responses in this project to finish before reverting files.'
/** docs/UI.md 7.4: a 404 to a chat request. */
export const STALE_CHAT_MESSAGE = 'This chat changed elsewhere and was reloaded.'

export const revertedMessage = (path: string): string => `Reverted ${path}`
export const restoredMessage = (path: string): string => `Restored ${path}`
export const undoSkippedMessage = (path: string): string => `${path} changed after the revert, so it was not restored.`
export const staleRevertMessage = (path: string): string => `${path} changed since its diff was loaded. Check it again.`
export const revertFailedMessage = (path: string): string => `Couldn't revert ${path}`
export const undoFailedMessage = (path: string): string => `Couldn't restore ${path}`

/** How a failed revert or undo reads: by the `conflict` reason, `not_found`, or anything else. */
export type RevertFailure = 'run-active' | 'stale' | 'not-found' | 'other'

export function revertFailure(error: HarnessError): RevertFailure {
  if (error.code === 'not_found')
    return 'not-found'
  if (error.code !== 'conflict')
    return 'other'
  const reason = (error.details as { reason?: unknown } | undefined)?.reason
  if (reason === 'stale')
    return 'stale'
  return reason === undefined || reason === null || reason === 'run-active' ? 'run-active' : 'other'
}

/** The toast of a failed revert of `path` (the caller refreshes the list on `stale` and `not-found`). */
export function showRevertError(error: unknown, path: string): RevertFailure {
  const failure = toHarnessError(error)
  const kind = revertFailure(failure)
  if (kind === 'run-active')
    toast.error(REVERT_RUN_ACTIVE_MESSAGE)
  else if (kind === 'stale')
    toast.error(staleRevertMessage(path))
  else if (kind === 'not-found')
    toast.error(STALE_CHAT_MESSAGE)
  else
    toast.error(revertFailedMessage(path), { description: failure.message })
  return kind
}

/** Undo of a revert: restores the batch, then says whether `path` came back. Never rejects. */
export async function undoRevert(chatId: string, batchId: string, path: string): Promise<void> {
  try {
    const result = await useWorkspaceStore().undo(chatId, batchId)
    if (result.skipped.some(skip => skip.path === path))
      toast(undoSkippedMessage(path))
    else
      toast.success(restoredMessage(path))
  }
  catch (error) {
    const failure = toHarnessError(error)
    if (revertFailure(failure) === 'run-active')
      toast.error(REVERT_RUN_ACTIVE_MESSAGE)
    else
      toast.error(undoFailedMessage(path), { description: failure.message })
  }
}

/** "Reverted {path}" after a revert that wrote something (with Undo), else a plain confirmation. */
export function showReverted(chatId: string, path: string, result: RestoreResult): void {
  const batchId = result.batchId
  if (!batchId) {
    toast.success(revertedMessage(path))
    return
  }
  toast.custom(markRaw(RevertedToast), {
    duration: REVERT_UNDO_MS,
    componentProps: {
      title: revertedMessage(path),
      onUndo: () => void undoRevert(chatId, batchId, path),
    },
  })
}
