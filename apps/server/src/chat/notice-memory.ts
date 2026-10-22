// The once-per-chat notice memory of a chat runner (Phase 14, C52, ADR-063; COMPLETE and FROZEN after P14-0b). Some
// notices are shown once per chat, model and reason (`web-search-unavailable`): the run checks its history
// (`alreadyNoticed`, `pipeline.ts`: survives a restart) and this in-memory set (a regenerate or another branch does not
// repeat it while the server runs). The runner (`index.ts`) owns one instance and hands it to every run
// (`RunContext.noticeMemory`).
// Bounded and keyed by chat (AGENT.md in-memory state rules): at most `NOTICE_MEMORY_CHATS_MAX` chats (the chat used
// least recently goes first) with at most `NOTICE_MEMORY_KEYS_MAX` keys each (the oldest key goes first); a chat is
// forgotten on `chat.deleted` (a chat delete, delete-all and a project delete emit it per chat), everything on
// `key.rotated` and on `stop()` (shutdown). The event bus is read lazily (the runner is built inside the deps factory) and
// subscribed once, with the first remembered key. Keys never hold message contents (a notice code, a model ref, a
// reason).
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { EventBus } from '../services/events/types.ts'

/** Chats the memory keeps at most. */
export const NOTICE_MEMORY_CHATS_MAX = 1000
/** Keys one chat keeps at most. */
export const NOTICE_MEMORY_KEYS_MAX = 64

export interface NoticeMemory {
  /** Records `key` for `chatId`: true when it is new (the notice is due), false when it was recorded before. */
  readonly remember: (chatId: string, key: string) => boolean
  /** True when `key` was recorded for `chatId` (nothing changes). */
  readonly has: (chatId: string, key: string) => boolean
  /** Forgets one chat. */
  readonly forget: (chatId: string) => void
  /** Forgets every chat (key rotation). */
  readonly clear: () => void
  /** Forgets every chat and ends the subscription (shutdown). */
  readonly stop: () => void
  /** Chats remembered (tests). */
  readonly size: () => number
}

/** The memory of one runner; `events` gives the bus (read on the first `remember`), absent = no subscription. */
export function createNoticeMemory(events?: () => Pick<EventBus, 'subscribe'> | undefined): NoticeMemory {
  const chats = new Map<string, Set<string>>()
  let subscription: Disposable | null = null
  let stopped = false

  function subscribe(): void {
    if (subscription !== null || stopped || events === undefined)
      return
    try {
      const bus = events()
      if (bus === undefined)
        return
      subscription = bus.subscribe((event) => {
        if (event.type === 'chat.deleted')
          chats.delete(event.data.id)
        else if (event.type === 'key.rotated')
          chats.clear()
      })
    }
    catch {
      // No bus (a test double): the memory still works, it is only never cleared by events.
    }
  }

  return {
    remember: (chatId, key) => {
      subscribe()
      let keys = chats.get(chatId)
      if (keys !== undefined) {
        // Most recently used last.
        chats.delete(chatId)
        chats.set(chatId, keys)
        if (keys.has(key))
          return false
      }
      else {
        keys = new Set()
        chats.set(chatId, keys)
        while (chats.size > NOTICE_MEMORY_CHATS_MAX) {
          const oldest = chats.keys().next().value
          if (oldest === undefined)
            break
          chats.delete(oldest)
        }
      }
      keys.add(key)
      while (keys.size > NOTICE_MEMORY_KEYS_MAX) {
        const oldest = keys.values().next().value
        if (oldest === undefined)
          break
        keys.delete(oldest)
      }
      return true
    },
    has: (chatId, key) => chats.get(chatId)?.has(key) === true,
    forget: (chatId) => {
      chats.delete(chatId)
    },
    clear: () => chats.clear(),
    stop: () => {
      stopped = true
      chats.clear()
      const current = subscription
      subscription = null
      try {
        current?.dispose()
      }
      catch {
        // Disposing a subscription of a stopped bus.
      }
    },
    size: () => chats.size,
  }
}
