// The in-memory run log of the hook service (Phase 11, ADR-048; `GET /hooks/runs`): the last `LIMITS.hookRunsKept`
// (200) hook runs, newest first, lost on restart. An entry never holds a command beyond its (redacted, cut) label, a
// payload or an output: only the event, the source, the label, the exit code, the duration, the outcome and a short
// error (at most `LIMITS.hookRunErrorMaxChars`).
import type { HookRun } from '@harness-forge/shared'
import { LIMITS } from '@harness-forge/shared'

export interface HookRunLog {
  /** Adds an entry (the oldest is dropped beyond the capacity). */
  readonly add: (entry: HookRun) => void
  /** Newest first, at most `limit` entries (default and maximum: the capacity). */
  readonly list: (limit?: number) => HookRun[]
  /** Number of entries kept. */
  readonly size: () => number
}

/** `text` cut to `max` UTF-16 units (never inside a surrogate pair). */
export function cutText(text: string, max: number): string {
  if (text.length <= max)
    return text
  let end = Math.max(0, max)
  const last = text.charCodeAt(end - 1)
  if (last >= 0xD800 && last <= 0xDBFF)
    end -= 1
  return text.slice(0, end)
}

export function createHookRunLog(capacity: number = LIMITS.hookRunsKept): HookRunLog {
  const max = Math.max(1, Math.floor(capacity))
  // Oldest first; `list` reverses.
  const entries: HookRun[] = []
  return {
    add: (entry) => {
      const error = entry.error === undefined ? undefined : cutText(entry.error, LIMITS.hookRunErrorMaxChars)
      entries.push(Object.freeze(error === undefined ? { ...entry } : { ...entry, error }))
      if (entries.length > max)
        entries.splice(0, entries.length - max)
    },
    list: (limit) => {
      const wanted = limit === undefined || !Number.isFinite(limit) ? max : Math.max(0, Math.min(Math.floor(limit), max))
      const newest: HookRun[] = []
      for (let index = entries.length - 1; index >= 0 && newest.length < wanted; index--)
        newest.push(entries[index] as HookRun)
      return newest
    },
    size: () => entries.length,
  }
}
