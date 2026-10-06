import type { HookRun } from '@harness-forge/shared'
import { LIMITS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { createHookRunLog, cutText } from './run-log.ts'

function entry(index: number, fields: Partial<HookRun> = {}): HookRun {
  return {
    id: `hev_${String(index).padStart(16, '0')}`,
    at: index,
    event: 'Stop',
    source: 'personal',
    label: `sh hook-${index}.sh`,
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    outcome: null,
    ...fields,
  }
}

describe('hook run log', () => {
  it('keeps the last 200 entries, newest first; limit', () => {
    const log = createHookRunLog()
    for (let index = 0; index < LIMITS.hookRunsKept + 25; index++)
      log.add(entry(index))
    expect(log.size()).toBe(LIMITS.hookRunsKept)
    const list = log.list()
    expect(list).toHaveLength(LIMITS.hookRunsKept)
    expect(list[0]?.at).toBe(LIMITS.hookRunsKept + 24)
    expect(list.at(-1)?.at).toBe(25)
    expect(log.list(3).map(item => item.at)).toEqual([LIMITS.hookRunsKept + 24, LIMITS.hookRunsKept + 23, LIMITS.hookRunsKept + 22])
    expect(log.list(0)).toEqual([])
    expect(log.list(10_000)).toHaveLength(LIMITS.hookRunsKept)
  })

  it('cuts the error to 500 characters', () => {
    const log = createHookRunLog(2)
    log.add(entry(1, { error: 'x'.repeat(2000), outcome: 'error' }))
    expect(log.list()[0]?.error).toHaveLength(LIMITS.hookRunErrorMaxChars)
    expect(cutText('a😀b', 2)).toBe('a')
  })
})
