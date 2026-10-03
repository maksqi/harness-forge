// `<dataDir>/server.lock` (Phase 7, ADR-034, ARCHITECTURE.md 5 and 6.14): `{ pid, hostname, port, startedAt }` of the
// running server, so the offline `rotate-key` CLI refuses to touch a data directory a server is using. Owner: W7.7
// (W7.7-T2); C16 stub with the final signatures.
//
// `main.ts` calls `acquireServerLock` right after the data directory exists and `release()` at shutdown (after the
// database is closed) and when the boot fails. The stub writes nothing: W7.7 writes the file (mode 0600) and removes it
// on release when it still names this process.
import type { Env } from '../../env.ts'
import type { Logger } from '../../logger.ts'
import { join } from 'node:path'

/** File name of the lock inside the data directory. */
export const SERVER_LOCK_FILE = 'server.lock'

/** Content of `server.lock`. */
export interface ServerLockInfo {
  pid: number
  hostname: string
  port: number
  /** ms */
  startedAt: number
}

/** The lock held by this process. */
export interface ServerLock {
  /** `<dataDir>/server.lock`. */
  readonly path: string
  /** Removes the lock (idempotent; never throws, a failure is logged). */
  readonly release: () => void
}

export interface ServerLockInput {
  readonly env: Pick<Env, 'paths' | 'port'>
  readonly logger: Logger
}

/** `<dataDir>/server.lock`. */
export function serverLockPath(env: Pick<Env, 'paths'>): string {
  return join(env.paths.root, SERVER_LOCK_FILE)
}

/**
 * Takes the server lock of the data directory (synchronous: it runs during the boot and the release may run in an exit
 * path). Stub: returns the handle without writing the file (W7.7-T2).
 */
export function acquireServerLock(input: ServerLockInput): ServerLock {
  const path = serverLockPath(input.env)
  let released = false
  return {
    path,
    release: () => {
      if (released)
        return
      released = true
    },
  }
}
