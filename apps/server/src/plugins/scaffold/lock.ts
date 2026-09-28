// Per-key serialization of the file operations of one plugin (stale check + write + re-pin, builds), so two editor tabs
// cannot interleave their read-modify-write sequences.

export type KeyedLock = <T>(key: string, run: () => Promise<T>) => Promise<T>

/** Runs `run` after every earlier operation with the same key settled (successfully or not). */
export function createKeyedLock(): KeyedLock {
  const tails = new Map<string, Promise<unknown>>()
  return <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve()
    const result = previous.then(run)
    const tail = result.then(() => undefined, () => undefined)
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail)
        tails.delete(key)
    })
    return result
  }
}
