// Coalesced `customization.changed` announcements (Phase 10, ADR-044; ARCHITECTURE.md 6.23). Owner: W10.1.
//
// A project whose catalog was dropped (`workspace.changed`, `project.changed`, `run.finished`) or rebuilt with other
// files, and the plugin agents, skills and commands (key ''), are announced at most once per `intervalMs` (1 s) per
// key: the first request is sent at once, the requests within the interval after it become one trailing announcement.
// Timers are `unref()`-ed and cleared by `stop()`, after which nothing is sent.

/** One announcement per key and second at most. */
export const CUSTOMIZATION_EVENT_INTERVAL_MS = 1000
/** Keys whose last announcement time is remembered before old ones are pruned. */
const REMEMBERED_KEYS_MAX = 256

export interface CoalescedNotifierOptions {
  /** Sends the announcement of a key ('' = the plugin entries changed). */
  readonly send: (key: string) => void
  readonly intervalMs?: number
  readonly now: () => number
}

export interface CoalescedNotifier {
  readonly request: (key: string) => void
  /** Clears every timer; later requests are ignored. Idempotent. */
  readonly stop: () => void
  /** Keys with a trailing announcement pending (tests). */
  readonly pending: () => string[]
}

export function createCoalescedNotifier(options: CoalescedNotifierOptions): CoalescedNotifier {
  const intervalMs = options.intervalMs ?? CUSTOMIZATION_EVENT_INTERVAL_MS
  const last = new Map<string, number>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let stopped = false

  function prune(): void {
    if (last.size <= REMEMBERED_KEYS_MAX)
      return
    const cutoff = options.now() - intervalMs
    for (const [key, at] of last) {
      if (at <= cutoff && !timers.has(key))
        last.delete(key)
    }
  }

  function send(key: string): void {
    last.set(key, options.now())
    prune()
    options.send(key)
  }

  return {
    request: (key) => {
      if (stopped || timers.has(key))
        return
      const previous = last.get(key)
      const elapsed = previous === undefined ? Number.POSITIVE_INFINITY : options.now() - previous
      if (elapsed >= intervalMs) {
        send(key)
        return
      }
      const timer = setTimeout(() => {
        timers.delete(key)
        if (!stopped)
          send(key)
      }, intervalMs - elapsed)
      timer.unref?.()
      timers.set(key, timer)
    },
    stop: () => {
      stopped = true
      for (const timer of timers.values())
        clearTimeout(timer)
      timers.clear()
      last.clear()
    },
    pending: () => [...timers.keys()],
  }
}
