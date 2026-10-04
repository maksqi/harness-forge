// The row helpers of background tasks (Phase 10, W10.4): the busy-connection retry and the end output. The row
// round trips run against a real database in ./index.test.ts and ./runs.test.ts.
import type { TaskOutput } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { BUSY_RETRIES, endedOutput, isConnectionBusy, retryBusy } from './store.ts'

const busy = Object.assign(new Error('TRANSACTION_ACTIVE: held'), { code: 'TRANSACTION_ACTIVE' })

describe('retryBusy', () => {
  it('tries a write again while the connection is busy (also as a cause), never for another error', async () => {
    expect(isConnectionBusy(busy)).toBe(true)
    expect(isConnectionBusy(new Error('wrapped', { cause: busy }))).toBe(true)
    expect(isConnectionBusy(new Error('other'))).toBe(false)
    expect(isConnectionBusy(null)).toBe(false)

    let calls = 0
    await expect(retryBusy(async () => {
      calls += 1
      if (calls < 3)
        throw new Error('query failed', { cause: busy })
      return 'written'
    })).resolves.toBe('written')
    expect(calls).toBe(3)

    let failing = 0
    await expect(retryBusy(async () => {
      failing += 1
      throw new Error('constraint')
    })).rejects.toThrow('constraint')
    expect(failing).toBe(1)

    let always = 0
    await expect(retryBusy(async () => {
      always += 1
      throw busy
    })).rejects.toBe(busy)
    expect(always).toBe(BUSY_RETRIES + 1)
  })
})

describe('endedOutput', () => {
  const output: TaskOutput = { status: 'running', type: 'explore', description: 'Look', modelRef: 'mock:echo', steps: [], stepsOmitted: 0, report: 'so far', startedAt: 1 }

  it('sets the status, keeps the report, adds the finish time unless the child set one, and replaces the error', () => {
    expect(endedOutput(output, 'aborted', 9, 'stopped')).toEqual({ ...output, status: 'aborted', finishedAt: 9, error: 'stopped' })
    expect(endedOutput({ ...output, status: 'failed', finishedAt: 5, error: 'boom' }, 'failed', 9)).toEqual({ ...output, status: 'failed', finishedAt: 5, error: 'boom' })
    expect(endedOutput({ ...output, error: 'old' }, 'limit', 9, 'new')).toMatchObject({ status: 'limit', error: 'new' })
    expect(endedOutput(output, 'completed', 9)).not.toHaveProperty('error')
  })
})
