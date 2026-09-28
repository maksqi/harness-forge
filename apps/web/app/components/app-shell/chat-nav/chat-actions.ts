// Row actions of the sidebar chat list (docs/UI.md 5.3): rename, export and the undoable delete. Failures become
// error toasts; callers never see a rejection. Call useChatActions() during setup.
import type { ChatExportFormat } from '@harness-forge/shared'
import { markRaw } from 'vue'
import { toast } from 'vue-sonner'
import { useChatsStore } from '~/stores/chats'
import { useUiStore } from '~/stores/ui'
import { toHarnessError } from '~/utils/errors'
import { navigateTo, useRoute } from '../nuxt-imports'
import ChatNavDeletedToast from './ChatNavDeletedToast.vue'

/** How long "Undo" stays available after a delete (docs/UI.md 5.3). */
export const CHAT_UNDO_MS = 5000

export interface ChatActions {
  /** Renames a chat (optimistic in the store); resolves false and shows a toast when the server refuses. */
  rename: (id: string, title: string) => Promise<boolean>
  /** Downloads a Markdown or JSON export. */
  exportChat: (id: string, format: ChatExportFormat) => Promise<void>
  /**
   * Hides the chat at once and shows "Chat deleted" with Undo; the DELETE request is sent only when the undo
   * window ends, and the toast closes at that moment. Deleting the open chat navigates to `/`.
   */
  remove: (id: string) => void
}

function describe(error: unknown): string {
  return toHarnessError(error).message
}

export function useChatActions(): ChatActions {
  const chats = useChatsStore()
  const ui = useUiStore()
  const route = useRoute()

  function isOpen(id: string): boolean {
    return ui.activeChatId === id || route.path === `/chat/${id}`
  }

  async function rename(id: string, title: string): Promise<boolean> {
    try {
      await chats.rename(id, title)
      return true
    }
    catch (error) {
      toast.error('Couldn\'t rename the chat', { description: describe(error) })
      return false
    }
  }

  async function exportChat(id: string, format: ChatExportFormat): Promise<void> {
    try {
      await chats.exportChat(id, format)
    }
    catch (error) {
      toast.error('Couldn\'t export the chat', { description: describe(error) })
    }
  }

  function remove(id: string): void {
    const wasOpen = isOpen(id)
    const handle = chats.remove(id, { undoMs: CHAT_UNDO_MS })
    // The store's undo window is the only clock: the toast has no timer of its own (hovering it cannot outlive
    // the window) and is dismissed when the window ends, is undone, or fails.
    const toastId = toast.custom(markRaw(ChatNavDeletedToast), {
      duration: Number.POSITIVE_INFINITY,
      componentProps: { title: 'Chat deleted', onUndo: () => handle.undo() },
    })
    void handle.done.then((outcome) => {
      toast.dismiss(toastId)
      if (outcome.status === 'failed')
        toast.error('Couldn\'t delete the chat', { description: outcome.error.message })
    })
    if (wasOpen)
      void navigateTo('/')
  }

  return { rename, exportChat, remove }
}
