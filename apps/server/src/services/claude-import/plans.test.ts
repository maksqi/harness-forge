// The plan store (W12.3-T3): at most `max` plans (the oldest dropped), each until its `expiresAt` (a read checks the
// clock, an unref'd timer frees it), `take` removes, `clear` drops everything.
import type { ClaudeImportPlan } from '@harness-forge/shared'
import type { StoredPlan } from './plans.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPlanStore } from './plans.ts'

afterEach(() => {
  vi.useRealTimers()
})

function stored(id: string, expiresAt: number): StoredPlan {
  const dto: ClaudeImportPlan = { id, source: 'upload', root: '.claude', createdAt: 0, expiresAt, items: [], skipped: [], diagnostics: [] }
  return { dto, files: [{ path: 'CLAUDE.md', text: 'x' }] }
}

describe('createPlanStore', () => {
  it('keeps at most max plans, dropping the oldest; take removes; clear drops all', () => {
    let clock = 0
    const store = createPlanStore({ max: 2, now: () => clock })
    store.put(stored('cip_A', 100))
    store.put(stored('cip_B', 100))
    store.put(stored('cip_C', 100))
    expect(store.size()).toBe(2)
    expect(store.get('cip_A')).toBeUndefined()
    expect(store.get('cip_B')?.dto.id).toBe('cip_B')
    expect(store.take('cip_B')?.dto.id).toBe('cip_B')
    expect(store.take('cip_B')).toBeUndefined()
    clock = 100
    expect(store.get('cip_C')).toBeUndefined()
    expect(store.size()).toBe(0)
    store.put(stored('cip_D', 500))
    store.clear()
    expect(store.size()).toBe(0)
  })

  it('a timer drops a plan at its expiry without a read', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const store = createPlanStore({ max: 4 })
    store.put(stored('cip_A', 1000 + 600_000))
    vi.advanceTimersByTime(599_999)
    expect(store.size()).toBe(1)
    vi.advanceTimersByTime(1)
    expect(store.size()).toBe(0)
  })
})
