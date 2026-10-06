// A counting semaphore with first-come waits that an abort signal can leave (Phase 11, ADR-048): the hook service holds
// one (`LIMITS.hookProcessesMax` slots), so at most 16 command hook processes of the whole server run at once; the other
// hooks wait, acquired with their run's signal (a stopped run leaves the queue without ever spawning).

export interface Semaphore {
  /**
   * Resolves with a release function once a slot is free (waiters are served in arrival order); rejects with the
   * signal's reason when it aborts first (also when it is aborted already). Releasing twice is a no-op.
   */
  readonly acquire: (signal?: AbortSignal) => Promise<() => void>
  /** Slots in use. */
  readonly active: () => number
  /** Callers waiting for a slot. */
  readonly waiting: () => number
}

interface Waiter {
  readonly grant: () => void
}

export function createSemaphore(max: number): Semaphore {
  const limit = Math.max(1, Math.floor(Number.isFinite(max) ? max : 1))
  const queue: Waiter[] = []
  let active = 0

  function releaser(): () => void {
    let released = false
    return () => {
      if (released)
        return
      released = true
      active -= 1
      drain()
    }
  }

  function drain(): void {
    while (active < limit && queue.length > 0) {
      const waiter = queue.shift() as Waiter
      active += 1
      waiter.grant()
    }
  }

  function acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true)
      return Promise.reject(signal.reason)
    if (active < limit && queue.length === 0) {
      active += 1
      return Promise.resolve(releaser())
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort)
          resolve(releaser())
        },
      }
      function onAbort(): void {
        const index = queue.indexOf(waiter)
        if (index !== -1)
          queue.splice(index, 1)
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      queue.push(waiter)
    })
  }

  return { acquire, active: () => active, waiting: () => queue.length }
}
