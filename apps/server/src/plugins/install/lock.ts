// Small async concurrency helpers of the installer: a mutex around commits (two installs never swap directories at
// the same time) and a semaphore around staging (archives are expanded in memory, so only a few run at once).

export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>

/** Runs at most `size` tasks at a time, in call order. A finished task hands its slot to the next waiting one. */
export function createSemaphore(size: number): Limiter {
  let running = 0
  const waiting: Array<() => void> = []
  const acquire = async (): Promise<void> => {
    if (running < size) {
      running += 1
      return
    }
    await new Promise<void>(resolve => waiting.push(resolve))
  }
  const release = (): void => {
    const next = waiting.shift()
    if (next)
      next()
    else
      running -= 1
  }
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    await acquire()
    try {
      return await fn()
    }
    finally {
      release()
    }
  }
}

/** Runs one task at a time. */
export function createMutex(): Limiter {
  return createSemaphore(1)
}
