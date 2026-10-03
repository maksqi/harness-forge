// The automatic file sweep (W8.7-T1, T2, T4; ADR-039, ARCHITECTURE.md 6.15): the pure due time, the timer (fake
// timers: off, daily, the 24 h boot delay, a manual cleanup pushing the next run back, weekly, busy retries, failures,
// switching modes, stop), and the real run through the data service (removed / kept files, the checkpoint folder,
// `_files.lastAutoSweep`, `FileSweepStatus`, the plugin data budget, abort on stop, the test delay variable, logs).
import type { FileSweepAttempt, FileSweepMode } from '@harness-forge/shared'
import type { AutoSweep, AutoSweepOutcome } from './auto-sweep.ts'
import type { FileSweepState } from './cleanup.ts'
import type { DataTestApp } from './fixtures.test-util.ts'
import type { DataServiceWithSweep } from './index.ts'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataCleanupPreviewSchema, dataSummarySchema, HarnessError } from '@harness-forge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { files } from '../../db/schema.ts'
import { envBootWarnings } from '../../env.ts'
import { createMemoryLogger } from '../../logger.ts'
import { DAY_MS, HOUR_MS, seedStoredFile, setMtime } from '../files/store.test-util.ts'
import { createAutoSweep, nextSweepAt, SWEEP_BOOT_DELAY_MS, SWEEP_BUSY_RETRY_MS, SWEEP_CHECK_INTERVAL_MS, SWEEP_INTERVAL_MS } from './auto-sweep.ts'
import { FILE_STATE_SETTING } from './cleanup.ts'
import { closeDataApps, dataApp } from './fixtures.test-util.ts'

const MINUTE_MS = 60 * 1000
const BOOT = Date.UTC(2026, 9, 1, 12)
const FILE_ID_TEXT = /file_[\dA-Za-z]{16}/

afterEach(async () => {
  vi.useRealTimers()
  await closeDataApps()
})

function useClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: BOOT })
}

const NONE: FileSweepState = { lastCleanup: null, lastAutoSweep: null }

function attempt(at: number, status: FileSweepAttempt['status']): FileSweepAttempt {
  return { at, status, reason: status === 'done' ? null : status === 'skipped' ? 'plugin-data-limit' : 'error', files: 0, diskBytes: 0 }
}

describe('nextSweepAt', () => {
  it('is null while off; daily / weekly wait at least 24 h after boot', () => {
    expect(nextSweepAt(NONE, 'off', BOOT)).toBeNull()
    expect(nextSweepAt({ lastCleanup: BOOT, lastAutoSweep: attempt(BOOT, 'failed') }, 'off', BOOT)).toBeNull()
    expect(nextSweepAt(NONE, 'daily', BOOT)).toBe(BOOT + DAY_MS)
    expect(nextSweepAt(NONE, 'weekly', BOOT)).toBe(BOOT + DAY_MS)
    expect(nextSweepAt({ lastCleanup: BOOT - 30 * DAY_MS, lastAutoSweep: null }, 'weekly', BOOT)).toBe(BOOT + DAY_MS)
    expect(nextSweepAt(NONE, 'daily', BOOT, 2000)).toBe(BOOT + 2000)
    expect(SWEEP_INTERVAL_MS).toEqual({ daily: DAY_MS, weekly: 7 * DAY_MS })
    expect([SWEEP_BOOT_DELAY_MS, SWEEP_CHECK_INTERVAL_MS, SWEEP_BUSY_RETRY_MS]).toEqual([DAY_MS, HOUR_MS, 10 * MINUTE_MS])
  })

  it('a cleanup (manual or automatic) pushes the next run one interval after it', () => {
    expect(nextSweepAt({ lastCleanup: BOOT + 20 * HOUR_MS, lastAutoSweep: null }, 'daily', BOOT)).toBe(BOOT + 44 * HOUR_MS)
    expect(nextSweepAt({ lastCleanup: BOOT - 2 * DAY_MS, lastAutoSweep: null }, 'weekly', BOOT)).toBe(BOOT + 5 * DAY_MS)
    // A done attempt also set `lastCleanup`: only `lastCleanup` counts.
    expect(nextSweepAt({ lastCleanup: BOOT + 2 * DAY_MS, lastAutoSweep: attempt(BOOT + 2 * DAY_MS, 'done') }, 'daily', BOOT)).toBe(BOOT + 3 * DAY_MS)
  })

  it('a failed or skipped attempt waits a full interval', () => {
    for (const status of ['failed', 'skipped'] as const) {
      expect(nextSweepAt({ lastCleanup: null, lastAutoSweep: attempt(BOOT + DAY_MS, status) }, 'daily', BOOT)).toBe(BOOT + 2 * DAY_MS)
      expect(nextSweepAt({ lastCleanup: BOOT, lastAutoSweep: attempt(BOOT + DAY_MS, status) }, 'weekly', BOOT)).toBe(BOOT + 8 * DAY_MS)
    }
  })
})

// ---------- the timer (a scripted run) ----------

interface TimerHarness {
  sweep: AutoSweep
  /** Times the run started. */
  runs: number[]
  /** Outcomes of the next runs (default `done`). */
  outcomes: AutoSweepOutcome[]
  mode: FileSweepMode
  state: FileSweepState
  /** `readMode` calls (one per check, plus `status()`). */
  checks: number
  /** Thrown by `readState` while set. */
  stateError: Error | null
  logs: ReturnType<typeof createMemoryLogger>
}

function timerHarness(mode: FileSweepMode, options: { run?: (signal: AbortSignal) => Promise<AutoSweepOutcome>, background?: boolean } = {}): TimerHarness {
  const logs = createMemoryLogger()
  const harness: TimerHarness = {
    runs: [],
    outcomes: [],
    mode,
    state: NONE,
    checks: 0,
    stateError: null,
    logs,
    sweep: createAutoSweep({
      now: () => Date.now(),
      background: options.background ?? true,
      bootDelayMs: SWEEP_BOOT_DELAY_MS,
      checkIntervalMs: SWEEP_CHECK_INTERVAL_MS,
      busyRetryMs: SWEEP_BUSY_RETRY_MS,
      readMode: async () => {
        harness.checks += 1
        return harness.mode
      },
      readState: async () => {
        if (harness.stateError !== null)
          throw harness.stateError
        return harness.state
      },
      run: options.run ?? (async () => {
        const at = Date.now()
        harness.runs.push(at)
        const outcome = harness.outcomes.shift() ?? 'done'
        if (outcome === 'done')
          harness.state = { lastCleanup: at, lastAutoSweep: attempt(at, 'done') }
        else if (outcome === 'failed' || outcome === 'skipped')
          harness.state = { ...harness.state, lastAutoSweep: attempt(at, outcome) }
        return outcome
      }),
      logger: logs.logger,
    }),
  }
  return harness
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('createAutoSweep: the timer', () => {
  it('off: checks hourly but runs nothing in 30 days', async () => {
    useClock()
    const h = timerHarness('off')
    h.sweep.start()
    expect(h.sweep.nextCheckAt()).toBe(BOOT + DAY_MS)
    await advance(30 * DAY_MS)
    expect(h.runs).toEqual([])
    expect(h.checks).toBe(29 * 24 + 1)
    expect((await h.sweep.status()).nextRunAt).toBeNull()
    await h.sweep.stop()
  })

  it('daily: nothing at 23:59 after boot, a run at 24 h, then one per day', async () => {
    useClock()
    const h = timerHarness('daily')
    h.sweep.start()
    await advance(DAY_MS - MINUTE_MS)
    expect(h.runs).toEqual([])
    expect(h.checks).toBe(0)
    await advance(MINUTE_MS)
    expect(h.runs).toEqual([BOOT + DAY_MS])
    await advance(DAY_MS)
    expect(h.runs).toEqual([BOOT + DAY_MS, BOOT + 2 * DAY_MS])
    await h.sweep.stop()
  })

  it('a manual cleanup pushes the next run back', async () => {
    useClock()
    const h = timerHarness('daily')
    h.sweep.start()
    await advance(20 * HOUR_MS)
    h.state = { lastCleanup: Date.now(), lastAutoSweep: null }
    await advance(4 * HOUR_MS)
    expect(h.runs).toEqual([])
    await advance(20 * HOUR_MS - MINUTE_MS)
    expect(h.runs).toEqual([])
    await advance(MINUTE_MS)
    expect(h.runs).toEqual([BOOT + 44 * HOUR_MS])
    await h.sweep.stop()
  })

  it('weekly: the first run 24 h after boot when the last cleanup is old enough, then every 7 days', async () => {
    useClock()
    const h = timerHarness('weekly')
    h.state = { lastCleanup: BOOT - 3 * DAY_MS, lastAutoSweep: null }
    h.sweep.start()
    await advance(4 * DAY_MS)
    expect(h.runs).toEqual([BOOT + 4 * DAY_MS])
    await advance(7 * DAY_MS - HOUR_MS)
    expect(h.runs).toHaveLength(1)
    await advance(HOUR_MS)
    expect(h.runs).toEqual([BOOT + 4 * DAY_MS, BOOT + 11 * DAY_MS])
    await h.sweep.stop()
  })

  it('busy: retried after 10 minutes with nothing stored', async () => {
    useClock()
    const h = timerHarness('daily')
    h.outcomes.push('busy', 'busy')
    h.sweep.start()
    await advance(DAY_MS)
    expect(h.runs).toEqual([BOOT + DAY_MS])
    expect(h.state).toEqual(NONE)
    expect(h.sweep.nextCheckAt()).toBe(BOOT + DAY_MS + 10 * MINUTE_MS)
    await advance(20 * MINUTE_MS)
    expect(h.runs).toEqual([BOOT + DAY_MS, BOOT + DAY_MS + 10 * MINUTE_MS, BOOT + DAY_MS + 20 * MINUTE_MS])
    expect(h.state.lastAutoSweep?.status).toBe('done')
    await h.sweep.stop()
  })

  it('a failure or a skip waits a full interval before the next attempt', async () => {
    useClock()
    const h = timerHarness('daily')
    h.outcomes.push('failed', 'skipped')
    h.sweep.start()
    await advance(DAY_MS)
    expect(h.state.lastAutoSweep).toMatchObject({ at: BOOT + DAY_MS, status: 'failed' })
    await advance(DAY_MS - HOUR_MS)
    expect(h.runs).toHaveLength(1)
    await advance(HOUR_MS)
    expect(h.state.lastAutoSweep).toMatchObject({ at: BOOT + 2 * DAY_MS, status: 'skipped' })
    await advance(DAY_MS)
    expect(h.runs).toEqual([BOOT + DAY_MS, BOOT + 2 * DAY_MS, BOOT + 3 * DAY_MS])
    expect(h.state.lastAutoSweep?.status).toBe('done')
    await h.sweep.stop()
  })

  it('switching from off to daily applies at the next hourly check; back to off stops the runs', async () => {
    useClock()
    const h = timerHarness('off')
    h.sweep.start()
    await advance(3 * DAY_MS + 10 * MINUTE_MS)
    h.mode = 'daily'
    await advance(50 * MINUTE_MS - 1)
    expect(h.runs).toEqual([])
    await advance(1)
    expect(h.runs).toEqual([BOOT + 3 * DAY_MS + HOUR_MS])
    h.mode = 'off'
    await advance(5 * DAY_MS)
    expect(h.runs).toHaveLength(1)
    await h.sweep.stop()
  })

  it('stop() aborts a run in flight, waits for it and no check runs after it; start() is then a no-op', async () => {
    useClock()
    let signal: AbortSignal | undefined
    const h = timerHarness('daily', {
      run: async (runSignal) => {
        signal = runSignal
        await new Promise(resolve => runSignal.addEventListener('abort', resolve))
        return 'aborted'
      },
    })
    h.sweep.start()
    await advance(DAY_MS)
    expect(signal?.aborted).toBe(false)
    const checks = h.checks
    await h.sweep.stop()
    expect(signal?.aborted).toBe(true)
    expect(h.sweep.nextCheckAt()).toBeNull()
    h.sweep.start()
    await advance(7 * DAY_MS)
    expect(h.checks).toBe(checks)
    expect(vi.getTimerCount()).toBe(0)
    await h.sweep.stop()
  })

  it('a check that fails is logged (code only) and the next one is still scheduled', async () => {
    useClock()
    const h = timerHarness('daily')
    h.sweep.start()
    h.stateError = new HarnessError({ code: 'internal_error', message: 'database is gone: /secret/path' })
    await advance(DAY_MS)
    expect(h.runs).toEqual([])
    expect(h.logs.records.find(record => record.msg === 'automatic file sweep check failed')).toMatchObject({ level: 'warn', code: 'internal_error' })
    h.stateError = null
    await advance(HOUR_MS)
    expect(h.runs).toEqual([BOOT + DAY_MS + HOUR_MS])
    expect(h.logs.text()).not.toContain('/secret/path')
    await h.sweep.stop()
  })

  it('status: nextRunAt is the first check at or after the due time while the timer runs, else the due time', async () => {
    useClock()
    const h = timerHarness('daily')
    expect(await h.sweep.status()).toEqual({ mode: 'daily', lastAttempt: null, nextRunAt: BOOT + DAY_MS })
    h.sweep.start()
    expect((await h.sweep.status()).nextRunAt).toBe(BOOT + DAY_MS)
    await advance(20 * HOUR_MS + 30 * MINUTE_MS)
    h.state = { lastCleanup: Date.now(), lastAutoSweep: null }
    // Due at 44:30; the checks come at 24:00, 25:00, ...: the first one after that is 45:00.
    expect((await h.sweep.status()).nextRunAt).toBe(BOOT + 45 * HOUR_MS)
    await advance(25 * HOUR_MS)
    expect(h.runs).toEqual([BOOT + 45 * HOUR_MS])
    expect(await h.sweep.status()).toEqual({ mode: 'daily', lastAttempt: attempt(BOOT + 45 * HOUR_MS, 'done'), nextRunAt: BOOT + 69 * HOUR_MS })
    h.mode = 'off'
    expect((await h.sweep.status()).nextRunAt).toBeNull()
    await h.sweep.stop()
    h.mode = 'daily'
    expect((await h.sweep.status()).nextRunAt).toBe(BOOT + 69 * HOUR_MS)

    // Without `background` (Vitest's default) nothing is scheduled: the due time itself.
    const quiet = timerHarness('weekly', { background: false })
    quiet.sweep.start()
    expect(quiet.sweep.nextCheckAt()).toBeNull()
    expect((await quiet.sweep.status()).nextRunAt).toBe(Date.now() + DAY_MS)
    await advance(30 * DAY_MS)
    expect(quiet.checks).toBe(1)
    await quiet.sweep.stop()
  })
})

// ---------- the real run through the data service ----------

const CHECKPOINT_SHA = 'ab'.repeat(32)

async function sweepApp(options: Parameters<typeof dataApp>[0] = {}): Promise<{ app: DataTestApp, sweep: AutoSweep }> {
  useClock()
  const app = await dataApp({ ...options, data: { background: true, ...options.data } })
  return { app, sweep: (app.deps.data as DataServiceWithSweep).autoSweep }
}

/** Advances the fake clock in steps, waiting for each check's real I/O to settle. */
async function step(sweep: AutoSweep, total: number, size = HOUR_MS): Promise<void> {
  for (let left = total; left > 0; left -= size) {
    await vi.advanceTimersByTimeAsync(Math.min(size, left))
    await sweep.idle()
  }
}

async function fileIds(app: DataTestApp): Promise<string[]> {
  return (await app.t.db.select({ id: files.id }).from(files)).map(row => row.id).sort()
}

function writePluginData(app: DataTestApp, rel: string, content: string): void {
  const path = join(app.t.env.paths.pluginData, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function writeCheckpointBlob(app: DataTestApp): string {
  const path = join(app.t.env.paths.checkpoints, CHECKPOINT_SHA.slice(0, 2), CHECKPOINT_SHA)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'Turn 1\n')
  setMtime(path, BOOT - 30 * DAY_MS)
  return path
}

describe('the automatic sweep in the data service', () => {
  it('daily: removes the unreferenced orphan at 24 h, keeps one a plugin file references, never touches checkpoints', async () => {
    const { app, sweep } = await sweepApp()
    const old = BOOT - 3 * DAY_MS
    const orphan = await seedStoredFile(app.deps, new TextEncoder().encode('orphan bytes'), { createdAt: old, name: 'private-plan.txt' })
    const inPluginData = await seedStoredFile(app.deps, new TextEncoder().encode('plugin bytes'), { createdAt: old, name: 'plugin.txt' })
    writePluginData(app, 'p/state.json', JSON.stringify({ last: inPluginData.id }))
    const checkpoint = writeCheckpointBlob(app)
    await app.deps.settings.update({ fileSweep: 'daily' })
    await app.deps.data.start()

    await step(sweep, DAY_MS - MINUTE_MS)
    expect(await fileIds(app)).toEqual([orphan.id, inPluginData.id].sort())
    await step(sweep, MINUTE_MS)
    expect(await fileIds(app)).toEqual([inPluginData.id])
    expect(existsSync(checkpoint)).toBe(true)
    const done = { at: BOOT + DAY_MS, status: 'done', reason: null, files: 1, diskBytes: 'orphan bytes'.length }
    expect(await app.deps.settings.getInternal(FILE_STATE_SETTING)).toEqual({ lastCleanup: BOOT + DAY_MS, lastAutoSweep: done })

    const summary = dataSummarySchema.parse(await (await app.t.request('/api/data')).json())
    expect(summary.fileSweep).toEqual({ mode: 'daily', lastAttempt: done, nextRunAt: BOOT + 2 * DAY_MS })
    const preview = dataCleanupPreviewSchema.parse(await (await app.t.request('/api/data/cleanup')).json())
    expect(preview).toMatchObject({ files: 0, lastRunAt: BOOT + DAY_MS, fileSweep: summary.fileSweep, pluginData: 'complete' })

    expect(app.t.logs.records.find(record => record.msg === 'automatic file sweep finished')).toMatchObject({
      level: 'info',
      trigger: 'auto',
      files: 1,
      recentFiles: 0,
      pluginData: 'complete',
      pluginDataFiles: 1,
      pluginDataBytes: JSON.stringify({ last: inPluginData.id }).length,
    })
    const logs = app.t.logs.text()
    expect(logs).not.toMatch(FILE_ID_TEXT)
    expect(logs).not.toContain('private-plan')
    expect(logs).not.toContain(app.t.env.paths.pluginData)
  })

  it('a manual cleanup pushes the next automatic run back a full day', async () => {
    const { app, sweep } = await sweepApp()
    await app.deps.settings.update({ fileSweep: 'daily' })
    await app.deps.data.start()
    await step(sweep, 20 * HOUR_MS)
    const manual = await app.deps.data.cleanup()
    expect(manual.ranAt).toBe(BOOT + 20 * HOUR_MS)
    await step(sweep, 24 * HOUR_MS - MINUTE_MS)
    expect(await app.deps.settings.getInternal(FILE_STATE_SETTING)).toEqual({ lastCleanup: BOOT + 20 * HOUR_MS })
    await step(sweep, MINUTE_MS, MINUTE_MS)
    expect(await app.deps.settings.getInternal(FILE_STATE_SETTING)).toMatchObject({ lastCleanup: BOOT + 44 * HOUR_MS, lastAutoSweep: { status: 'done' } })
    expect(app.t.logs.records.find(record => record.msg === 'orphaned files cleaned up')).toMatchObject({ trigger: 'manual' })
  })

  it('busy: another data task holds the lock, so nothing is stored and it runs 10 minutes later', async () => {
    const { app, sweep } = await sweepApp()
    await app.deps.settings.update({ fileSweep: 'daily' })
    await app.deps.data.start()
    await step(sweep, DAY_MS - MINUTE_MS)
    let release!: () => void
    const holder = app.deps.maintenance.exclusive('import', () => new Promise<void>((resolve) => {
      release = resolve
    }))
    await step(sweep, MINUTE_MS, MINUTE_MS)
    expect(await app.deps.settings.getInternal(FILE_STATE_SETTING)).toBeUndefined()
    expect(app.t.logs.records.find(record => record.msg === 'automatic file sweep postponed: another data task is running')).toMatchObject({ level: 'debug' })
    release()
    await holder
    await step(sweep, 10 * MINUTE_MS - 1, MINUTE_MS)
    expect(await app.deps.settings.getInternal(FILE_STATE_SETTING)).toBeUndefined()
    await step(sweep, 1, 1)
    expect(await app.deps.settings.getInternal(FILE_STATE_SETTING)).toMatchObject({ lastAutoSweep: { at: BOOT + DAY_MS + 10 * MINUTE_MS, status: 'done' } })
  })

  it('a failure is stored and warned (no path), and retried only after a full interval', async () => {
    let calls = 0
    const { app, sweep } = await sweepApp({
      files: inner => ({
        ...inner,
        sweep: async (input) => {
          calls += 1
          if (calls === 1)
            throw Object.assign(new Error(`EIO: i/o error, unlink '/private/data/files/aa/${'a'.repeat(64)}'`), { code: 'EIO' })
          return inner.sweep(input)
        },
      }),
    })
    await app.deps.settings.update({ fileSweep: 'daily' })
    await app.deps.data.start()
    await step(sweep, DAY_MS)
    const failed = { at: BOOT + DAY_MS, status: 'failed', reason: 'error', files: 0, diskBytes: 0 }
    expect(await app.deps.settings.getInternal(FILE_STATE_SETTING)).toEqual({ lastAutoSweep: failed })
    expect(app.deps.maintenance.current()).toBeNull()
    expect(app.t.logs.records.find(record => record.msg === 'automatic file sweep failed')).toMatchObject({ level: 'warn', code: 'EIO' })
    expect(app.t.logs.text()).not.toContain('/private/data/files')
    expect((await app.deps.data.summary()).fileSweep).toEqual({ mode: 'daily', lastAttempt: failed, nextRunAt: BOOT + 2 * DAY_MS })
    await step(sweep, DAY_MS - HOUR_MS)
    expect(calls).toBe(1)
    await step(sweep, HOUR_MS)
    expect(calls).toBe(2)
    expect(await app.deps.settings.getInternal(FILE_STATE_SETTING)).toMatchObject({ lastCleanup: BOOT + 2 * DAY_MS, lastAutoSweep: { status: 'done' } })
  })

  it('over the plugin data budget: the automatic run is skipped (nothing deleted), a manual run proceeds as partial', async () => {
    const { app, sweep } = await sweepApp({ data: { pluginDataBudget: { maxBytes: 64 } } })
    const orphan = await seedStoredFile(app.deps, new TextEncoder().encode('orphan'), { createdAt: BOOT - 3 * DAY_MS })
    writePluginData(app, 'big/cache.txt', 'x'.repeat(100))
    await app.deps.settings.update({ fileSweep: 'weekly' })
    await app.deps.data.start()
    await step(sweep, DAY_MS)
    const skipped = { at: BOOT + DAY_MS, status: 'skipped', reason: 'plugin-data-limit', files: 0, diskBytes: 0 }
    expect(await app.deps.settings.getInternal(FILE_STATE_SETTING)).toEqual({ lastAutoSweep: skipped })
    expect(await fileIds(app)).toEqual([orphan.id])
    expect(app.t.logs.records.find(record => record.msg === 'automatic file sweep skipped')).toMatchObject({ level: 'info', reason: 'plugin-data-limit' })
    expect((await app.deps.data.summary()).fileSweep).toEqual({ mode: 'weekly', lastAttempt: skipped, nextRunAt: BOOT + 8 * DAY_MS })

    expect((await app.deps.data.cleanupPreview()).pluginData).toBe('partial')
    expect(await app.deps.data.cleanup()).toMatchObject({ files: 1, pluginData: 'partial' })
    expect(await fileIds(app)).toEqual([])
    expect(app.t.logs.records.find(record => record.msg === 'orphaned files cleaned up')).toMatchObject({ trigger: 'manual', pluginData: 'partial' })
  })

  it('stop() aborts a sweep in flight: nothing stored, the lock released, no check afterwards', async () => {
    let entered!: () => void
    const inSweep = new Promise<void>((resolve) => {
      entered = resolve
    })
    let calls = 0
    const { app, sweep } = await sweepApp({
      files: inner => ({
        ...inner,
        sweep: async (input) => {
          calls += 1
          entered()
          await new Promise(resolve => input.signal?.addEventListener('abort', resolve))
          return inner.sweep(input)
        },
      }),
    })
    await seedStoredFile(app.deps, new TextEncoder().encode('orphan'), { createdAt: BOOT - 3 * DAY_MS })
    await app.deps.settings.update({ fileSweep: 'daily' })
    await app.deps.data.start()
    await vi.advanceTimersByTimeAsync(DAY_MS)
    await inSweep
    expect(app.deps.maintenance.current()).toMatchObject({ kind: 'file-cleanup', blockRuns: false })
    await app.deps.data.stop()
    expect(app.deps.maintenance.current()).toBeNull()
    expect(await app.deps.settings.getInternal(FILE_STATE_SETTING)).toBeUndefined()
    expect(await fileIds(app)).toHaveLength(1)
    expect(sweep.nextCheckAt()).toBeNull()
    await step(sweep, 3 * DAY_MS, DAY_MS)
    expect(calls).toBe(1)
    expect(app.t.logs.records.find(record => record.msg === 'automatic file sweep stopped')).toMatchObject({ level: 'debug' })
  })

  it('the test delay replaces the boot delay and the check interval with HF_MOCK_PROVIDER=1', async () => {
    const { app, sweep } = await sweepApp({ env: { HF_MOCK_PROVIDER: '1', HF_TEST_FILE_SWEEP_DELAY_MS: '2000' } })
    expect(app.t.env.testFileSweepDelayMs).toBe(2000)
    await app.deps.settings.update({ fileSweep: 'daily' })
    await app.deps.data.start()
    expect(sweep.nextCheckAt()).toBe(BOOT + 2000)
    await step(sweep, 2000, 1000)
    expect(await app.deps.settings.getInternal(FILE_STATE_SETTING)).toMatchObject({ lastAutoSweep: { at: BOOT + 2000, status: 'done' } })
    expect(sweep.nextCheckAt()).toBe(BOOT + 4000)
    expect((await app.deps.data.summary()).fileSweep.nextRunAt).toBe(BOOT + 2000 + DAY_MS)
    expect(app.t.logs.records.find(record => record.msg === 'automatic file sweep checks use the test delay')).toMatchObject({ delayMs: 2000 })
  })

  it('the test delay is ignored without HF_MOCK_PROVIDER (a boot warning): the first run still waits 24 h', async () => {
    const { app, sweep } = await sweepApp({ env: { HF_TEST_FILE_SWEEP_DELAY_MS: '2000' } })
    expect(app.t.env.testFileSweepDelayMs).toBeNull()
    expect(envBootWarnings(app.t.env)).toEqual(['the test-only automatic file sweep delay is ignored: it is honored only with HF_MOCK_PROVIDER=1'])
    await app.deps.settings.update({ fileSweep: 'daily' })
    await app.deps.data.start()
    expect(sweep.nextCheckAt()).toBe(BOOT + DAY_MS)
    await step(sweep, DAY_MS - HOUR_MS)
    expect(await app.deps.settings.getInternal(FILE_STATE_SETTING)).toBeUndefined()
    await step(sweep, HOUR_MS)
    expect(await app.deps.settings.getInternal(FILE_STATE_SETTING)).toMatchObject({ lastAutoSweep: { at: BOOT + DAY_MS, status: 'done' } })
  })

  it('without background (Vitest default) start() schedules nothing', async () => {
    useClock()
    const app = await dataApp()
    const sweep = (app.deps.data as DataServiceWithSweep).autoSweep
    await app.deps.settings.update({ fileSweep: 'daily' })
    await app.deps.data.start()
    expect(sweep.nextCheckAt()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    expect((await app.deps.data.summary()).fileSweep).toEqual({ mode: 'daily', lastAttempt: null, nextRunAt: BOOT + DAY_MS })
    await app.deps.data.stop()
    await app.deps.data.stop()
  })
})
