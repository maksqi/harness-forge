// In-memory pins of the files service (W7.8-T2): kept for the grace period after the latest pin, snapshots.
import { describe, expect, it } from 'vitest'
import { createFilePins, FILE_CLEANUP_GRACE_MS } from './pins.ts'

const HOUR = 60 * 60 * 1000

describe('file pins', () => {
  it('keeps an id for 24 hours after its latest pin; a snapshot never changes afterwards', () => {
    let now = 1_000_000
    const pins = createFilePins(() => now)
    expect(FILE_CLEANUP_GRACE_MS).toBe(24 * HOUR)
    pins.pin('file_aaaaaaaaaaaaaaaa')
    now += 10 * HOUR
    pins.pin('file_bbbbbbbbbbbbbbbb')
    now += 13 * HOUR
    const snapshot = pins.snapshot()
    expect([...snapshot].sort()).toEqual(['file_aaaaaaaaaaaaaaaa', 'file_bbbbbbbbbbbbbbbb'])
    now += HOUR
    expect([...pins.snapshot()]).toEqual(['file_bbbbbbbbbbbbbbbb'])
    expect(snapshot.size).toBe(2)
    // A new pin restarts the period.
    now += 6 * HOUR
    pins.pin('file_bbbbbbbbbbbbbbbb')
    now += 23 * HOUR
    expect([...pins.snapshot()]).toEqual(['file_bbbbbbbbbbbbbbbb'])
    now += HOUR
    expect(pins.snapshot().size).toBe(0)
  })

  it('drops expired pins as new ones arrive, also after the clock went back', () => {
    let now = 50 * HOUR
    const pins = createFilePins(() => now)
    pins.pin('file_aaaaaaaaaaaaaaaa')
    now -= HOUR
    pins.pin('file_bbbbbbbbbbbbbbbb')
    now += 23 * HOUR
    // 72 h: `a` (pinned at 50 h) has 2 h left, `b` (49 h) 1 h.
    expect([...pins.snapshot()].sort()).toEqual(['file_aaaaaaaaaaaaaaaa', 'file_bbbbbbbbbbbbbbbb'])
    now += 2 * HOUR
    pins.pin('file_cccccccccccccccc')
    expect([...pins.snapshot()]).toEqual(['file_cccccccccccccccc'])
  })
})
