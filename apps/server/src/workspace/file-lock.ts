// The per-file lock of the agent workspace (Phase 8, ADR-036, ARCHITECTURE.md 6.13 / 6.16). FROZEN after P8-0b (C19,
// complete).
//
// `withFileLock(absolutePath, fn)` runs `fn` after every earlier holder of the same path finished: a process-wide
// promise chain per path, so journaled writes (`journaledWrite`: read the before-state -> produce -> store -> write ->
// journal row), restores (rewind, revert, undo) and the writes of other chats to the same file never interleave, and two
// `edit_file` calls on one file in one step see each other's result. Different paths run in parallel. A throw (or a
// rejection) releases the lock like a normal end; the map entry is removed once the chain is idle, so the map only
// holds paths with a holder or a waiter.
//
// Keys: callers pass the resolved absolute path of the target (`ResolvedWorkspacePath.absolute`, a realpath plus the
// missing tail), normalized here with `resolve`; two different spellings of one file (a case-insensitive filesystem, a
// hard link) are two locks. Not re-entrant: taking the lock of a path again inside its own `fn` waits forever. The lock
// works only inside the server process (a shell command or an editor is not serialized).
import { resolve } from 'node:path'

/** The tail of each path's chain: settles once its last holder released the lock. Never rejects. */
const chains = new Map<string, Promise<void>>()

/**
 * Runs `fn` holding the lock of `absolutePath` and resolves (or rejects) with its result. Waiters are served in call
 * order.
 */
export async function withFileLock<T>(absolutePath: string, fn: () => T | Promise<T>): Promise<T> {
  const key = resolve(absolutePath)
  const previous = chains.get(key) ?? Promise.resolve()
  let release!: () => void
  const held = new Promise<void>((done) => {
    release = done
  })
  const tail = previous.then(() => held)
  chains.set(key, tail)
  try {
    await previous
    return await fn()
  }
  finally {
    release()
    if (chains.get(key) === tail)
      chains.delete(key)
  }
}

/** Paths with a holder or a waiter right now (tests: an idle lock leaves nothing behind). */
export function heldFileLocks(): number {
  return chains.size
}
