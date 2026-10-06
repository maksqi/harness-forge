// The per-project snapshot cache of the project config reader (Phase 11, ADR-049; ARCHITECTURE.md 6.29). Owner: W11.3.
// The same rules as the customization catalog cache (`services/customizations/cache.ts`):
//
// - One slot per project. A snapshot is served while it is younger than `ttlMs` (10 s, from the start of its build);
//   the next call after that rebuilds it.
// - Single flight: concurrent calls share one build. `refresh` starts a new build (unless a refresh build is already in
//   flight, which it joins); the answer of the older build still reaches its waiters but is not kept.
// - `invalidate` drops a slot: a build in flight for it is discarded (its waiters still get its answer). `clear` drops
//   every slot. At most `maxProjects` slots are kept (the least recently used is dropped first).
// - A signal aborts the wait of one caller only (the build goes on for the others).

export interface SnapshotCacheOptions<T> {
  readonly build: (projectId: string) => Promise<T>
  /** When a value was built (epoch ms): the start of its build. */
  readonly builtAt: (value: T) => number
  readonly ttlMs: number
  readonly maxProjects: number
  readonly now: () => number
}

export interface SnapshotCacheGetOptions {
  readonly refresh?: boolean
  readonly signal?: AbortSignal
}

export interface SnapshotCache<T> {
  readonly get: (projectId: string, options?: SnapshotCacheGetOptions) => Promise<T>
  /** Drops the slot of a project; true when there was one (a snapshot or a build). */
  readonly invalidate: (projectId: string) => boolean
  /** Drops every slot. */
  readonly clear: () => void
  /** The cached value of a project (expired ones included), without building. */
  readonly peek: (projectId: string) => T | null
  /** The project ids with a slot. */
  readonly projects: () => string[]
}

interface Build<T> {
  readonly refresh: boolean
  promise: Promise<T>
}

interface Slot<T> {
  value: T | null
  build: Build<T> | null
}

/** `promise`, or a rejection with the signal's reason when it aborts first. */
export function waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
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

export function createSnapshotCache<T>(options: SnapshotCacheOptions<T>): SnapshotCache<T> {
  const slots = new Map<string, Slot<T>>()

  function fresh(value: T): boolean {
    return options.now() - options.builtAt(value) < options.ttlMs
  }

  /** Marks a slot as the most recently used (the map keeps insertion order). */
  function touch(key: string, slot: Slot<T>): void {
    slots.delete(key)
    slots.set(key, slot)
  }

  function evict(): void {
    for (const key of slots.keys()) {
      if (slots.size <= options.maxProjects)
        break
      slots.delete(key)
    }
  }

  function start(key: string, slot: Slot<T>, refresh: boolean): Build<T> {
    const build = { refresh } as Build<T>
    build.promise = options.build(key).then(
      (value) => {
        // Only the latest build of a slot that is still cached is kept (a refresh or an invalidation discards it).
        if (slot.build === build) {
          slot.build = null
          if (slots.get(key) === slot)
            slot.value = value
        }
        return value
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
      let slot = slots.get(projectId)
      const refresh = getOptions.refresh === true
      if (slot !== undefined) {
        touch(projectId, slot)
        if (!refresh && slot.value !== null && fresh(slot.value))
          return slot.value
        if (slot.build !== null && (!refresh || slot.build.refresh))
          return waitFor(slot.build.promise, getOptions.signal)
      }
      else {
        slot = { value: null, build: null }
        slots.set(projectId, slot)
        evict()
      }
      return waitFor(start(projectId, slot, refresh).promise, getOptions.signal)
    },
    invalidate: (projectId) => {
      const slot = slots.get(projectId)
      if (slot === undefined)
        return false
      slots.delete(projectId)
      return slot.value !== null || slot.build !== null
    },
    clear: () => {
      slots.clear()
    },
    peek: projectId => slots.get(projectId)?.value ?? null,
    projects: () => [...slots.keys()],
  }
}
