// `<dataDir>/server.lock` (Phase 7, ADR-034, ARCHITECTURE.md 5 and 6.14): `{ pid, hostname, port, startedAt }` of the
// running server, so the offline `rotate-key` CLI refuses to touch a data directory a server is using. Owner: W7.7
// (W7.7-T2).
//
// `main.ts` calls `acquireServerLock` right after the data directory exists and `release()` at shutdown (after the
// database is closed) and when the boot fails. The file is written atomically (a temporary file renamed into place,
// mode 0600) and replaces a lock left by a process that died; a lock naming another live process on this host is
// replaced too, with a warning (the server never refuses to start because of it). `release()` removes the file only
// while it still names this process, so a lock taken over by a newer server is never removed.
import type { Env } from '../../env.ts'
import type { Logger } from '../../logger.ts'
import { randomBytes } from 'node:crypto'
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import { syncDirectory } from '../../security/keyring.ts'

/** File name of the lock inside the data directory. */
export const SERVER_LOCK_FILE = 'server.lock'

/** Permissions of the lock file. */
export const SERVER_LOCK_MODE = 0o600

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
  /** Process facts (tests); default: this process. */
  readonly pid?: number
  readonly hostname?: string
  readonly now?: () => number
}

const serverLockSchema = z.object({
  pid: z.int().min(1),
  hostname: z.string().min(1).max(255),
  port: z.int().min(0).max(65_535),
  startedAt: z.int().min(0),
})

/** `<dataDir>/server.lock`. */
export function serverLockPath(env: Pick<Env, 'paths'>): string {
  return join(env.paths.root, SERVER_LOCK_FILE)
}

/** The host name recorded in (and compared with) the lock. */
export function currentHostname(): string {
  return osHostname()
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * Reads a lock file: `null` when there is none, `'invalid'` when it exists but is not a lock this server wrote (or
 * cannot be read), else its content.
 */
export function readServerLock(path: string): ServerLockInfo | 'invalid' | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  }
  catch (error) {
    return errorCode(error) === 'ENOENT' ? null : 'invalid'
  }
  try {
    const parsed = serverLockSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : 'invalid'
  }
  catch {
    return 'invalid'
  }
}

/** True when a process with this pid exists on this host (`EPERM`: it exists but belongs to another user). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return false
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return errorCode(error) === 'EPERM'
  }
}

/** Writes `info` atomically (temporary file + rename), mode 0600. */
function writeLock(path: string, info: ServerLockInfo): void {
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(info)}\n`, { mode: SERVER_LOCK_MODE, flag: 'wx' })
    renameSync(temp, path)
  }
  catch (error) {
    try {
      unlinkSync(temp)
    }
    catch {
      // Already gone.
    }
    throw error
  }
}

/**
 * Takes the server lock of the data directory (synchronous: it runs during the boot and the release may run in an exit
 * path). Throws when the file cannot be written (the boot fails with exit code 1).
 */
export function acquireServerLock(input: ServerLockInput): ServerLock {
  const logger = input.logger.child({ component: 'keys' })
  const path = serverLockPath(input.env)
  const info: ServerLockInfo = {
    pid: input.pid ?? process.pid,
    hostname: input.hostname ?? currentHostname(),
    port: input.env.port,
    startedAt: (input.now ?? Date.now)(),
  }

  const previous = readServerLock(path)
  if (previous !== null && previous !== 'invalid' && previous.pid !== info.pid) {
    if (previous.hostname !== info.hostname)
      logger.warn('server.lock names a server on another host; it is replaced', { path, hostname: previous.hostname, pid: previous.pid })
    else if (isProcessAlive(previous.pid))
      logger.warn('server.lock names another running process; it is replaced (two servers must not share a data directory)', { path, pid: previous.pid })
    else
      logger.debug('replacing a stale server.lock', { path, pid: previous.pid })
  }
  writeLock(path, info)
  syncDirectory(input.env.paths.root)

  let released = false
  return {
    path,
    release: () => {
      if (released)
        return
      released = true
      try {
        const current = readServerLock(path)
        // Only our own lock: a newer server may have replaced it meanwhile.
        if (current === null || current === 'invalid' || current.pid !== info.pid || current.startedAt !== info.startedAt)
          return
        unlinkSync(path)
      }
      catch (error) {
        if (errorCode(error) !== 'ENOENT')
          logger.warn('cannot remove server.lock', { path, err: error })
      }
    },
  }
}
