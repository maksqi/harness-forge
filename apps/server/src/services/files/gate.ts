// The store gate of the files service (ADR-035, ARCHITECTURE.md 6.15): a shared / exclusive lock in memory. `upload`,
// `importFile` and `saveGenerated` hold it shared around their blob write + row insert (+ pin); `sweep` and `purge` hold
// it exclusively, so they never see a blob whose row is not inserted yet, and a pin is always in place before the sweep
// picks its candidates.
//
// Waiters are served in arrival order: a shared request that arrives while an exclusive request waits queues behind it,
// so a stream of uploads cannot starve a sweep. Not re-entrant: taking the gate again from inside an operation that
// holds it can deadlock as soon as an exclusive request is queued in between.

export interface StoreGate {
  /** Runs `operation` holding the gate shared (together with other shared holders, never with an exclusive one). */
  readonly shared: <T>(operation: () => Promise<T>) => Promise<T>
  /** Runs `operation` holding the gate alone. */
  readonly exclusive: <T>(operation: () => Promise<T>) => Promise<T>
  /** Current holders and waiters (tests). */
  readonly state: () => { shared: number, exclusive: boolean, waiting: number }
}

type Mode = 'shared' | 'exclusive'

interface Waiter {
  mode: Mode
  grant: () => void
}

export function createStoreGate(): StoreGate {
  let sharedHolders = 0
  let exclusiveHeld = false
  const queue: Waiter[] = []

  function canEnter(mode: Mode): boolean {
    return mode === 'shared' ? !exclusiveHeld : !exclusiveHeld && sharedHolders === 0
  }

  function enter(mode: Mode): void {
    if (mode === 'shared')
      sharedHolders += 1
    else
      exclusiveHeld = true
  }

  /** Grants the waiters at the head of the queue that can enter now (consecutive shared ones together). */
  function drain(): void {
    while (queue.length > 0) {
      const head = queue[0]!
      if (!canEnter(head.mode))
        return
      queue.shift()
      enter(head.mode)
      head.grant()
      if (head.mode === 'exclusive')
        return
    }
  }

  function acquire(mode: Mode): Promise<void> | null {
    // Queue behind earlier waiters even when the gate is free for this mode (arrival order).
    if (queue.length === 0 && canEnter(mode)) {
      enter(mode)
      return null
    }
    return new Promise<void>((resolve) => {
      queue.push({ mode, grant: resolve })
    })
  }

  function release(mode: Mode): void {
    if (mode === 'shared')
      sharedHolders -= 1
    else
      exclusiveHeld = false
    drain()
  }

  async function run<T>(mode: Mode, operation: () => Promise<T>): Promise<T> {
    const waiting = acquire(mode)
    if (waiting !== null)
      await waiting
    try {
      return await operation()
    }
    finally {
      release(mode)
    }
  }

  return {
    shared: operation => run('shared', operation),
    exclusive: operation => run('exclusive', operation),
    state: () => ({ shared: sharedHolders, exclusive: exclusiveHeld, waiting: queue.length }),
  }
}
