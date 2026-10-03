// The one move action behind every "Move to project" menu (docs/UI.md 7.20, 11.4; ADR-031; W7.9): the header `⋯`
// menu, the sidebar row menu, the header chip and the command palette. `chats.update(chatId, { projectId })`
// (optimistic: the row leaves a list it no longer matches), then the toast "Moved to {name}" / "Moved out of {name}"
// with Undo (moves back); 409 run-active -> rolled back + "Wait for the response to finish before moving this chat.";
// 404 -> rolled back + "This project no longer exists."; never rejects.
// Signature frozen from Gate P7-0b (C15). Call useMoveChat() during setup.
import { markRaw } from 'vue'
import { toast } from 'vue-sonner'
import { useChatsStore } from '~/stores/chats'
import { useProjectsStore } from '~/stores/projects'
import { toHarnessError } from '~/utils/errors'
import ProjectMovedToast from './ProjectMovedToast.vue'

/** Moves a chat into a project (null = out of its project). Never rejects. */
export type MoveChat = (chatId: string, projectId: string | null) => Promise<void>

/** How long the Undo of a move stays available. */
export const MOVE_UNDO_MS = 5000

export const MOVE_RUN_ACTIVE_MESSAGE = 'Wait for the response to finish before moving this chat.'
export const MOVE_NOT_FOUND_MESSAGE = 'This project no longer exists.'

/** Error toast of a failed move (or of its undo). */
function showMoveError(error: unknown): void {
  const failure = toHarnessError(error)
  if (failure.code === 'conflict')
    toast.error(MOVE_RUN_ACTIVE_MESSAGE)
  else if (failure.code === 'not_found')
    toast.error(MOVE_NOT_FOUND_MESSAGE)
  else
    toast.error('Couldn\'t move the chat', { description: failure.message })
}

export function useMoveChat(): MoveChat {
  const chats = useChatsStore()
  const projects = useProjectsStore()

  function nameOf(projectId: string | null | undefined): string {
    return (projectId ? projects.byId(projectId)?.name : undefined) ?? 'the project'
  }

  return async (chatId, projectId) => {
    // The project before the move (undefined when the chat's summary is unknown here: no Undo then).
    const from = chats.byId(chatId)?.projectId
    if (from === projectId)
      return
    try {
      await chats.update(chatId, { projectId })
    }
    catch (error) {
      showMoveError(error)
      return
    }
    const title = projectId ? `Moved to ${nameOf(projectId)}` : `Moved out of ${nameOf(from)}`
    if (from === undefined) {
      toast.success(title)
      return
    }
    toast.custom(markRaw(ProjectMovedToast), {
      duration: MOVE_UNDO_MS,
      componentProps: {
        title,
        onUndo: () => {
          chats.update(chatId, { projectId: from }).catch(showMoveError)
        },
      },
    })
  }
}
