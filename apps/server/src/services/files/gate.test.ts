// The store gate of the files service (W7.8-T2): shared holders together, an exclusive holder alone, arrival order,
// release on failure.
import { describe, expect, it } from 'vitest'
import { createStoreGate } from './gate.ts'

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Lets every pending microtask and timer callback run. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('store gate', () => {
  it('runs shared holders together and an exclusive holder alone, after them', async () => {
    const gate = createStoreGate()
    const log: string[] = []
    const first = deferred()
    const second = deferred()
    const a = gate.shared(async () => {
      log.push('a start')
      await first.promise
      log.push('a end')
    })
    const b = gate.shared(async () => {
      log.push('b start')
      await second.promise
      log.push('b end')
    })
    const x = gate.exclusive(async () => {
      log.push('x')
      return 42
    })
    await settle()
    expect(log).toEqual(['a start', 'b start'])
    expect(gate.state()).toEqual({ shared: 2, exclusive: false, waiting: 1 })
    first.resolve()
    await settle()
    expect(log).toEqual(['a start', 'b start', 'a end'])
    second.resolve()
    expect(await x).toBe(42)
    await Promise.all([a, b])
    expect(log).toEqual(['a start', 'b start', 'a end', 'b end', 'x'])
    expect(gate.state()).toEqual({ shared: 0, exclusive: false, waiting: 0 })
  })

  it('serves waiters in arrival order: a shared request behind a waiting exclusive one waits for it', async () => {
    const gate = createStoreGate()
    const log: string[] = []
    const hold = deferred()
    const exclusiveHold = deferred()
    const first = gate.shared(async () => {
      await hold.promise
      log.push('first shared')
    })
    const sweep = gate.exclusive(async () => {
      log.push('exclusive start')
      await exclusiveHold.promise
      log.push('exclusive end')
    })
    const late = gate.shared(async () => {
      log.push('late shared')
    })
    const other = gate.exclusive(async () => {
      log.push('second exclusive')
    })
    await settle()
    expect(log).toEqual([])
    hold.resolve()
    await settle()
    expect(log).toEqual(['first shared', 'exclusive start'])
    exclusiveHold.resolve()
    await Promise.all([first, sweep, late, other])
    expect(log).toEqual(['first shared', 'exclusive start', 'exclusive end', 'late shared', 'second exclusive'])
  })

  it('takes the gate when called, so a request made right after an exclusive one waits for it', async () => {
    const gate = createStoreGate()
    const log: string[] = []
    const x = gate.exclusive(async () => {
      log.push('exclusive')
    })
    const s = gate.shared(async () => {
      log.push('shared')
    })
    expect(gate.state()).toEqual({ shared: 0, exclusive: true, waiting: 1 })
    await Promise.all([x, s])
    expect(log).toEqual(['exclusive', 'shared'])
  })

  it('releases the gate when the operation fails and rethrows the error unchanged', async () => {
    const gate = createStoreGate()
    const failure = new Error('boom')
    await expect(gate.exclusive(async () => {
      throw failure
    })).rejects.toBe(failure)
    await expect(gate.shared(async () => {
      throw failure
    })).rejects.toBe(failure)
    expect(gate.state()).toEqual({ shared: 0, exclusive: false, waiting: 0 })
    expect(await gate.exclusive(async () => 'free')).toBe('free')
  })
})
