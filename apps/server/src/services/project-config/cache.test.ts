// The snapshot cache of the project config reader (Phase 11, W11.3-T1): TTL, single flight, refresh, invalidation,
// the least recently used eviction and per-caller abort.
import { describe, expect, it } from 'vitest'
import { createSnapshotCache } from './cache.ts'

interface Value {
  readonly id: string
  readonly n: number
  readonly builtAt: number
}

function harness(options: { ttlMs?: number, maxProjects?: number } = {}) {
  let clock = 1000
  let builds = 0
  const gates: Array<() => void> = []
  let gated = false
  const cache = createSnapshotCache<Value>({
    build: async (id) => {
      builds += 1
      const n = builds
      const builtAt = clock
      if (gated)
        await new Promise<void>(resolve => gates.push(resolve))
      return { id, n, builtAt }
    },
    builtAt: value => value.builtAt,
    ttlMs: options.ttlMs ?? 100,
    maxProjects: options.maxProjects ?? 3,
    now: () => clock,
  })
  return {
    cache,
    builds: () => builds,
    tick: (ms: number) => {
      clock += ms
    },
    gate: (on: boolean) => {
      gated = on
    },
    open: () => {
      for (const resolve of gates.splice(0))
        resolve()
    },
  }
}

describe('project config snapshot cache', () => {
  it('serves a snapshot until its TTL ends, then rebuilds it', async () => {
    const h = harness()
    expect((await h.cache.get('a')).n).toBe(1)
    h.tick(99)
    expect((await h.cache.get('a')).n).toBe(1)
    h.tick(1)
    expect((await h.cache.get('a')).n).toBe(2)
    expect(h.cache.peek('a')?.n).toBe(2)
    expect(h.cache.peek('b')).toBeNull()
  })

  it('shares one build between concurrent calls; refresh starts a new one whose answer is kept', async () => {
    const h = harness()
    h.gate(true)
    const first = h.cache.get('a')
    const second = h.cache.get('a')
    const refreshed = h.cache.get('a', { refresh: true })
    const joined = h.cache.get('a', { refresh: true })
    h.open()
    expect((await first).n).toBe(1)
    expect((await second).n).toBe(1)
    expect((await refreshed).n).toBe(2)
    expect((await joined).n).toBe(2)
    expect(h.builds()).toBe(2)
    h.gate(false)
    expect((await h.cache.get('a')).n).toBe(2)
  })

  it('invalidate drops a slot and discards a build in flight; clear drops every slot', async () => {
    const h = harness()
    await h.cache.get('a')
    expect(h.cache.invalidate('a')).toBe(true)
    expect(h.cache.invalidate('a')).toBe(false)
    h.gate(true)
    const pending = h.cache.get('a')
    expect(h.cache.invalidate('a')).toBe(true)
    h.open()
    expect((await pending).n).toBe(2)
    expect(h.cache.peek('a')).toBeNull()
    h.gate(false)
    await h.cache.get('b')
    h.cache.clear()
    expect(h.cache.projects()).toEqual([])
  })

  it('evicts the least recently used project beyond the limit', async () => {
    const h = harness({ maxProjects: 2 })
    await h.cache.get('a')
    await h.cache.get('b')
    await h.cache.get('a')
    await h.cache.get('c')
    expect(h.cache.projects().sort()).toEqual(['a', 'c'])
  })

  it('a signal aborts only its own wait', async () => {
    const h = harness()
    h.gate(true)
    const controller = new AbortController()
    const aborted = h.cache.get('a', { signal: controller.signal })
    const other = h.cache.get('a')
    controller.abort(new Error('stopped'))
    await expect(aborted).rejects.toThrow('stopped')
    h.open()
    expect((await other).n).toBe(1)
    await expect(h.cache.get('a', { signal: controller.signal })).rejects.toThrow('stopped')
  })
})
