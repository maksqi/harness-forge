// In-memory pins of the files service (ADR-035, ARCHITECTURE.md 6.15): every id `upload`, `importFile` and
// `saveGenerated` returned stays pinned for the grace period, so the orphaned file cleanup never removes a row that a
// run is about to reference (a reused old row whose message is not saved yet). Pins are lost on restart; the runs that
// held them are gone too.

/** The grace period of the cleanup (24 h): rows younger than this, and pins younger than this, are kept. */
export const FILE_CLEANUP_GRACE_MS = 24 * 60 * 60 * 1000

export interface FilePins {
  /** Pins `id` (again) from now on. */
  readonly pin: (id: string) => void
  /** The ids pinned within the grace period (a snapshot); expired pins are dropped. */
  readonly snapshot: () => ReadonlySet<string>
}

export function createFilePins(now: () => number, graceMs: number = FILE_CLEANUP_GRACE_MS): FilePins {
  /** id -> time of its latest pin. */
  const pins = new Map<string, number>()

  /** Drops the expired pins from the head of the map (ordered by pin time), so it never grows past a grace period. */
  function prune(at: number): void {
    for (const [id, pinnedAt] of pins) {
      if (at - pinnedAt < graceMs)
        return
      pins.delete(id)
    }
  }

  return {
    pin: (id) => {
      const at = now()
      prune(at)
      // Re-inserted so the map stays ordered by pin time.
      pins.delete(id)
      pins.set(id, at)
    },
    snapshot: () => {
      const at = now()
      prune(at)
      const live = new Set<string>()
      for (const [id, pinnedAt] of pins) {
        if (at - pinnedAt < graceMs)
          live.add(id)
      }
      return live
    },
  }
}
