// `server.lock` (W7.7-T2, ADR-034): written after the data directory exists with `{ pid, hostname, port, startedAt }`
// (mode 0600), removed on release only while it still names this process; a stale or foreign lock is replaced.
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { loadEnv } from '../../env.ts'
import { createMemoryLogger } from '../../logger.ts'
import { acquireServerLock, currentHostname, isProcessAlive, readServerLock, SERVER_LOCK_FILE, serverLockPath } from './server-lock.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function setup(port = 8797) {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'hf-lock-')))
  dirs.push(dataDir)
  const env = loadEnv({ HF_DATA_DIR: dataDir, HF_PORT: String(port) }, { cwd: dataDir })
  const logs = createMemoryLogger()
  return { env, logs, path: join(dataDir, SERVER_LOCK_FILE) }
}

/** A pid that is not running (far above any real pid on CI machines). */
const DEAD_PID = 2 ** 22 + 12_345

describe('acquireServerLock', () => {
  it('writes { pid, hostname, port, startedAt } with mode 0600 and removes it on release', () => {
    const { env, logs, path } = setup()
    const lock = acquireServerLock({ env, logger: logs.logger, now: () => 1234 })
    expect(lock.path).toBe(path)
    expect(serverLockPath(env)).toBe(path)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ pid: process.pid, hostname: currentHostname(), port: 8797, startedAt: 1234 })
    expect(readServerLock(path)).toEqual({ pid: process.pid, hostname: currentHostname(), port: 8797, startedAt: 1234 })
    if (process.platform !== 'win32')
      expect(statSync(path).mode & 0o777).toBe(0o600)
    lock.release()
    expect(existsSync(path)).toBe(false)
    // Idempotent.
    lock.release()
  })

  it('replaces a stale lock silently and a lock of another live process with a warning', () => {
    const { env, logs, path } = setup()
    writeFileSync(path, JSON.stringify({ pid: DEAD_PID, hostname: currentHostname(), port: 1, startedAt: 1 }))
    acquireServerLock({ env, logger: logs.logger }).release()
    expect(logs.records.filter(record => record.level === 'warn')).toEqual([])

    // The parent process (the test runner's) is alive on this host.
    writeFileSync(path, JSON.stringify({ pid: process.ppid, hostname: currentHostname(), port: 1, startedAt: 1 }))
    const lock = acquireServerLock({ env, logger: logs.logger })
    expect(logs.records.find(record => record.level === 'warn')?.msg).toContain('another running process')
    expect(readServerLock(path)).toMatchObject({ pid: process.pid })
    lock.release()

    writeFileSync(path, JSON.stringify({ pid: 7, hostname: 'elsewhere.example', port: 1, startedAt: 1 }))
    acquireServerLock({ env, logger: logs.logger }).release()
    expect(logs.records.some(record => String(record.msg).includes('another host'))).toBe(true)
  })

  it('release never removes a lock that a newer server took over', () => {
    const { env, logs, path } = setup()
    const lock = acquireServerLock({ env, logger: logs.logger, now: () => 1 })
    writeFileSync(path, JSON.stringify({ pid: process.pid, hostname: currentHostname(), port: 8797, startedAt: 2 }))
    lock.release()
    expect(existsSync(path)).toBe(true)
  })

  it('release tolerates a lock that is already gone', () => {
    const { env, logs, path } = setup()
    const lock = acquireServerLock({ env, logger: logs.logger })
    rmSync(path)
    expect(() => lock.release()).not.toThrow()
    expect(logs.records.filter(record => record.level === 'warn')).toEqual([])
  })
})

describe('readServerLock and isProcessAlive', () => {
  it('reads null for no file and invalid for anything that is not a lock', () => {
    const { path } = setup()
    expect(readServerLock(path)).toBeNull()
    for (const text of ['', 'nope', '{}', JSON.stringify({ pid: 0, hostname: 'h', port: 1, startedAt: 1 })]) {
      writeFileSync(path, text)
      expect(readServerLock(path)).toBe('invalid')
    }
  })

  it('tells a live process from a dead one', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(DEAD_PID)).toBe(false)
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
  })
})
