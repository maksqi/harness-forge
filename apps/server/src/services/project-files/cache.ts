// The in-memory cache of project file indexes (Phase 9, ADR-042, ARCHITECTURE.md 6.21). Owner: W9.6.
//
// - One slot per project, keyed by the project id (and the root it was built for). An index lives `ttlMs`
//   (`LIMITS.mentionIndexTtlMs`, 30 s) from the start of its build: the next search after that rebuilds it, and an
//   `unref()`-ed timer frees it when nobody searches.
// - Single-flight: concurrent searches of a project share one build, and the builds of a project run one at a time.
// - `invalidate` drops the index. A build that already walks is discarded: the searches waiting for it still get its
//   answer, but it is not kept, and the next search queues a fresh build behind it (so a search after an invalidation
//   never gets an index whose walk started before it, and a project never has more than one walk running). A build
//   that is queued and has not started walking yet is kept: its walk starts after the invalidation anyway.
// - At most `maxProjects` indexes are kept; the least recently searched one is dropped first.
// - `stop()` aborts the walks in flight (their searches reject with the abort reason), clears every timer and slot.
import type { ProjectFileIndex } from './file-index.ts'

/** Indexes kept at most (one per project); the least recently searched is dropped first. */
export const MENTION_INDEX_PROJECTS_MAX = 8

export interface ProjectIndexCacheOptions {
  /** Builds the index of a project folder (`buildProjectFileIndex` with the service's walker and limits). */
  build: (root: string, signal: AbortSignal) => Promise<ProjectFileIndex>
  /** Lifetime of an index from `indexedAt` (`LIMITS.mentionIndexTtlMs`). */
  ttlMs: number
  /** Indexes kept at most (`MENTION_INDEX_PROJECTS_MAX`). */
  maxProjects: number
  /** Clock (default `Date.now`, read at every call so fake timers apply). */
  now?: () => number
}

export interface ProjectIndexCache {
  /** The index of the project folder `root`: the cached one while fresh, else the build in flight or a new build. */
  readonly get: (projectId: string, root: string) => Promise<ProjectFileIndex>
  /** Drops the project's index (see the module comment); a no-op for an unknown project. */
  readonly invalidate: (projectId: string) => void
  /** Aborts the walks, clears every timer and slot. Idempotent. The cache works again afterwards (tests). */
  readonly stop: () => void
  /** Project ids with a slot (an index, a build or a walk in flight), least recently searched first (tests). */
  readonly projects: () => string[]
  /** Project ids with a cached index (tests). */
  readonly cached: () => string[]
}

interface Build {
  readonly promise: Promise<ProjectFileIndex>
  /** The walk started (it waited for the previous build of the project before). */
  started: boolean
  /** Invalidated while it walked: its answer is not kept. */
  stale: boolean
}

interface Slot {
  readonly root: string
  index: ProjectFileIndex | null
  timer: ReturnType<typeof setTimeout> | undefined
  /** The build whose answer will be kept (null when none, or when it went stale). */
  current: Build | null
  /** The last build started (settles, never rejects): the next build waits for it. */
  running: Promise<void> | null
}

export function createProjectIndexCache(options: ProjectIndexCacheOptions): ProjectIndexCache {
  const now = options.now ?? (() => Date.now())
  const slots = new Map<string, Slot>()
  let controller = new AbortController()

  function clearIndex(slot: Slot): void {
    clearTimeout(slot.timer)
    slot.timer = undefined
    slot.index = null
  }

  /** Removes an empty slot (no index, no build, no walk). */
  function prune(projectId: string, slot: Slot): void {
    if (slot.index === null && slot.current === null && slot.running === null && slots.get(projectId) === slot)
      slots.delete(projectId)
  }

  /** Marks the project as the most recently searched (the map keeps insertion order). */
  function touch(projectId: string, slot: Slot): void {
    slots.delete(projectId)
    slots.set(projectId, slot)
  }

  /** Drops the least recently searched indexes above `maxProjects` (never the one of `except`). */
  function evict(except: string): void {
    let cached = 0
    for (const slot of slots.values()) {
      if (slot.index !== null)
        cached++
    }
    for (const [projectId, slot] of slots) {
      if (cached <= options.maxProjects)
        break
      if (projectId === except || slot.index === null)
        continue
      clearIndex(slot)
      prune(projectId, slot)
      cached--
    }
  }

  function keep(projectId: string, slot: Slot, index: ProjectFileIndex): void {
    const remaining = options.ttlMs - (now() - index.indexedAt)
    if (remaining <= 0)
      return
    clearTimeout(slot.timer)
    slot.index = index
    const timer = setTimeout(() => {
      if (slot.index !== index)
        return
      slot.timer = undefined
      slot.index = null
      prune(projectId, slot)
    }, remaining)
    timer.unref?.()
    slot.timer = timer
    evict(projectId)
  }

  function startBuild(projectId: string, slot: Slot): Build {
    const previous = slot.running
    const { signal } = controller
    // The flags object becomes the build (`Object.assign` below), so the callbacks compare `slot.current` with it.
    const flags = { started: false, stale: false }
    const work = (async () => {
      if (previous !== null)
        await previous
      signal.throwIfAborted()
      flags.started = true
      return options.build(slot.root, signal)
    })()
    const promise = work.then(
      (index) => {
        if (slot.current === flags)
          slot.current = null
        if (!flags.stale && !signal.aborted && slots.get(projectId) === slot)
          keep(projectId, slot, index)
        return index
      },
      (error: unknown) => {
        if (slot.current === flags)
          slot.current = null
        throw error
      },
    )
    const build: Build = Object.assign(flags, { promise })
    const settled = promise.then(() => {}, () => {})
    slot.running = settled
    void settled.then(() => {
      if (slot.running !== settled)
        return
      slot.running = null
      prune(projectId, slot)
    })
    slot.current = build
    return build
  }

  function invalidate(projectId: string): void {
    const slot = slots.get(projectId)
    if (slot === undefined)
      return
    clearIndex(slot)
    if (slot.current !== null && slot.current.started) {
      slot.current.stale = true
      slot.current = null
    }
    prune(projectId, slot)
  }

  return {
    get: async (projectId, root) => {
      let slot = slots.get(projectId)
      if (slot !== undefined && slot.root !== root) {
        // The project's folder changed (never in practice: a project keeps its path): forget the old slot.
        if (slot.current !== null)
          slot.current.stale = true
        slot.current = null
        clearIndex(slot)
        slots.delete(projectId)
        slot = undefined
      }
      if (slot !== undefined && slot.index !== null) {
        if (now() - slot.index.indexedAt < options.ttlMs) {
          touch(projectId, slot)
          return slot.index
        }
        clearIndex(slot)
      }
      if (slot === undefined) {
        slot = { root, index: null, timer: undefined, current: null, running: null }
        slots.set(projectId, slot)
      }
      touch(projectId, slot)
      return (slot.current ?? startBuild(projectId, slot)).promise
    },
    invalidate,
    stop: () => {
      controller.abort(new DOMException('The project file index stopped.', 'AbortError'))
      controller = new AbortController()
      for (const slot of slots.values()) {
        clearIndex(slot)
        if (slot.current !== null)
          slot.current.stale = true
        slot.current = null
        slot.running = null
      }
      slots.clear()
    },
    projects: () => [...slots.keys()],
    cached: () => [...slots].filter(([, slot]) => slot.index !== null).map(([projectId]) => projectId),
  }
}
