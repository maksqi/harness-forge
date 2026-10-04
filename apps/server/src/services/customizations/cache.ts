// The catalog cache (Phase 10, ADR-044; ARCHITECTURE.md 6.23 "Cache"). Owner: W10.1.
//
// - One slot per project id and one for the global catalog (key ''). A snapshot is served while it is younger than
//   `ttlMs` (`LIMITS.customizationIndexTtlMs`, 10 s, from the start of its build); the next call after that rebuilds it.
//   An expired snapshot stays in its slot (so dropping it is still noticed) until it is replaced, invalidated or evicted.
// - Single-flight: concurrent calls share one build. `refresh` starts a new build (unless a refresh build is already in
//   flight, which it joins); the answer of the older build still reaches its waiters but is not kept.
// - `invalidate` drops a slot: a build in flight for it is discarded (its waiters still get its answer). `clear` drops
//   every slot. At most `maxProjects` project slots are kept (the least recently used is dropped first; the global slot
//   is never evicted).
// - A signal aborts the wait of one caller only (the build goes on for the others).
// - `onRebuilt(projectId, previous, next)` is called when a build replaces a snapshot of the same slot (the service
//   compares the project part and announces a change).
import type { CustomizationCatalog } from './types.ts'

/** Project catalogs kept at most (the global catalog does not count). */
export const CUSTOMIZATION_CACHE_PROJECTS_MAX = 50

export interface CatalogCacheOptions {
  /** Builds the catalog of a project (null = the global one). */
  readonly build: (projectId: string | null) => Promise<CustomizationCatalog>
  readonly ttlMs: number
  readonly maxProjects: number
  readonly now: () => number
  readonly onRebuilt?: (projectId: string | null, previous: CustomizationCatalog, next: CustomizationCatalog) => void
}

export interface CatalogCacheGetOptions {
  readonly refresh?: boolean
  readonly signal?: AbortSignal
}

export interface CatalogCache {
  readonly get: (projectId: string | null, options?: CatalogCacheGetOptions) => Promise<CustomizationCatalog>
  /** Drops the slot of a project (null = the global one); true when there was one (a snapshot or a build). */
  readonly invalidate: (projectId: string | null) => boolean
  /** Drops every slot. */
  readonly clear: () => void
  /** The project ids with a slot (tests and `run.finished` lookups). */
  readonly projects: () => string[]
  /** The current snapshots (expired ones included), for lookups of the project of an entry. */
  readonly snapshots: () => CustomizationCatalog[]
}

interface Build {
  readonly refresh: boolean
  promise: Promise<CustomizationCatalog>
}

interface Slot {
  snapshot: CustomizationCatalog | null
  build: Build | null
}

function keyOf(projectId: string | null): string {
  return projectId ?? ''
}

/** `promise`, or a rejection with the signal's reason when it aborts first. */
function waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined)
    return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

export function createCatalogCache(options: CatalogCacheOptions): CatalogCache {
  const slots = new Map<string, Slot>()

  function fresh(snapshot: CustomizationCatalog): boolean {
    return options.now() - snapshot.builtAt < options.ttlMs
  }

  /** Marks a slot as the most recently used (the map keeps insertion order). */
  function touch(key: string, slot: Slot): void {
    slots.delete(key)
    slots.set(key, slot)
  }

  function evict(): void {
    let projects = slots.size - (slots.has('') ? 1 : 0)
    for (const key of slots.keys()) {
      if (projects <= options.maxProjects)
        break
      if (key === '')
        continue
      slots.delete(key)
      projects -= 1
    }
  }

  function start(key: string, slot: Slot, projectId: string | null, refresh: boolean): Build {
    const build = { refresh } as Build
    build.promise = options.build(projectId).then(
      (snapshot) => {
        // Only the latest build of a slot that is still cached is kept (a refresh or an invalidation discards it).
        if (slot.build !== build)
          return snapshot
        slot.build = null
        if (slots.get(key) !== slot)
          return snapshot
        const previous = slot.snapshot
        slot.snapshot = snapshot
        if (previous !== null)
          options.onRebuilt?.(projectId, previous, snapshot)
        return snapshot
      },
      (error: unknown) => {
        if (slot.build === build)
          slot.build = null
        throw error
      },
    )
    slot.build = build
    return build
  }

  return {
    get: async (projectId, getOptions = {}) => {
      getOptions.signal?.throwIfAborted()
      const key = keyOf(projectId)
      let slot = slots.get(key)
      const refresh = getOptions.refresh === true
      if (slot !== undefined) {
        touch(key, slot)
        if (!refresh && slot.snapshot !== null && fresh(slot.snapshot))
          return slot.snapshot
        if (slot.build !== null && (!refresh || slot.build.refresh))
          return waitFor(slot.build.promise, getOptions.signal)
      }
      else {
        slot = { snapshot: null, build: null }
        slots.set(key, slot)
        evict()
      }
      return waitFor(start(key, slot, projectId, refresh).promise, getOptions.signal)
    },
    invalidate: (projectId) => {
      const key = keyOf(projectId)
      const slot = slots.get(key)
      if (slot === undefined)
        return false
      slots.delete(key)
      return slot.snapshot !== null || slot.build !== null
    },
    clear: () => {
      slots.clear()
    },
    projects: () => [...slots.keys()].filter(key => key !== ''),
    snapshots: () => [...slots.values()].flatMap(slot => (slot.snapshot === null ? [] : [slot.snapshot])),
  }
}
