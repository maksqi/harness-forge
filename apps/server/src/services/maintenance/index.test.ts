// Maintenance lock (C16-T1): one operation at a time, `busy` for the others, released after a throw, `current()`, and
// the run blocking of `assertRunsAllowed`.
import { HarnessError } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import {
  assertRunsAllowed,
  createMaintenanceLock,
  KEY_ROTATION_RUNS_MESSAGE,
  MAINTENANCE_BUSY_MESSAGE,
  MAINTENANCE_RUNS_MESSAGE,
} from './index.ts'

const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of closers.splice(0))
    await close()
})

async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  }
  catch (error) {
    expect(error).toBeInstanceOf(HarnessError)
    return error as HarnessError
  }
  throw new Error('expected a rejection')
}

function deferred(): { promise: Promise<void>, resolve: () => void, reject: (error: Error) => void } {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('maintenance lock', () => {
  it('runs one operation, returns its result and reports it as current while it runs', async () => {
    const lock = createMaintenanceLock({ now: () => 42 })
    expect(lock.current()).toBeNull()
    const gate = deferred()
    const running = lock.exclusive('import', async () => {
      await gate.promise
      return 'done'
    })
    expect(lock.current()).toEqual({ kind: 'import', blockRuns: false, startedAt: 42 })
    expect(Object.isFrozen(lock.current())).toBe(true)
    gate.resolve()
    expect(await running).toBe('done')
    expect(lock.current()).toBeNull()
  })

  it('refuses every other operation with 409 busy while one runs (nested calls too), then accepts again', async () => {
    const lock = createMaintenanceLock()
    const gate = deferred()
    let nested: HarnessError | undefined
    const running = lock.exclusive('key-rotation', async () => {
      nested = await rejection(lock.exclusive('import', async () => 'nested'))
      await gate.promise
    }, { blockRuns: true })
    for (const kind of ['import', 'delete-all', 'key-rotation', 'file-cleanup'] as const) {
      let ran = false
      const busy = await rejection(lock.exclusive(kind, async () => {
        ran = true
      }))
      expect(ran).toBe(false)
      expect(busy.toJSON().error).toEqual({ code: 'conflict', message: MAINTENANCE_BUSY_MESSAGE, details: { reason: 'busy' } })
    }
    gate.resolve()
    await running
    expect(nested?.toJSON().error.details).toEqual({ reason: 'busy' })
    expect(await lock.exclusive('file-cleanup', async () => 7)).toBe(7)
  })

  it('releases the lock when the operation throws and rethrows the error unchanged', async () => {
    const lock = createMaintenanceLock()
    const failure = new Error('boom')
    await expect(lock.exclusive('delete-all', async () => {
      throw failure
    })).rejects.toBe(failure)
    expect(lock.current()).toBeNull()
    expect(await lock.exclusive('delete-all', async () => 'again')).toBe('again')
  })

  it('assertRunsAllowed refuses runs only while an operation with blockRuns holds the lock', async () => {
    const lock = createMaintenanceLock()
    expect(() => assertRunsAllowed(lock)).not.toThrow()
    const cleanup = deferred()
    const running = lock.exclusive('file-cleanup', () => cleanup.promise)
    expect(() => assertRunsAllowed(lock)).not.toThrow()
    cleanup.resolve()
    await running

    const rotation = deferred()
    const rotating = lock.exclusive('key-rotation', () => rotation.promise, { blockRuns: true })
    let refused: unknown
    try {
      assertRunsAllowed(lock)
    }
    catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(HarnessError)
    expect((refused as HarnessError).toJSON().error).toEqual({ code: 'conflict', message: KEY_ROTATION_RUNS_MESSAGE, details: { reason: 'busy' } })
    rotation.resolve()
    await rotating
    expect(() => assertRunsAllowed(lock)).not.toThrow()

    const other = deferred()
    const blocking = lock.exclusive('import', () => other.promise, { blockRuns: true })
    expect(() => assertRunsAllowed(lock)).toThrow(MAINTENANCE_RUNS_MESSAGE)
    other.resolve()
    await blocking
  })

  it('is wired as deps.maintenance', async () => {
    const t = await createTestApp({ start: false })
    closers.push(() => t.close())
    expect(t.deps.maintenance.current()).toBeNull()
    expect(await t.deps.maintenance.exclusive('import', async () => 'ok')).toBe('ok')
  })
})
