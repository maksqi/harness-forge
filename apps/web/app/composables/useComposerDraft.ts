// Unsent composer text per chat (docs/UI.md 7.7, 11): kept in sessionStorage, so it survives navigating between
// chats and reloads of the tab, and is removed once sent. Writes are debounced and flushed on chat switch, unmount
// and `pagehide`. Storage that is missing, full or blocked degrades to an in-memory draft.
import type { MaybeRefOrGetter, Ref } from 'vue'
import { useEventListener } from '@vueuse/core'
import { getCurrentScope, onScopeDispose, ref, toValue, watch } from 'vue'

export const COMPOSER_DRAFT_KEY_PREFIX = 'hf-composer-draft:'
export const COMPOSER_DRAFT_SAVE_MS = 300

function draftKey(chatId: string): string {
  return `${COMPOSER_DRAFT_KEY_PREFIX}${chatId}`
}

function sessionStore(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null
  }
  catch {
    return null
  }
}

/** The stored draft of a chat ('' when none). */
export function readComposerDraft(chatId: string): string {
  if (!chatId)
    return ''
  try {
    return sessionStore()?.getItem(draftKey(chatId)) ?? ''
  }
  catch {
    return ''
  }
}

/** Stores a draft; blank text removes it. */
export function writeComposerDraft(chatId: string, text: string): void {
  if (!chatId)
    return
  try {
    const store = sessionStore()
    if (!store)
      return
    if (text.trim())
      store.setItem(draftKey(chatId), text)
    else
      store.removeItem(draftKey(chatId))
  }
  catch {
    // Full or blocked storage: the draft stays in memory only.
  }
}

export interface ComposerDraft {
  /** The composer text of the current chat. */
  text: Ref<string>
  /** Writes a pending change now. */
  flush: () => void
  /** Empties the text and forgets the stored draft (after sending). */
  clear: () => void
}

/**
 * The draft of `chatId`: loaded on start and whenever the id changes (the previous chat's text is saved first).
 */
export function useComposerDraft(chatId: MaybeRefOrGetter<string>, options: { delayMs?: number } = {}): ComposerDraft {
  const delayMs = options.delayMs ?? COMPOSER_DRAFT_SAVE_MS
  let currentId = toValue(chatId)
  const text = ref(readComposerDraft(currentId))
  let timer: ReturnType<typeof setTimeout> | undefined
  let dirty = false

  function cancelTimer() {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  function flush() {
    cancelTimer()
    if (dirty)
      writeComposerDraft(currentId, text.value)
    dirty = false
  }

  // Sync: a change is recorded before a chat switch in the same tick is handled.
  watch(text, () => {
    dirty = true
    cancelTimer()
    timer = setTimeout(flush, delayMs)
  }, { flush: 'sync' })

  watch(() => toValue(chatId), (next) => {
    if (next === currentId)
      return
    flush()
    currentId = next
    text.value = readComposerDraft(next)
    // Loading is not an edit.
    cancelTimer()
    dirty = false
  }, { flush: 'sync' })

  function clear() {
    text.value = ''
    cancelTimer()
    dirty = false
    writeComposerDraft(currentId, '')
  }

  if (typeof window !== 'undefined')
    useEventListener(window, 'pagehide', flush)
  if (getCurrentScope())
    onScopeDispose(flush)

  return { text, flush, clear }
}
