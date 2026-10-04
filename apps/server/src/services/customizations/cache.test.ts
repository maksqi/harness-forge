// The catalog cache and the coalesced announcements (W10.1-T5): the TTL, single-flight builds, `refresh`, an
// invalidation during a build (its answer reaches its waiters but is not kept), an aborted wait, the project cap (the
// global slot is never evicted), `onRebuilt`; the notifier sends at most one announcement per key and second (fake
// timers) and nothing after `stop`.
import type { CustomizationCatalog } from './types.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCatalogCache } from './cache.ts'
import { createCoalescedNotifier } from './notifier.ts'
import { createCatalogSnapshot } from './snapshot.ts'

afterEach(() => {
  vi.useRealTimers()
})

interface Deferred {
  readonly projectId: string | null
  readonly resolve: () => void
}

/** A cache whose builds wait until the test resolves them. */
function harness(options: { ttlMs?: number, maxProjects?: number } = {}) {
  let clock = 1000
  const builds: Deferred[] = []
  const rebuilt: Array<[string | null, number, number]> = []
  const cache = createCatalogCache({
    ttlMs: options.ttlMs ?? 10_000,
    maxProjects: options.maxProjects ?? 50,
    now: () => clock,
    build: async projectId => new Promise<CustomizationCatalog>((resolve) => {
      const builtAt = clock
      builds.push({ projectId, resolve: () => resolve(createCatalogSnapshot({ projectId, entries: [], builtAt })) })
    }),
    onRebuilt: (projectId, previous, next) => rebuilt.push([projectId, previous.builtAt, next.builtAt]),
  })
  return {
    cache,
    builds,
    rebuilt,
    tick: (ms: number) => {
      clock += ms
    },
    /** Resolves every pending build and lets the cache store them. */
    settle: async () => {
      for (const build of builds.splice(0))
        build.resolve()
      await new Promise(resolve => setImmediate(resolve))
    },
  }
}

describe('createCatalogCache', () => {
  it('serves a snapshot while it is fresh, shares one build between concurrent calls, rebuilds after the TTL', async () => {
    const h = harness()
    const first = h.cache.get('prj_A')
    const second = h.cache.get('prj_A')
    expect(h.builds).toHaveLength(1)
    await h.settle()
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    h.tick(9_999)
    expect(await h.cache.get('prj_A')).toBe(a)
    expect(h.builds).toHaveLength(0)
    h.tick(1)
    const third = h.cache.get('prj_A')
    expect(h.builds).toHaveLength(1)
    await h.settle()
    expect(await third).not.toBe(a)
    expect(h.rebuilt).toEqual([['prj_A', 1000, 11_000]])
    expect(h.cache.projects()).toEqual(['prj_A'])
  })

  it('refresh builds again (joining a refresh in flight); an older build is answered but not kept', async () => {
    const h = harness()
    const normal = h.cache.get('prj_A')
    const refreshed = h.cache.get('prj_A', { refresh: true })
    const joined = h.cache.get('prj_A', { refresh: true })
    expect(h.builds).toHaveLength(2)
    h.builds[0]!.resolve()
    const older = await normal
    h.builds[1]!.resolve()
    h.builds.splice(0)
    const newer = await refreshed
    expect(await joined).toBe(newer)
    expect(await h.cache.get('prj_A')).toBe(newer)
    expect(older).not.toBe(newer)
  })

  it('an invalidation during a build discards it (its waiters still get it); the next call builds again', async () => {
    const h = harness()
    const pending = h.cache.get(null)
    expect(h.cache.invalidate(null)).toBe(true)
    expect(h.cache.invalidate(null)).toBe(false)
    await h.settle()
    const answered = await pending
    expect(answered.projectId).toBeNull()
    const again = h.cache.get(null)
    expect(h.builds).toHaveLength(1)
    await h.settle()
    expect(await again).not.toBe(answered)
    h.cache.clear()
    expect(h.cache.snapshots()).toEqual([])
  })

  it('an aborted signal rejects that wait only; the build goes on for the others', async () => {
    const h = harness()
    const controller = new AbortController()
    const aborted = h.cache.get('prj_A', { signal: controller.signal })
    const other = h.cache.get('prj_A')
    controller.abort(new Error('stop waiting'))
    await expect(aborted).rejects.toThrow('stop waiting')
    await h.settle()
    expect((await other).projectId).toBe('prj_A')
    const done = new AbortController()
    done.abort(new Error('already'))
    await expect(h.cache.get('prj_A', { signal: done.signal })).rejects.toThrow('already')
  })

  it('keeps at most maxProjects project catalogs (least recently used first); the global one is never evicted', async () => {
    const h = harness({ maxProjects: 2 })
    void h.cache.get(null)
    void h.cache.get('prj_A')
    void h.cache.get('prj_B')
    await h.settle()
    void h.cache.get('prj_A')
    void h.cache.get('prj_C')
    await h.settle()
    expect(h.cache.projects().sort()).toEqual(['prj_A', 'prj_C'])
    expect(h.cache.snapshots().map(snapshot => snapshot.projectId)).toContain(null)
  })

  it('a failed build is not kept and rejects its waiters', async () => {
    let fail = true
    const cache = createCatalogCache({
      ttlMs: 10_000,
      maxProjects: 5,
      now: () => 1,
      build: async (projectId) => {
        if (fail)
          throw new Error('database')
        return createCatalogSnapshot({ projectId, entries: [], builtAt: 1 })
      },
    })
    await expect(cache.get('prj_A')).rejects.toThrow('database')
    fail = false
    expect((await cache.get('prj_A')).projectId).toBe('prj_A')
  })
})

describe('createCoalescedNotifier', () => {
  it('sends at once, then at most once per second per key (a trailing announcement); nothing after stop', () => {
    vi.useFakeTimers()
    const sent: Array<[string, number]> = []
    const notifier = createCoalescedNotifier({ now: () => Date.now(), send: key => sent.push([key, Date.now()]) })
    const start = Date.now()
    notifier.request('prj_A')
    notifier.request('prj_A')
    notifier.request('prj_A')
    notifier.request('')
    expect(sent).toEqual([['prj_A', start], ['', start]])
    expect(notifier.pending()).toEqual(['prj_A'])
    vi.advanceTimersByTime(999)
    expect(sent).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(sent).toEqual([['prj_A', start], ['', start], ['prj_A', start + 1000]])
    vi.advanceTimersByTime(5000)
    notifier.request('prj_A')
    expect(sent).toHaveLength(4)
    notifier.request('prj_A')
    expect(notifier.pending()).toEqual(['prj_A'])
    notifier.stop()
    notifier.stop()
    vi.advanceTimersByTime(5000)
    notifier.request('prj_B')
    expect(sent).toHaveLength(4)
    expect(vi.getTimerCount()).toBe(0)
  })
})
